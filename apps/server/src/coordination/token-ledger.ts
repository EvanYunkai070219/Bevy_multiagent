/**
 * One running total for a leader run, covering the leader's own calls and every
 * worker's.
 *
 * Checked at the call boundary, so an already-admitted call can overshoot
 * slightly. The alternative is cancelling work mid-flight to save tokens that
 * were already spent.
 */
import type { RunUsage } from "../types.js";

export class TokenLedger {
  private input = 0;
  private output = 0;

  constructor(private readonly maxTotal: number) {}

  record(usage: RunUsage | null): void {
    if (usage === null) return; // A failed call with no usage invents nothing.
    this.input += usage.inputTokens ?? 0;
    this.output += usage.outputTokens ?? 0;
  }

  total(): number {
    return this.input + this.output;
  }

  /** False once the budget is reached: no further request is started. */
  admits(): boolean {
    return this.total() < this.maxTotal;
  }

  exhaustedReason(): string {
    return (
      "TOKEN_BUDGET_EXHAUSTED: " + this.total() + " of " + this.maxTotal + " tokens used"
    );
  }
}

/**
 * The worst case the current settings permit, in model turns. Budget and
 * follow-up limit are not independent knobs — raising one without checking the
 * other produces a configuration that always ends in fallback synthesis.
 */
export function worstCaseTurns(options: {
  maxSubtasks: number;
  maxIterations: number;
  maxFollowUpTurnsPerWorker: number;
  leaderCallsPerIteration: number;
}): number {
  const workerTurns =
    options.maxSubtasks * (1 + options.maxFollowUpTurnsPerWorker) * options.maxIterations;
  return workerTurns + options.leaderCallsPerIteration * options.maxIterations;
}
