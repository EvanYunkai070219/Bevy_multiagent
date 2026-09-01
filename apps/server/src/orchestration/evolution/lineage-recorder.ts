import type { JsonStore } from "../../store.js";
import type {
  AgentRun,
  ContributionRecord,
  FaultRecord,
  IntegrationRecord,
  MutationCandidate,
  OrchestrationState,
  ProjectRunRecord,
  RepairTournament,
  RepairCheckpoint,
  TaskNodeState,
  VerificationResult,
} from "../../types.js";
import {
  buildEvolutionFingerprints,
  canonicalHash,
  canonicalSerialize,
  exactRepeatKey,
} from "./evolution-fingerprints.js";
import type { EvolutionStore } from "./evolution-store.js";
import { EvolutionStoreError } from "./evolution-store.js";
import {
  deterministicEvolutionId,
  EVOLUTION_MAX_OUTBOX_BYTES,
  EVOLUTION_MAX_OUTBOX_ENTRIES,
  type EvolutionObservationKind,
  type EvolutionOutboxEntry,
  type EvolutionPayload,
  type LineageEdge,
  type LineageEdgeKind,
  type LineageNode,
  type LineageNodeKind,
  type LineageObservation,
} from "./evolution-types.js";
import type { FailureCueService } from "./failure-cues.js";
import { createBranchReturn } from "../healing/branch-return-recorder.js";

const EXECUTED_TRANSITIONS = new Set<EvolutionObservationKind>([
  "executed",
  "verifying",
  "verified",
  "rejected",
  "promotion_pending",
  "promoted",
  "rolled_back",
]);

export interface EvolutionTransitionInput {
  run: AgentRun;
  project: ProjectRunRecord;
  node: TaskNodeState;
  fault: FaultRecord | null;
  candidate: MutationCandidate | null;
  tournament: RepairTournament | null;
  verification: VerificationResult | null;
  integration: IntegrationRecord | null;
  contribution?: ContributionRecord | null;
  candidateRun: AgentRun | null;
  transition: EvolutionObservationKind;
  eventEvidenceRefs: string[];
  occurredAt: string;
  /** Exact hash of the complete Task 1 runtime capability manifest frozen for this candidate. */
  runtimeCapabilityIdentity: {
    runtimeCapabilityHash: string;
    manifestComplete: boolean;
  } | null;
  /** Set only by the post-settlement tournament reconciliation boundary. */
  includeSettledTransfers?: boolean;
  /** Authoritative frozen checkpoint; required before branch-return records may be emitted. */
  repairCheckpoint?: RepairCheckpoint | null;
}

export interface LineageRecorderOptions {
  readonly store?: JsonStore;
  readonly evolutionStore?: EvolutionStore;
  /** Failure seam at the durable append → delivered-state boundary. */
  readonly beforeMarkDelivered?: (entry: EvolutionOutboxEntry) => void | Promise<void>;
  readonly failureCueService?: FailureCueService;
}

export class LineageUnavailableError extends Error {
  readonly code = "evolution_history_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "LineageUnavailableError";
  }
}

export class LineageRecorder {
  readonly #store: JsonStore | null;
  readonly #evolutionStore: EvolutionStore | null;
  readonly #beforeMarkDelivered: LineageRecorderOptions["beforeMarkDelivered"];
  readonly #failureCueService: FailureCueService | null;

  constructor(options?: LineageRecorderOptions) {
    this.#store = options?.store ?? null;
    this.#evolutionStore = options?.evolutionStore ?? null;
    this.#beforeMarkDelivered = options?.beforeMarkDelivered;
    this.#failureCueService = options?.failureCueService ?? null;
  }

