import type {
  BudgetSnapshot,
  DiagnosisRecord,
  EvidenceSnapshot,
  FaultRecord,
  FaultClass,
  GateResult,
  MutationCandidate,
  VerificationResult,
} from "../../types.js";
import { canonicalHash, canonicalSerialize } from "./evolution-fingerprints.js";

export const EVOLUTION_MAX_RECORD_BYTES = 64 * 1024;
export const EVOLUTION_MAX_ARRAY_ITEMS = 200;
export const EVOLUTION_MAX_OUTBOX_ENTRIES = 1_000;
export const EVOLUTION_MAX_OUTBOX_BYTES = 16 * 1024 * 1024;
export const EVOLUTION_MAX_DEPTH = 16;
export const EVOLUTION_MAX_SUMMARY_CHARACTERS = 512;

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const EVOLUTION_FINGERPRINT_FIELDS = [
  "repositoryBaseHash",
  "contractHash",
  "authorityManifestHash",
  "runtimeCapabilityHash",
  "faultEvidenceHash",
  "mutationContentHash",
] as const;

export interface RuntimeCapabilityManifestV2 {
  readonly schemaVersion: 2;
  readonly harnessVersion: string;
  readonly repairPromptVersion: string;
  readonly diagnosisPromptVersion: string;
  readonly modelId: string;
  readonly runtimeMode: string;
  readonly toolSchemaHash: string;
  readonly excludedToolHash: string;
  readonly sandboxPolicyHash: string;
  readonly containerImageId: string | null;
  readonly timeoutMs: number;
  readonly stepCap: number;
  readonly rootResourceHorizonHash: string;
}

export interface RepairRuntimeCapabilityEnvironmentV1 {
  readonly schemaVersion: 1;
  readonly modelId: string;
  readonly runtimeMode: string;
  readonly toolSchemas: readonly RuntimeToolSchemaV1[];
  readonly sandboxPolicyHash: string;
  readonly containerImageId: string | null;
}

