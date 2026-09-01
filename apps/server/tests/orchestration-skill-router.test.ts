import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSkillInjectionPlan,
  classifyCapabilityNeeds,
  installSelectedSkills,
  readSkillRoutingFeedback,
  recordSkillRoutingOutcome,
} from "../src/orchestration/skill-router.js";
import type { SkillRouteCandidate } from "../src/types.js";

let dataDirectory = "";
let commonWorkspace = "";

function candidate(input: Partial<SkillRouteCandidate> & { name: string }): SkillRouteCandidate {
  return {
    name: input.name,
    version: input.version ?? "1",
    description: input.description ?? input.name + " skill",
    tags: input.tags ?? [],
    notes: input.notes ?? "",
    createdAt: input.createdAt ?? "2026-08-30T00:00:00.000Z",
    evidenceRefs: input.evidenceRefs ?? [],
    provenanceWarnings: input.provenanceWarnings ?? [],
    installArguments: input.installArguments ?? {
      name: input.name,
      version: input.version ?? "1",
      scope: "run",
    },
  };
}

function publishSkill(
  name: string,
  version: string,
  record: Record<string, unknown>,
): void {
  const root = path.join(dataDirectory, "skill-hub", "skills", name, version);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, ".launchpad-skill.json"),
    JSON.stringify({
      name,
      version,
      description: name + " description",
      createdAt: "2026-08-30T00:00:00.000Z",
      ...record,
    }),
    "utf8",
  );
  writeFileSync(path.join(root, "SKILL.md"), "# " + name + "\n\nUse me.\n", "utf8");
}

beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), "skill-router-data-"));
  commonWorkspace = mkdtempSync(path.join(tmpdir(), "skill-router-common-"));
});

afterEach(() => {
  rmSync(dataDirectory, { recursive: true, force: true });
  rmSync(commonWorkspace, { recursive: true, force: true });
});

describe("classifyCapabilityNeeds", () => {
  it("detects academic PDF extraction from task evidence", () => {
    const needs = classifyCapabilityNeeds({
      runId: "run-1",
      task: "Extract citations and tables from this academic PDF paper.",
    });

    expect(needs[0]).toMatchObject({
      id: "academic_pdf_extraction",
      label: "Academic PDF extraction",
    });
    expect(needs[0]?.confidence).toBeGreaterThan(0.8);
  });
});

