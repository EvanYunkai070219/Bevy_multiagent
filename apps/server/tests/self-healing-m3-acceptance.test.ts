import { beforeAll, describe, expect, it } from "vitest";
import {
  assertSelfHealingEvolutionDemoAccepted,
  runDeterministicSelfHealingEvolutionDemo,
  type SelfHealingEvolutionDemoResult,
} from "../scripts/self-healing-evolution-demo.js";
import { sanitizeEvolutionProjection } from "../src/orchestration/evolution/evolution-types.js";

let result!: SelfHealingEvolutionDemoResult;

beforeAll(async () => {
  result = await runDeterministicSelfHealingEvolutionDemo();
}, 120_000);

describe("Milestone 3 production-path evolution acceptance", () => {
  it("drives first, exact-repeat, and changed-context runs through the accepted Milestone 2 fixture", () => {
    expect(result.fixture).toBe("accepted-m2-production-path");
    expect(result.firstRun).toMatchObject({
      diagnosisCalls: 1,
      candidateExecutions: 3,
      candidateVerifications: expect.any(Number),
      integrations: expect.any(Number),
    });
    expect(result.firstRun.candidateExecutions).toBe(3);
    expect(result.firstRun.integrations).toBeGreaterThan(0);
    expect(result.repeatRun.pruned).toBeGreaterThan(0);
    expect(result.repeatRun.pruned).toBeLessThanOrEqual(3);
    expect(result.repeatRun.candidateExecutions + result.repeatRun.pruned).toBe(3);
    expect(result.changedRun.candidateExecutions).toBe(3);
    expect(result.changedRun.diagnosisVariant).toBe("changed");
    expect(result.changedRun.pruned).toBe(0);
    expect(result.analogousCue).toMatchObject({ pruned: 0, capsules: 0 });
    expect(result.analogousCue.cues).toBeGreaterThanOrEqual(1);
    expect(result.analogousCue.cues).toBeLessThanOrEqual(3);
    expect(result.branchReturn).toMatchObject({
      capsules: expect.any(Number),
      pruned: expect.any(Number),
      returned: expect.any(Number),
      successfulSiblingIntegrated: true,
    });
    expect(result.branchReturn.capsules).toBeGreaterThan(0);
    expect(result.branchReturn.pruned).toBeGreaterThan(0);
    expect(result.branchReturn.returned).toBeGreaterThan(0);
    expect(result.branchReturn.runId).toBe(result.runIds[2]);
    expect(result.branchReturn.tournamentId).not.toBe("");
    expect(result.branchReturn.returnedCandidateId).not.toBe(
      result.branchReturn.successfulSiblingCandidateId,
    );
    expect(result.exclusions).toEqual({
      cancellation: {
        quarantined: true,
        quarantineReason: "schema_invalid",
        pruned: 0,
        cues: 0,
        capsules: 0,
      },
      malformedEvidence: {
        quarantined: true,
        quarantineReason: "evidence_reference_invalid",
        pruned: 0,
        cues: 0,
        capsules: 0,
      },
    });
    expect(result.projectIsolation).toMatchObject({ pruned: 0, cues: 0 });
    expect(result.projectIsolation.projectId).not.toBe(result.projectId);
  });

  it("restarts production history and queries the persisted API projection", () => {
    expect(result.restart).toEqual({ reconciled: true, indexesReady: true });
    expect(result.projection.syncState).toMatch(/synced|quarantined/);
    expect(result.projection.counts.executed).toBeGreaterThan(0);
    expect(result.projection.nodes).toBeGreaterThan(0);
    expect(result.projection.observations).toBeGreaterThan(0);
    expect(result.reconciliation).toEqual({ pending: false, droppedHistoryCount: 0 });
    expect(result.sourceIntegrity).toBe(true);
  });

  it("sanitizes public health without exposing private storage", () => {
    const publicProjection = sanitizeEvolutionProjection({
      syncState: "unavailable",
      historyHealth: {
        droppedHistoryCount: 2,
        droppedReason: "outbox_entry_limit",
        reconciliationPending: true,
        rawPath: "/private/evolution/segments",
      },
      primaryFault: null,
      warningLevel: null,
      terminalReason: null,
      runBranch: result.runBranch,
      baseCommit: result.baseCommit,
      headCommit: result.headCommit,
      counts: result.projection.counts,
      nodes: [], edges: [], observations: [], cues: [], transfers: [], quarantines: [],
      nextCursor: null,
    } as never);
    expect(publicProjection.historyHealth).toEqual({
      droppedHistoryCount: 2,
      droppedReason: "outbox_entry_limit",
      reconciliationPending: true,
    });
    expect(JSON.stringify(publicProjection)).not.toContain("/private/evolution");
  });

  it("fails the CLI gate when materially different work is hard-pruned", () => {
    expect(() => assertSelfHealingEvolutionDemoAccepted(result)).not.toThrow();
    expect(() => assertSelfHealingEvolutionDemoAccepted({
      ...result,
      changedRun: { ...result.changedRun, pruned: 1 },
    })).toThrow(/changed exploration/u);
    expect(() => assertSelfHealingEvolutionDemoAccepted({
      ...result,
      exclusions: {
        ...result.exclusions,
        cancellation: { ...result.exclusions.cancellation, capsules: 1 },
      },
    })).toThrow(/historical exclusions/u);
    expect(() => assertSelfHealingEvolutionDemoAccepted({
      ...result,
      exclusions: {
        ...result.exclusions,
        malformedEvidence: {
          ...result.exclusions.malformedEvidence,
          quarantineReason: "schema_invalid",
        },
      },
    })).toThrow(/historical exclusions/u);
  });
});
