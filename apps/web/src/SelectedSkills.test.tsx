import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SelectedSkills } from "./SelectedSkills";
import type { SkillInjectionPlan } from "./types";

function plan(): SkillInjectionPlan {
  return {
    runId: "run-1",
    task: "Extract citations from an academic PDF.",
    createdAt: "2026-08-30T00:00:00.000Z",
    mode: "selected",
    needs: [],
    selected: [
      {
        candidate: {
          name: "academic-pdf-extractor",
          version: "1.4",
          description: "Academic PDF extraction",
          tags: ["academic_pdf_extraction"],
          notes: "",
          createdAt: "2026-08-30T00:00:00.000Z",
          evidenceRefs: [],
          provenanceWarnings: [],
          installArguments: {
            name: "academic-pdf-extractor",
            version: "1.4",
            scope: "run",
          },
        },
        score: 0.91,
        reasons: ["exact capability tag", "citation extraction evidence"],
        risks: [],
      },
    ],
    rejected: [
      {
        candidate: {
          name: "pdf-analysis",
          version: "2.1",
          description: "Generic PDF analysis",
          tags: ["pdf_analysis"],
          notes: "",
          createdAt: "2026-08-30T00:00:00.000Z",
          evidenceRefs: [],
          provenanceWarnings: [],
          installArguments: { name: "pdf-analysis", version: "2.1", scope: "run" },
        },
        score: 0.64,
        reasons: ["broad PDF support"],
        risks: ["generic fit"],
      },
    ],
    install: [
      {
        name: "academic-pdf-extractor",
        version: "1.4",
        scope: "run",
        installedPath: "$COMMON_WORKSPACE/skills/academic-pdf-extractor",
      },
    ],
    promptContext: "",
  };
}

describe("SelectedSkills", () => {
  it("renders installed middleware-selected skills without rejected alternatives", () => {
    const html = renderToStaticMarkup(<SelectedSkills plans={[plan()]} />);

    expect(html).toContain('aria-label="Selected skills"');
    expect(html).toContain("academic-pdf-extractor");
    expect(html).toContain("v1.4");
    expect(html).toContain("91%");
    expect(html).toContain("$COMMON_WORKSPACE/skills/academic-pdf-extractor");
    expect(html).not.toContain("pdf-analysis");
  });

  it("renders nothing when no skill was selected", () => {
    const html = renderToStaticMarkup(<SelectedSkills plans={[{ ...plan(), selected: [] }]} />);
    expect(html).toBe("");
  });
});
