/**
 * Watches the message stream for coordination that has stopped making progress.
 *
 * This exists because the wakeup tool exists. Two agents can acknowledge each
 * other indefinitely, each wakeup costing a model turn, and a prompt asking them
 * not to is not a constraint. The follow-up limit is a spending cap: it cannot
 * tell a productive exchange from a courteous loop, which is what this does.
 *
 * Nothing here steers automatically — an automatic intervention is itself a turn
 * and can deepen the loop it meant to break. It downgrades and reports.
 */
import { createHash } from "node:crypto";
import type { TeamMessageQueued } from "./messages.js";

export interface CoordinationAnomaly {
  code: "COORDINATION_PING_PONG" | "COORDINATION_REPEAT_FOLLOWUP";
  pair: string;
  detail: string;
}

export interface AnomalyDetectorOptions {
  minVolleys?: number;
  repeatThreshold?: number;
}

export class CoordinationAnomalyDetector {
  private readonly minVolleys: number;
  private readonly repeatThreshold: number;
  private lastFrom: string | null = null;
  private lastTo: string | null = null;
  private volleys = 0;
  private firedPairs = new Set<string>();
  private readonly repeats = new Map<string, number>();
  private readonly downgraded = new Set<string>();

  constructor(options: AnomalyDetectorOptions = {}) {
    this.minVolleys = options.minVolleys ?? 6;
    this.repeatThreshold = options.repeatThreshold ?? 3;
  }

  observe(message: TeamMessageQueued): CoordinationAnomaly | null {
    // Only wakeups can loop: a quiet note costs nothing and starts nothing.
    if (message.delivery !== "wakeup") return null;

    const repeatKey =
      message.fromWorkerRunId +
      ">" +
      message.toWorkerRunId +
      "#" +
      createHash("sha1").update(message.content.trim()).digest("hex").slice(0, 12);
    const seen = (this.repeats.get(repeatKey) ?? 0) + 1;
    this.repeats.set(repeatKey, seen);
    if (seen >= this.repeatThreshold) {
      this.downgraded.add(pairKey(message.fromWorkerRunId, message.toWorkerRunId));
      return {
        code: "COORDINATION_REPEAT_FOLLOWUP",
        pair: pairKey(message.fromWorkerRunId, message.toWorkerRunId),
        detail:
          "Same wakeup sent " + seen + " times from " + message.fromWorkerRunId +
          " to " + message.toWorkerRunId + " with no change in content.",
      };
    }

    // A volley is a strict reversal of the previous message's direction. A third
    // party, or a second message the same way, means something else is happening.
    const reversed =
      this.lastFrom === message.toWorkerRunId && this.lastTo === message.fromWorkerRunId;
    this.volleys = reversed ? this.volleys + 1 : 1;
    this.lastFrom = message.fromWorkerRunId;
    this.lastTo = message.toWorkerRunId;

    const pair = pairKey(message.fromWorkerRunId, message.toWorkerRunId);
    if (this.volleys >= this.minVolleys && !this.firedPairs.has(pair)) {
      this.firedPairs.add(pair);
      this.downgraded.add(pair);
      return {
        code: "COORDINATION_PING_PONG",
        pair,
        detail:
          this.volleys + " wakeups volleyed between " + message.fromWorkerRunId +
          " and " + message.toWorkerRunId + " without a third party or a change of direction.",
      };
    }
    return null;
  }

  /** After a pair trips, its wakeups become quiet rather than being refused. */
  shouldDowngrade(from: string, to: string): boolean {
    return this.downgraded.has(pairKey(from, to));
  }

  anomalies(): string[] {
    return [...this.firedPairs].map(() => "COORDINATION_PING_PONG");
  }
}

/** Order-independent: A↔B is one relationship, not two. */
function pairKey(a: string, b: string): string {
  return [a, b].sort().join("<->");
}