  build(input: EvolutionTransitionInput): EvolutionPayload[] {
    const projectId = input.run.projectId;
    if (projectId === null || input.project.source.sourceFingerprint.length === 0) {
      throw new LineageUnavailableError("Project/source identity is unavailable for lineage");
    }
    if (input.candidate !== null) this.#assertCandidateTruth(input);
    const sourceFingerprint = input.project.source.sourceFingerprint;
    const harnessVersionHash = harnessHash(input.runtimeCapabilityIdentity);
    const source = lineageNode(input, {
      kind: "source",
      entityId: sourceFingerprint,
      revision: 1,
      subtaskId: null,
      harnessVersionHash,
      baseCommit: input.project.source.baseCommit,
      headCommit: input.project.source.baseCommit,
      fingerprints: null,
      verificationIds: [],
      evidenceRefs: [],
      changedPaths: [],
      createdAt: input.run.createdAt,
    });
    const harness = lineageNode(input, {
      kind: "harness",
      entityId: harnessVersionHash,
      revision: 1,
      subtaskId: null,
      harnessVersionHash,
      baseCommit: input.project.source.baseCommit,
      headCommit: input.project.source.baseCommit,
      fingerprints: null,
      verificationIds: [],
      evidenceRefs: [],
      changedPaths: [],
      createdAt: input.run.createdAt,
    });
    const attemptEntityId = input.node.attemptId ?? `${input.node.subtaskId}:${input.node.revision}`;
    const persistedAttempt = input.project.attempts.find((value) => value.attemptId === input.node.attemptId);
    const attempt = lineageNode(input, {
      kind: "attempt",
      entityId: attemptEntityId,
      revision: input.node.revision,
      subtaskId: input.node.subtaskId,
      harnessVersionHash,
      baseCommit: persistedAttempt?.baseCommit ?? input.project.source.baseCommit,
      headCommit: persistedAttempt?.headCommit ?? null,
      fingerprints: null,
      verificationIds: [],
      evidenceRefs: input.fault?.evidenceRefs ?? [],
      changedPaths: [],
      createdAt: input.run.createdAt,
    });
    const payloads: EvolutionPayload[] = [
      { type: "node", value: source },
      { type: "node", value: harness },
      { type: "node", value: attempt },
      { type: "edge", value: lineageEdge(input, source, attempt, "continuation") },
      { type: "edge", value: lineageEdge(input, harness, attempt, "executed_by") },
    ];

    let observationNode = attempt;
    if (input.candidate !== null) {
      const candidate = lineageNode(input, candidateNodeFields(input, harnessVersionHash));
      observationNode = candidate;
      payloads.push(
        { type: "node", value: candidate },
        { type: "edge", value: lineageEdge(input, attempt, candidate, "repair_fork") },
      );
      if ((input.transition === "rejected" || input.transition === "rolled_back") &&
        input.verification !== null && candidate.fingerprints !== null &&
        this.#failureCueService !== null) {
        const repeatKey = exactRepeatKey(candidate.fingerprints);
        const contractKey = input.run.orchestration?.healing.contracts.find((value) =>
          value.subtaskId === input.node.subtaskId && value.revision === input.node.revision)?.contractKey;
        if (repeatKey !== null && contractKey !== undefined) {
          const cue = this.#failureCueService.create({
            projectId: input.run.projectId!,
            sourceFingerprint,
            contractKey,
            candidate: input.candidate,
            candidateNodeId: candidate.id,
            verification: input.verification,
            exactRepeatKey: repeatKey,
          });
          if (cue !== null) payloads.push({ type: "cue", value: cue });
        }
      }
      if (input.includeSettledTransfers === true && input.candidate.delta.family === "context_patch" &&
        (input.candidate.delta.failureCueIds?.length ?? 0) > 0 && input.verification !== null &&
        input.candidate.evolutionFingerprints !== null && this.#failureCueService !== null) {
        const controlCandidate = input.run.orchestration?.healing.candidates.find((value) =>
          value.tournamentId === input.candidate!.tournamentId && value.delta.family === "control");
        const controlVerifications = controlCandidate === undefined
          ? []
          : input.run.orchestration?.healing.verifications.filter((value) =>
              controlCandidate.verificationIds.includes(value.id) &&
              value.stage === input.verification!.stage) ?? [];
        const controlVerification = controlCandidate !== undefined &&
          exactControlContext(controlCandidate, input.candidate) && controlVerifications.length === 1
          ? controlVerifications[0]!
          : null;
        const transfers = this.#failureCueService.observeTransfer({
          projectId: input.run.projectId!,
          cueIds: input.candidate.delta.failureCueIds ?? [],
          control: controlVerification,
          candidate: input.verification,
          targetCandidateNodeId: candidate.id,
          differingFingerprintFields: this.#failureCueService.differingFingerprintFields(
            input.candidate.delta.failureCueIds ?? [],
            input.candidate.evolutionFingerprints,
          ),
        });
        payloads.push(...transfers.map((value) => ({ type: "transfer" as const, value })));
      }
      if (input.integration !== null) {
        const integration = lineageNode(input, integrationNodeFields(input, harnessVersionHash));
        payloads.push(
          { type: "node", value: integration },
          { type: "edge", value: lineageEdge(input, candidate, integration, "integrated_as") },
        );
        if (input.transition === "promoted") {
          const promotion = lineageNode(input, terminalNodeFields(input, harnessVersionHash, "promotion"));
          payloads.push(
            { type: "node", value: promotion },
            { type: "edge", value: lineageEdge(input, integration, promotion, "promoted_as") },
          );
        }
      }
      if (input.transition === "rolled_back") {
        const rollback = lineageNode(input, terminalNodeFields(input, harnessVersionHash, "rollback"));
        payloads.push(
          { type: "node", value: rollback },
          { type: "edge", value: lineageEdge(input, candidate, rollback, "rolled_back_to") },
        );
      }
      const branchReturnReason = authorizedBranchReturnReason(input);
      if (branchReturnReason !== null) {
        payloads.push(...createBranchReturn({
          projectId,
          runId: input.run.id,
          tournament: input.tournament!,
          checkpoint: input.repairCheckpoint!,
          candidate: input.candidate,
          candidateNode: candidate,
          checkpointNode: attempt,
          stopReason: branchReturnReason,
          verification: input.verification,
          integration: input.integration,
          contribution: input.contribution ?? null,
          summary: branchReturnSummary(input.candidate.delta.family, branchReturnReason),
          evidenceRefs: transitionEvidence(input),
          createdAt: stableOccurredAt(input),
        }));
      }
    }
    payloads.push({ type: "observation", value: observation(input, observationNode) });
    return deduplicatePayloads(payloads);
  }

  enqueue(state: OrchestrationState, input: EvolutionTransitionInput): EvolutionOutboxEntry {
    const records = this.build(input);
    const projectId = input.run.projectId!;
    const id = deterministicEvolutionId("evolution-outbox", {
      schemaVersion: 1,
      projectId,
      runId: input.run.id,
      recordIds: records.map((record) => record.value.id).sort(),
    });
    const existing = state.evolutionOutbox.find((entry) => entry.id === id);
    if (existing !== undefined) {
      if (canonicalSerialize(existing.records) !== canonicalSerialize(records)) {
        throw new LineageUnavailableError("Outbox ID has unequal deterministic content");
      }
      return existing;
    }
    const entry: EvolutionOutboxEntry = {
      id,
      projectId,
      runId: input.run.id,
      records,
      state: "pending",
      createdAt: input.occurredAt,
      deliveredAt: null,
      lastErrorCode: null,
    };
    assertEvolutionOutboxCapacity(state, entry);
    state.evolutionOutbox.push(entry);
    state.evolutionHistory = {
      state: "ready",
      droppedHistoryCount: state.evolutionHistory?.droppedHistoryCount ?? 0,
      droppedReason: null,
      reconciliationPending: true,
    };
    return entry;
  }

  async flush(
    runId: string,
    options: { maxEntries?: number; shouldContinue?: () => boolean } = {},
  ): Promise<{ delivered: number; deliveredIds: string[]; remaining: number }> {
    if (this.#store === null || this.#evolutionStore === null) {
      throw new LineageUnavailableError("Lineage recorder delivery is not configured");
    }
    const maxEntries = options.maxEntries ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
      throw new RangeError("Evolution flush maxEntries must be a non-negative integer");
    }
    let delivered = 0;
    const deliveredIds: string[] = [];
    while (delivered < maxEntries && (options.shouldContinue?.() ?? true)) {
      const entry = this.#store.snapshot().runs.find((run) => run.id === runId)
        ?.orchestration?.evolutionOutbox.find((candidate) => candidate.state === "pending");
      if (entry === undefined) break;
      try {
        const existingRecords = await this.#evolutionStore.recordPayloads(entry.projectId);
        assertEqualExistingRecords(entry.records, existingRecords);
        const pending = entry.records.filter((record) => !existingRecords.has(record.value.id));
        if (pending.length > 0) await this.#appendWithCompare(entry.projectId, pending);
        await this.#beforeMarkDelivered?.(entry);
        await this.#store.mutate((database) => {
          const orchestration = database.runs.find((run) => run.id === runId)?.orchestration;
          const outbox = orchestration?.evolutionOutbox;
          const index = outbox?.findIndex((candidate) => candidate.id === entry.id) ?? -1;
          const current = index < 0 ? undefined : outbox![index];
          if (current === undefined || current.state === "delivered") return;
          outbox![index] = {
            ...current,
            state: "delivered",
            deliveredAt: new Date().toISOString(),
            lastErrorCode: null,
          };
          if (orchestration && !outbox!.some((candidate) => candidate.state === "pending")) {
            orchestration.evolutionHistory = {
              state: orchestration.evolutionHistory?.state ?? "ready",
              droppedHistoryCount: orchestration.evolutionHistory?.droppedHistoryCount ?? 0,
              droppedReason: orchestration.evolutionHistory?.droppedReason ?? null,
              reconciliationPending: false,
            };
          }
        });
        delivered += 1;
        deliveredIds.push(entry.id);
      } catch (error) {
        const code = deliveryErrorCode(error);
        await this.#store.mutate((database) => {
          const outbox = database.runs.find((run) => run.id === runId)?.orchestration?.evolutionOutbox;
          const index = outbox?.findIndex((candidate) => candidate.id === entry.id) ?? -1;
          const current = index < 0 ? undefined : outbox![index];
          if (current?.state === "pending") outbox![index] = { ...current, lastErrorCode: code };
        });
        throw error;
      }
    }
    const remaining = this.#store.snapshot().runs.find((run) => run.id === runId)
      ?.orchestration?.evolutionOutbox.filter((candidate) => candidate.state === "pending").length ?? 0;
    return { delivered, deliveredIds, remaining };
  }

  #assertCandidateTruth(input: EvolutionTransitionInput): void {
    const candidate = input.candidate!;
    if (!EXECUTED_TRANSITIONS.has(input.transition)) return;
    if (candidate.attemptId === null || input.candidateRun === null ||
      input.candidateRun.id !== candidate.attemptId || input.candidateRun.parentRunId !== input.run.id ||
      input.candidateRun.projectId !== input.run.projectId) {
      throw new LineageUnavailableError("Persisted candidate child run does not match candidate attempt identity");
    }
  }

  async #appendWithCompare(projectId: string, records: EvolutionPayload[]): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const head = await this.#evolutionStore!.head(projectId);
      try {
        await this.#evolutionStore!.appendBatch({
          projectId,
          expectedHeadHash: head.segmentHash,
          records,
        });
        return;
      } catch (error) {
        if (error instanceof EvolutionStoreError && error.code === "evolution_store_compare_failed") continue;
        if (error instanceof EvolutionStoreError && error.code === "evolution_store_duplicate_record") {
          const existing = await this.#evolutionStore!.recordPayloads(projectId);
          assertEqualExistingRecords(records, existing);
          if (records.every((record) => existing.has(record.value.id))) return;
        }
        throw error;
      }
    }
    throw new LineageUnavailableError("Evolution append compare-and-append retry bound exhausted");
  }
}