export interface RuntimeToolSchemaV1 {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface CandidateContextManifestV1 {
  readonly schemaVersion: 1;
  readonly fault: {
    readonly class: FaultClass;
    readonly reasonCode: string;
  };
  readonly snapshots: readonly {
    readonly source: EvidenceSnapshot["source"];
    readonly mandatoryFailures: number;
    readonly consumerPassed: boolean;
    readonly regressionCount: number;
    readonly failureFingerprints: readonly string[];
    readonly changedPaths: readonly string[];
    readonly protectedViolations: readonly string[];
    readonly stateFingerprint: string;
  }[];
  readonly diagnosis: {
    readonly status: DiagnosisRecord["status"];
    readonly classification: string;
    readonly rationale: string;
    readonly allowedMutationFamilies: DiagnosisRecord["allowedMutationFamilies"];
  };
}

export interface MutationContentManifestV1 {
  readonly schemaVersion: 1;
  readonly family: "control" | "context_patch" | "strategy_patch";
  readonly targetSubtaskId: string;
  readonly instructionPatch: string;
  readonly expectedEffect: string;
  readonly addedEvidenceRefs: readonly string[];
  readonly failureCueIds?: readonly string[];
  readonly toolRoute: readonly string[];
  readonly repairPromptVersion: string;
}

export interface EvolutionFingerprints {
  readonly schemaVersion: 2;
  readonly complete: boolean;
  readonly repositoryBaseHash: string;
  readonly contractHash: string;
  readonly authorityManifestHash: string;
  readonly runtimeCapabilityHash: string;
  readonly faultEvidenceHash: string;
  readonly mutationContentHash: string;
}

export type EvolutionWarningLevel = BudgetSnapshot["warningLevel"];

export type LineageNodeKind =
  | "source" | "harness" | "attempt" | "candidate"
  | "integration" | "promotion" | "rollback";

export type LineageEdgeKind =
  | "continuation" | "executed_by" | "repair_fork"
  | "verified_by" | "integrated_as" | "promoted_as" | "rolled_back_to"
  | "returned_to";

export interface LineageNode {
  readonly id: string;
  readonly projectId: string;
  readonly sourceFingerprint: string;
  readonly runId: string;
  readonly subtaskId: string | null;
  readonly kind: LineageNodeKind;
  readonly entityId: string;
  readonly revision: number;
  readonly harnessVersionHash: string;
  readonly baseCommit: string | null;
  readonly headCommit: string | null;
  readonly faultId: string | null;
  readonly fingerprints: EvolutionFingerprints | null;
  readonly verificationIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly changedPaths: readonly string[];
  readonly createdAt: string;
}

export interface LineageEdge {
  readonly id: string;
  readonly projectId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: LineageEdgeKind;
  readonly createdAt: string;
}

export type EvolutionObservationKind =
  | "declared" | "pruned_duplicate" | "admitted" | "executed"
  | "verifying" | "verified" | "rejected" | "cancelled"
  | "promotion_pending" | "promoted" | "rolled_back"
  | "restart_cancelled" | "history_sync_pending" | "history_synced"
  | "branch_pruned";

export interface LineageObservation {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly kind: EvolutionObservationKind;
  readonly candidateState: MutationCandidate["state"] | null;
  readonly terminalReason: string | null;
  readonly modelCalls: number;
  readonly reservedTokens: number;
  readonly actualInputTokens: number;
  readonly actualOutputTokens: number;
  readonly elapsedMs: number;
  readonly occurredAt: string;
}

export interface FailureCue {
  readonly id: string;
  readonly projectId: string;
  readonly sourceFingerprint: string;
  readonly sourceCandidateNodeId: string;
  readonly contractKey: string;
  readonly contractHash: string;
  readonly candidateFamily: MutationCandidate["delta"]["family"];
  readonly fingerprints: EvolutionFingerprints;
  readonly gateTier: GateResult["tier"];
  readonly failureFingerprint: string;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly exactRepeatKey: string;
  readonly differingFingerprintFields: readonly (keyof EvolutionFingerprints)[];
  readonly createdAt: string;
}

export interface TransferObservation {
  readonly id: string;
  readonly projectId: string;
  readonly cueId: string;
  readonly targetCandidateNodeId: string;
  readonly differingFingerprintFields: readonly (keyof EvolutionFingerprints)[];
  readonly outcome: "helped" | "neutral" | "regressed" | "inconclusive";
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
}

export type BranchReturnStopReason =
  | "no_evidence_progress"
  | "protected_rejection"
  | "verified_rollback";

export interface FailureCapsule {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly tournamentId: string;
  readonly candidateId: string;
  readonly candidateFamily: MutationCandidate["delta"]["family"];
  readonly mutationContentHash: string;
  readonly repairGraphFenceHash: string;
  readonly returnCheckpointId: string;
  readonly stopReason: BranchReturnStopReason;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
}

export interface BranchReturnRecord {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly candidateNodeId: string;
  readonly checkpointNodeId: string;
  readonly capsuleId: string;
  readonly createdAt: string;
}

export type SanitizedFailureCapsule = Omit<
  FailureCapsule,
  "mutationContentHash" | "repairGraphFenceHash"
>;

export interface QuarantineRecord {
  readonly id: string;
  readonly projectId: string;
  readonly targetRecordId: string;
  readonly reason:
    | "schema_invalid" | "hash_mismatch" | "evidence_missing"
    | "evidence_reference_invalid" | "evidence_hash_mismatch" | "authority_untrusted"
    | "infrastructure_fault" | "provider_fault"
    | "classification_contradicted" | "ownership_mismatch"
    | "fingerprint_incomplete" | "legacy_fingerprint";
  readonly evidenceRefs: readonly string[];
  readonly quarantinedAt: string;
}

export type EvolutionPayload =
  | { readonly type: "node"; readonly value: LineageNode }
  | { readonly type: "edge"; readonly value: LineageEdge }
  | { readonly type: "observation"; readonly value: LineageObservation }
  | { readonly type: "cue"; readonly value: FailureCue }
  | { readonly type: "transfer"; readonly value: TransferObservation }
  | { readonly type: "capsule"; readonly value: FailureCapsule }
  | { readonly type: "branch_return"; readonly value: BranchReturnRecord }
  | { readonly type: "quarantine"; readonly value: QuarantineRecord };

export interface EvolutionAuditDecision {
  readonly recordId: string;
  readonly trustedForPruning: boolean;
  readonly trustedForCue: boolean;
  readonly quarantine: QuarantineRecord | null;
  readonly verification?: VerificationResult;
}

/** Durable staging only. Consumers must ignore it until `complete` is true. */
export interface EvolutionReconciliationCheckpoint {
  readonly projectId: string;
  readonly targetHeadHash: string | null;
  readonly targetSequence: number;
  readonly nextSequence: number;
  readonly phase: "collecting" | "auditing" | "complete";
  readonly auditOffset: number;
  readonly records: readonly EvolutionPayload[];
  readonly auditDecisions: readonly EvolutionAuditDecision[];
  readonly quarantines: readonly QuarantineRecord[];
  readonly complete: boolean;
}

export interface EvolutionOutboxEntry {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string;
  readonly records: readonly EvolutionPayload[];
  readonly state: "pending" | "delivered";
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly lastErrorCode: string | null;
}

export interface EvolutionHistoryStatus {
  readonly state: "ready" | "unavailable";
  readonly droppedHistoryCount: number;
  readonly droppedReason:
    | "outbox_entry_limit"
    | "outbox_byte_limit"
    | "store_over_quota"
    | "store_unavailable"
    | null;
  readonly reconciliationPending: boolean;
}

export interface EvolutionCounts {
  readonly declared: number;
  readonly prunedDuplicate: number;
  readonly admitted: number;
  readonly executed: number;
  readonly verified: number;
  readonly promoted: number;
  readonly rolledBack: number;
  readonly branchPruned: number;
  readonly branchReturned: number;
  readonly historicalEvidenceUsed: number;
}

export interface EvolutionProjection {
  readonly syncState: "synced" | "pending" | "unavailable" | "quarantined";
  readonly historyHealth: {
    readonly droppedHistoryCount: number;
    readonly droppedReason: EvolutionHistoryStatus["droppedReason"];
    readonly reconciliationPending: boolean;
  };
  readonly primaryFault: {
    readonly class: FaultRecord["class"];
    readonly summary: string;
    readonly evidenceRefs: readonly string[];
  } | null;
  readonly warningLevel: BudgetSnapshot["warningLevel"];
  readonly terminalReason: string | null;
  readonly runBranch: string | null;
  readonly baseCommit: string | null;
  readonly headCommit: string | null;
  readonly counts: EvolutionCounts;
  readonly nodes: readonly LineageNode[];
  readonly edges: readonly LineageEdge[];
  readonly observations: readonly LineageObservation[];
  readonly cues: readonly FailureCue[];
  readonly transfers: readonly TransferObservation[];
  readonly capsules: readonly SanitizedFailureCapsule[];
  readonly branchReturns: readonly BranchReturnRecord[];
  readonly quarantines: readonly QuarantineRecord[];
  readonly nextCursor: string | null;
}

export function deterministicEvolutionId(domain: string, identity: unknown): string {
  assertIdentifier(domain, "evolution id domain");
  return canonicalHash({ schemaVersion: 1, domain, identity });
}

export function normalizeEvolutionOutbox(value: unknown): readonly EvolutionOutboxEntry[] {
  if (!Array.isArray(value)) throw new Error("Evolution outbox must be an array");
  if (value.length > EVOLUTION_MAX_OUTBOX_ENTRIES) {
    throw new Error("Evolution outbox exceeds 1,000 entries");
  }
  return deepFreeze(value.map((entry) => normalizeEvolutionOutboxEntry(
    entry as EvolutionOutboxEntry,
  )));
}

export function normalizeEvolutionHistoryStatus(value: unknown): EvolutionHistoryStatus | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Evolution history status is invalid");
  const state = value.state;
  const reason = value.droppedReason;
  if (state !== "ready" && state !== "unavailable") throw new Error("Evolution history state is invalid");
  if (!Number.isSafeInteger(value.droppedHistoryCount) || (value.droppedHistoryCount as number) < 0) {
    throw new Error("Evolution dropped-history count is invalid");
  }
  if (reason !== null && reason !== "outbox_entry_limit" && reason !== "outbox_byte_limit" &&
    reason !== "store_over_quota" && reason !== "store_unavailable") {
    throw new Error("Evolution dropped-history reason is invalid");
  }
  if (typeof value.reconciliationPending !== "boolean") {
    throw new Error("Evolution reconciliation state is invalid");
  }
  return deepFreeze({
    state,
    droppedHistoryCount: value.droppedHistoryCount as number,
    droppedReason: reason,
    reconciliationPending: value.reconciliationPending,
  });
}

