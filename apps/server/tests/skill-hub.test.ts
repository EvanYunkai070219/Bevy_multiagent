import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/errors.js";
import { listSkills, readSkillFromHub } from "../src/skill-hub.js";

let dataDirectory = "";

function publishSkill(
  name: string,
  version: string,
  record: Record<string, unknown> = {},
  files: Record<string, string> = { "SKILL.md": "# " + name + "\n\nHow to do it.\n" },
): void {
  const root = path.join(dataDirectory, "skill-hub", "skills", name, version);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, ".launchpad-skill.json"),
    JSON.stringify({
      name,
      version,
      description: name + " description",
      createdAt: "2026-08-30T10:00:00.000Z",
      ...record,
    }),
    "utf8",
  );
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), "skill-hub-"));
});

afterEach(() => {
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("listSkills", () => {
  it("lists nothing before any skill is published", () => {
    expect(listSkills(dataDirectory)).toEqual([]);
  });

  it("reports a published skill with what the record actually says", () => {
    publishSkill("repo-triage", "1", {
      description: "Triage a repository",
      tags: ["research", "repo"],
      notes: "Extracted from run 7",
      ownerAgentId: "agent-1",
      ownerRunId: "run-7",
    });
    expect(listSkills(dataDirectory)).toEqual([
      {
        name: "repo-triage",
        version: "1",
        description: "Triage a repository",
        tags: ["research", "repo"],
        notes: "Extracted from run 7",
        ownerAgentId: "agent-1",
        ownerRunId: "run-7",
        createdAt: "2026-08-30T10:00:00.000Z",
        versions: ["1"],
      },
    ]);
  });

  it("shows one row per skill, at its newest version", () => {
    publishSkill("repo-triage", "1", { createdAt: "2026-08-30T10:00:00.000Z" });
    publishSkill("repo-triage", "2", { createdAt: "2026-08-30T12:00:00.000Z" });
    const skills = listSkills(dataDirectory);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.version).toBe("2");
    expect(skills[0]?.versions).toEqual(["1", "2"]);
  });

  it("puts the most recently published skill first", () => {
    publishSkill("older", "1", { createdAt: "2026-08-29T10:00:00.000Z" });
    publishSkill("newer", "1", { createdAt: "2026-08-30T10:00:00.000Z" });
    expect(listSkills(dataDirectory).map((skill) => skill.name)).toEqual(["newer", "older"]);
  });

  it("ignores a version folder with no skill record", () => {
    publishSkill("repo-triage", "1");
    mkdirSync(path.join(dataDirectory, "skill-hub", "skills", "repo-triage", "2"), {
      recursive: true,
    });
    expect(listSkills(dataDirectory)[0]?.versions).toEqual(["1"]);
  });
});

describe("readSkillFromHub", () => {
  it("returns SKILL.md alongside the record", () => {
    publishSkill("repo-triage", "1", {}, { "SKILL.md": "# Repo triage\n\nStep one.\n" });
    const detail = readSkillFromHub(dataDirectory, "repo-triage");
    expect(detail.skillMarkdown).toBe("# Repo triage\n\nStep one.\n");
  });

  it("lists the files bundled with the skill", () => {
    publishSkill(
      "repo-triage",
      "1",
      {},
      { "SKILL.md": "# x", "scripts/scan.sh": "echo hi", "references/notes.md": "notes" },
    );
    expect(readSkillFromHub(dataDirectory, "repo-triage").files).toEqual([
      "SKILL.md",
      "references/notes.md",
      "scripts/scan.sh",
    ]);
  });

  it("carries the provenance the publisher recorded", () => {
    publishSkill("repo-triage", "1", {
      originPatterns: ["pattern-a"],
      evidenceRefs: ["run-7"],
      supersedesVersion: "0",
      provenanceWarnings: ["no PURPOSE.md"],
    });
    const detail = readSkillFromHub(dataDirectory, "repo-triage");
    expect(detail.originPatterns).toEqual(["pattern-a"]);
    expect(detail.evidenceRefs).toEqual(["run-7"]);
    expect(detail.supersedesVersion).toBe("0");
    expect(detail.provenanceWarnings).toEqual(["no PURPOSE.md"]);
  });

  it("reads the newest version when none is asked for", () => {
    publishSkill("repo-triage", "1", { createdAt: "2026-08-30T10:00:00.000Z" });
    publishSkill("repo-triage", "2", { createdAt: "2026-08-30T12:00:00.000Z" });
    expect(readSkillFromHub(dataDirectory, "repo-triage").version).toBe("2");
  });

  it("reads the exact version when one is asked for", () => {
    publishSkill("repo-triage", "1", { createdAt: "2026-08-30T10:00:00.000Z" });
    publishSkill("repo-triage", "2", { createdAt: "2026-08-30T12:00:00.000Z" });
    expect(readSkillFromHub(dataDirectory, "repo-triage", "1").version).toBe("1");
  });

  it("says a skill without SKILL.md has none rather than inventing one", () => {
    publishSkill("repo-triage", "1", {}, { "notes.md": "hi" });
    expect(readSkillFromHub(dataDirectory, "repo-triage").skillMarkdown).toBeNull();
  });

  it("reports an unpublished skill as not found", () => {
    try {
      readSkillFromHub(dataDirectory, "missing-skill");
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).statusCode).toBe(404);
    }
  });

  it("refuses a name that is a path rather than a skill name", () => {
    expect(() => readSkillFromHub(dataDirectory, "../../launchpad")).toThrow(HttpError);
  });

  it("refuses a version that climbs out of the hub", () => {
    publishSkill("repo-triage", "1");
    expect(() => readSkillFromHub(dataDirectory, "repo-triage", "..")).toThrow(HttpError);
  });
});