export function assertEvolutionOutboxCapacity(
  state: OrchestrationState,
  entry: EvolutionOutboxEntry,
): void {
  const pending = state.evolutionOutbox.filter((candidate) => candidate.state === "pending");
  const pendingBytes = pending.reduce((total, candidate) =>
    total + Buffer.byteLength(canonicalSerialize(candidate), "utf8"), 0);
  const nextBytes = Buffer.byteLength(canonicalSerialize(entry), "utf8");
  const reason = pending.length >= EVOLUTION_MAX_OUTBOX_ENTRIES
    ? "outbox_entry_limit" as const
    : pendingBytes + nextBytes > EVOLUTION_MAX_OUTBOX_BYTES
      ? "outbox_byte_limit" as const
      : null;
  if (reason === null) return;
  state.evolutionHistory = {
    state: "unavailable",
    droppedHistoryCount: (state.evolutionHistory?.droppedHistoryCount ?? 0) + 1,
    droppedReason: reason,
    reconciliationPending: pending.length > 0,
  };
  throw new LineageUnavailableError(reason === "outbox_entry_limit"
    ? "Evolution outbox entry limit reached"
    : "Evolution outbox byte limit reached");
}

function candidateNodeFields(
  input: EvolutionTransitionInput,
  harnessVersionHash: string,
): NodeFields {
  const candidate = input.candidate!;
  const contract = input.run.orchestration?.healing.contracts.find((value) =>
    value.subtaskId === input.node.subtaskId && value.revision === input.node.revision);
  const fingerprints = candidate.evolutionFingerprints ?? buildEvolutionFingerprints({
    repositoryBaseHash: canonicalHash({
      sourceFingerprint: input.project.source.sourceFingerprint,
      baseCommit: input.project.source.baseCommit,
    }),
    contractHash: contract === undefined ? canonicalHash({ missing: "contract" }) : canonicalHash(contract),
    authorityManifestHash: canonicalHash({ missing: "authority-at-declaration" }),
    runtimeCapabilityHash: harnessVersionHash,
    faultEvidenceHash: input.fault === null ? canonicalHash({ missing: "fault" }) : canonicalHash({
      id: input.fault.id,
      class: input.fault.class,
      reasonCode: input.fault.reasonCode,
      evidenceRefs: sortedUnique(input.fault.evidenceRefs),
    }),
    mutationContentHash: validHashOrSentinel(candidate.delta.contentHash, "mutation"),
    // The transition input does not carry the complete frozen capability manifest.
    // Fail closed: reconciliation may later attach a complete v2 fingerprint.
    runtimeCapabilityComplete: false,
  });
  return {
    kind: "candidate",
    entityId: candidate.id,
    revision: input.node.revision,
    subtaskId: input.node.subtaskId,
    harnessVersionHash,
    baseCommit: input.project.source.baseCommit,
    headCommit: null,
    fingerprints,
    verificationIds: candidate.verificationIds,
    evidenceRefs: sortedUnique([
      ...(input.fault?.evidenceRefs ?? []),
      ...candidate.delta.addedEvidenceRefs,
    ]).slice(0, 200),
    changedPaths: [],
    createdAt: input.tournament?.startedAt ?? input.node.updatedAt,
  };
}