export function normalizeEvolutionOutboxEntry(
  input: EvolutionOutboxEntry,
): EvolutionOutboxEntry {
  assertStructuralBounds(input);
  assertHash(input.id, "outbox id");
  assertIdentifier(input.projectId, "outbox project id");
  assertIdentifier(input.runId, "outbox run id");
  if (input.state !== "pending" && input.state !== "delivered") {
    throw new Error("Evolution outbox state is invalid");
  }
  assertTimestamp(input.createdAt, "outbox createdAt");
  assertNullableTimestamp(input.deliveredAt, "outbox deliveredAt");
  assertNullableIdentifier(input.lastErrorCode, "outbox lastErrorCode");
  const normalized: EvolutionOutboxEntry = {
    id: input.id,
    projectId: input.projectId,
    runId: input.runId,
    records: input.records.map(normalizePayload),
    state: input.state,
    createdAt: input.createdAt,
    deliveredAt: input.deliveredAt,
    lastErrorCode: input.lastErrorCode,
  };
  if (Buffer.byteLength(canonicalSerialize(normalized), "utf8") > EVOLUTION_MAX_RECORD_BYTES) {
    throw new Error("Evolution payload exceeds 64 KiB");
  }
  return deepFreeze(normalized);
}

export function emptyEvolutionCounts(): EvolutionCounts {
  return Object.freeze({
    declared: 0,
    prunedDuplicate: 0,
    admitted: 0,
    executed: 0,
    verified: 0,
    promoted: 0,
    rolledBack: 0,
    branchPruned: 0,
    branchReturned: 0,
    historicalEvidenceUsed: 0,
  });
}

