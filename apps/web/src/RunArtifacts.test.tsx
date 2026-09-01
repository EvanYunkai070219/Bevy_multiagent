// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunArtifacts, collectArtifacts } from "./RunArtifacts";
import type { RunEvent } from "./types";

function event(
  partial: Partial<RunEvent> & Pick<RunEvent, "seq" | "kind" | "name">,
): RunEvent {
  return {
    runId: "run-1",
    agentId: "agent-1",
    spanId: "span-" + partial.seq,
    parentSpanId: "run",
    status: "ok",
    startedAt: "2026-08-30T00:00:00.000Z",
    endedAt: "2026-08-30T00:00:00.000Z",
    durationMs: 0,
    input: {},
    output: {},
    error: null,
    attributes: {},
    usage: null,
    ...partial,
  } as RunEvent;
}

afterEach(cleanup);

describe("collectArtifacts", () => {
  it("lists every file the run wrote, once each", () => {
    const events = [
      event({ seq: 1, kind: "file_change", name: "apply_patch", output: { changedFiles: ["src/a.ts"] } }),
      event({ seq: 2, kind: "command", name: "bash", input: { command: "ls" } }),
      event({
        seq: 3,
        kind: "file_change",
        name: "apply_patch",
        output: { changedFiles: ["src/a.ts", "README.md"] },
      }),
    ];
    expect(collectArtifacts(events).map((item) => item.path)).toEqual([
      "src/a.ts",
      "README.md",
    ]);
  });

  it("attributes a file to the workspace it was written in", () => {
    const events = [
      event({
        seq: 1,
        kind: "file_change",
        name: "apply_patch",
        agentId: "worker-7",
        output: { changedFiles: ["out/report.md"] },
      }),
    ];
    expect(collectArtifacts(events)[0]?.agentId).toBe("worker-7");
  });

  it("falls back to the paths an in-progress change declares", () => {
    const events = [
      event({
        seq: 1,
        kind: "file_change",
        name: "apply_patch",
        status: "in_progress",
        input: { paths: ["src/b.ts"] },
      }),
    ];
    expect(collectArtifacts(events).map((item) => item.path)).toEqual(["src/b.ts"]);
  });

  it("ignores blank paths", () => {
    const events = [
      event({ seq: 1, kind: "file_change", name: "apply_patch", output: { changedFiles: ["  "] } }),
    ];
    expect(collectArtifacts(events)).toEqual([]);
  });
});

describe("RunArtifacts", () => {
  it("renders nothing when the run produced no files", () => {
    const { container } = render(<RunArtifacts events={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("offers each file for opening", () => {
    render(
      <RunArtifacts
        events={[
          event({
            seq: 1,
            kind: "file_change",
            name: "apply_patch",
            output: { changedFiles: ["out/report.md"] },
          }),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "out/report.md" })).toBeTruthy();
  });
});