describe("buildSkillInjectionPlan", () => {
  it("ranks an academic extractor above a generic PDF analyzer", () => {
    const plan = buildSkillInjectionPlan({
      runId: "run-1",
      task: "Analyze an academic PDF and extract citations.",
      candidates: [
        candidate({
          name: "pdf-analysis",
          version: "2.1",
          description: "Generic PDF analysis and text extraction",
          tags: ["pdf_analysis"],
        }),
        candidate({
          name: "academic-pdf-extractor",
          version: "1.4",
          description: "Academic paper PDF extraction for citations and references",
          tags: ["academic_pdf_extraction", "citations"],
          notes: "validated citation extraction success",
          evidenceRefs: ["run-7"],
        }),
      ],
    });

    expect(plan.mode).toBe("selected");
    expect(plan.selected[0]?.candidate.name).toBe("academic-pdf-extractor");
    expect(plan.rejected.map((rank) => rank.candidate.name)).toContain("pdf-analysis");
    expect(plan.promptContext).toContain("academic-pdf-extractor v1.4");
  });

  it("rejects a skill with blocking provenance warnings despite a strong match", () => {
    const plan = buildSkillInjectionPlan({
      runId: "run-1",
      task: "Extract citations from an academic PDF.",
      candidates: [
        candidate({
          name: "academic-pdf-extractor",
          description: "Academic paper PDF citation extraction",
          tags: ["academic_pdf_extraction"],
          provenanceWarnings: ["untrusted package source"],
        }),
      ],
    });

    expect(plan.mode).toBe("shortlist");
    expect(plan.selected).toEqual([]);
    expect(plan.rejected[0]?.candidate.name).toBe("academic-pdf-extractor");
    expect(plan.install).toEqual([]);
  });

  it("does not install for low-confidence tasks", () => {
    const plan = buildSkillInjectionPlan({
      runId: "run-1",
      task: "Say hello.",
      candidates: [
        candidate({
          name: "repo-triage",
          description: "Repository triage",
          tags: ["repo"],
        }),
      ],
    });

    expect(plan.mode).toBe("none");
    expect(plan.install).toEqual([]);
    expect(plan.promptContext).toBe("");
  });

  it("never selects codex_home by default", () => {
    const plan = buildSkillInjectionPlan({
      runId: "run-1",
      task: "Extract citations from an academic PDF.",
      candidates: [
        candidate({
          name: "academic-pdf-extractor",
          description: "Academic paper PDF citation extraction",
          tags: ["academic_pdf_extraction"],
          installArguments: {
            name: "academic-pdf-extractor",
            version: "1",
            scope: "codex_home",
          },
        }),
      ],
    });

    expect(plan.install[0]?.scope).toBe("run");
  });

  it("retrieves from the real Skill Hub and installs selected skills into the common workspace", async () => {
    publishSkill("academic-pdf-extractor", "1.4", {
      description: "Academic paper PDF extraction for citations and references",
      tags: ["academic_pdf_extraction", "citations"],
      notes: "validated citation extraction success",
      evidenceRefs: ["run-7"],
    });
    const plan = buildSkillInjectionPlan({
      runId: "run-1",
      task: "Extract citations from an academic PDF.",
      dataDirectory,
      commonWorkspacePath: commonWorkspace,
    });
    const installed = await installSelectedSkills(plan, { dataDirectory, commonWorkspacePath: commonWorkspace });

    expect(installed.selected[0]?.candidate.name).toBe("academic-pdf-extractor");
    const installedPath = installed.install[0]?.installedPath;
    expect(installedPath).toBe(path.join(commonWorkspace, "skills", "academic-pdf-extractor"));
    await expect(access(path.join(installedPath!, "SKILL.md"))).resolves.toBeUndefined();
    await expect(readFile(path.join(installedPath!, ".launchpad-selected-skill.json"), "utf8"))
      .resolves.toContain("\"runId\": \"run-1\"");
  });

  it("records durable routing outcome feedback", async () => {
    const plan = buildSkillInjectionPlan({
      runId: "run-1",
      task: "Analyze an academic PDF and extract citations.",
      candidates: [
        candidate({
          name: "academic-pdf-extractor",
          version: "1.4",
          description: "Academic paper PDF extraction for citations and references",
          tags: ["academic_pdf_extraction", "citations"],
        }),
      ],
    });

    await recordSkillRoutingOutcome({
      dataDirectory,
      runId: "run-1",
      runStatus: "completed",
      taskOutcome: "succeeded",
      completedAt: "2026-08-30T01:00:00.000Z",
      plans: [plan],
    });

    const text = await readFile(path.join(dataDirectory, "skill-hub", "router-impact.jsonl"), "utf8");
    const record = JSON.parse(text.trim());
    expect(record).toMatchObject({
      schemaVersion: 1,
      runId: "run-1",
      runStatus: "completed",
      taskOutcome: "succeeded",
      selected: [
        expect.objectContaining({
          name: "academic-pdf-extractor",
          version: "1.4",
        }),
      ],
    });
  });

  it("uses prior successful routing feedback when ranking candidates", async () => {
    const successful = buildSkillInjectionPlan({
      runId: "run-old",
      task: "Extract citations from an academic PDF.",
      candidates: [
        candidate({
          name: "paper-citation-reader",
          version: "1",
          description: "Academic paper citation extraction",
          tags: ["academic_pdf_extraction"],
        }),
      ],
    });
    await recordSkillRoutingOutcome({
      dataDirectory,
      runId: "run-old",
      runStatus: "completed",
      taskOutcome: "succeeded",
      completedAt: "2026-08-30T01:00:00.000Z",
      plans: [successful],
    });

    const plan = buildSkillInjectionPlan({
      runId: "run-new",
      task: "Extract citations from an academic PDF.",
      dataDirectory,
      candidates: [
        candidate({
          name: "academic-pdf-extractor",
          version: "1",
          description: "Academic paper citation extraction",
          tags: ["academic_pdf_extraction"],
        }),
        candidate({
          name: "paper-citation-reader",
          version: "1",
          description: "Academic paper citation extraction",
          tags: ["academic_pdf_extraction"],
        }),
      ],
    });

    expect(plan.selected[0]?.candidate.name).toBe("paper-citation-reader");
    expect(plan.selected[0]?.reasons).toContain("prior router success: 1");
  });

  it("reports prior failed routing feedback as a ranking risk", async () => {
    const failed = buildSkillInjectionPlan({
      runId: "run-old",
      task: "Extract citations from an academic PDF.",
      candidates: [
        candidate({
          name: "paper-citation-reader",
          version: "1",
          description: "Academic paper citation extraction",
          tags: ["academic_pdf_extraction"],
        }),
      ],
    });
    await recordSkillRoutingOutcome({
      dataDirectory,
      runId: "run-old",
      runStatus: "failed",
      taskOutcome: "failed",
      completedAt: "2026-08-30T01:00:00.000Z",
      plans: [failed],
    });

    const feedback = readSkillRoutingFeedback(dataDirectory);
    expect(feedback.get("paper-citation-reader@1")).toEqual({ successes: 0, failures: 1 });

    const plan = buildSkillInjectionPlan({
      runId: "run-new",
      task: "Extract citations from an academic PDF.",
      dataDirectory,
      candidates: [
        candidate({
          name: "paper-citation-reader",
          version: "1",
          description: "Academic paper citation extraction",
          tags: ["academic_pdf_extraction"],
        }),
      ],
    });

    expect(plan.selected[0]?.risks).toContain("prior router failure: 1");
  });
});