export function evolutionCountsFromObservations(
  observations: readonly LineageObservation[],
  historicalEvidenceUsed = 0,
  branchReturned = 0,
): EvolutionCounts {
  assertNonNegativeInteger(historicalEvidenceUsed, "historical evidence count");
  assertNonNegativeInteger(branchReturned, "branch return count");
  const counts = { ...emptyEvolutionCounts(), historicalEvidenceUsed, branchReturned };
  const seen = new Set<string>();
  for (const observation of observations) {
    if (seen.has(observation.id)) continue;
    seen.add(observation.id);
    switch (observation.kind) {
      case "declared": counts.declared += 1; break;
      case "pruned_duplicate": counts.prunedDuplicate += 1; break;
      case "admitted": counts.admitted += 1; break;
      case "executed": counts.executed += 1; break;
      case "verified": counts.verified += 1; break;
      case "promoted": counts.promoted += 1; break;
      case "rolled_back": counts.rolledBack += 1; break;
      case "branch_pruned": counts.branchPruned += 1; break;
      default: break;
    }
  }
  return deepFreeze(counts);
}

export function sanitizeEvolutionProjection(input: EvolutionProjection): EvolutionProjection {
  const source = input as unknown as Record<string, unknown>;
  const primary = isRecord(source.primaryFault) ? source.primaryFault : null;
  const projection: EvolutionProjection = {
    syncState: isSyncState(source.syncState) ? source.syncState : "unavailable",
    historyHealth: normalizeHistoryHealth(source.historyHealth),
    primaryFault: primary === null
      ? null
      : {
          class: isFaultClass(primary.class) ? primary.class : "infrastructure_failure",
          summary: boundedText(primary.summary),
          evidenceRefs: normalizeHashArray(arrayValue(primary.evidenceRefs, true), "fault evidence ref"),
        },
    warningLevel:
      source.warningLevel === "advisory" || source.warningLevel === "severe"
        ? source.warningLevel
        : null,
    terminalReason: nullableBoundedText(source.terminalReason),
    runBranch: nullableBoundedText(source.runBranch),
    baseCommit: nullableCommit(source.baseCommit, "projection base commit"),
    headCommit: nullableCommit(source.headCommit, "projection head commit"),
    counts: normalizeCounts(source.counts),
    nodes: projectionArray(source.nodes).map((value) => normalizeNode(value as LineageNode)),
    edges: projectionArray(source.edges).map((value) => normalizeEdge(value as LineageEdge)),
    observations: projectionArray(source.observations).map((value) =>
      normalizeObservation(value as LineageObservation)),
    cues: projectionArray(source.cues).map((value) => normalizeCue(value as FailureCue)),
    transfers: projectionArray(source.transfers).map((value) =>
      normalizeTransfer(value as TransferObservation)),
    capsules: projectionArray(source.capsules).map(normalizeSanitizedCapsule),
    branchReturns: projectionArray(source.branchReturns).map((value) =>
      normalizeBranchReturn(value as BranchReturnRecord)),
    quarantines: projectionArray(source.quarantines).map((value) =>
      normalizeQuarantine(value as QuarantineRecord)),
    nextCursor: nullableBoundedText(source.nextCursor),
  };
  return deepFreeze(projection);
}

function normalizeHistoryHealth(value: unknown): EvolutionProjection["historyHealth"] {
  const record = isRecord(value) ? value : {};
  const reason = record.droppedReason;
  return deepFreeze({
    droppedHistoryCount: countValue(record.droppedHistoryCount),
    droppedReason: reason === "outbox_entry_limit" || reason === "outbox_byte_limit" ||
      reason === "store_over_quota" || reason === "store_unavailable" ? reason : null,
    reconciliationPending: record.reconciliationPending === true,
  });
}

function normalizePayload(payload: EvolutionPayload): EvolutionPayload {
  if (!isRecord(payload)) throw new Error("Evolution payload record is invalid");
  switch (payload.type) {
    case "node": return { type: "node", value: normalizeNode(payload.value as LineageNode) };
    case "edge": return { type: "edge", value: normalizeEdge(payload.value as LineageEdge) };
    case "observation": return {
      type: "observation",
      value: normalizeObservation(payload.value as LineageObservation),
    };
    case "cue": return { type: "cue", value: normalizeCue(payload.value as FailureCue) };
    case "transfer": return {
      type: "transfer",
      value: normalizeTransfer(payload.value as TransferObservation),
    };
    case "capsule": return {
      type: "capsule",
      value: normalizeFailureCapsule(payload.value as FailureCapsule),
    };
    case "branch_return": return {
      type: "branch_return",
      value: normalizeBranchReturn(payload.value as BranchReturnRecord),
    };
    case "quarantine": return {
      type: "quarantine",
      value: normalizeQuarantine(payload.value as QuarantineRecord),
    };
    default: throw new Error("Evolution payload type is invalid");
  }
}

