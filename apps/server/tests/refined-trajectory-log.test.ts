/** Covers the structured JSONL projection of the RunEvent stream. */
import { describe, expect, it } from "vitest";
import {
  createRefinedTrajectoryState,
  renderRefinedTrajectoryRecords,
} from "../src/refined-trajectory-log.js";
import type { RunEvent } from "../src/run-events.js";

let seq = 0;

function event(overrides: Partial<RunEvent>): RunEvent {
  seq += 1;
  return {
    seq,
    runId: "run-1",
    agentId: "agent-1",
    spanId: "span-" + seq,
    parentSpanId: "run",
    kind: "message",
    name: "message",
    status: "ok",
    startedAt: "2026-08-26T12:00:00.000Z",
    endedAt: "2026-08-26T12:00:00.000Z",
    durationMs: 0,
    input: {},
    output: {},
    error: null,
    attributes: {},
    usage: null,
    ...overrides,
  };
}

const render = (events: RunEvent[]) => {
  const state = createRefinedTrajectoryState();
  return events.flatMap((item) => renderRefinedTrajectoryRecords(item, state));
};

describe("refined trajectory log", () => {
  it("splits model prose from a trailing assistant tool request", () => {
    const rows = render([
      event({
        kind: "api_call",
        name: "model",
        status: "ok",
        spanId: "api-1",
        output: {
          text: 'I will inspect the files.{"cmd":"rg --files","yield_time_ms":10000}{}',
        },
        usage: { inputTokens: 10, outputTokens: 4 },
      }),
    ]);

    expect(rows.map((row) => row.type)).toEqual(["reasoning", "tool_call"]);
    expect(rows[0]).toMatchObject({
      type: "reasoning",
      text: "I will inspect the files.",
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    expect(rows[1]).toMatchObject({
      type: "tool_call",
      name: "exec_command",
      tool_kind: "assistant_tool_request",
      arguments: { cmd: "rg --files", yield_time_ms: 10000 },
    });
  });

  it("emits one tool call row plus one result row for a completed tool span", () => {
    const rows = render([
      event({
        kind: "command",
        name: "bash",
        status: "in_progress",
        spanId: "cmd-1",
        endedAt: null,
        input: { command: "npm test" },
      }),
      event({
        kind: "command",
        name: "bash",
        status: "ok",
        spanId: "cmd-1",
        output: { text: "pass", exitCode: 0 },
        durationMs: 25,
      }),
    ]);

    expect(rows.map((row) => row.type)).toEqual(["tool_call", "tool_result"]);
    expect(rows[0]).toMatchObject({ command: "npm test", tool_kind: "command" });
    expect(rows[1]).toMatchObject({
      output: { text: "pass", exitCode: 0 },
      duration_ms: 25,
    });
  });

  it("keeps records timestamp-sortable in event order", () => {
    const rows = render([
      event({
        kind: "api_call",
        status: "in_progress",
        spanId: "api-1",
        startedAt: "2026-08-26T12:00:01.000Z",
        endedAt: null,
      }),
      event({
        kind: "api_call",
        status: "ok",
        spanId: "api-1",
        startedAt: "2026-08-26T12:00:01.000Z",
        endedAt: "2026-08-26T12:00:02.000Z",
        output: { text: "Done" },
      }),
    ]);

    expect(rows.map((row) => row.ts)).toEqual([
      "2026-08-26T12:00:01.000Z",
      "2026-08-26T12:00:02.000Z",
    ]);
  });
});
