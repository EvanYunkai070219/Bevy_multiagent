import { describe, expect, it } from "vitest";
import { creatureStateOf } from "./creature-state";
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

const failed = event({
  seq: 1,
  kind: "command",
  name: "command",
  status: "error",
  error: { message: "Permission denied" },
});

describe("creatureStateOf", () => {
  it("is idle with nothing to show", () => {
    expect(creatureStateOf([])).toBe("idle");
  });

  it("waits when a run exists but nothing is open", () => {
    expect(creatureStateOf([], "running")).toBe("waiting");
  });

  it("thinks while reasoning is open", () => {
    const events = [event({ seq: 1, kind: "reasoning", name: "reasoning", status: "in_progress" })];
    expect(creatureStateOf(events, "running")).toBe("thinking");
  });

  it("works while a command is open", () => {
    const events = [event({ seq: 1, kind: "command", name: "command", status: "in_progress" })];
    expect(creatureStateOf(events, "running")).toBe("working");
  });

  it("searches while a web search or a search-shaped tool is open", () => {
    expect(
      creatureStateOf([event({ seq: 1, kind: "web_search", name: "web_search", status: "in_progress" })], "running"),
    ).toBe("searching");
    expect(
      creatureStateOf([event({ seq: 1, kind: "mcp_tool", name: "search_files", status: "in_progress" })], "running"),
    ).toBe("searching");
  });

  it("is hurt while sitting on a failure", () => {
    expect(creatureStateOf([failed], "running")).toBe("hurt");
  });

  it("is thinking, not hurt, once it starts reasoning about the failure", () => {
    const events = [
      failed,
      event({ seq: 2, kind: "reasoning", name: "reasoning", status: "in_progress" }),
    ];
    expect(creatureStateOf(events, "running")).toBe("thinking");
  });

  it("is working, not hurt, once it starts retrying", () => {
    const events = [
      failed,
      event({ seq: 2, kind: "command", name: "command", status: "in_progress" }),
    ];
    expect(creatureStateOf(events, "running")).toBe("working");
  });

  it("is done, not hurt, when a run that recovered has completed", () => {
    const events = [failed, event({ seq: 2, kind: "command", name: "command" })];
    expect(creatureStateOf(events, "completed")).toBe("done");
    expect(creatureStateOf([failed], "completed")).toBe("done");
  });

  it("ignores plan updates and repeated diagnostics", () => {
    const events = [
      failed,
      event({ seq: 2, kind: "todo", name: "todo" }),
      event({
        seq: 3,
        kind: "error",
        name: "error",
        error: { message: "unknown model metadata", code: "codex_diagnostic" },
      }),
    ];
    expect(creatureStateOf(events, "running")).toBe("hurt");
  });
});

describe("a run that has stopped", () => {
  const open = event({
    seq: 2,
    kind: "command",
    name: "command",
    status: "in_progress",
    input: { command: "./slow.sh" },
  });

  it("is not working on a cancelled run whose span was never closed", () => {
    expect(creatureStateOf([open], "running")).toBe("working");
    expect(creatureStateOf([open], "cancelled")).not.toBe("working");
  });

  it("shows the failure a failed run ended on rather than the open span", () => {
    expect(creatureStateOf([failed, open], "failed")).toBe("hurt");
  });

  it("is done on a completed run even with a span left open", () => {
    expect(creatureStateOf([open], "completed")).toBe("done");
  });
});