function normalizeNode(node: LineageNode): LineageNode {
  assertHash(node.id, "lineage node id");
  assertIdentifier(node.projectId, "lineage project id");
  assertHash(node.sourceFingerprint, "lineage source hash");
  assertIdentifier(node.runId, "lineage run id");
  assertNullableIdentifier(node.subtaskId, "lineage subtask id");
  if (!["source", "harness", "attempt", "candidate", "integration", "promotion", "rollback"].includes(node.kind)) {
    throw new Error("Lineage node kind is invalid");
  }
  assertIdentifier(node.entityId, "lineage entity id", 4_096);
  assertPositiveRevision(node.revision, "lineage revision");
  assertHash(node.harnessVersionHash, "lineage harness hash");
  assertNullableCommit(node.baseCommit, "lineage base commit");
  assertNullableCommit(node.headCommit, "lineage head commit");
  assertNullableIdentifier(node.faultId, "lineage fault id");
  const fingerprints = node.fingerprints === null ? null : normalizeFingerprints(node.fingerprints);
  assertTimestamp(node.createdAt, "lineage createdAt");
  return deepFreeze({
    id: node.id,
    projectId: node.projectId,
    sourceFingerprint: node.sourceFingerprint,
    runId: node.runId,
    subtaskId: node.subtaskId,
    kind: node.kind,
    entityId: node.entityId,
    revision: node.revision,
    harnessVersionHash: node.harnessVersionHash,
    baseCommit: node.baseCommit,
    headCommit: node.headCommit,
    faultId: node.faultId,
    fingerprints,
    verificationIds: normalizeIdentifierArray(node.verificationIds, "verification id"),
    evidenceRefs: normalizeHashArray(node.evidenceRefs, "evidence ref"),
    changedPaths: normalizePathArray(node.changedPaths),
    createdAt: node.createdAt,
  });
}

function normalizeEdge(edge: LineageEdge): LineageEdge {
  assertHash(edge.id, "lineage edge id");
  assertIdentifier(edge.projectId, "lineage project id");
  assertHash(edge.fromNodeId, "lineage from node id");
  assertHash(edge.toNodeId, "lineage to node id");
  if (!["continuation", "executed_by", "repair_fork", "verified_by", "integrated_as", "promoted_as", "rolled_back_to", "returned_to"].includes(edge.kind)) {
    throw new Error("Lineage edge kind is invalid");
  }
  assertTimestamp(edge.createdAt, "lineage edge createdAt");
  return deepFreeze({
    id: edge.id,
    projectId: edge.projectId,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    kind: edge.kind,
    createdAt: edge.createdAt,
  });
}

function normalizeObservation(observation: LineageObservation): LineageObservation {
  assertHash(observation.id, "observation id");
  assertIdentifier(observation.projectId, "observation project id");
  assertIdentifier(observation.runId, "observation run id");
  assertHash(observation.nodeId, "observation node id");
  if (![
    "declared", "pruned_duplicate", "admitted", "executed", "verifying", "verified",
    "rejected", "cancelled", "promotion_pending", "promoted", "rolled_back",
    "restart_cancelled", "history_sync_pending", "history_synced", "branch_pruned",
  ].includes(observation.kind)) throw new Error("Evolution observation kind is invalid");
  assertNullableIdentifier(observation.candidateState, "observation candidate state");
  assertNullableIdentifier(observation.terminalReason, "observation terminal reason", 1_024);
  for (const [field, value] of Object.entries({
    modelCalls: observation.modelCalls,
    reservedTokens: observation.reservedTokens,
    actualInputTokens: observation.actualInputTokens,
    actualOutputTokens: observation.actualOutputTokens,
    elapsedMs: observation.elapsedMs,
  })) assertNonNegativeInteger(value, "observation " + field);
  assertTimestamp(observation.occurredAt, "observation occurredAt");
  return deepFreeze({
    id: observation.id,
    projectId: observation.projectId,
    runId: observation.runId,
    nodeId: observation.nodeId,
    kind: observation.kind,
    candidateState: observation.candidateState,
    terminalReason: observation.terminalReason,
    modelCalls: observation.modelCalls,
    reservedTokens: observation.reservedTokens,
    actualInputTokens: observation.actualInputTokens,
    actualOutputTokens: observation.actualOutputTokens,
    elapsedMs: observation.elapsedMs,
    occurredAt: observation.occurredAt,
  });
}

