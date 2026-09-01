/** The brake that has to ship with peer wakeup. */
import { describe, expect, it } from "vitest";
import { CoordinationAnomalyDetector } from "../src/coordination/anomaly-detector.js";
import type { MessageDelivery, TeamMessageQueued } from "../src/coordination/messages.js";

let counter = 0;
const msg = (
  from: string,
  to: string,
  content = "ping",
  delivery: MessageDelivery = "wakeup",
): TeamMessageQueued => ({
  id: "m" + counter++,
  parentRunId: "leader-1",
  fromWorkerRunId: from,
  toWorkerRunId: to,
  delivery,
  content,
  workspaceRefs: [],
  createdAt: "2026-08-27T00:00:00.000Z",
});

const feed = (
  detector: CoordinationAnomalyDetector,
  pairs: [string, string][],
  content?: (i: number) => string,
): string[] =>
  pairs
    .map(([from, to], i) => detector.observe(msg(from, to, content ? content(i) : "ping " + i)))
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .map((a) => a.code);

describe("coordination anomaly detector", () => {
  it("fires on strict direction reversals", () => {
    const codes = feed(new CoordinationAnomalyDetector(), [
      ["A", "B"], ["B", "A"], ["A", "B"], ["B", "A"], ["A", "B"], ["B", "A"],
    ]);
    expect(codes).toContain("COORDINATION_PING_PONG");
  });

  // A third party means the exchange is going somewhere, not round in circles.
  it("resets when a third party joins", () => {
    const codes = feed(new CoordinationAnomalyDetector(), [
      ["A", "B"], ["B", "A"], ["C", "B"], ["A", "B"], ["B", "A"], ["A", "B"],
    ]);
    expect(codes).toEqual([]);
  });

  it("resets on two messages the same way", () => {
    const codes = feed(new CoordinationAnomalyDetector(), [
      ["A", "B"], ["B", "A"], ["A", "B"], ["A", "B"], ["B", "A"], ["A", "B"],
    ]);
    expect(codes).toEqual([]);
  });

  // A quiet note costs nothing and starts nothing, so it cannot be a loop.
  it("ignores quiet messages entirely", () => {
    const detector = new CoordinationAnomalyDetector();
    const pairs: [string, string][] = [
      ["A", "B"], ["B", "A"], ["A", "B"], ["B", "A"], ["A", "B"], ["B", "A"],
    ];
    const codes = pairs
      .map(([f, t], i) => detector.observe(msg(f, t, "note " + i, "quiet")))
      .filter((a) => a !== null);
    expect(codes).toEqual([]);
  });

  it("flags the same wakeup repeated to the same target", () => {
    const detector = new CoordinationAnomalyDetector();
    const codes = [
      detector.observe(msg("A", "B", "do the thing")),
      detector.observe(msg("A", "B", "do the thing")),
      detector.observe(msg("A", "B", "do the thing")),
    ].filter((a) => a !== null);
    expect(codes[0]?.code).toBe("COORDINATION_REPEAT_FOLLOWUP");
  });

  // Downgrade, do not refuse: the message still arrives, it just stops costing
  // a turn. Refusing would lose information the recipient may still need.
  it("downgrades the offending pair's wakeups afterwards", () => {
    const detector = new CoordinationAnomalyDetector();
    feed(detector, [
      ["A", "B"], ["B", "A"], ["A", "B"], ["B", "A"], ["A", "B"], ["B", "A"],
    ]);
    expect(detector.shouldDowngrade("A", "B")).toBe(true);
    expect(detector.shouldDowngrade("B", "A")).toBe(true);
    expect(detector.shouldDowngrade("A", "C")).toBe(false);
  });

  it("fires once per pair rather than on every message after the threshold", () => {
    const detector = new CoordinationAnomalyDetector();
    const codes = feed(detector, [
      ["A", "B"], ["B", "A"], ["A", "B"], ["B", "A"], ["A", "B"], ["B", "A"],
      ["A", "B"], ["B", "A"],
    ]);
    expect(codes.filter((c) => c === "COORDINATION_PING_PONG")).toHaveLength(1);
  });
});
