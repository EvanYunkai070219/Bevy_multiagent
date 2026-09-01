/** The team's spending ceilings, and whether they are self-consistent. */
import { describe, expect, it } from "vitest";
import { TokenLedger, worstCaseTurns } from "../src/coordination/token-ledger.js";
import { loadConfig } from "../src/config.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";

describe("token ledger", () => {
  it("covers leader and worker usage in one total", () => {
    const ledger = new TokenLedger(1_000);
    ledger.record({ inputTokens: 300, outputTokens: 200 });
    ledger.record({ inputTokens: 100, outputTokens: 100 });
    expect(ledger.total()).toBe(700);
    expect(ledger.admits()).toBe(true);
  });

  it("stops admitting once the budget is reached", () => {
    const ledger = new TokenLedger(500);
    ledger.record({ inputTokens: 300, outputTokens: 300 });
    expect(ledger.admits()).toBe(false);
    expect(ledger.exhaustedReason()).toMatch(/TOKEN_BUDGET_EXHAUSTED/);
  });

  // A failed call reported no usage; inventing some would corrupt the total.
  it("records nothing for a call that reported no usage", () => {
    const ledger = new TokenLedger(100);
    ledger.record(null);
    expect(ledger.total()).toBe(0);
  });
});

describe("budget and follow-up limit are chosen against each other", () => {
  // Measured: with reasoning off a leader planner call ran ~1300 output tokens,
  // and a worker turn ~450 with most of it reasoning. Raising the follow-up
  // limit without raising the budget produces a setup that always ends in
  // fallback synthesis, which looks like a model problem and is a config one.
  it("keeps the worst case within the configured budget", () => {
    const config = loadConfig({ NODE_ENV: "test", ARK_API_KEY: "k", ARK_MODEL: "m" });
    const turns = worstCaseTurns({
      maxSubtasks: defaultExecutionPolicy.maxSubtasks,
      maxIterations: defaultExecutionPolicy.maxIterations,
      maxFollowUpTurnsPerWorker: config.orchestrationMaxFollowUpTurnsPerWorker,
      leaderCallsPerIteration: 4,
    });
    // A generous per-turn allowance; the point is the relationship, not the
    // exact number.
    const pessimisticTokensPerTurn = 12_000;
    expect(turns * pessimisticTokensPerTurn).toBeLessThanOrEqual(
      config.orchestrationMaxTotalTokens,
    );
  });

  it("leaves the worker reasoning switch alone by default", () => {
    const config = loadConfig({ NODE_ENV: "test", ARK_API_KEY: "k", ARK_MODEL: "m" });
    expect(config.workerReasoningEnabled).toBeNull();
    expect(config.orchestrationReasoningEnabled).toBe(false);
  });
});