function integrationNodeFields(input: EvolutionTransitionInput, harnessVersionHash: string): NodeFields {
  const integration = input.integration!;
  return {
    kind: "integration",
    entityId: integration.contributionId,
    revision: input.node.revision,
    subtaskId: integration.subtaskId,
    harnessVersionHash,
    baseCommit: integration.canonicalHeadBefore,
    headCommit: integration.canonicalHeadAfter,
    fingerprints: null,
    verificationIds: integration.verificationIds,
    evidenceRefs: [],
    changedPaths: [],
    createdAt: input.run.createdAt,
  };
}

function terminalNodeFields(
  input: EvolutionTransitionInput,
  harnessVersionHash: string,
  kind: "promotion" | "rollback",
): NodeFields {
  return {
    kind,
    entityId: `${input.integration!.contributionId}:${kind}`,
    revision: input.node.revision,
    subtaskId: input.node.subtaskId,
    harnessVersionHash,
    baseCommit: input.integration!.canonicalHeadBefore,
    headCommit: input.integration!.canonicalHeadAfter,
    fingerprints: null,
    verificationIds: input.integration!.verificationIds,
    evidenceRefs: transitionEvidence(input),
    changedPaths: [],
    createdAt: input.tournament?.completedAt ?? input.occurredAt,
  };
}

