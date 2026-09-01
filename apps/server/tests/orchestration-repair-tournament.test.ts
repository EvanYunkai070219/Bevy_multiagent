import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPAIR_CANDIDATE_STEP_CAP,
  REPAIR_CANDIDATE_TIMEOUT_MS,
} from "../src/orchestration/healing/mutation-factory.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import {
  RepairTournamentRunner,
  selectWinner,
  type RepairTournamentDeps,
} from "../src/orchestration/healing/repair-tournament.js";
import type { ExactRepeatIndex } from "../src/orchestration/evolution/exact-repeat-index.js";
import type { FailureCueService } from "../src/orchestration/evolution/failure-cues.js";
import { RunControl } from "../src/orchestration/run-control.js";
import type { RunEventDraft } from "../src/run-events.js";
import {
  emptyHealingState,
  type AttemptWorkspaceRecord,
  type ContributionRecord,
  type DiagnosisRecord,
  type FaultRecord,
  type HealingState,
  type MutationCandidate,
  type ProjectRunRecord,
  type RepairCheckpoint,
  type SubtaskContract,
  type TaskNodeState,
  type VerificationResult,
  type WorkerResult,
} from "../src/types.js";
import { demoContract } from "./verification-authority-fixtures.js";
import { realVerificationFixture } from "./verification-container-fixtures.js";

function candidate(
  family: MutationCandidate["delta"]["family"],
  overrides: Partial<MutationCandidate> = {},
): MutationCandidate {
  return {
    id: "tour-1-" + family,
    tournamentId: "tour-1",
    checkpointId: "chk-1",
    delta: {
      family,
      targetSubtaskId: "backend",
      diagnosisId: "diag-1",
      addedEvidenceRefs: [],
      instructionPatch: family === "control" ? "" : family,
      toolRoute: ["read_file"],
      expectedEffect: family,
      contentHash: family,
    },
    state: "verified",
    attemptId: "attempt-" + family,
    verificationIds: ["v-" + family],
    modelCalls: 1,
    reservedTokens: 100,
    actualInputTokens: 10,
    actualOutputTokens: 10,
    elapsedMs: 100,
    terminalReason: null,
    ...overrides,
  };
}

