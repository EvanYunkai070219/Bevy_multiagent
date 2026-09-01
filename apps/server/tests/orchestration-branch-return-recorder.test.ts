import { describe, expect, it } from "vitest";
import type {
  IntegrationRecord,
  ContributionRecord,
  MutationCandidate,
  RepairCheckpoint,
  RepairTournament,
  VerificationResult,
} from "../src/types.js";
import { createBranchReturn } from "../src/orchestration/healing/branch-return-recorder.js";
import { canonicalHash } from "../src/orchestration/evolution/evolution-fingerprints.js";
import {
  normalizeEvolutionOutboxEntry,
  type LineageNode,
} from "../src/orchestration/evolution/evolution-types.js";

const hash = (value: string) => canonicalHash({ value });
const createdAt = "2026-08-31T00:00:00.000Z";

function candidate(state: MutationCandidate["state"] = "rejected"): MutationCandidate {
  const mutationContentHash = hash("mutation");
  return {
    id: "tournament-1-context_patch",
    tournamentId: "tournament-1",
    checkpointId: "checkpoint-1",
    delta: {
      family: "context_patch",
      targetSubtaskId: "backend",
      diagnosisId: "diagnosis-1",
      addedEvidenceRefs: [],
      failureCueIds: [],
      instructionPatch: "Use the bounded context.",
      toolRoute: ["read_file"],
      expectedEffect: "repair the contract failure",
      contentHash: mutationContentHash,
    },
    state,
    attemptId: "candidate-run-1",
    verificationIds: ["verification-1"],
    modelCalls: 1,
    reservedTokens: 100,
    actualInputTokens: 30,
    actualOutputTokens: 20,
    elapsedMs: 40,
    terminalReason: state === "rejected" ? "no_evidence_progress" : null,
    historicalMatchRecordId: null,
    historicalVerificationId: null,
    evolutionFingerprints: {
      schemaVersion: 2,
      complete: true,
      repositoryBaseHash: hash("repository"),
      contractHash: hash("contract"),
      authorityManifestHash: hash("authority"),
      runtimeCapabilityHash: hash("runtime"),
      faultEvidenceHash: hash("fault"),
      mutationContentHash,
    },
    repairGraphFenceHash: hash("fence"),
  };
}

function tournament(): RepairTournament {
  return {
    id: "tournament-1",
    subtaskId: "backend",
    revision: 1,
    checkpointId: "checkpoint-1",
    candidateIds: [
      "tournament-1-control",
      "tournament-1-context_patch",
      "tournament-1-strategy_patch",
    ],
    status: "failed",
    winnerCandidateId: null,
    failureReason: "no_passing_candidate",
    startedAt: createdAt,
    completedAt: createdAt,
    repairGraphFenceHash: hash("fence"),
  };
}

function checkpoint(): RepairCheckpoint {
  return {
    id: "checkpoint-1",
    runId: "run-1",
    subtaskId: "backend",
    taskRevision: 1,
    sourceAttemptId: "attempt-1",
    sourceAttemptRevision: 1,
    originalBaseCommit: "a".repeat(40),
    checkpointCommit: "b".repeat(40),
    treeHash: hash("tree"),
    fingerprintSchemaVersion: 2,
    fingerprintComplete: true,
    repositoryBaseHash: hash("repository"),
    contractHash: hash("contract"),
    authorityManifestHash: hash("authority"),
    contextBundleHash: hash("context"),
    faultEvidenceHash: hash("fault"),
    contextEvidenceRefs: [hash("evidence-1")],
    contextAuditEvidenceRefs: [hash("audit")],
    runtimeCapabilityHash: hash("runtime"),
    allowedMutationPaths: ["apps/server"],
    protectedPaths: [".github"],
    createdAt,
    repairGraphFenceHash: hash("fence"),
  };
}

function node(kind: "attempt" | "candidate"): LineageNode {
  return {
    id: hash(kind),
    projectId: "project-1",
    sourceFingerprint: hash("source"),
    runId: "run-1",
    subtaskId: "backend",
    kind,
    entityId: kind === "candidate" ? "tournament-1-context_patch" : "attempt-1",
    revision: 1,
    harnessVersionHash: hash("runtime"),
    baseCommit: "a".repeat(40),
    headCommit: kind === "attempt" ? "b".repeat(40) : null,
    faultId: "fault-1",
    fingerprints: kind === "candidate" ? candidate().evolutionFingerprints : null,
    verificationIds: kind === "candidate" ? ["verification-1"] : [],
    evidenceRefs: [],
    changedPaths: [],
    createdAt,
  };
}

function verification(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    id: "verification-1",
    subjectType: "candidate",
    subjectId: "tournament-1-context_patch",
    stage: "candidate",
    authorityManifestHash: hash("authority"),
    gates: [{
      gateId: "contract",
      tier: "contract",
      passed: false,
      evidenceRef: hash("evidence-1"),
      failureFingerprint: hash("failure"),
    }],
    failureKind: "deterministic_gate_failure",
    mandatoryPassed: false,
    hardProgress: 0,
    regressionCount: 0,
    modelCalls: 0,
    reservedTokens: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    elapsedMs: 1,
    verifiedAt: createdAt,
    repairGraphFenceHash: hash("fence"),
    ...overrides,
  };
}

