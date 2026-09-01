import { describe, expect, it } from "vitest";
import {
  EXPECTED_SELF_HEALING_TRACE,
  formatSelfHealingDemo,
  runDeterministicSelfHealingDemo,
} from "../scripts/self-healing-demo-fixture.js";

describe("Milestone 2 deterministic self-healing demo", () => {
  it("prints the complete bounded repair trace and operator evidence", async () => {
    const result = await runDeterministicSelfHealingDemo();
    const output = formatSelfHealingDemo(result);

    expect(result).toMatchObject({
      status: "completed",
      outcome: "succeeded",
      winnerFamily: "context_patch",
      candidateCounts: {
        declared: 3,
        admitted: 3,
        executed: 3,
        verified: 1,
        promoted: 1,
      },
      diagnosisCalls: 1,
      tournamentCount: 1,
      frontendStarts: 1,
      backendStarts: 1,
      integrationStarts: 1,
      repairStarts: 3,
      repeatedFailureCount: 3,
      userBranchIntegrity: true,
      cleanupDecision: "removed",
    });
    expect(result.trace).toEqual(EXPECTED_SELF_HEALING_TRACE);
    expect(result.siblingOverlap).toBe(true);
    expect(result.preflightBeforeModel).toBe(true);
    expect(result.sourceBefore).toEqual(result.sourceAfter);
    expect(result.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.finalCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.finalTree).toMatch(/^[0-9a-f]{40}$/);
    expect(result.finalCommit).not.toBe(result.baseCommit);
    expect(new Set(result.candidateCheckpointHashes)).toEqual(
      new Set([result.candidateCheckpointHashes[0]]),
    );
    expect(result.mandatoryGateTiers).toEqual(
      expect.arrayContaining([
        "integrity",
        "targeted",
        "contract",
        "consumer",
        "held_out",
        "mutation_quality",
        "regression",
        "post_integration",
      ]),
    );
    expect(result.mandatoryGatesPassed).toBe(true);
    expect(result.calls).toBeGreaterThan(0);
    expect(result.reservedTokens).toBeGreaterThanOrEqual(0);
    expect(result.actualTokens).toBeGreaterThan(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    expect(output).toContain(EXPECTED_SELF_HEALING_TRACE.join(" -> "));
    for (const label of [
      "run_id",
      "project_id",
      "run_branch",
      "base_commit",
      "final_commit",
      "calls",
      "reserved_tokens",
      "actual_tokens",
      "elapsed_ms",
      "cleanup",
      "user_branch_integrity",
    ]) {
      expect(output).toContain(label + "=");
    }
    expect(output).not.toMatch(/fixture-key|fixture-secret|ARK_API_KEY|model-token/i);
  }, 60_000);
});
