// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunResult, producedFiles } from "./RunResult";
import type { Message, RunEvent } from "./types";

afterEach(cleanup);

function event(partial: Partial<RunEvent> & Pick<RunEvent, "seq" | "spanId">): RunEvent {
  return {
    runId: "run-1",
    agentId: "agent-1",
    parentSpanId: "run",
    kind: "file_change",
    name: "file_change",
    status: "ok",
    startedAt: "2026-08-29T00:00:00.000Z",
    endedAt: "2026-08-29T00:00:00.000Z",
    durationMs: 0,
    input: {},
    output: {},
    error: null,
    attributes: {},
    usage: null,
    ...partial,
  } as RunEvent;
}

const answer: Message = {
  id: "msg-1",
  agentId: "agent-1",
  runId: "run-1",
  role: "assistant",
  content: "Wrote the report.",
  createdAt: "2026-08-29T00:00:20.000Z",
};

describe("producedFiles", () => {
  it("collects changed paths once, in the order first touched", () => {
    const files = producedFiles([
      event({ seq: 1, spanId: "a", output: { changedFiles: ["src/one.ts", "src/two.ts"] } }),
      event({ seq: 2, spanId: "b", output: { changedFiles: ["src/one.ts", "README.md"] } }),
    ]);
    expect(files).toEqual(["src/one.ts", "src/two.ts", "README.md"]);
  });

  it("survives an event with no output at all", () => {
    expect(producedFiles([{ seq: 1, spanId: "a" } as unknown as RunEvent])).toEqual([]);
  });

  it("drops blank paths rather than listing an empty entry", () => {
    expect(
      producedFiles([event({ seq: 1, spanId: "a", output: { changedFiles: ["  ", "ok.ts"] } })]),
    ).toEqual(["ok.ts"]);
  });
});

describe("RunResult", () => {
  it("names the files a run changed alongside its answer", () => {
    render(
      <RunResult
        answer={answer}
        events={[event({ seq: 1, spanId: "a", output: { changedFiles: ["report.txt"] } })]}
        failed={false}
      />,
    );
    expect(screen.getByText("Wrote the report.")).toBeTruthy();
    expect(screen.getByText("report.txt")).toBeTruthy();
    expect(screen.getByText("1 file changed")).toBeTruthy();
  });

  it("renders nothing when a run produced neither an answer nor a file", () => {
    const { container } = render(<RunResult answer={null} events={[]} failed={false} />);
    expect(container.querySelector(".run-result")).toBeNull();
  });

  it("still reports the files when a run failed before answering", () => {
    render(
      <RunResult
        answer={null}
        events={[event({ seq: 1, spanId: "a", output: { changedFiles: ["half-done.ts"] } })]}
        failed
      />,
    );
    expect(screen.getByText("half-done.ts")).toBeTruthy();
    expect(document.querySelector(".run-result--failed")).toBeTruthy();
  });
});