function integration(): IntegrationRecord {
  return {
    contributionId: "contribution-1",
    subtaskId: "backend",
    canonicalHeadBefore: "a".repeat(40),
    canonicalHeadAfter: "a".repeat(40),
    state: "rolled_back",
    structuralDecision: { allowed: true, reason: null },
    reason: "post_integration_verification_failed",
    verificationIds: ["verification-1"],
    repairGraphFenceHash: hash("fence"),
  };
}

function contribution(): ContributionRecord {
  return {
    contributionId: "contribution-1",
    attemptId: "candidate-run-1",
    attemptRevision: 1,
    ownerFingerprint: hash("owner"),
    subtaskId: "backend",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    changedPaths: ["apps/server/index.ts"],
    diffHash: hash("diff"),
    verificationLevel: "structural",
    verificationIds: ["verification-1"],
    repairGraphFenceHash: hash("fence"),
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-1",
    runId: "run-1",
    tournament: tournament(),
    checkpoint: checkpoint(),
    candidate: candidate(),
    candidateNode: node("candidate"),
    checkpointNode: node("attempt"),
    stopReason: "no_evidence_progress",
    verification: null,
    integration: null,
    contribution: null,
    summary: "  No evidence   progress after the bounded continuation.  ",
    evidenceRefs: [hash("evidence-3"), hash("evidence-1"), hash("evidence-2"), hash("evidence-1")],
    createdAt,
    ...overrides,
  };
}

