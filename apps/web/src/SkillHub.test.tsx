// @vitest-environment jsdom

/**
 * The hub is capability the platform accumulated, made visible.
 *
 * Skills published by agents were only ever readable through MCP tools inside a
 * container. What is asserted here is that the page reports the hub honestly:
 * an empty hub says it is empty rather than looking broken, and a skill's page
 * shows what its record actually holds -- no invented usage counts, because
 * nothing on disk records usage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SkillDetail, SkillSummary } from "./types";

const skills = vi.fn();
const skill = vi.fn();

vi.mock("./api", () => ({
  api: {
    skills: () => skills(),
    skill: (name: string, version?: string) => skill(name, version),
  },
}));

const { SkillHub } = await import("./SkillHub");

function summary(over: Partial<SkillSummary> = {}): SkillSummary {
  return {
    name: "repo-triage",
    version: "2",
    description: "Triage an unfamiliar repository",
    tags: ["research"],
    notes: "",
    ownerAgentId: "agent-1",
    ownerRunId: "run-7",
    createdAt: "2026-08-30T10:00:00.000Z",
    versions: ["1", "2"],
    ...over,
  };
}

function detail(over: Partial<SkillDetail> = {}): SkillDetail {
  return {
    ...summary(),
    sourcePath: "/workspace/skills/repo-triage",
    hubPath: "/launchpad-data/skill-hub/skills/repo-triage/2",
    originPatterns: ["pattern-a"],
    evidenceRefs: ["run-7"],
    supersedesVersion: "1",
    provenanceWarnings: [],
    skillMarkdown: "# Repo triage\n\nStart with the build file.\n",
    files: ["SKILL.md", "scripts/scan.sh"],
    ...over,
  };
}

afterEach(() => {
  cleanup();
  skills.mockReset();
  skill.mockReset();
});

describe("SkillHub", () => {
  beforeEach(() => {
    skills.mockResolvedValue({ skills: [summary()] });
    skill.mockResolvedValue({ skill: detail() });
  });

  it("lists a published skill by name and description", async () => {
    await act(async () => {
      render(<SkillHub onClose={() => undefined} />);
    });
    expect(screen.getByText("repo-triage")).toBeTruthy();
    expect(screen.getByText("Triage an unfamiliar repository")).toBeTruthy();
  });

  it("says the hub is empty rather than looking like a failed page", async () => {
    skills.mockResolvedValue({ skills: [] });
    await act(async () => {
      render(<SkillHub onClose={() => undefined} />);
    });
    expect(screen.getByText(/No skills have been published yet/i)).toBeTruthy();
  });

  it("reports a hub that could not be read as an error, not as an empty hub", async () => {
    skills.mockRejectedValue(new Error("hub unreadable"));
    await act(async () => {
      render(<SkillHub onClose={() => undefined} />);
    });
    expect(screen.getByText("hub unreadable")).toBeTruthy();
  });

  it("treats an answer with no skill list as an empty hub, not as a crash", async () => {
    skills.mockResolvedValue({});
    await act(async () => {
      render(<SkillHub onClose={() => undefined} />);
    });
    expect(screen.getByText(/No skills have been published yet/i)).toBeTruthy();
  });

  it("opens a skill and shows its SKILL.md", async () => {
    await act(async () => {
      render(<SkillHub onClose={() => undefined} />);
    });
    await userEvent.click(screen.getByText("repo-triage"));
    expect(skill).toHaveBeenCalledWith("repo-triage", undefined);
    expect(await screen.findByText("Start with the build file.")).toBeTruthy();
  });

  it("shows the run that produced the skill, because that is its provenance", async () => {
    await act(async () => {
      render(<SkillHub onClose={() => undefined} />);
    });
    await userEvent.click(screen.getByText("repo-triage"));
    // The same run id is also cited as evidence, so this asserts the fact and
    // not merely that the string appears somewhere on the page.
    const term = await screen.findByText("Produced by run");
    expect(term.parentElement?.textContent).toContain("run-7");
  });

  it("lists the files bundled with the skill", async () => {
    await act(async () => {
      render(<SkillHub onClose={() => undefined} />);
    });
    await userEvent.click(screen.getByText("repo-triage"));
    expect(await screen.findByText("scripts/scan.sh")).toBeTruthy();
  });

  it("reads an earlier version when one is chosen", async () => {
    await act(async () => {
      render(<SkillHub onClose={() => undefined} />);
    });
    await userEvent.click(screen.getByText("repo-triage"));
    await screen.findByText("Start with the build file.");
    await userEvent.selectOptions(screen.getByLabelText("Version"), "1");
    expect(skill).toHaveBeenCalledWith("repo-triage", "1");
  });

  it("says a skill has no SKILL.md rather than showing a blank page", async () => {
    skill.mockResolvedValue({ skill: detail({ skillMarkdown: null }) });
    await act(async () => {
      render(<SkillHub onClose={() => undefined} />);
    });
    await userEvent.click(screen.getByText("repo-triage"));
    expect(await screen.findByText(/no SKILL.md/i)).toBeTruthy();
  });

  it("closes back to the workspace", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<SkillHub onClose={onClose} />);
    });
    await userEvent.click(screen.getByRole("button", { name: "Close the skill hub" }));
    expect(onClose).toHaveBeenCalled();
  });
});