function normalizeCue(cue: FailureCue): FailureCue {
  assertHash(cue.id, "cue id");
  assertIdentifier(cue.projectId, "cue project id");
  assertHash(cue.sourceFingerprint, "cue source fingerprint");
  assertHash(cue.sourceCandidateNodeId, "cue source node id");
  assertIdentifier(cue.contractKey, "cue contract key");
  assertHash(cue.contractHash, "cue contract hash");
  if (!["control", "context_patch", "strategy_patch"].includes(cue.candidateFamily)) {
    throw new Error("Cue candidate family is invalid");
  }
  if (!["integrity", "targeted", "contract", "consumer", "held_out", "mutation_quality", "regression", "post_integration"].includes(cue.gateTier)) {
    throw new Error("Cue gate tier is invalid");
  }
  assertHash(cue.failureFingerprint, "cue failure hash");
  assertHash(cue.exactRepeatKey, "cue repeat key");
  assertTimestamp(cue.createdAt, "cue createdAt");
  return deepFreeze({
    id: cue.id,
    projectId: cue.projectId,
    sourceFingerprint: cue.sourceFingerprint,
    sourceCandidateNodeId: cue.sourceCandidateNodeId,
    contractKey: cue.contractKey,
    contractHash: cue.contractHash,
    candidateFamily: cue.candidateFamily,
    fingerprints: normalizeFingerprints(cue.fingerprints),
    gateTier: cue.gateTier,
    failureFingerprint: cue.failureFingerprint,
    summary: boundedText(cue.summary),
    evidenceRefs: normalizeHashArray(cue.evidenceRefs, "cue evidence ref"),
    exactRepeatKey: cue.exactRepeatKey,
    differingFingerprintFields: normalizeFingerprintFields(cue.differingFingerprintFields),
    createdAt: cue.createdAt,
  });
}

function normalizeTransfer(transfer: TransferObservation): TransferObservation {
  assertHash(transfer.id, "transfer id");
  assertIdentifier(transfer.projectId, "transfer project id");
  assertHash(transfer.cueId, "transfer cue id");
  assertHash(transfer.targetCandidateNodeId, "transfer target node id");
  if (!["helped", "neutral", "regressed", "inconclusive"].includes(transfer.outcome)) {
    throw new Error("Transfer outcome is invalid");
  }
  assertTimestamp(transfer.createdAt, "transfer createdAt");
  return deepFreeze({
    id: transfer.id,
    projectId: transfer.projectId,
    cueId: transfer.cueId,
    targetCandidateNodeId: transfer.targetCandidateNodeId,
    differingFingerprintFields: normalizeFingerprintFields(transfer.differingFingerprintFields),
    outcome: transfer.outcome,
    evidenceRefs: normalizeHashArray(transfer.evidenceRefs, "transfer evidence ref"),
    createdAt: transfer.createdAt,
  });
}

function normalizeFailureCapsule(capsule: FailureCapsule): FailureCapsule {
  assertHash(capsule.id, "failure capsule id");
  assertIdentifier(capsule.projectId, "failure capsule project id");
  assertIdentifier(capsule.runId, "failure capsule run id");
  assertIdentifier(capsule.tournamentId, "failure capsule tournament id");
  assertIdentifier(capsule.candidateId, "failure capsule candidate id");
  if (!["control", "context_patch", "strategy_patch"].includes(capsule.candidateFamily)) {
    throw new Error("Failure capsule candidate family is invalid");
  }
  assertHash(capsule.mutationContentHash, "failure capsule mutation hash");
  assertHash(capsule.repairGraphFenceHash, "failure capsule fence hash");
  assertIdentifier(capsule.returnCheckpointId, "failure capsule checkpoint id");
  assertBranchReturnStopReason(capsule.stopReason);
  assertSafeSummary(capsule.summary);
  assertTimestamp(capsule.createdAt, "failure capsule createdAt");
  const evidenceRefs = normalizeHashArray(capsule.evidenceRefs, "failure capsule evidence ref");
  if (evidenceRefs.length === 0 || evidenceRefs.length > 3) {
    throw new Error("Failure capsule must contain one to three unique evidence refs");
  }
  const normalized = {
    projectId: capsule.projectId,
    runId: capsule.runId,
    tournamentId: capsule.tournamentId,
    candidateId: capsule.candidateId,
    candidateFamily: capsule.candidateFamily,
    mutationContentHash: capsule.mutationContentHash,
    repairGraphFenceHash: capsule.repairGraphFenceHash,
    returnCheckpointId: capsule.returnCheckpointId,
    stopReason: capsule.stopReason,
    summary: boundedText(capsule.summary),
    evidenceRefs,
    createdAt: capsule.createdAt,
  } as const;
  const expectedId = deterministicEvolutionId("failure-capsule", {
    schemaVersion: 1,
    ...normalized,
  });
  if (capsule.id !== expectedId) throw new Error("Failure capsule content hash is invalid");
  return deepFreeze({ id: capsule.id, ...normalized });
}

function normalizeSanitizedCapsule(value: unknown): SanitizedFailureCapsule {
  if (!isRecord(value)) throw new Error("Public failure capsule is invalid");
  const stopReason = value.stopReason;
  assertHash(value.id, "public failure capsule id");
  assertIdentifier(value.projectId, "public failure capsule project id");
  assertIdentifier(value.runId, "public failure capsule run id");
  assertIdentifier(value.tournamentId, "public failure capsule tournament id");
  assertIdentifier(value.candidateId, "public failure capsule candidate id");
  if (!["control", "context_patch", "strategy_patch"].includes(value.candidateFamily as string)) {
    throw new Error("Public failure capsule candidate family is invalid");
  }
  assertIdentifier(value.returnCheckpointId, "public failure capsule checkpoint id");
  assertBranchReturnStopReason(stopReason);
  assertSafeSummary(value.summary);
  assertTimestamp(value.createdAt, "public failure capsule createdAt");
  const evidenceRefs = normalizeHashArray(arrayValue(value.evidenceRefs, true), "public failure capsule evidence ref")
    .slice(0, 3);
  return deepFreeze({
    id: value.id,
    projectId: value.projectId,
    runId: value.runId,
    tournamentId: value.tournamentId,
    candidateId: value.candidateId,
    candidateFamily: value.candidateFamily as MutationCandidate["delta"]["family"],
    returnCheckpointId: value.returnCheckpointId,
    stopReason,
    summary: boundedText(value.summary),
    evidenceRefs,
    createdAt: value.createdAt,
  });
}