interface NodeFields extends Omit<LineageNode, "id" | "projectId" | "sourceFingerprint" | "runId" | "faultId"> {}

function lineageNode(input: EvolutionTransitionInput, fields: NodeFields): LineageNode {
  const identity = {
    schemaVersion: 1,
    projectId: input.run.projectId!,
    runId: input.run.id,
    faultId: input.fault?.id ?? null,
    sourceFingerprint: input.project.source.sourceFingerprint,
    kind: fields.kind,
    entityId: fields.entityId,
    revision: fields.revision,
    immutableContentHash: canonicalHash({
      baseCommit: fields.baseCommit,
      headCommit: fields.headCommit,
      fingerprints: fields.fingerprints,
      verificationIds: sortedUnique(fields.verificationIds),
      evidenceRefs: sortedUnique(fields.evidenceRefs),
      changedPaths: sortedUnique(fields.changedPaths),
      createdAt: fields.createdAt,
    }),
  };
  return {
    id: deterministicEvolutionId("lineage-node", identity),
    projectId: input.run.projectId!,
    sourceFingerprint: input.project.source.sourceFingerprint,
    runId: input.run.id,
    faultId: input.fault?.id ?? null,
    ...fields,
    verificationIds: sortedUnique(fields.verificationIds),
    evidenceRefs: sortedUnique(fields.evidenceRefs)
      .filter((value) => /^[0-9a-f]{64}$/u.test(value))
      .slice(0, 200),
    changedPaths: sortedUnique(fields.changedPaths).slice(0, 200),
  };
}

