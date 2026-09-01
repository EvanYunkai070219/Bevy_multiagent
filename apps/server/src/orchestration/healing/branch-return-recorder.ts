import type {
  IntegrationRecord,
  ContributionRecord,
  MutationCandidate,
  RepairCheckpoint,
  RepairTournament,
  VerificationResult,
} from "../../types.js";
import {
  deterministicEvolutionId,
  EVOLUTION_MAX_SUMMARY_CHARACTERS,
  type BranchReturnRecord,
  type BranchReturnStopReason,
  type EvolutionPayload,
  type FailureCapsule,
  type LineageEdge,
  type LineageNode,
  type LineageObservation,
} from "../evolution/evolution-types.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PRIVATE_OR_RAW_SUMMARY = [
  /\b(?:raw\s+(?:model\s+)?(?:output|trace)|traceback\s*\(|stack\s+trace|authority\s+token)\b/iu,
  /(?:file:\/\/|(?:^|[\s"'(])\/(?:Users|home|private|tmp|var|root|etc|opt)\/|\b[A-Za-z]:[\\/])/u,
  /\b(?:api[_ -]?key|authorization|password|secret|owner[_ -]?token)\s*[:=]/iu,
] as const;

export interface CreateBranchReturnInput {
  readonly projectId: string;
  readonly runId: string;
  readonly tournament: RepairTournament;
  readonly checkpoint: RepairCheckpoint;
  readonly candidate: MutationCandidate;
  readonly candidateNode: LineageNode;
  readonly checkpointNode: LineageNode;
  readonly stopReason: BranchReturnStopReason;
  readonly verification: VerificationResult | null;
  readonly integration: IntegrationRecord | null;
  readonly contribution: ContributionRecord | null;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
}

export function createBranchReturn(input: CreateBranchReturnInput): readonly EvolutionPayload[] {
  assertOwnedBranch(input);
  assertAuthorizedDecision(input);
  const summary = normalizeSummary(input.summary);
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs);
  const capsuleFields = {
    projectId: input.projectId,
    runId: input.runId,
    tournamentId: input.tournament.id,
    candidateId: input.candidate.id,
    candidateFamily: input.candidate.delta.family,
    mutationContentHash: input.candidate.delta.contentHash,
    repairGraphFenceHash: input.candidate.repairGraphFenceHash!,
    returnCheckpointId: input.candidate.checkpointId,
    stopReason: input.stopReason,
    summary,
    evidenceRefs,
    createdAt: input.createdAt,
  } as const;
  const capsule: FailureCapsule = Object.freeze({
    id: deterministicEvolutionId("failure-capsule", { schemaVersion: 1, ...capsuleFields }),
    ...capsuleFields,
  });
  const returnFields = {
    projectId: input.projectId,
    runId: input.runId,
    candidateNodeId: input.candidateNode.id,
    checkpointNodeId: input.checkpointNode.id,
    capsuleId: capsule.id,
    createdAt: input.createdAt,
  } as const;
  const branchReturn: BranchReturnRecord = Object.freeze({
    id: deterministicEvolutionId("branch-return", { schemaVersion: 1, ...returnFields }),
    ...returnFields,
  });
  const observationFields = {
    projectId: input.projectId,
    runId: input.runId,
    nodeId: input.candidateNode.id,
    kind: "branch_pruned" as const,
    candidateState: input.candidate.state,
    terminalReason: input.stopReason,
    modelCalls: input.candidate.modelCalls,
    reservedTokens: input.candidate.reservedTokens,
    actualInputTokens: input.candidate.actualInputTokens,
    actualOutputTokens: input.candidate.actualOutputTokens,
    elapsedMs: input.candidate.elapsedMs,
    occurredAt: input.createdAt,
  };
  const observation: LineageObservation = Object.freeze({
    id: deterministicEvolutionId("lineage-observation", {
      schemaVersion: 1,
      projectId: input.projectId,
      runId: input.runId,
      nodeId: input.candidateNode.id,
      transition: "branch_pruned",
      stopReason: input.stopReason,
      capsuleId: capsule.id,
    }),
    ...observationFields,
  });
  const edgeFields = {
    projectId: input.projectId,
    fromNodeId: input.candidateNode.id,
    toNodeId: input.checkpointNode.id,
    kind: "returned_to" as const,
    createdAt: input.createdAt,
  };
  const edge: LineageEdge = Object.freeze({
    id: deterministicEvolutionId("lineage-edge", { schemaVersion: 1, ...edgeFields }),
    ...edgeFields,
  });
  return Object.freeze([
    { type: "capsule", value: capsule },
    { type: "branch_return", value: branchReturn },
    { type: "observation", value: observation },
    { type: "edge", value: edge },
  ]);
}

function assertOwnedBranch(input: CreateBranchReturnInput): void {
  const { candidate, tournament, candidateNode, checkpointNode } = input;
  const checkpoint = input.checkpoint;
  if (candidateNode.projectId !== input.projectId || checkpointNode.projectId !== input.projectId) {
    throw new Error("Branch return Project ownership mismatch");
  }
  if (candidateNode.runId !== input.runId || checkpointNode.runId !== input.runId) {
    throw new Error("Branch return run ownership mismatch");
  }
  if (candidateNode.kind !== "candidate" || candidateNode.entityId !== candidate.id) {
    throw new Error("Branch return candidate node ownership mismatch");
  }
  if (checkpointNode.kind !== "attempt" || checkpointNode.subtaskId !== tournament.subtaskId ||
    checkpointNode.revision !== tournament.revision || candidateNode.subtaskId !== tournament.subtaskId ||
    candidateNode.revision !== tournament.revision) {
    throw new Error("Branch return checkpoint node ownership mismatch");
  }
  if (candidate.tournamentId !== tournament.id || !tournament.candidateIds.includes(candidate.id)) {
    throw new Error("Branch return tournament ownership mismatch");
  }
  if (candidate.checkpointId !== tournament.checkpointId || tournament.checkpointId === null ||
    checkpoint.id !== tournament.checkpointId) {
    throw new Error("Branch return checkpoint ownership mismatch");
  }
  const fenceHash = candidate.repairGraphFenceHash;
  if (!isHash(fenceHash) || tournament.repairGraphFenceHash !== fenceHash) {
    throw new Error("Branch return repair graph fence mismatch");
  }
  if (checkpoint.runId !== input.runId || checkpoint.subtaskId !== tournament.subtaskId ||
    checkpoint.taskRevision !== tournament.revision ||
    checkpoint.sourceAttemptId !== checkpointNode.entityId ||
    checkpoint.sourceAttemptRevision !== checkpointNode.revision ||
    checkpoint.repairGraphFenceHash !== fenceHash) {
    throw new Error("Branch return authoritative checkpoint ownership mismatch");
  }
  if (!isHash(candidate.delta.contentHash) || candidate.evolutionFingerprints === null ||
    candidate.evolutionFingerprints.complete !== true ||
    candidate.evolutionFingerprints.mutationContentHash !== candidate.delta.contentHash ||
    candidateNode.fingerprints === null ||
    candidateNode.fingerprints.mutationContentHash !== candidate.delta.contentHash) {
    throw new Error("Branch return mutation content ownership mismatch");
  }
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("Branch return timestamp is invalid");
  }
  for (const record of [input.verification, input.integration]) {
    if (record !== null && record.repairGraphFenceHash !== fenceHash) {
      throw new Error("Branch return evidence fence mismatch");
    }
  }
}

function assertAuthorizedDecision(input: CreateBranchReturnInput): void {
  const { candidate, verification, integration, contribution } = input;
  switch (input.stopReason) {
    case "no_evidence_progress":
      if (candidate.state !== "rejected" || candidate.terminalReason !== "no_evidence_progress" ||
        integration !== null || contribution !== null) {
        throw new Error("No-evidence-progress branch return is not M2-authorized");
      }
      return;
    case "protected_rejection":
      if (candidate.state !== "rejected" || integration !== null || contribution !== null || verification === null ||
        !["deterministic_gate_failure", "mandatory_gate_failed", "targeted_gate_failed"]
          .includes(candidate.terminalReason ?? "") ||
        verification.subjectType !== "candidate" || verification.subjectId !== candidate.id ||
        !candidate.verificationIds.includes(verification.id) || verification.mandatoryPassed ||
        verification.failureKind !== "deterministic_gate_failure" ||
        !verification.gates.some((gate) => !gate.passed && gate.failureFingerprint !== null)) {
        throw new Error("Protected rejection branch return lacks deterministic verification authority");
      }
      return;
    case "verified_rollback": {
      if (candidate.state !== "rolled_back" || integration === null || contribution === null ||
        input.tournament.winnerCandidateId !== candidate.id ||
        contribution.contributionId !== integration.contributionId ||
        contribution.attemptId !== candidate.attemptId ||
        contribution.attemptRevision !== input.tournament.revision ||
        contribution.subtaskId !== input.tournament.subtaskId ||
        contribution.repairGraphFenceHash !== candidate.repairGraphFenceHash ||
        integration.state !== "rolled_back" ||
        integration.reason !== "post_integration_verification_failed" ||
        integration.subtaskId !== input.tournament.subtaskId ||
        verification === null || verification.subjectType !== "contribution" ||
        verification.subjectId !== integration.contributionId ||
        verification.stage !== "post_integration" ||
        !integration.verificationIds.includes(verification.id) ||
        verification.mandatoryPassed ||
        verification.failureKind !== "deterministic_gate_failure" ||
        !verification.gates.some((gate) => !gate.passed && gate.failureFingerprint !== null)) {
        throw new Error("Verified rollback branch return lacks protected rollback authority");
      }
      return;
    }
    default:
      throw new Error("Branch return reason is not authorized");
  }
}

function normalizeSummary(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 ||
    PRIVATE_OR_RAW_SUMMARY.some((pattern) => pattern.test(value))) {
    throw new Error("Branch return summary contains raw trace, private path, secret, or authority material");
  }
  return [...value.normalize("NFKC").replace(/\s+/gu, " ").trim()]
    .slice(0, EVOLUTION_MAX_SUMMARY_CHARACTERS)
    .join("");
}

function normalizeEvidenceRefs(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.some((value) => !isHash(value))) {
    throw new Error("Branch return evidence references are invalid");
  }
  const normalized = [...new Set(values)].sort((left, right) => left.localeCompare(right, "en")).slice(0, 3);
  if (normalized.length === 0) throw new Error("Branch return requires evidence");
  return Object.freeze(normalized);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}