function normalizeBranchReturn(record: BranchReturnRecord): BranchReturnRecord {
  assertHash(record.id, "branch return id");
  assertIdentifier(record.projectId, "branch return project id");
  assertIdentifier(record.runId, "branch return run id");
  assertHash(record.candidateNodeId, "branch return candidate node id");
  assertHash(record.checkpointNodeId, "branch return checkpoint node id");
  assertHash(record.capsuleId, "branch return capsule id");
  assertTimestamp(record.createdAt, "branch return createdAt");
  const expectedId = deterministicEvolutionId("branch-return", {
    schemaVersion: 1,
    projectId: record.projectId,
    runId: record.runId,
    candidateNodeId: record.candidateNodeId,
    checkpointNodeId: record.checkpointNodeId,
    capsuleId: record.capsuleId,
    createdAt: record.createdAt,
  });
  if (record.id !== expectedId) throw new Error("Branch return content hash is invalid");
  return deepFreeze({ ...record });
}

function normalizeQuarantine(record: QuarantineRecord): QuarantineRecord {
  assertHash(record.id, "quarantine id");
  assertIdentifier(record.projectId, "quarantine project id");
  assertHash(record.targetRecordId, "quarantine target id");
  if (![
    "schema_invalid", "hash_mismatch", "evidence_missing", "evidence_reference_invalid",
    "evidence_hash_mismatch",
    "authority_untrusted", "infrastructure_fault", "provider_fault",
    "classification_contradicted", "ownership_mismatch", "fingerprint_incomplete",
    "legacy_fingerprint",
  ].includes(record.reason)) throw new Error("Quarantine reason is invalid");
  assertTimestamp(record.quarantinedAt, "quarantine timestamp");
  return deepFreeze({
    id: record.id,
    projectId: record.projectId,
    targetRecordId: record.targetRecordId,
    reason: record.reason,
    evidenceRefs: normalizeHashArray(record.evidenceRefs, "quarantine evidence ref"),
    quarantinedAt: record.quarantinedAt,
  });
}

function normalizeFingerprints(value: EvolutionFingerprints): EvolutionFingerprints {
  const record = value as unknown as Record<string, unknown>;
  const expectedKeys = new Set<string>([
    "schemaVersion",
    "complete",
    ...EVOLUTION_FINGERPRINT_FIELDS,
  ]);
  const actualKeys = Object.keys(record);
  if (
    value.schemaVersion !== 2 ||
    typeof value.complete !== "boolean" ||
    actualKeys.length !== expectedKeys.size ||
    actualKeys.some((key) => !expectedKeys.has(key))
  ) {
    throw new Error("Evolution fingerprint schema is invalid");
  }
  for (const field of EVOLUTION_FINGERPRINT_FIELDS) {
    assertHash(value[field], "evolution " + field);
  }
  return deepFreeze({
    schemaVersion: 2,
    complete: value.complete,
    repositoryBaseHash: value.repositoryBaseHash,
    contractHash: value.contractHash,
    authorityManifestHash: value.authorityManifestHash,
    runtimeCapabilityHash: value.runtimeCapabilityHash,
    faultEvidenceHash: value.faultEvidenceHash,
    mutationContentHash: value.mutationContentHash,
  });
}

function normalizeCounts(value: unknown): EvolutionCounts {
  const record = isRecord(value) ? value : {};
  const counts: EvolutionCounts = {
    declared: countValue(record.declared),
    prunedDuplicate: countValue(record.prunedDuplicate),
    admitted: countValue(record.admitted),
    executed: countValue(record.executed),
    verified: countValue(record.verified),
    promoted: countValue(record.promoted),
    rolledBack: countValue(record.rolledBack),
    branchPruned: countValue(record.branchPruned),
    branchReturned: countValue(record.branchReturned),
    historicalEvidenceUsed: countValue(record.historicalEvidenceUsed),
  };
  return deepFreeze(counts);
}

function assertStructuralBounds(value: unknown): void {
  walkBounds(value, 0, new Set<object>());
  if (Buffer.byteLength(canonicalSerialize(value), "utf8") > EVOLUTION_MAX_RECORD_BYTES) {
    throw new Error("Evolution payload exceeds 64 KiB");
  }
}