function lineageEdge(
  input: EvolutionTransitionInput,
  from: LineageNode,
  to: LineageNode,
  kind: LineageEdgeKind,
): LineageEdge {
  return {
    id: deterministicEvolutionId("lineage-edge", {
      schemaVersion: 1,
      projectId: input.run.projectId!,
      fromNodeId: from.id,
      toNodeId: to.id,
      kind,
    }),
    projectId: input.run.projectId!,
    fromNodeId: from.id,
    toNodeId: to.id,
    kind,
    createdAt: to.createdAt,
  };
}

function observation(input: EvolutionTransitionInput, node: LineageNode): LineageObservation {
  const candidate = input.candidate;
  const executed = candidate !== null && EXECUTED_TRANSITIONS.has(input.transition);
  const childUsage = executed ? input.candidateRun!.usage : null;
  const occurredAt = stableOccurredAt(input);
  const terminalReason = candidate?.terminalReason ?? input.integration?.reason ?? null;
  const modelCalls = executed ? candidate!.modelCalls : 0;
  const reservedTokens = executed ? candidate!.reservedTokens : 0;
  const actualInputTokens = childUsage?.inputTokens ?? 0;
  const actualOutputTokens = childUsage?.outputTokens ?? 0;
  const elapsedMs = executed ? candidate!.elapsedMs : 0;
  return {
    id: deterministicEvolutionId("lineage-observation", {
      schemaVersion: 1,
      projectId: input.run.projectId!,
      runId: input.run.id,
      nodeId: node.id,
      revision: input.node.revision,
      transition: input.transition,
      candidateState: candidate?.state ?? null,
      immutableContentHash: canonicalHash({
        terminalReason,
        modelCalls,
        reservedTokens,
        actualInputTokens,
        actualOutputTokens,
        elapsedMs,
        occurredAt,
      }),
    }),
    projectId: input.run.projectId!,
    runId: input.run.id,
    nodeId: node.id,
    kind: input.transition,
    candidateState: candidate?.state ?? null,
    terminalReason,
    modelCalls,
    reservedTokens,
    actualInputTokens,
    actualOutputTokens,
    elapsedMs,
    occurredAt,
  };
}

function harnessHash(identity: EvolutionTransitionInput["runtimeCapabilityIdentity"]): string {
  if (identity === null || identity.manifestComplete !== true ||
    !/^[0-9a-f]{64}$/u.test(identity.runtimeCapabilityHash)) {
    throw new LineageUnavailableError("Complete frozen runtime capability identity is unavailable");
  }
  return identity.runtimeCapabilityHash;
}

function stableOccurredAt(input: EvolutionTransitionInput): string {
  if (input.transition === "promoted" || input.transition === "rolled_back") {
    return input.tournament?.completedAt ?? input.verification?.verifiedAt ?? input.node.updatedAt;
  }
  if (input.transition === "verified" || input.transition === "verifying" ||
    input.transition === "promotion_pending") {
    return input.verification?.verifiedAt ?? input.node.updatedAt;
  }
  if (input.transition === "declared") return input.tournament?.startedAt ?? input.occurredAt;
  return input.node.updatedAt ?? input.occurredAt;
}

function transitionEvidence(input: EvolutionTransitionInput): string[] {
  return sortedUnique([
    ...input.eventEvidenceRefs,
    ...(input.fault?.evidenceRefs ?? []),
    ...(input.candidate?.delta.addedEvidenceRefs ?? []),
    ...(input.verification?.gates.map((gate) => gate.evidenceRef) ?? []),
  ]).slice(0, 200);
}

