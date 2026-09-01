import { describe, expect, it } from "vitest";
import {
  healingTransitionEvents,
  repairCandidateRunRecord,
} from "../src/orchestration/orchestrator.js";
import {
  emptyHealingState,
  type AgentRun,
  type HealingState,
  type MutationCandidate,
} from "../src/types.js";

function candidate(id: string, state: MutationCandidate["state"]): MutationCandidate {
  return {
    id,
    tournamentId: "tour-1",
    checkpointId: "checkpoint-1",
    delta: {
      family: "control",
      targetSubtaskId: "backend",
      diagnosisId: "diagnosis-1",
      addedEvidenceRefs: [],
      instructionPatch: "",
      toolRoute: [],
      expectedEffect: "repair",
      contentHash: "c".repeat(64),
    },
    state,
    attemptId: state === "declared" ? null : id,
    verificationIds: [],
    modelCalls: state === "declared" ? 0 : 1,
    reservedTokens: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    elapsedMs: 0,
    terminalReason: null,
  };
}

describe("healing lifecycle events", () => {
  it("persists repair execution as a restart-visible child AgentRun", () => {
    const parent = {
      id: "leader-run",
      agentId: "leader-agent",
      projectId: "project-1",
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "leader",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-29T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-29T00:00:00.000Z",
    } satisfies AgentRun;

    expect(repairCandidateRunRecord(
      parent,
      "candidate-run",
      "repair candidate prompt",
      "2026-08-29T00:00:01.000Z",
    )).toEqual({
      id: "candidate-run",
      agentId: "leader-agent",
      projectId: "project-1",
      kind: "subtask",
      parentRunId: "leader-run",
      orchestration: null,
      status: "running",
      prompt: "repair candidate prompt",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-29T00:00:01.000Z",
      completedAt: null,
      createdAt: "2026-08-29T00:00:01.000Z",
    });
  });

  it("derives truthful lifecycle events from persisted transitions without counting declarations as execution", () => {
    const before = emptyHealingState();
    before.nodes.push({
      subtaskId: "backend",
      revision: 1,
      state: "running",
      blockedBy: [],
      attemptId: "attempt-1",
      faultId: null,
      diagnosisId: null,
      tournamentId: null,
      verificationIds: [],
      integrationContributionId: null,
      updatedAt: "2026-08-29T00:00:00.000Z",
    });
    before.nodes.push({
      subtaskId: "consumer",
      revision: 1,
      state: "ready",
      blockedBy: [],
      attemptId: null,
      faultId: null,
      diagnosisId: null,
      tournamentId: null,
      verificationIds: [],
      integrationContributionId: null,
      updatedAt: "2026-08-29T00:00:00.000Z",
    });
    const after: HealingState = structuredClone(before);
    after.faults.push({
      id: "fault-1",
      subtaskId: "backend",
      revision: 1,
      class: "hard_failure",
      reasonCode: "fixture",
      summary: "failure",
      repairable: true,
      evidenceRefs: ["evidence-1"],
      affectedConsumers: ["consumer"],
      detectedAt: "2026-08-29T00:00:01.000Z",
    });
    after.nodes[0]!.faultId = "fault-1";
    after.nodes[0]!.diagnosisId = "diagnosis-1";
    after.nodes[0]!.state = "repairing";
    after.nodes[0]!.tournamentId = "tour-1";
    after.nodes[1]!.state = "blocked";
    after.nodes[1]!.blockedBy = ["backend"];
    after.diagnoses.push({
      id: "diagnosis-1",
      faultId: "fault-1",
      status: "available",
      classification: "context",
      rationale: "fixture",
      allowedMutationFamilies: ["control"],
      createdAt: "2026-08-29T00:00:02.000Z",
    });
    after.candidates.push(candidate("declared-only", "declared"), candidate("executed", "running"));
    after.tournaments.push({
      id: "tour-1",
      subtaskId: "backend",
      revision: 1,
      checkpointId: "checkpoint-1",
      candidateIds: ["declared-only", "executed", "missing"],
      status: "running",
      winnerCandidateId: null,
      failureReason: null,
      startedAt: "2026-08-29T00:00:03.000Z",
      completedAt: null,
    });
    after.verifications.push({
      id: "verification-1",
      subjectType: "candidate",
      subjectId: "executed",
      stage: "candidate",
      authorityManifestHash: "a".repeat(64),
      gates: [],
      failureKind: null,
      mandatoryPassed: true,
      hardProgress: 1,
      regressionCount: 0,
      modelCalls: 1,
      reservedTokens: 0,
      actualInputTokens: 1,
      actualOutputTokens: 1,
      elapsedMs: 1,
      verifiedAt: "2026-08-29T00:00:04.000Z",
    });
    after.budget = {
      advisoryTokens: 1,
      severeTokens: 2,
      advisoryModelCalls: 1,
      severeModelCalls: 2,
      emergencyTokenFuse: 10,
      emergencyModelCallFuse: 10,
      usedModelCalls: 1,
      reservedTokens: 1,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      estimatedDollars: null,
      warningLevel: "advisory",
      deadlineAt: "2026-08-29T01:00:00.000Z",
      terminalReason: "user_cancelled",
    };

    const events = healingTransitionEvents(before, after);
    expect(events.map((event) => event.name)).toEqual([
      "fault_detected",
      "diagnosis_started",
      "diagnosis_completed",
      "checkpoint_created",
      "candidate_declared",
      "candidate_declared",
      "candidate_started",
      "verification_passed",
      "dependency_blocked",
      "budget_warning",
      "terminal_denied",
    ]);
    expect(events.filter((event) => event.name === "candidate_started")).toHaveLength(1);
    expect(events.find((event) => (
      event.name === "candidate_declared"
      && event.attributes?.candidateId === "declared-only"
    ))?.attributes).toMatchObject({ executed: false });
    expect(events.find((event) => event.name === "candidate_started")?.attributes)
      .toMatchObject({ candidateId: "executed" });
  });

  it("emits checkpoint failure without claiming that a tournament started", () => {
    const before = emptyHealingState();
    before.nodes.push({
      subtaskId: "backend",
      revision: 1,
      state: "failed",
      blockedBy: [],
      attemptId: "attempt-1",
      faultId: "fault-1",
      diagnosisId: "diagnosis-1",
      tournamentId: null,
      verificationIds: [],
      integrationContributionId: null,
      updatedAt: "2026-08-29T00:00:00.000Z",
    });
    const after = structuredClone(before);

    const events = healingTransitionEvents(before, after, {
      checkpointFailure: { subtaskId: "backend", reason: "checkpoint_unavailable" },
    });
    expect(events.map((event) => event.name)).toEqual(["checkpoint_failed"]);
    expect(events.some((event) => event.name === "repair_tournament_started")).toBe(false);
  });

  it("publishes candidate stop, unavailable diagnosis, promotion, rollback, and dependency resume transitions", () => {
    const before = emptyHealingState();
    before.nodes.push({
      subtaskId: "consumer",
      revision: 1,
      state: "blocked",
      blockedBy: ["backend"],
      attemptId: null,
      faultId: null,
      diagnosisId: null,
      tournamentId: null,
      verificationIds: [],
      integrationContributionId: null,
      updatedAt: "2026-08-29T00:00:00.000Z",
    });
    before.candidates.push(candidate("executed", "running"));
    before.tournaments.push({
      id: "tour-1",
      subtaskId: "backend",
      revision: 1,
      checkpointId: "checkpoint-1",
      candidateIds: ["executed", "missing-1", "missing-2"],
      status: "running",
      winnerCandidateId: null,
      failureReason: null,
      startedAt: "2026-08-29T00:00:00.000Z",
      completedAt: null,
    });
    const stopped = structuredClone(before);
    stopped.nodes[0]!.state = "ready";
    stopped.nodes[0]!.blockedBy = [];
    stopped.candidates[0]!.state = "verifying";
    stopped.diagnoses.push({
      id: "diagnosis-unavailable",
      faultId: "fault-missing",
      status: "unavailable",
      classification: "",
      rationale: "",
      allowedMutationFamilies: [],
      createdAt: "2026-08-29T00:00:01.000Z",
    });
    stopped.tournaments[0]!.status = "promotion_pending";
    stopped.tournaments[0]!.winnerCandidateId = "executed";

    expect(healingTransitionEvents(before, stopped).map((event) => event.name)).toEqual([
      "diagnosis_unavailable",
      "candidate_stopped",
      "promotion_pending",
      "dependency_resumed",
    ]);

    const promoted = structuredClone(stopped);
    promoted.tournaments[0]!.status = "promoted";
    expect(healingTransitionEvents(stopped, promoted).map((event) => event.name)).toEqual([
      "promoted",
    ]);

    const rolledBack = structuredClone(stopped);
    rolledBack.tournaments[0]!.status = "rolled_back";
    rolledBack.tournaments[0]!.failureReason = "post_integration_failed";
    expect(healingTransitionEvents(stopped, rolledBack).map((event) => event.name)).toEqual([
      "rollback",
    ]);

    const admitted = structuredClone(before);
    admitted.candidates[0]!.state = "admitted";
    expect(healingTransitionEvents(before, admitted).map((event) => event.name)).toEqual([
      "candidate_admitted",
    ]);
  });
});