function walkBounds(value: unknown, depth: number, ancestors: Set<object>): void {
  if (depth > EVOLUTION_MAX_DEPTH) throw new Error("Evolution payload exceeds depth limit");
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) throw new Error("Evolution payload contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertArrayBound(value);
      for (const item of value) walkBounds(item, depth + 1, ancestors);
      return;
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      walkBounds(item, depth + 1, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function assertArrayBound(value: readonly unknown[]): void {
  if (value.length > EVOLUTION_MAX_ARRAY_ITEMS) {
    throw new Error("Evolution array exceeds 200 items");
  }
}

function normalizeIdentifierArray(values: readonly string[], label: string): string[] {
  assertArrayBound(values);
  for (const value of values) assertIdentifier(value, label);
  return sortedUnique(values);
}

function normalizeHashArray(values: readonly string[], label: string): string[] {
  assertArrayBound(values);
  for (const value of values) assertHash(value, label);
  return sortedUnique(values);
}

function normalizePathArray(values: readonly string[]): string[] {
  assertArrayBound(values);
  return sortedUnique(values.map(assertRelativePath));
}

function assertRelativePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  ) throw new Error("Evolution path must be repository-relative");
  const parts = value.split("/");
  if (parts.some((part) => part === "..")) {
    throw new Error("Evolution path must not escape the repository");
  }
  return parts.filter((part) => part !== "" && part !== ".").join("/");
}

function projectionArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, EVOLUTION_MAX_ARRAY_ITEMS) : [];
}

function arrayValue(value: unknown, truncate: boolean): string[] {
  if (!Array.isArray(value)) return [];
  const bounded = truncate ? value.slice(0, EVOLUTION_MAX_ARRAY_ITEMS) : value;
  return bounded.filter((item): item is string => typeof item === "string");
}

function boundedText(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.normalize("NFKC").replace(/\s+/gu, " ").trim()]
    .slice(0, EVOLUTION_MAX_SUMMARY_CHARACTERS)
    .join("");
}

function assertBranchReturnStopReason(value: unknown): asserts value is BranchReturnStopReason {
  if (value !== "no_evidence_progress" && value !== "protected_rejection" &&
    value !== "verified_rollback") {
    throw new Error("Branch return reason is not authorized");
  }
}

function assertSafeSummary(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Failure capsule summary is invalid");
  }
  if (/\b(?:raw\s+(?:model\s+)?(?:output|trace)|traceback\s*\(|stack\s+trace|authority\s+token)\b/iu.test(value) ||
    /(?:file:\/\/|(?:^|[\s"'(])\/(?:Users|home|private|tmp|var|root|etc|opt)\/|\b[A-Za-z]:[\\/])/u.test(value) ||
    /\b(?:api[_ -]?key|authorization|password|secret|owner[_ -]?token)\s*[:=]/iu.test(value)) {
    throw new Error("Failure capsule summary contains raw trace, private path, or authority material");
  }
}

function nullableBoundedText(value: unknown): string | null {
  return value === null || value === undefined ? null : boundedText(value);
}

function nullableCommit(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  assertCommit(value, label);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSyncState(value: unknown): value is EvolutionProjection["syncState"] {
  return value === "synced" || value === "pending" || value === "unavailable" || value === "quarantined";
}

function isFaultClass(value: unknown): value is FaultClass {
  return [
    "hard_failure", "stall", "false_completion", "coordination_failure", "budget_failure",
    "deadline_failure", "provider_rate_limited", "infrastructure_failure", "authority_failure",
    "integration_conflict", "cancelled",
  ].includes(value as string);
}

function countValue(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(label + " has invalid hash shape");
  }
}

function assertCommit(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new Error(label + " has invalid commit shape");
  }
}

function assertNullableCommit(value: unknown, label: string): void {
  if (value !== null) assertCommit(value, label);
}

function assertIdentifier(value: unknown, label: string, maximum = 1_024): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error(label + " has invalid id shape");
}

function assertNullableIdentifier(value: unknown, label: string, maximum = 1_024): void {
  if (value !== null) assertIdentifier(value, label, maximum);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(label + " has invalid timestamp");
  }
}

function assertNullableTimestamp(value: unknown, label: string): void {
  if (value !== null) assertTimestamp(value, label);
}

function assertPositiveRevision(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(label + " must be a positive integer");
  }
}

function assertNonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(label + " must be a non-negative integer");
  }
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeFingerprintFields(
  values: readonly (keyof EvolutionFingerprints)[],
): (keyof EvolutionFingerprints)[] {
  if (!Array.isArray(values)) throw new Error("Fingerprint field list is invalid");
  assertArrayBound(values);
  if (values.some((field) => !EVOLUTION_FINGERPRINT_FIELDS.includes(
    field as typeof EVOLUTION_FINGERPRINT_FIELDS[number],
  ))) throw new Error("Fingerprint field list contains an unsupported field");
  return sortedUnique(values);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}