describe("createBranchReturn", () => {
  it("constructs deterministic bounded records with exact fence and checkpoint ownership", () => {
    const first = createBranchReturn(input());
    const second = createBranchReturn(input());

    expect(first).toEqual(second);
    expect(first.map((record) => record.type)).toEqual([
      "capsule", "branch_return", "observation", "edge",
    ]);
    const capsule = first.find((record) => record.type === "capsule")!.value;
    expect(capsule).toMatchObject({
      projectId: "project-1",
      runId: "run-1",
      tournamentId: "tournament-1",
      candidateId: "tournament-1-context_patch",
      candidateFamily: "context_patch",
      mutationContentHash: hash("mutation"),
      repairGraphFenceHash: hash("fence"),
      returnCheckpointId: "checkpoint-1",
      stopReason: "no_evidence_progress",
      summary: "No evidence progress after the bounded continuation.",
      evidenceRefs: [hash("evidence-1"), hash("evidence-2"), hash("evidence-3")].sort(),
    });
    const returned = first.find((record) => record.type === "branch_return")!.value;
    expect(returned).toMatchObject({
      projectId: "project-1",
      runId: "run-1",
      candidateNodeId: hash("candidate"),
      checkpointNodeId: hash("attempt"),
      capsuleId: capsule.id,
    });
    expect(first.find((record) => record.type === "observation")!.value)
      .toMatchObject({ nodeId: hash("candidate"), kind: "branch_pruned" });
    expect(first.find((record) => record.type === "edge")!.value)
      .toMatchObject({ fromNodeId: hash("candidate"), toNodeId: hash("attempt"), kind: "returned_to" });

    const outbox = {
      id: hash("outbox"), projectId: "project-1", runId: "run-1", records: first,
      state: "pending" as const, createdAt, deliveredAt: null, lastErrorCode: null,
    };
    expect(normalizeEvolutionOutboxEntry(outbox).records).toEqual(first);
    expect(() => normalizeEvolutionOutboxEntry({
      ...outbox,
      records: first.map((record) => record.type === "capsule"
        ? { ...record, value: { ...record.value, id: hash("forged-capsule") } }
        : record),
    })).toThrow(/content hash/i);
    expect(() => normalizeEvolutionOutboxEntry({
      ...outbox,
      records: first.map((record) => record.type === "branch_return"
        ? { ...record, value: { ...record.value, id: hash("forged-return") } }
        : record),
    })).toThrow(/content hash/i);
  });

  it("normalizes summaries to 512 characters and rejects raw traces or private paths", () => {
    const records = createBranchReturn(input({ summary: "x".repeat(600) }));
    expect(records.find((record) => record.type === "capsule")!.value.summary).toHaveLength(512);

    for (const summary of [
      "Traceback (most recent call last):\n  File /private/worktree/worker.py",
      "raw trace: at worker (/Users/alice/project/worker.ts:1:1)",
      "read file:///home/alice/private/result.json",
      "authority token=secret-value",
    ]) {
      expect(() => createBranchReturn(input({ summary }))).toThrow(/summary/i);
    }
  });

  it("authorizes exactly the three bounded M2 terminal decisions", () => {
    const protectedRecords = createBranchReturn(input({
      stopReason: "protected_rejection",
      candidate: { ...candidate(), terminalReason: "deterministic_gate_failure" },
      verification: verification(),
    }));
    expect(protectedRecords.find((record) => record.type === "capsule")!.value.stopReason)
      .toBe("protected_rejection");

    const rolledBack = candidate("rolled_back");
    const rollbackRecords = createBranchReturn(input({
      stopReason: "verified_rollback",
      tournament: { ...tournament(), status: "rolled_back", winnerCandidateId: rolledBack.id },
      candidate: rolledBack,
      candidateNode: { ...node("candidate"), fingerprints: rolledBack.evolutionFingerprints },
      verification: verification({
        subjectType: "contribution",
        subjectId: "contribution-1",
        stage: "post_integration",
        mandatoryPassed: false,
        failureKind: "deterministic_gate_failure",
        gates: [{
          gateId: "contract",
          tier: "contract",
          passed: false,
          evidenceRef: hash("evidence-1"),
          failureFingerprint: hash("post-failure"),
        }],
      }),
      integration: integration(),
      contribution: contribution(),
    }));
    expect(rollbackRecords.find((record) => record.type === "capsule")!.value.stopReason)
      .toBe("verified_rollback");

    for (const stopReason of [
      "cancelled", "deadline", "provider_failure", "infrastructure_failure", "authority_failure",
    ]) {
      expect(() => createBranchReturn(input({ stopReason }))).toThrow(/authorized|reason/i);
    }
  });

  it("fails closed on owner, fence, checkpoint, and decision mismatches", () => {
    expect(() => createBranchReturn(input({ projectId: "project-2" }))).toThrow(/project/i);
    expect(() => createBranchReturn(input({
      candidate: { ...candidate(), checkpointId: "checkpoint-other" },
    }))).toThrow(/checkpoint/i);
    expect(() => createBranchReturn(input({
      candidate: { ...candidate(), repairGraphFenceHash: hash("other-fence") },
    }))).toThrow(/fence/i);
    expect(() => createBranchReturn(input({
      stopReason: "protected_rejection",
      verification: verification({ failureKind: "authority_failure" }),
    }))).toThrow(/authorized|verification/i);
    expect(() => createBranchReturn(input({
      stopReason: "protected_rejection",
      candidate: { ...candidate(), terminalReason: null },
      verification: verification(),
    }))).toThrow(/terminal|authorized|verification/i);
    expect(() => createBranchReturn(input({
      stopReason: "verified_rollback",
      tournament: {
        ...tournament(), status: "rolled_back", winnerCandidateId: "tournament-1-context_patch",
      },
      candidate: candidate("rolled_back"),
      verification: verification({
        subjectType: "contribution",
        subjectId: "contribution-1",
        stage: "post_integration",
      }),
      integration: { ...integration(), reason: "integration_conflict" },
      contribution: contribution(),
    }))).toThrow(/authorized|rollback/i);
    for (const verificationOverride of [
      { subjectId: "other-contribution" },
      { stage: "finalist" as const },
      { mandatoryPassed: true },
      { failureKind: "authority_failure" as const },
    ]) {
      expect(() => createBranchReturn(input({
        stopReason: "verified_rollback",
        tournament: {
          ...tournament(), status: "rolled_back", winnerCandidateId: "tournament-1-context_patch",
        },
        candidate: candidate("rolled_back"),
        verification: verification({
          subjectType: "contribution",
          subjectId: "contribution-1",
          stage: "post_integration",
          ...verificationOverride,
        }),
        integration: integration(),
        contribution: contribution(),
      }))).toThrow(/authorized|rollback/i);
    }
    expect(() => createBranchReturn(input({
      stopReason: "verified_rollback",
      candidate: candidate("rolled_back"),
      tournament: { ...tournament(), status: "rolled_back", winnerCandidateId: "tournament-1-control" },
      verification: verification({
        subjectType: "contribution",
        subjectId: "contribution-1",
        stage: "post_integration",
      }),
      integration: integration(),
      contribution: contribution(),
    }))).toThrow(/authorized|rollback/i);
    expect(() => createBranchReturn(input({
      stopReason: "verified_rollback",
      candidate: candidate("rolled_back"),
      tournament: {
        ...tournament(), status: "rolled_back", winnerCandidateId: "tournament-1-context_patch",
      },
      verification: verification({
        subjectType: "contribution", subjectId: "contribution-1", stage: "post_integration",
      }),
      integration: integration(),
      contribution: { ...contribution(), attemptId: "sibling-candidate-run" },
    }))).toThrow(/contribution|attempt|authorized|rollback/i);
    expect(() => createBranchReturn(input({
      checkpoint: { ...checkpoint(), sourceAttemptId: "sibling-attempt" },
    }))).toThrow(/checkpoint|attempt/i);
    expect(() => createBranchReturn(input({
      checkpointNode: { ...node("attempt"), entityId: "sibling-attempt" },
    }))).toThrow(/checkpoint|attempt/i);
    expect(() => createBranchReturn(input({
      checkpoint: { ...checkpoint(), taskRevision: 2 },
    }))).toThrow(/checkpoint|revision/i);
    expect(() => createBranchReturn(input({
      checkpoint: { ...checkpoint(), runId: "run-other" },
    }))).toThrow(/checkpoint|run/i);
    expect(() => createBranchReturn(input({
      checkpoint: { ...checkpoint(), repairGraphFenceHash: hash("other-fence") },
    }))).toThrow(/checkpoint|fence/i);
  });
});