function authorizedBranchReturnReason(
  input: EvolutionTransitionInput,
): "no_evidence_progress" | "protected_rejection" | "verified_rollback" | null {
  const candidate = input.candidate;
  const tournament = input.tournament;
  if (candidate === null || tournament === null ||
    input.repairCheckpoint === undefined || input.repairCheckpoint === null ||
    tournament.candidateIds.includes(candidate.id) === false ||
    tournament.checkpointId !== candidate.checkpointId ||
    !/^[0-9a-f]{64}$/u.test(candidate.repairGraphFenceHash ?? "") ||
    tournament.repairGraphFenceHash !== candidate.repairGraphFenceHash) return null;
  if (input.transition === "rejected" && candidate.state === "rejected") {
    if (candidate.terminalReason === "no_evidence_progress") return "no_evidence_progress";
    const verification = input.verification;
    if (verification !== null && verification.subjectType === "candidate" &&
      verification.subjectId === candidate.id && !verification.mandatoryPassed &&
      verification.failureKind === "deterministic_gate_failure" &&
      ["deterministic_gate_failure", "mandatory_gate_failed", "targeted_gate_failed"]
        .includes(candidate.terminalReason ?? "")) return "protected_rejection";
  }
  if (input.transition === "rolled_back" && candidate.state === "rolled_back" &&
    input.integration?.state === "rolled_back" &&
    input.contribution?.contributionId === input.integration.contributionId &&
    input.contribution.attemptId === candidate.attemptId &&
    input.integration.reason === "post_integration_verification_failed" &&
    input.verification?.subjectType === "contribution" &&
    input.verification.subjectId === input.integration.contributionId &&
    input.verification.stage === "post_integration" &&
    input.integration.verificationIds.includes(input.verification.id) &&
    !input.verification.mandatoryPassed &&
    input.verification.failureKind === "deterministic_gate_failure") return "verified_rollback";
  return null;
}

function branchReturnSummary(
  family: MutationCandidate["delta"]["family"],
  reason: "no_evidence_progress" | "protected_rejection" | "verified_rollback",
): string {
  switch (reason) {
    case "no_evidence_progress":
      return `${family} continuation stopped after no evidence progress.`;
    case "protected_rejection":
      return `${family} continuation stopped after protected verification rejection.`;
    case "verified_rollback":
      return `${family} continuation returned after verified rollback.`;
  }
}

function deduplicatePayloads(payloads: readonly EvolutionPayload[]): EvolutionPayload[] {
  const byId = new Map<string, { serialized: string; payload: EvolutionPayload }>();
  for (const payload of payloads) {
    const id = payload.value.id;
    const serialized = canonicalSerialize(payload);
    const existing = byId.get(id);
    if (existing !== undefined && existing.serialized !== serialized) {
      throw new LineageUnavailableError(`Deterministic record ID collision: ${id}`);
    }
    if (existing === undefined) byId.set(id, { serialized, payload });
  }
  return [...byId.values()].map((value) => value.payload);
}

function assertEqualExistingRecords(
  records: readonly EvolutionPayload[],
  existing: ReadonlyMap<string, EvolutionPayload>,
): void {
  for (const record of records) {
    const persisted = existing.get(record.value.id);
    if (persisted !== undefined && canonicalSerialize(persisted) !== canonicalSerialize(record)) {
      throw new LineageUnavailableError(`Persisted evolution ID has unequal deterministic content: ${record.value.id}`);
    }
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function validHashOrSentinel(value: string, label: string): string {
  return /^[0-9a-f]{64}$/u.test(value) ? value : canonicalHash({ missing: label, value });
}

function deliveryErrorCode(error: unknown): string {
  if (error instanceof EvolutionStoreError || error instanceof LineageUnavailableError) return error.code;
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && code.length > 0 ? code : "evolution_history_unavailable";
}

function exactControlContext(control: MutationCandidate, candidate: MutationCandidate): boolean {
  const left = control.evolutionFingerprints;
  const right = candidate.evolutionFingerprints;
  return left !== null && right !== null && left.schemaVersion === 2 && right.schemaVersion === 2 &&
    left.complete && right.complete &&
    left.repositoryBaseHash === right.repositoryBaseHash &&
    left.contractHash === right.contractHash &&
    left.authorityManifestHash === right.authorityManifestHash &&
    left.runtimeCapabilityHash === right.runtimeCapabilityHash &&
    left.faultEvidenceHash === right.faultEvidenceHash;
}
