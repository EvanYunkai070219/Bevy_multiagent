import { describe, expect, it } from "vitest";
import { agentStatsOf } from "./agent-stats";
import type { RunEvent } from "./types";

function event(
  partial: Partial<RunEvent> & Pick<RunEvent, "seq" | "spanId" | "kind" | "name">,
): RunEvent {
  return {
    runId: "run-1",
    agentId: "agent-1",
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

describe("agentStatsOf", () => {
  it("counts a span once even though it reports twice", () => {
    const stats = agentStatsOf([
      event({ seq: 1, spanId: "a", kind: "command", name: "command", status: "in_progress" }),
      event({ seq: 2, spanId: "a", kind: "command", name: "command" }),
    ]);
    expect(stats.toolsUsed).toBe(1);
  });

  it("does not count reasoning or model calls as tools used", () => {
    const stats = agentStatsOf([
      event({ seq: 1, spanId: "a", kind: "reasoning", name: "reasoning" }),
      event({ seq: 2, spanId: "b", kind: "api_call", name: "api_call" }),
      event({ seq: 3, spanId: "c", kind: "command", name: "command" }),
    ]);
    expect(stats.toolsUsed).toBe(1);
  });

  it("counts each changed path once across the whole run", () => {
    const stats = agentStatsOf([
      event({ seq: 1, spanId: "a", kind: "file_change", name: "file_change", output: { changedFiles: ["a.ts", "b.ts"] } }),
      event({ seq: 2, spanId: "b", kind: "file_change", name: "file_change", output: { changedFiles: ["b.ts", "c.ts"] } }),
    ]);
    expect(stats.filesChanged).toBe(3);
  });

  it("counts errors, and does not claim they were recovered", () => {
    const stats = agentStatsOf([
      event({ seq: 1, spanId: "a", kind: "command", name: "command", status: "error", error: { message: "boom" } }),
      event({ seq: 2, spanId: "b", kind: "command", name: "command" }),
    ]);
    expect(stats.errors).toBe(1);
    expect(stats).not.toHaveProperty("errorsRecovered");
  });

  it("reads tasks done from the newest plan", () => {
    const stats = agentStatsOf([
      event({ seq: 1, spanId: "p", kind: "todo", name: "todo", output: { todos: [{ text: "one", done: true }] } }),
      event({
        seq: 2,
        spanId: "p",
        kind: "todo",
        name: "todo",
        output: { todos: [{ text: "one", done: true }, { text: "two", done: true }, { text: "three", done: false }] },
      }),
    ]);
    expect(stats.tasksDone).toBe(2);
  });

  it("tallies moves in descending use order", () => {
    const stats = agentStatsOf([
      event({ seq: 1, spanId: "a", kind: "command", name: "command" }),
      event({ seq: 2, spanId: "b", kind: "command", name: "command" }),
      event({ seq: 3, spanId: "c", kind: "file_change", name: "file_change" }),
    ]);
    expect(stats.moves.map((tally) => [tally.move.label, tally.count])).toEqual([
      ["SHELL", 2],
      ["WRITE", 1],
    ]);
  });

  it("reports the open span as the current move", () => {
    const stats = agentStatsOf([
      event({ seq: 1, spanId: "a", kind: "command", name: "command" }),
      event({ seq: 2, spanId: "b", kind: "command", name: "command", status: "in_progress", input: { command: "./run.sh" } }),
    ]);
    expect(stats.current?.input.command).toBe("./run.sh");
  });

  /**
   * An agent between two tool calls -- waiting on the model, or just back from
   * `wait_for_workers` -- has nothing in flight. Reporting only `current` made
   * the move vanish at exactly those moments, which read as the agent stopping.
   * `last` is what it did, and is never confused for what it is doing.
   */
  it("remembers the finished move when nothing is in flight", () => {
    const stats = agentStatsOf([
      event({ seq: 1, spanId: "a", kind: "command", name: "command", input: { command: "./first.sh" } }),
      event({ seq: 2, spanId: "b", kind: "command", name: "command", input: { command: "./second.sh" } }),
    ]);
    expect(stats.current).toBeNull();
    expect(stats.last?.input.command).toBe("./second.sh");
  });

  it("does not report a finished move while one is still open", () => {
    const stats = agentStatsOf([
      event({ seq: 1, spanId: "a", kind: "command", name: "command", input: { command: "./done.sh" } }),
      event({ seq: 2, spanId: "b", kind: "command", name: "command", status: "in_progress" }),
    ]);
    expect(stats.last).toBeNull();
  });

  /** Reasoning and model calls are not moves, so neither can be the last one. */
  it("ignores spans that are not moves when remembering the last one", () => {
    const stats = agentStatsOf([
      event({ seq: 1, spanId: "a", kind: "command", name: "command", input: { command: "./real.sh" } }),
      event({ seq: 2, spanId: "b", kind: "reasoning", name: "reasoning" }),
      event({ seq: 3, spanId: "c", kind: "api_call", name: "api_call" }),
    ]);
    expect(stats.last?.input.command).toBe("./real.sh");
  });
});
