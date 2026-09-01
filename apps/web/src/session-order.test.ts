import { describe, expect, it } from "vitest";
import { orderSessionEvents } from "./session-order";
import type { RunEvent } from "./types";

function event(runId: string, seq: number, startedAt: string): RunEvent {
  return {
    seq,
    runId,
    agentId: "agent-" + runId,
    spanId: runId + "-" + seq,
    parentSpanId: "run",
    kind: "command",
    name: "command",
    status: "ok",
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    input: {},
    output: {},
    error: null,
    attributes: {},
    usage: null,
  } as RunEvent;
}

function order(byRun: Record<string, RunEvent[]>): string[] {
  return orderSessionEvents(byRun).map((row) => row.event.spanId);
}

describe("orderSessionEvents", () => {
  it("keeps a run in seq order even when a later event carries an earlier time", () => {
    const result = order({
      A: [event("A", 1, "2026-08-30T00:00:10.000Z"), event("A", 2, "2026-08-30T00:00:05.000Z")],
    });
    expect(result).toEqual(["A-1", "A-2"]);
  });

  it("resolves the intransitive case into one stable order", () => {
    // A1 t=10, A2 t=5, B1 t=7. Ordering pairwise by timestamp across runs and by
    // seq within one is self-contradictory; the clamped key removes the question.
    const byRun = {
      A: [event("A", 1, "2026-08-30T00:00:10.000Z"), event("A", 2, "2026-08-30T00:00:05.000Z")],
      B: [event("B", 1, "2026-08-30T00:00:07.000Z")],
    };
    const result = order(byRun);
    expect(result).toEqual(["B-1", "A-1", "A-2"]);
    expect(order({ B: byRun.B, A: byRun.A })).toEqual(result);
  });

  it("orders across runs by each event's own time, not by when its run began", () => {
    const result = order({
      A: [event("A", 1, "2026-08-30T00:00:10.000Z")],
      B: [event("B", 1, "2026-08-30T00:00:03.000Z")],
    });
    expect(result).toEqual(["B-1", "A-1"]);
  });

  it("breaks an exact tie by run id then seq, so the order never wobbles", () => {
    const at = "2026-08-30T00:00:00.000Z";
    expect(order({ B: [event("B", 1, at)], A: [event("A", 1, at), event("A", 2, at)] })).toEqual([
      "A-1",
      "A-2",
      "B-1",
    ]);
  });
});
