// @vitest-environment jsdom

/**
 * The half of "artifacts" that could not be shown before.
 *
 * Files an agent wrote were already listed off the trace and served from its
 * workspace. Artifacts published with `publish_artifact` -- often the actual
 * deliverable -- landed in a shared directory with no HTTP route, so the rail
 * deliberately omitted them rather than printing rows that opened nothing.
 * There is a route now, and these assert that a published artifact both lists
 * and opens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PublishedArtifact } from "./types";

const runArtifacts = vi.fn();
const runArtifact = vi.fn();

vi.mock("./api", () => ({
  api: {
    runArtifacts: (id: string) => runArtifacts(id),
    runArtifact: (id: string, artifactId: string) => runArtifact(id, artifactId),
  },
}));

const { PublishedArtifacts } = await import("./PublishedArtifacts");

function artifact(over: Partial<PublishedArtifact> = {}): PublishedArtifact {
  return {
    id: "artifact-1",
    type: "report",
    description: "Findings from the audit",
    sourcePath: "/workspace/report.md",
    ownerWorkerId: "worker-1",
    ownerWorkerRunId: "run-1",
    createdAt: "2026-08-30T10:00:00.000Z",
    bytes: 2048,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  runArtifacts.mockReset();
  runArtifact.mockReset();
});

describe("PublishedArtifacts", () => {
  beforeEach(() => {
    runArtifacts.mockResolvedValue({ artifacts: [artifact()] });
    runArtifact.mockResolvedValue({ artifact: artifact(), text: "the whole report" });
  });

  it("lists what the mission published, by description", async () => {
    await act(async () => {
      render(<PublishedArtifacts runId="run-1" running={false} />);
    });
    expect(screen.getByText("Findings from the audit")).toBeTruthy();
  });

  /**
   * A row headed `text/markdown` tells you the encoding of something you cannot
   * identify. The file it came from is what the reader is looking for.
   */
  it("falls back to the file name when the publisher wrote no description", async () => {
    runArtifacts.mockResolvedValue({
      artifacts: [
        artifact({
          description: "",
          type: "text/markdown",
          sourcePath: "$COMMON_WORKSPACE/reports/syllabus-map.md",
        }),
      ],
    });
    await act(async () => {
      render(<PublishedArtifacts runId="run-1" running={false} />);
    });
    expect(screen.getByText("syllabus-map.md")).toBeTruthy();
    expect(screen.queryByText("text/markdown")).toBeNull();
  });

  it("falls back to the type only when there is no file either", async () => {
    runArtifacts.mockResolvedValue({
      artifacts: [artifact({ description: "", type: "text/markdown", sourcePath: null })],
    });
    await act(async () => {
      render(<PublishedArtifacts runId="run-1" running={false} />);
    });
    expect(screen.getByText("text/markdown")).toBeTruthy();
  });

  it("prefers what the publisher said over the file name", async () => {
    runArtifacts.mockResolvedValue({
      artifacts: [artifact({ sourcePath: "$COMMON_WORKSPACE/reports/syllabus-map.md" })],
    });
    await act(async () => {
      render(<PublishedArtifacts runId="run-1" running={false} />);
    });
    expect(screen.getByText("Findings from the audit")).toBeTruthy();
  });

  it("fetches the content only when an artifact is opened", async () => {
    await act(async () => {
      render(<PublishedArtifacts runId="run-1" running={false} />);
    });
    expect(runArtifact).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Findings from the audit"));
    expect(runArtifact).toHaveBeenCalledWith("run-1", "artifact-1");
    expect(await screen.findByText("the whole report")).toBeTruthy();
  });

  it("renders nothing when the mission published nothing", async () => {
    runArtifacts.mockResolvedValue({ artifacts: [] });
    const { container } = render(<PublishedArtifacts runId="run-1" running={false} />);
    await act(async () => undefined);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the run has no shared directory", async () => {
    runArtifacts.mockRejectedValue(new Error("gone"));
    const { container } = render(<PublishedArtifacts runId="run-1" running={false} />);
    await act(async () => undefined);
    expect(container.firstChild).toBeNull();
  });

  it("says so rather than showing an empty artifact when the content cannot be read", async () => {
    runArtifact.mockRejectedValue(new Error("Artifact content not found"));
    await act(async () => {
      render(<PublishedArtifacts runId="run-1" running={false} />);
    });
    await userEvent.click(screen.getByText("Findings from the audit"));
    expect(await screen.findByText("Artifact content not found")).toBeTruthy();
  });

  /**
   * A run with no shared directory, or a route that answers with a shape this
   * page did not expect, must render nothing -- not take the rail down.
   */
  it("renders nothing when the answer carries no artifact list", async () => {
    runArtifacts.mockResolvedValue({});
    const { container } = render(<PublishedArtifacts runId="run-1" running={false} />);
    await act(async () => undefined);
    expect(container.firstChild).toBeNull();
  });

  it("asks once for a mission that has finished", async () => {
    await act(async () => {
      render(<PublishedArtifacts runId="run-1" running={false} />);
    });
    expect(runArtifacts).toHaveBeenCalledTimes(1);
  });
});

/**
 * Whose artifact is it?
 *
 * Reported as "published is same for leader & worker, is this intended". It
 * was: the route answers from the mission's shared directory, which is one
 * place every member publishes into, so every agent showed the same
 * undifferentiated list and a worker's report looked like the leader's.
 *
 * A worker's card answers "what did THIS worker produce"; the leader is the
 * mission, so its card answers "what did the mission produce". Ownership is
 * read off the run each artifact records publishing it, not guessed.
 */
describe("whose artifacts these are", () => {
  const mine = artifact({
    id: "a-mine",
    description: "Worker's report",
    ownerWorkerRunId: "run-worker",
  });
  const sibling = artifact({
    id: "a-sibling",
    description: "Another worker's report",
    ownerWorkerRunId: "run-other",
  });

  beforeEach(() => {
    runArtifacts.mockResolvedValue({ artifacts: [mine, sibling] });
  });

  it("shows the whole mission's output when nobody is singled out", async () => {
    await act(async () => {
      render(<PublishedArtifacts runId="run-1" running={false} />);
    });
    expect(screen.getByText("Worker's report")).toBeTruthy();
    expect(screen.getByText("Another worker's report")).toBeTruthy();
  });

  it("shows only what this worker published", async () => {
    await act(async () => {
      render(<PublishedArtifacts runId="run-1" running={false} ownerRunId="run-worker" />);
    });
    expect(screen.getByText("Worker's report")).toBeTruthy();
    expect(screen.queryByText("Another worker's report")).toBeNull();
  });

  it("says the list is that worker's, not the mission's", async () => {
    await act(async () => {
      render(<PublishedArtifacts runId="run-1" running={false} ownerRunId="run-worker" />);
    });
    expect(screen.getByText(/Published by this agent/i)).toBeTruthy();
  });

  it("renders nothing when this worker published nothing, even though the mission did", async () => {
    const { container } = render(
      <PublishedArtifacts runId="run-1" running={false} ownerRunId="run-silent" />,
    );
    await act(async () => undefined);
    expect(container.firstChild).toBeNull();
  });
});