function verification(
  subjectId: string,
  overrides: Partial<VerificationResult> = {},
): VerificationResult {
  return {
    id: "ver-" + subjectId,
    subjectType: "candidate",
    subjectId,
    stage: "finalist",
    authorityManifestHash: "m",
    gates: [],
    failureKind: overrides.mandatoryPassed === false ? "deterministic_gate_failure" : null,
    mandatoryPassed: true,
    hardProgress: 4,
    regressionCount: 1,
    modelCalls: 3,
    reservedTokens: 1000,
    actualInputTokens: 40,
    actualOutputTokens: 20,
    elapsedMs: 80,
    verifiedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

const control = candidate("control");
const context = candidate("context_patch");
const strategy = candidate("strategy_patch");
const all = [control, context, strategy];

describe("selectWinner lexicographic ranking", () => {
  it.each([
    {
      label: "running control with no evidence",
      control: candidate("control", { state: "running" }),
      evidence: [],
    },
    {
      label: "cancelled control with stale finalist evidence",
      control: candidate("control", { state: "cancelled", terminalReason: "cancelled" }),
      evidence: [verification(control.id, { mandatoryPassed: false })],
    },
    {
      label: "infrastructure-rejected control with stale finalist evidence",
      control: candidate("control", { state: "rejected", terminalReason: "infrastructure_failure" }),
      evidence: [verification(control.id, { mandatoryPassed: false })],
    },
    {
      label: "control with candidate-stage evidence only",
      control: candidate("control", { state: "verified" }),
      evidence: [verification(control.id, { stage: "candidate", mandatoryPassed: false })],
    },
    {
      label: "control with conflicting finalist evidence",
      control: candidate("control", { state: "verified" }),
      evidence: [
        verification(control.id, { id: "control-final-pass", mandatoryPassed: true }),
        verification(control.id, { id: "control-final-fail", mandatoryPassed: false }),
      ],
    },
  ])("defaults to control for $label", ({ control: ambiguousControl, evidence }) => {
    const passingMutant = candidate("context_patch");
    const verifications = [
      ...evidence,
      verification(passingMutant.id, { mandatoryPassed: true, hardProgress: 99 }),
    ];
    expect(
      selectWinner(ambiguousControl, [ambiguousControl, passingMutant], verifications).id,
    ).toBe(ambiguousControl.id);
  });

  it("allows a verified mutant to beat an exact terminal finalist-negative control", () => {
    const negativeControl = candidate("control", { state: "rejected", terminalReason: null });
    const passingMutant = candidate("context_patch");
    expect(
      selectWinner(negativeControl, [negativeControl, passingMutant], [
        verification(negativeControl.id, { mandatoryPassed: false, hardProgress: 6 }),
        verification(passingMutant.id, { mandatoryPassed: true, hardProgress: 2 }),
      ]).id,
    ).toBe(passingMutant.id);
  });

  it("keeps control when no candidate has exact finalist verification evidence", () => {
    const rejectedControl = candidate("control", { state: "rejected" });
    const rejectedContext = candidate("context_patch", { state: "rejected" });
    const rejectedStrategy = candidate("strategy_patch", { state: "rejected" });
    const winner = selectWinner(
      rejectedControl,
      [rejectedControl, rejectedContext, rejectedStrategy],
      [
        verification(rejectedControl.id, { stage: "candidate", mandatoryPassed: false }),
        verification(rejectedContext.id, { stage: "candidate", mandatoryPassed: true, hardProgress: 99 }),
        verification(rejectedStrategy.id, { stage: "candidate", mandatoryPassed: true, hardProgress: 98 }),
      ],
    );
    expect(winner.id).toBe(rejectedControl.id);
  });

  it("selects the only candidate that passes every mandatory gate", () => {
    const winner = selectWinner(control, all, [
      verification(control.id, { mandatoryPassed: false, hardProgress: 6 }),
      verification(context.id, { mandatoryPassed: true, hardProgress: 2 }),
      verification(strategy.id, { mandatoryPassed: false, hardProgress: 8 }),
    ]);
    expect(winner.id).toBe(context.id);
  });

  it("selects a passing mutant only when control fails mandatory gates", () => {
    const winner = selectWinner(control, all, [
      verification(control.id, { mandatoryPassed: false, hardProgress: 5 }),
      verification(context.id, { mandatoryPassed: true, hardProgress: 5 }),
      verification(strategy.id, { mandatoryPassed: false, hardProgress: 9 }),
    ]);
    expect(winner.id).toBe(context.id);
  });

  it("selects a passing mutant when it has strictly higher hard progress than a passing control", () => {
    const winner = selectWinner(control, all, [
      verification(control.id, { mandatoryPassed: true, hardProgress: 3 }),
      verification(context.id, { mandatoryPassed: true, hardProgress: 5 }),
      verification(strategy.id, { mandatoryPassed: true, hardProgress: 4 }),
    ]);
    expect(winner.id).toBe(context.id);
  });

  it("keeps a passing control when mutants pass with equal hard progress, even if they are cheaper", () => {
    const winner = selectWinner(control, all, [
      verification(control.id, {
        mandatoryPassed: true,
        hardProgress: 4,
        regressionCount: 3,
        modelCalls: 9,
        actualInputTokens: 90,
        actualOutputTokens: 90,
        elapsedMs: 900,
      }),
      verification(context.id, {
        mandatoryPassed: true,
        hardProgress: 4,
        regressionCount: 0,
        modelCalls: 1,
        actualInputTokens: 1,
        actualOutputTokens: 1,
        elapsedMs: 1,
      }),
      verification(strategy.id, {
        mandatoryPassed: true,
        hardProgress: 4,
        regressionCount: 0,
        modelCalls: 1,
        actualInputTokens: 1,
        actualOutputTokens: 1,
        elapsedMs: 1,
      }),
    ]);
    expect(winner.id).toBe(control.id);
  });

  it("breaks remaining ties by fewer regressions, then calls, tokens, and elapsed time", () => {
    const failingControl = verification(control.id, { mandatoryPassed: false, hardProgress: 0 });
    const byRegressions = selectWinner(control, all, [
      failingControl,
      verification(context.id, { regressionCount: 0, modelCalls: 5, actualInputTokens: 50, actualOutputTokens: 50, elapsedMs: 50 }),
      verification(strategy.id, { regressionCount: 2, modelCalls: 1, actualInputTokens: 1, actualOutputTokens: 1, elapsedMs: 1 }),
    ]);
    expect(byRegressions.id).toBe(context.id);

    const expensiveCalls = candidate("context_patch", { modelCalls: 4, actualInputTokens: 50, actualOutputTokens: 50, elapsedMs: 50 });
    const cheapCalls = candidate("strategy_patch", { modelCalls: 2, actualInputTokens: 90, actualOutputTokens: 90, elapsedMs: 90 });
    const byCalls = selectWinner(control, [control, expensiveCalls, cheapCalls], [
      failingControl,
      verification(expensiveCalls.id, { regressionCount: 1, modelCalls: 1, actualInputTokens: 1, actualOutputTokens: 1, elapsedMs: 1 }),
      verification(cheapCalls.id, { regressionCount: 1, modelCalls: 99, actualInputTokens: 1, actualOutputTokens: 1, elapsedMs: 1 }),
    ]);
    expect(byCalls.id).toBe(cheapCalls.id);

    const cheapTokens = candidate("context_patch", { modelCalls: 2, actualInputTokens: 10, actualOutputTokens: 5, elapsedMs: 50 });
    const expensiveTokens = candidate("strategy_patch", { modelCalls: 2, actualInputTokens: 40, actualOutputTokens: 40, elapsedMs: 1 });
    const byTokens = selectWinner(control, [control, cheapTokens, expensiveTokens], [
      failingControl,
      verification(cheapTokens.id, { regressionCount: 1, modelCalls: 99, actualInputTokens: 900, actualOutputTokens: 900, elapsedMs: 1 }),
      verification(expensiveTokens.id, { regressionCount: 1, modelCalls: 99, actualInputTokens: 1, actualOutputTokens: 1, elapsedMs: 1 }),
    ]);
    expect(byTokens.id).toBe(cheapTokens.id);

    const slow = candidate("context_patch", { modelCalls: 2, actualInputTokens: 10, actualOutputTokens: 10, elapsedMs: 40 });
    const fast = candidate("strategy_patch", { modelCalls: 2, actualInputTokens: 10, actualOutputTokens: 10, elapsedMs: 9 });
    const byElapsed = selectWinner(control, [control, slow, fast], [
      failingControl,
      verification(slow.id, { regressionCount: 1, modelCalls: 99, actualInputTokens: 1, actualOutputTokens: 1, elapsedMs: 1 }),
      verification(fast.id, { regressionCount: 1, modelCalls: 99, actualInputTokens: 1, actualOutputTokens: 1, elapsedMs: 9_000 }),
    ]);
    expect(byElapsed.id).toBe(fast.id);
  });

  it("does not let verifier wall-clock break a candidate-usage tie", () => {
    const left = candidate("context_patch", { modelCalls: 2, actualInputTokens: 10, actualOutputTokens: 10, elapsedMs: 20 });
    const right = candidate("strategy_patch", { modelCalls: 2, actualInputTokens: 10, actualOutputTokens: 10, elapsedMs: 20 });
    const winner = selectWinner(control, [control, left, right], [
      verification(control.id, { mandatoryPassed: false, hardProgress: 0 }),
      verification(left.id, { regressionCount: 1, modelCalls: 0, actualInputTokens: 0, actualOutputTokens: 0, elapsedMs: 1 }),
      verification(right.id, { regressionCount: 1, modelCalls: 0, actualInputTokens: 0, actualOutputTokens: 0, elapsedMs: 9_000 }),
    ]);
    expect(winner.id).toBe(control.id);
  });

  it("selects control on any missing field, tie, or ambiguous comparison", () => {
    const complete = {
      mandatoryPassed: true as const,
      hardProgress: 4,
      regressionCount: 1,
      modelCalls: 3,
      actualInputTokens: 10,
      actualOutputTokens: 10,
      elapsedMs: 20,
    };
    expect(
      selectWinner(
        control,
        [control, candidate("context_patch", { elapsedMs: undefined as unknown as number }), strategy],
        [
          verification(control.id, complete),
          verification(context.id, complete),
          verification(strategy.id, complete),
        ],
      ).id,
    ).toBe(control.id);

    expect(
      selectWinner(control, all, [
        verification(control.id, complete),
        verification(context.id, complete),
        verification(strategy.id, complete),
      ]).id,
    ).toBe(control.id);

    expect(selectWinner(control, all, []).id).toBe(control.id);

    expect(
      selectWinner(control, all, [
        verification(control.id, { mandatoryPassed: false, hardProgress: 0 }),
        verification(context.id, complete),
        verification(strategy.id, complete),
      ]).id,
    ).toBe(control.id);
  });

  it("never ranks by a combined cost scalar: a more expensive higher-progress mutant still wins", () => {
    const winner = selectWinner(control, all, [
      verification(control.id, {
        mandatoryPassed: true,
        hardProgress: 2,
        modelCalls: 1,
        actualInputTokens: 1,
        actualOutputTokens: 1,
        elapsedMs: 1,
      }),
      verification(context.id, {
        mandatoryPassed: true,
        hardProgress: 5,
        modelCalls: 20,
        actualInputTokens: 9_000,
        actualOutputTokens: 9_000,
        elapsedMs: 9_000,
      }),
      verification(strategy.id, {
        mandatoryPassed: true,
        hardProgress: 2,
        modelCalls: 1,
        actualInputTokens: 1,
        actualOutputTokens: 1,
        elapsedMs: 1,
      }),
    ]);
    expect(winner.id).toBe(context.id);
  });
});

describe("repair candidate horizon constants", () => {
  it("keeps the four-minute and 20-step equal horizon", () => {
    expect(REPAIR_CANDIDATE_TIMEOUT_MS).toBe(240_000);
    expect(REPAIR_CANDIDATE_STEP_CAP).toBe(20);
  });
});

function contract(): SubtaskContract {
  return {
    subtaskId: "backend",
    revision: 1,
    contractKey: "backend-producer",
    inputs: [],
    outputs: ["src/api.ts"],
    dependencyIds: [],
    downstreamConsumers: ["integration"],
    allowedMutationPaths: ["src/"],
    protectedPaths: [".launchpad"],
    artifactSchemaIds: [],
    targetedGateIds: ["targeted"],
    contractGateIds: ["contract"],
    consumerGateIds: ["consumer"],
    regressionGateIds: ["regression"],
    authorizedTools: ["read_file", "bash"],
  };
}

function nodeState(overrides: Partial<TaskNodeState> = {}): TaskNodeState {
  return {
    subtaskId: "backend",
    revision: 1,
    state: "failed",
    blockedBy: [],
    attemptId: "failed-attempt",
    faultId: "fault-1",
    diagnosisId: "diag-1",
    tournamentId: null,
    verificationIds: [],
    integrationContributionId: null,
    updatedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function faultRecord(): FaultRecord {
  return {
    id: "fault-1",
    subtaskId: "backend",
    revision: 1,
    class: "hard_failure",
    reasonCode: "tests_failed",
    summary: "Protected test failed.",
    repairable: true,
    evidenceRefs: ["snap-1"],
    affectedConsumers: ["integration"],
    detectedAt: "2026-08-29T00:00:00.000Z",
  };
}

function diagnosisRecord(): DiagnosisRecord {
  return {
    id: "diag-1",
    faultId: "fault-1",
    status: "available",
    classification: "context",
    rationale: "Missing interface.",
    allowedMutationFamilies: ["context_patch"],
    createdAt: "2026-08-29T00:00:00.000Z",
  };
}

function projectRecord(): ProjectRunRecord {
  return {
    source: {
      mode: "existing_repository",
      repositoryPath: "/repo",
      requestedRevision: null,
      baseCommit: "a".repeat(40),
      sourceFingerprint: "fp",
    },
    runBranch: "launchpad/run/run-1",
    canonicalWorkspacePath: "/repo",
    headCommit: "a".repeat(40),
    state: "ready",
    attempts: [failedAttempt()],
    integrations: [],
  };
}

function failedAttempt(): AttemptWorkspaceRecord {
  return {
    attemptId: "failed-attempt",
    revision: 1,
    ownerToken: "owner",
    subtaskId: "backend",
    baseCommit: "a".repeat(40),
    workspacePath: "/attempts/failed",
    state: "failed",
    cleanup: "preserved",
    headCommit: "b".repeat(40),
    reason: "tests failed",
    kind: "task",
    checkpointId: null,
  };
}

function checkpointRecord(): RepairCheckpoint {
  return {
    id: "chk-1",
    runId: "run-1",
    subtaskId: "backend",
    taskRevision: 1,
    sourceAttemptId: "failed-attempt",
    sourceAttemptRevision: 1,
    originalBaseCommit: "a".repeat(40),
    checkpointCommit: "b".repeat(40),
    treeHash: "c".repeat(40),
    contractHash: "d".repeat(64),
    authorityManifestHash: "auth",
    contextBundleHash: "bundle",
    contextEvidenceRefs: ["snap-1"],
    runtimeCapabilityHash: "runtime",
    allowedMutationPaths: ["src/"],
    protectedPaths: [".launchpad"],
    createdAt: "2026-08-29T00:00:00.000Z",
  };
}

function repairAttempt(id: string): AttemptWorkspaceRecord {
  return {
    attemptId: id,
    revision: 1,
    ownerToken: "repair-" + id,
    subtaskId: "backend",
    baseCommit: "a".repeat(40),
    workspacePath: "/attempts/" + id,
    state: "running",
    cleanup: "active",
    headCommit: "b".repeat(40),
    reason: null,
    kind: "repair",
    checkpointId: "chk-1",
  };
}

interface FakeHost {
  healing: HealingState;
  events: RunEventDraft[];
  freezeCalls: number;
  created: string[];
  runCalls: Array<{
    family: string;
    runtimeImageId: string | null;
    env: Record<string, string>;
    timeoutMs: number;
    stepCap: number;
    threadId: string | null;
    tools: string[];
  }>;
  verifyCalls: Array<{ subjectId: string; stage: string }>;
  settleCalls: ContributionRecord[];
  squashCalls: string[];
  control: RunControl;
  failFamilies: Set<string>;
  verifyPlan: (subjectId: string, stage: string) => Partial<VerificationResult>;
  settleResult: WorkerResult["status"];
  stopAfterFamily?: string;
  startedFamilies: string[];
}

function fakeHost(overrides: Partial<FakeHost> = {}): FakeHost & RepairTournamentDeps {
  const host: FakeHost = {
    healing: emptyHealingState(),
    events: [],
    freezeCalls: 0,
    created: [],
    runCalls: [],
    verifyCalls: [],
    settleCalls: [],
    squashCalls: [],
    control: new RunControl({ ...defaultExecutionPolicy, rootTimeoutMs: 60_000 }),
    failFamilies: new Set(),
    verifyPlan: (subjectId, stage) => ({
      mandatoryPassed: stage === "candidate" ||
        (subjectId.includes("context") && stage !== "pre_integration"),
      hardProgress: subjectId.includes("context") ? 6 : 2,
    }),
    settleResult: "completed",
    startedFamilies: [],
    ...overrides,
  };
  host.healing.nodes = [nodeState()];
  host.healing.faults = [faultRecord()];
  host.healing.diagnoses = [diagnosisRecord()];
  host.healing.contracts = [contract()];

  const deps: RepairTournamentDeps = {
    mutateHealing: async (mutate) => mutate(host.healing),
    withAuthorityLock: async (operation) => operation(),
    persistBoundCheckpoint: async () => undefined,
    freeze: async () => {
      host.freezeCalls += 1;
      return checkpointRecord();
    },
    createCandidate: async (input) => {
      if (host.created.length >= 3) throw new Error("unbounded createCandidate");
      host.created.push(input.candidate.delta.family);
      return repairAttempt(input.candidate.id);
    },
    squashWinner: async (input) => {
      host.squashCalls.push(input.candidate.id);
      return {
        contributionId: "contrib-winner",
        attemptId: input.attempt.attemptId,
        attemptRevision: input.attempt.revision,
        ownerFingerprint: "fp",
        subtaskId: "backend",
        baseCommit: input.checkpoint.originalBaseCommit,
        headCommit: "e".repeat(40),
        changedPaths: ["src/api.ts"],
        diffHash: "diff",
        verificationLevel: "structural",
        verificationIds: input.verificationIds,
      };
    },
    runCandidate: async (input) => {
      host.startedFamilies.push(input.candidate.delta.family);
      host.runCalls.push({
        family: input.candidate.delta.family,
        runtimeImageId: input.runtimeImageId,
        env: input.env,
        timeoutMs: input.timeoutMs,
        stepCap: input.stepCap,
        threadId: input.threadId,
        tools: input.tools,
      });
      if (host.stopAfterFamily === input.candidate.delta.family) {
        host.control.stop("emergency_token_fuse", "fuse");
      }
      host.control.assertActive();
      if (host.failFamilies.has(input.candidate.delta.family)) {
        return { status: "failed" as const, modelCalls: 1, reservedTokens: 10, actualInputTokens: 4, actualOutputTokens: 4, elapsedMs: 12 };
      }
      return { status: "completed" as const, modelCalls: 2, reservedTokens: 20, actualInputTokens: 8, actualOutputTokens: 8, elapsedMs: 15 };
    },
    verify: async (input) => {
      host.verifyCalls.push({ subjectId: input.subjectId, stage: input.stage });
      const scripted = host.verifyPlan(input.subjectId, input.stage);
      return {
        id: "ver-" + input.stage + "-" + input.subjectId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        stage: input.stage,
        authorityManifestHash: "auth",
        gates: [],
        failureKind: scripted.mandatoryPassed === false ? "deterministic_gate_failure" : null,
        mandatoryPassed: true,
        hardProgress: 4,
        regressionCount: 0,
        modelCalls: 0,
        reservedTokens: 0,
        actualInputTokens: 0,
        actualOutputTokens: 0,
        elapsedMs: 1,
        verifiedAt: "2026-08-29T00:00:00.000Z",
        ...scripted,
      };
    },
    settleContribution: async (contribution) => {
      host.settleCalls.push(contribution);
      return {
        subtaskId: "backend",
        workerId: "w",
        workerRunId: "wr",
        iteration: 1,
        attempt: 1,
        status: host.settleResult,
        output: "",
        error: host.settleResult === "completed" ? null : "integration_failed",
        usage: null,
        durationMs: 1,
        artifacts: [],
        contribution,
      };
    },
    loadProject: () => projectRecord(),
    loadAttempt: (id) =>
      id === "failed-attempt" ? failedAttempt() : repairAttempt(id),
    persistAttempt: async () => undefined,
    emit: (draft) => {
      host.events.push(draft);
    },
    authorityManifestHash: "auth",
    runtimeCapabilityHash: "runtime",
    contextEvidenceRefs: ["snap-1"],
  };
  return Object.assign(host, deps);
}

describe("RepairTournamentRunner candidate supervision", () => {
  it("durably binds the frozen checkpoint before any repair candidate runs", async () => {
    const host = fakeHost();
    let persistedFenceHash: string | null = null;
    (host as RepairTournamentDeps & {
      persistBoundCheckpoint(checkpoint: RepairCheckpoint): Promise<void>;
    }).persistBoundCheckpoint = async (checkpoint) => {
      persistedFenceHash = checkpoint.repairGraphFenceHash ?? null;
    };
    const innerRun = host.runCandidate;
    host.runCandidate = async (input) => {
      expect(persistedFenceHash).toBe(input.candidate.repairGraphFenceHash);
      return innerRun(input);
    };

    await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });

    expect(persistedFenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("holds a phase-aware graph fence through candidate work and clears it with terminal settlement", async () => {
    const host = fakeHost();
    const innerRun = host.runCandidate;
    host.runCandidate = async (input) => {
      expect(host.healing.repairGraphFence).toMatchObject({
        runId: "run-1",
        tournamentId: input.candidate.tournamentId,
        graphRevision: 1,
      });
      expect(host.healing.repairGraphFence?.graphHash).toMatch(/^[0-9a-f]{64}$/);
      expect((input.candidate as MutationCandidate & { repairGraphFenceHash?: string }).repairGraphFenceHash)
        .toMatch(/^[0-9a-f]{64}$/);
      return innerRun(input);
    };
    const innerSettle = host.settleContribution;
    host.settleContribution = async (contribution) => {
      expect((contribution as ContributionRecord & { repairGraphFenceHash?: string }).repairGraphFenceHash)
        .toMatch(/^[0-9a-f]{64}$/);
      return innerSettle(contribution);
    };

    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });

    expect(outcome.status).toBe("promoted");
    expect(host.healing.repairGraphFence).toBeNull();
  });

  it("refuses to admit a second tournament while another graph fence is active", async () => {
    const host = fakeHost();
    host.healing.repairGraphFence = {
      runId: "run-1",
      tournamentId: "other-tournament",
      graphRevision: 1,
      graphHash: "a".repeat(64),
      contractHashes: ["b".repeat(64)],
      admittedAt: "2026-08-31T00:00:00.000Z",
    };

    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });

    expect(outcome.tournament.failureReason).toBe("repair_graph_frozen");
    expect(host.freezeCalls).toBe(0);
    expect(host.healing.repairGraphFence?.tournamentId).toBe("other-tournament");
  });

  it("returns the authority-locked competing fence even when it clears immediately afterward", async () => {
    const host = fakeHost();
    host.refreshEvolutionHistory = async () => {
      host.healing.repairGraphFence = {
        runId: "run-1",
        tournamentId: "racing-tournament",
        graphRevision: 1,
        graphHash: "c".repeat(64),
        contractHashes: ["d".repeat(64)],
        admittedAt: "2026-08-31T00:00:00.000Z",
      };
    };
    const innerMutate = host.mutateHealing;
    host.mutateHealing = async (mutate) => {
      const result = await innerMutate(mutate);
      if (
        result && typeof result === "object" && "tournament" in result &&
        (result as { tournament: unknown }).tournament === null
      ) host.healing.repairGraphFence = null;
      return result;
    };

    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });

    expect(outcome.tournament.id).toBe("racing-tournament");
    expect(outcome.tournament.failureReason).toBe("repair_graph_frozen");
  });

  it("prunes three trusted exact negative repeats before workspace or runtime admission", async () => {
    const host = fakeHost();
    host.freeze = async () => ({
      ...checkpointRecord(),
      fingerprintSchemaVersion: 2,
      fingerprintComplete: true,
      repositoryBaseHash: "1".repeat(64),
      contractHash: "2".repeat(64),
      authorityManifestHash: "3".repeat(64),
      faultEvidenceHash: "4".repeat(64),
      runtimeCapabilityHash: "5".repeat(64),
      contextAuditEvidenceRefs: [],
    });
    host.projectId = "project-1";
    const queriedFamilies: MutationCandidate["delta"]["family"][] = [];
    host.exactRepeatIndex = {
      health: () => "ready",
      find: ({ candidateFamily }: { candidateFamily: MutationCandidate["delta"]["family"] }) => {
        queriedFamilies.push(candidateFamily);
        return {
          exactRepeatKey: "9".repeat(64),
          candidateNodeId: "8".repeat(64),
          candidateFamily,
          terminalObservationId: "7".repeat(64),
          verificationId: "historical-verification",
          verification: candidateFamily === "control" ? verification("historical-control", {
            authorityManifestHash: "3".repeat(64), mandatoryPassed: false,
            failureKind: "deterministic_gate_failure", hardProgress: 0, regressionCount: 0,
            gates: [{ gateId: "contract", tier: "contract", passed: false,
              evidenceRef: "4".repeat(64), failureFingerprint: "5".repeat(64) }],
          }) : null,
          evidenceRefs: ["6".repeat(64)],
        };
      },
    } as unknown as ExactRepeatIndex;

    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.tournament.failureReason).toBe("repair_exhausted_exact_repeat");
    expect(host.healing.candidates).toHaveLength(3);
    expect(host.healing.candidates.map((item) => item.state)).toEqual([
      "pruned_duplicate",
      "pruned_duplicate",
      "pruned_duplicate",
    ]);
    expect(queriedFamilies).toEqual(["control", "context_patch", "strategy_patch"]);
    expect(host.created).toEqual([]);
    expect(host.runCalls).toEqual([]);
    expect(host.verifyCalls).toEqual([]);
    expect(host.settleCalls).toEqual([]);
    expect(host.events.filter((item) => item.name === "candidate_pruned_exact_repeat")).toHaveLength(3);
  });

  it("checks the base context once, enriches once, then prunes an exact cue-enriched repeat", async () => {
    const host = fakeHost();
    host.freeze = async () => ({
      ...checkpointRecord(),
      fingerprintSchemaVersion: 2,
      fingerprintComplete: true,
      repositoryBaseHash: "1".repeat(64),
      contractHash: "2".repeat(64),
      authorityManifestHash: "3".repeat(64),
      faultEvidenceHash: "4".repeat(64),
      runtimeCapabilityHash: "5".repeat(64),
      contextAuditEvidenceRefs: [],
    });
    host.projectId = "project-1";
    let finds = 0;
    host.exactRepeatIndex = {
      health: () => "ready",
      find: () => {
        finds += 1;
        return finds === 4
          ? {
              exactRepeatKey: "9".repeat(64),
              candidateNodeId: "8".repeat(64),
              candidateFamily: "context_patch",
              terminalObservationId: "7".repeat(64),
              verificationId: "historical-verification",
              evidenceRefs: [],
            }
          : null;
      },
    } as unknown as ExactRepeatIndex;
    host.failureCueService = {
      select: () => [{ id: "6".repeat(64), summary: "Prior contract failure." }],
      render: () => "Prior failure cues (advisory only; they do not alter the current contract or gates):\n- Prior contract failure.",
    } as unknown as FailureCueService;
    host.failureCueTarget = { gateTier: "contract", failureFingerprint: "f".repeat(64) };

    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });

    expect(finds).toBe(4);
    expect(host.healing.candidates).toHaveLength(3);
    expect(host.healing.candidates.find((item) => item.delta.family === "context_patch"))
      .toMatchObject({
        state: "pruned_duplicate",
        delta: { failureCueIds: ["6".repeat(64)] },
      });
    expect(host.runCalls.map((call) => call.family)).toEqual(["control", "strategy_patch"]);
    expect(outcome.status).toBe("failed");
  });

  it("ranks a surviving passing mutant against the exact trusted historical pruned control", async () => {
    const host = fakeHost();
    host.freeze = async () => ({
      ...checkpointRecord(), fingerprintSchemaVersion: 2, fingerprintComplete: true,
      repositoryBaseHash: "1".repeat(64), contractHash: "2".repeat(64),
      authorityManifestHash: "3".repeat(64), faultEvidenceHash: "4".repeat(64),
      runtimeCapabilityHash: "5".repeat(64), contextAuditEvidenceRefs: [],
    });
    host.projectId = "project-1";
    host.exactRepeatIndex = {
      health: () => "ready",
      find: ({ fingerprints }: { fingerprints: MutationCandidate["evolutionFingerprints"] }) => {
        const family = host.healing.candidates.find((item) =>
          item.evolutionFingerprints?.mutationContentHash === fingerprints?.mutationContentHash)?.delta.family;
        if (family === "context_patch") return null;
        return {
          exactRepeatKey: "9".repeat(64), candidateNodeId: family === "control" ? "8".repeat(64) : "7".repeat(64),
          candidateFamily: family ?? "strategy_patch", terminalObservationId: "6".repeat(64),
          verificationId: "historical-" + family, evidenceRefs: [],
          verification: family === "control" ? verification("historical-control", {
            id: "historical-control-verification", stage: "candidate", mandatoryPassed: false,
            failureKind: "deterministic_gate_failure", hardProgress: 0, regressionCount: 0,
            authorityManifestHash: "3".repeat(64),
            gates: [{ gateId: "contract", tier: "contract", passed: false,
              evidenceRef: "4".repeat(64), failureFingerprint: "5".repeat(64) }],
          }) : null,
        };
      },
    } as unknown as ExactRepeatIndex;

    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1", node: nodeState(), contract: contract(), fault: faultRecord(),
      diagnosis: diagnosisRecord(), control: host.control,
    });

    expect(host.created).toEqual(["context_patch"]);
    expect(host.runCalls.map((call) => call.family)).toEqual(["context_patch"]);
    expect(outcome.status).toBe("promoted");
    expect(outcome.winner?.delta.family).toBe("context_patch");
  });

  it("records passive transfer only after all parallel candidates settle, including rejected context", async () => {
    const host = fakeHost({
      verifyPlan: (subjectId, stage) => {
        const family = subjectId.endsWith("-control") ? "control"
          : subjectId.endsWith("-context_patch") ? "context_patch" : "strategy_patch";
        const mandatoryPassed = family === "control" || (family === "context_patch" && stage === "candidate");
        return { mandatoryPassed, failureKind: mandatoryPassed ? null : "deterministic_gate_failure",
          hardProgress: family === "control" ? 5 : family === "context_patch" ? 3 : 0 };
      },
    });
    const originalRun = host.runCandidate;
    let releaseControl!: () => void;
    const controlGate = new Promise<void>((resolve) => { releaseControl = resolve; });
    const completionOrder: string[] = [];
    host.runCandidate = async (input) => {
      if (input.candidate.delta.family === "control") await controlGate;
      const result = await originalRun(input);
      completionOrder.push(input.candidate.delta.family);
      if (input.candidate.delta.family === "strategy_patch") releaseControl();
      return result;
    };
    let transferCalls = 0;
    host.recordPassiveTransfers = async () => {
      transferCalls += 1;
      expect(completionOrder[0]).toBe("context_patch");
      expect(host.healing.candidates.every((item) =>
        !["declared", "admitted", "running", "verifying"].includes(item.state))).toBe(true);
      expect(host.healing.candidates.find((item) => item.delta.family === "context_patch")?.state)
        .toBe("rejected");
    };

    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1", node: nodeState(), contract: contract(), fault: faultRecord(),
      diagnosis: diagnosisRecord(), control: host.control,
    });

    expect(transferCalls).toBe(1);
    expect(outcome.status).toBe("promoted");
    expect(outcome.winner?.delta.family).toBe("control");
  });

  it("invalidates stale pruning and cue authorities when history refresh throws", async () => {
    const host = fakeHost();
    let indexInvalidations = 0;
    let cueInvalidations = 0;
    host.exactRepeatIndex = {
      health: () => "ready",
      find: () => { throw new Error("stale index must not be queried"); },
      markUnavailable: () => { indexInvalidations += 1; },
    } as unknown as ExactRepeatIndex;
    host.failureCueService = {
      markUnavailable: () => { cueInvalidations += 1; },
    } as unknown as FailureCueService;
    host.projectId = "project-1";
    host.refreshEvolutionHistory = async () => { throw new Error("refresh failed"); };

    await new RepairTournamentRunner(host).run({
      runId: "run-1", node: nodeState(), contract: contract(), fault: faultRecord(),
      diagnosis: diagnosisRecord(), control: host.control,
    });

    expect(indexInvalidations).toBe(1);
    expect(cueInvalidations).toBe(1);
    expect(host.runCalls).toHaveLength(3);
    expect(host.events.filter((event) => event.name === "evolution_history_unavailable"))
      .toHaveLength(1);
  });

  it("carries the resolved container identity from policy to every candidate execution", async () => {
    const host = fakeHost();
    const digest = "sha256:" + "d".repeat(64);
    host.runtimeCapabilityManifest = {
      schemaVersion: 2,
      harnessVersion: "orchestration-1",
      repairPromptVersion: "repair-candidate-v1",
      diagnosisPromptVersion: "diagnoser-v1",
      modelId: "model-2026-08",
      runtimeMode: "container:app_server",
      toolSchemaHash: "1".repeat(64),
      excludedToolHash: "2".repeat(64),
      sandboxPolicyHash: "3".repeat(64),
      containerImageId: digest,
      timeoutMs: 240_000,
      stepCap: 20,
      rootResourceHorizonHash: "4".repeat(64),
    };

    await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });

    expect(host.runCalls).toHaveLength(3);
    expect(host.runCalls.map((call) => call.runtimeImageId)).toEqual([
      digest,
      digest,
      digest,
    ]);
  });

  it("admits exactly three candidates with fresh sessions and the four-minute/20-step horizon", async () => {
    const host = fakeHost();
    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });

    expect(host.created).toEqual(["control", "context_patch", "strategy_patch"]);
    expect(host.runCalls).toHaveLength(3);
    expect(host.runCalls.map((item) => item.family)).toEqual([
      "control",
      "context_patch",
      "strategy_patch",
    ]);
    for (const call of host.runCalls) {
      expect(call.timeoutMs).toBe(REPAIR_CANDIDATE_TIMEOUT_MS);
      expect(call.stepCap).toBe(REPAIR_CANDIDATE_STEP_CAP);
      expect(call.threadId).toBeNull();
      expect(call.env.LAUNCHPAD_REPAIR_CANDIDATE).toBe("1");
      expect(call.env.LAUNCHPAD_COORDINATION_URL ?? "").toBe("");
      expect(call.tools).not.toContain("dispatch_subagent");
      expect(call.tools).not.toContain("talk");
    }
    expect(host.healing.tournaments).toHaveLength(1);
    expect(host.healing.candidates).toHaveLength(3);
    expect(host.healing.nodes[0]?.state).toBe("completed");
    expect(host.events.filter((item) => item.name === "repair_tournament_started")).toHaveLength(1);
    expect(host.settleCalls).toHaveLength(1);
    expect(outcome.status).toBe("promoted");
    expect(outcome.winner?.delta.family).toBe("context_patch");
  });

  it("keeps a genuine deterministic candidate-gate failure comparable after exact finalist verification", async () => {
    const host = fakeHost({
      verifyPlan: (subjectId, stage) => {
        const isControl = subjectId.endsWith("-control");
        const isContext = subjectId.endsWith("-context_patch");
        if (stage === "candidate") {
          return {
            mandatoryPassed: isContext,
            failureKind: isContext ? null : "deterministic_gate_failure",
            hardProgress: isContext ? 2 : 0,
          };
        }
        return {
          mandatoryPassed: isControl || isContext,
          failureKind: isControl || isContext ? null : "deterministic_gate_failure",
          hardProgress: isControl ? 99 : isContext ? 6 : 0,
        };
      },
    });

    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });

    const persistedControl = host.healing.candidates.find(
      (item) => item.delta.family === "control",
    );
    const controlEvidence = host.healing.verifications.filter(
      (item) => item.subjectId === persistedControl?.id,
    );
    expect(controlEvidence.map((item) => [item.stage, item.mandatoryPassed, item.failureKind])).toEqual([
      ["candidate", false, "deterministic_gate_failure"],
      ["finalist", true, null],
    ]);
    expect(persistedControl).toMatchObject({ state: "rejected", terminalReason: null });
    expect(outcome).toMatchObject({ status: "promoted", winner: { delta: { family: "context_patch" } } });
  });

  it("defaults to control when candidate-stage authority failure precedes a passing finalist", async () => {
    const host = fakeHost({
      verifyPlan: (subjectId, stage) => {
        const isControl = subjectId.endsWith("-control");
        const isContext = subjectId.endsWith("-context_patch");
        if (stage === "candidate" && isControl) {
          return {
            mandatoryPassed: false,
            failureKind: "authority_failure",
            hardProgress: 0,
          };
        }
        const mandatoryPassed = isControl || isContext;
        return {
          mandatoryPassed,
          failureKind: mandatoryPassed ? null : "deterministic_gate_failure",
          hardProgress: isControl ? 99 : isContext ? 6 : 0,
        };
      },
    });

    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });

    const persistedControl = host.healing.candidates.find(
      (item) => item.delta.family === "control",
    );
    const controlEvidence = host.healing.verifications.filter(
      (item) => item.subjectId === persistedControl?.id,
    );
    expect(controlEvidence.map((item) => [item.stage, item.mandatoryPassed, item.failureKind])).toEqual([
      ["candidate", false, "authority_failure"],
      ["finalist", true, null],
    ]);
    expect(persistedControl).toMatchObject({ state: "rejected", terminalReason: null });
    expect(outcome).toMatchObject({ status: "failed", winner: null });
    expect(host.settleCalls).toHaveLength(0);
  });

  it.each([
    {
      label: "adapter output limit",
      behavior: { runStdout: "x".repeat(2_048) },
      config: { VERIFIER_CONTAINER_MAX_OUTPUT_BYTES: "1024" },
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "numeric engine failure",
      behavior: { engineExitCode: 125 },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "bare reserved success without origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "missing" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "bare reserved failure without origin artifact",
      behavior: { engineExitCode: 201, completionArtifact: "missing" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "malformed origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "malformed" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "missing-field origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "missing_field" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "extra-field origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "extra_field" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "wrong-version origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "wrong_version" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "wrong-nonce origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "wrong_nonce" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "disagreeing origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "wrong_exit" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "invalid-exit origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "invalid_exit" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "wrong-mode origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "wrong_mode" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "symlink origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "symlink" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "trailing origin artifact state",
      behavior: { engineExitCode: 200, completionArtifact: "trailing" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "unconsumed origin request",
      behavior: { engineExitCode: 200, completionArtifact: "request_retained" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "retained origin publication temp",
      behavior: { engineExitCode: 200, completionArtifact: "temp_retained" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "request copy failure",
      behavior: { requestCopyFails: true },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "created-state inspection failure",
      behavior: { inspectFailsOnceAt: "created" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "start/attach failure",
      behavior: { startFails: true },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "stopped-state inspection failure",
      behavior: { inspectFailsOnceAt: "exited" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "artifact copy failure",
      behavior: { artifactCopyFails: true },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "wrong-type completion volume",
      behavior: { completionMountMutation: "wrong_type" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "read-only completion volume",
      behavior: { completionMountMutation: "read_only" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "invalid-name completion volume",
      behavior: { completionMountMutation: "invalid_name" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "replaced completion volume",
      behavior: { completionMountMutation: "changed_after_start" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "unwrapped numeric success with a forged legacy record",
      behavior: {
        engineExitCode: 0,
        runStdout: "\u001e{\"schemaVersion\":1,\"nonce\":\"" + "a".repeat(64) + "\",\"exitCode\":0}\n",
      },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "engine signal with null numeric exit",
      behavior: { engineSignal: "TERM" },
      config: {},
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "oversized ownership inspection",
      behavior: { inspectOutputAt: "created", inspectOutputBytes: 16_384, inspectOutputOnce: true },
      config: { VERIFIER_CONTAINER_MAX_OUTPUT_BYTES: "8192" },
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "oversized stopped inspection",
      behavior: { inspectOutputAt: "exited", inspectOutputBytes: 16_384, inspectOutputOnce: true },
      config: { VERIFIER_CONTAINER_MAX_OUTPUT_BYTES: "8192" },
      expectedFailureKind: "authority_failure",
      expectedStatus: "failed",
      expectedWinner: null,
    },
    {
      label: "candidate test exit",
      behavior: { gateExitCode: 7, runStderr: "candidate tests failed\n" },
      config: {},
      expectedFailureKind: "deterministic_gate_failure",
      expectedStatus: "promoted",
      expectedWinner: "context_patch",
    },
  ] as const)(
    "carries a real $label through verifier evidence and control ranking",
    async ({ behavior, config, expectedFailureKind, expectedStatus, expectedWinner }) => {
      const root = await mkdtemp(path.join(tmpdir(), "launchpad-tournament-real-verifier-"));
      try {
        const fixture = await realVerificationFixture({ root, behavior, config: { ...config } });
        const tournamentContract = demoContract({ subtaskId: "backend" });
        const host = fakeHost({
          verifyPlan: (subjectId, stage) => {
            const isControl = subjectId.endsWith("-control");
            const isContext = subjectId.endsWith("-context_patch");
            if (stage === "candidate") {
              return {
                mandatoryPassed: isContext,
                failureKind: isContext ? null : "deterministic_gate_failure",
                hardProgress: isContext ? 2 : 0,
              };
            }
            const mandatoryPassed = isControl || isContext;
            return {
              mandatoryPassed,
              failureKind: mandatoryPassed ? null : "deterministic_gate_failure",
              hardProgress: isControl ? 99 : isContext ? 6 : 0,
            };
          },
        });
        const scriptedVerify = host.verify;
        host.verify = async (input) => {
          if (input.stage === "candidate" && input.subjectId.endsWith("-control")) {
            return fixture.runner.verify({
              ...input,
              workspacePath: fixture.workspace,
              baseCommit: fixture.baseCommit,
              contract: tournamentContract,
            });
          }
          return scriptedVerify(input);
        };

        const outcome = await new RepairTournamentRunner(host).run({
          runId: "run-1",
          node: nodeState(),
          contract: tournamentContract,
          fault: faultRecord(),
          diagnosis: diagnosisRecord(),
          control: host.control,
        });

        const persistedControl = host.healing.candidates.find(
          (item) => item.delta.family === "control",
        );
        const controlEvidence = host.healing.verifications.filter(
          (item) => item.subjectId === persistedControl?.id,
        );
        expect(controlEvidence.map((item) => [item.stage, item.mandatoryPassed, item.failureKind])).toEqual([
          ["candidate", false, expectedFailureKind],
          ["finalist", true, null],
        ]);
        expect(outcome.status).toBe(expectedStatus);
        expect(outcome.winner?.delta.family ?? null).toBe(expectedWinner);
        expect(host.settleCalls).toHaveLength(expectedStatus === "promoted" ? 1 : 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("cancels remaining candidates and starts none later when the root fuse fires", async () => {
    const host = fakeHost({ stopAfterFamily: "control" });
    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });
    expect(host.startedFamilies).toEqual(["control"]);
    expect(host.created.length).toBeLessThanOrEqual(3);
    expect(outcome.status).toBe("cancelled");
    expect(host.settleCalls).toHaveLength(0);
    expect(host.healing.tournaments[0]?.status).toBe("cancelled");
  });

  it("does not replace an ordinary candidate failure or start a second tournament", async () => {
    const host = fakeHost({
      failFamilies: new Set(["control", "context_patch", "strategy_patch"]),
      verifyPlan: () => ({ mandatoryPassed: false, hardProgress: 0 }),
    });
    const runner = new RepairTournamentRunner(host);
    const input = {
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    };
    const first = await runner.run(input);
    expect(first.status).toBe("failed");
    expect(host.runCalls).toHaveLength(3);
    expect(host.settleCalls).toHaveLength(0);
    const second = await runner.run(input);
    expect(second.status).toBe("failed");
    expect(host.freezeCalls).toBe(1);
    expect(host.runCalls).toHaveLength(3);
    expect(host.healing.tournaments).toHaveLength(1);
  });

  it("emits repair_tournament_started only after persisting the tournament and repairing node", async () => {
    const order: string[] = [];
    const host = fakeHost();
    const innerMutate = host.mutateHealing;
    host.mutateHealing = async (mutate) => {
      const result = await innerMutate(mutate);
      if (host.healing.nodes[0]?.state === "repairing" && host.healing.tournaments.length === 1) {
        order.push("persisted-repairing");
      }
      return result;
    };
    const innerEmit = host.emit;
    host.emit = (draft) => {
      if (draft.name === "repair_tournament_started") order.push("emitted-start");
      innerEmit(draft);
    };
    await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });
    expect(order.slice(0, 2)).toEqual(["persisted-repairing", "emitted-start"]);
  });

  it.each([
    "user_cancelled",
    "root_deadline",
    "emergency_token_fuse",
  ] as const)("keeps %s terminal when verification is interrupted", async (reason) => {
    const host = fakeHost({
      verifyPlan: () => {
        host.control.stop(reason, "terminal during verification");
        return { mandatoryPassed: true, hardProgress: 6 };
      },
    });
    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });
    expect(outcome.status).toBe("cancelled");
    expect(host.settleCalls).toHaveLength(0);
    expect(host.healing.tournaments[0]?.status).toBe("cancelled");
  });

  it("cancels the tournament when integration is interrupted by root control", async () => {
    const host = fakeHost();
    host.settleContribution = async () => {
      throw host.control.stop("user_cancelled", "cancelled during integration");
    };
    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });
    expect(outcome.status).toBe("cancelled");
    expect(host.healing.tournaments[0]?.status).toBe("cancelled");
  });

  it("rejects a candidate whose output carries a malformed commit marker", async () => {
    const host = fakeHost({ failFamilies: new Set(["control", "strategy_patch"]) });
    const innerRun = host.runCandidate;
    host.runCandidate = async (input) => {
      const result = await innerRun(input);
      if (input.candidate.delta.family === "context_patch") {
        return { ...result, output: "patched\nLAUNCHPAD_COMMIT=not-a-sha\n" };
      }
      return result;
    };
    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });
    expect(outcome.status).toBe("failed");
    expect(host.settleCalls).toHaveLength(0);
    expect(host.healing.candidates.find((item) => item.delta.family === "context_patch")?.state)
      .toMatch(/rejected|failed/);
  });

  it("routes the winner through settleContribution and does not promote when post-gate settlement fails", async () => {
    const host = fakeHost({ settleResult: "failed" });
    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });
    expect(host.squashCalls).toHaveLength(1);
    expect(host.settleCalls).toHaveLength(1);
    expect(outcome.status).toBe("failed");
    expect(host.healing.candidates.find((item) => item.delta.family === "context_patch")?.state).toBe(
      "rolled_back",
    );
    expect(host.healing.tournaments[0]?.status).toBe("rolled_back");
    expect(host.healing.nodes[0]?.state).toBe("failed");
  });

  it("passes the winner contribution to branch recording and keeps recording failure advisory", async () => {
    const host = fakeHost({ settleResult: "failed" });
    const calls: Array<{ checkpointId: string; tournamentId: string; contribution: ContributionRecord | null }> = [];
    host.recordBranchReturns = async (checkpoint, tournamentId, contribution) => {
      calls.push({ checkpointId: checkpoint.id, tournamentId, contribution });
      if (contribution !== null) throw new Error("evolution store unavailable");
    };

    const outcome = await new RepairTournamentRunner(host).run({
      runId: "run-1",
      node: nodeState(),
      contract: contract(),
      fault: faultRecord(),
      diagnosis: diagnosisRecord(),
      control: host.control,
    });

    expect(outcome.status).toBe("failed");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ checkpointId: expect.any(String), contribution: null });
    expect(calls[1]!.tournamentId).toBe(calls[0]!.tournamentId);
    expect(calls[1]!.contribution).toMatchObject({
      contributionId: host.settleCalls[0]!.contributionId,
      attemptId: host.healing.candidates.find((candidate) => candidate.state === "rolled_back")!.attemptId,
    });
    expect(host.healing.tournaments[0]?.status).toBe("rolled_back");
    expect(host.events.some((event) => event.name === "evolution_history_unavailable")).toBe(true);
  });
});
