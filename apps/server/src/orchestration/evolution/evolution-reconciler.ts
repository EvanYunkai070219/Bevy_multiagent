import { createHash } from "node:crypto";
import type { JsonStore } from "../../store.js";
import type { AgentRun, MutationCandidate, TaskNodeState } from "../../types.js";
import type { EvolutionStore } from "./evolution-store.js";
import type { EvidenceStore } from "../verification/evidence-store.js";
import { EvolutionProjector } from "./evolution-projector.js";
import {
  deterministicEvolutionId,
  type EvolutionPayload,
  type EvolutionReconciliationCheckpoint,
  type QuarantineRecord,
} from "./evolution-types.js";
import type {
  HistoricalAuditDecision,
  HistoricalEvidenceAuditor,
} from "./historical-evidence-auditor.js";
import type { EvolutionTransitionInput, LineageRecorder } from "./lineage-recorder.js";
import type { ExactRepeatIndex } from "./exact-repeat-index.js";
import type { FailureCueService } from "./failure-cues.js";

const MAX_RECONCILIATION_ITEMS = 100;
const MAX_RECONCILIATION_MS = 5_000;

export function evolutionRunGroupFingerprint(run: AgentRun, runs: readonly AgentRun[]): string {
  const children = runs
    .filter((item) => item.parentRunId === run.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify({ run, children })).digest("hex");
}

export class EvolutionReconciler {
  readonly #store: JsonStore;
  readonly #evolutionStore: EvolutionStore;
  readonly #recorder: LineageRecorder;
  readonly #auditor: HistoricalEvidenceAuditor | null;
  readonly #exactRepeatIndex: ExactRepeatIndex | null;
  readonly #failureCueService: FailureCueService | null;
  readonly #evidenceStore: EvidenceStore | null;
  readonly #afterSnapshot: ((runId: string) => void | Promise<void>) | undefined;
  readonly #now: () => number;

  constructor(options: {
    store: JsonStore;
    evolutionStore: EvolutionStore;
    lineageRecorder: LineageRecorder;
    auditor?: HistoricalEvidenceAuditor;
    exactRepeatIndex?: ExactRepeatIndex;
    failureCueService?: FailureCueService;
    evidenceStore?: EvidenceStore;
    afterSnapshot?: (runId: string) => void | Promise<void>;
    now?: () => number;
  }) {
    this.#store = options.store;
    this.#evolutionStore = options.evolutionStore;
    this.#recorder = options.lineageRecorder;
    this.#auditor = options.auditor ?? null;
    this.#exactRepeatIndex = options.exactRepeatIndex ?? null;
    this.#failureCueService = options.failureCueService ?? null;
    this.#evidenceStore = options.evidenceStore ?? null;
    this.#afterSnapshot = options.afterSnapshot;
    this.#now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await this.#evidenceStore?.initialize();
    await this.#evolutionStore.initialize();
  }

  async reconcile(): Promise<{
    deliveredOutboxIds: string[];
    backfilledRunIds: string[];
    quarantineIds: string[];
    unavailableProjectIds: string[];
  }> {
    const delivered = new Set<string>();
    const backfilled = new Set<string>();
    const quarantineIds = new Set<string>();
    const unavailable = new Set<string>();
    const trustedRecords: EvolutionPayload[] = [];
    const evidencePins = new Set<string>();
    const auditDecisions: HistoricalAuditDecision[] = [];
    const pendingRunIds = new Set<string>();
    const pendingProjectIds = new Set<string>();
    const startedAt = this.#now();
    let processed = 0;
    let reconciliationIncomplete = false;
    const exhausted = () => processed >= MAX_RECONCILIATION_ITEMS ||
      this.#now() - startedAt >= MAX_RECONCILIATION_MS;
    const snapshot = this.#store.snapshot();
    const groups = snapshot.runs
      .filter((run) => run.parentRunId === null && run.projectId !== null && needsGroupReconciliation(run))
      .map((run) => ({ runId: run.id, fingerprint: evolutionRunGroupFingerprint(run, snapshot.runs) }));

    for (const group of groups) {
      if (exhausted()) {
        reconciliationIncomplete = true;
        break;
      }
      try {
        await this.#afterSnapshot?.(group.runId);
        const result = await this.#store.mutate((database) => {
          const run = database.runs.find((value) => value.id === group.runId);
          if (!run || evolutionRunGroupFingerprint(run, database.runs) !== group.fingerprint) {
            return { stale: true, pending: [] as string[], added: 0 };
          }
          const pendingBefore = run.orchestration?.evolutionOutbox.filter((entry) => entry.state === "pending") ?? [];
          let added = 0;
          if (run.status === "completed" && run.project && run.orchestration) {
            for (const input of legacyTransitions(run, database.runs)) {
              const size = run.orchestration.evolutionOutbox.length;
              this.#recorder.enqueue(run.orchestration, input);
              if (run.orchestration.evolutionOutbox.length > size) added += 1;
            }
          }
          const pending = run.orchestration?.evolutionOutbox
            .filter((entry) => entry.state === "pending")
            .map((entry) => entry.id) ?? [];
          return { stale: false, pending: [...new Set([...pendingBefore.map((entry) => entry.id), ...pending])], added };
        });
        if (result.stale) continue;
        if (result.added > 0) backfilled.add(group.runId);
        if (result.pending.length > 0) {
          const flush = await this.#recorder.flush(group.runId, {
            maxEntries: Math.max(0, MAX_RECONCILIATION_ITEMS - processed),
            shouldContinue: () => this.#now() - startedAt < MAX_RECONCILIATION_MS,
          });
          processed += flush.delivered;
          for (const id of flush.deliveredIds) delivered.add(id);
          if (flush.remaining > 0) {
            reconciliationIncomplete = true;
            pendingRunIds.add(group.runId);
          }
        }
      } catch {
        const projectId = snapshot.runs.find((run) => run.id === group.runId)?.projectId;
        if (projectId) unavailable.add(projectId);
      }
    }

    for (const project of this.#store.snapshot().projects) {
      if (exhausted()) {
        reconciliationIncomplete = true;
        break;
      }
      processed += 1;
      try {
        const head = await this.#evolutionStore.head(project.id);
        let checkpoint = this.#checkpoint(project.id);
        if (checkpoint === null || checkpoint.targetHeadHash !== head.segmentHash ||
          checkpoint.targetSequence !== head.sequence) {
          checkpoint = {
            projectId: project.id,
            targetHeadHash: head.segmentHash,
            targetSequence: head.sequence,
            nextSequence: 0,
            phase: head.sequence === 0 ? "complete" : "collecting",
            auditOffset: 0,
            records: [],
            auditDecisions: [],
            quarantines: [],
            complete: head.sequence === 0,
          };
          await this.#persistCheckpoint(checkpoint);
        }
        if (checkpoint.phase === "collecting") {
          const remaining = Math.max(0, MAX_RECONCILIATION_ITEMS - processed);
          if (remaining === 0 || exhausted()) {
            reconciliationIncomplete = true;
            pendingProjectIds.add(project.id);
            continue;
          }
          const page = await this.#evolutionStore.read({
            projectId: project.id,
            afterSequence: checkpoint.nextSequence,
            limit: Math.min(200, remaining),
          });
          for (const segmentHash of page.health.quarantinableSegmentHashes) {
            quarantineIds.add(deterministicEvolutionId("corrupt-evolution-segment", {
              projectId: project.id,
              segmentHash,
            }));
          }
          if (page.health.state !== "ready") {
            unavailable.add(project.id);
            continue;
          }
          const nextSequence = page.nextSequence ?? checkpoint.targetSequence;
          checkpoint = {
            ...checkpoint,
            nextSequence,
            records: [...checkpoint.records, ...page.records],
            phase: nextSequence >= checkpoint.targetSequence ? "auditing" : "collecting",
          };
          processed += page.records.length;
          await this.#persistCheckpoint(checkpoint);
          reconciliationIncomplete = true;
          pendingProjectIds.add(project.id);
          continue;
        }
        if (checkpoint.phase === "auditing") {
          const decisions = [...checkpoint.auditDecisions];
          const quarantines = [...checkpoint.quarantines];
          let offset = checkpoint.auditOffset;
          for (; offset < checkpoint.records.length; offset += 1) {
            const payload = checkpoint.records[offset]!;
            if (payload.type !== "node" || payload.value.kind !== "candidate") continue;
            if (exhausted()) break;
            processed += 1;
            const root = this.#store.snapshot().runs.find((run) => run.id === payload.value.runId);
            const fault = root?.orchestration?.healing.faults.find((value) =>
              value.id === payload.value.faultId) ?? null;
            const relatedRecords = checkpoint.records.filter(
              (record): record is Extract<EvolutionPayload, { type: "node" }> =>
                record.type === "node" && record.value.kind === "candidate" &&
                record.value.runId === payload.value.runId && record.value.entityId === payload.value.entityId,
            ).map((record) => record.value);
            const relatedNodeIds = new Set(relatedRecords.map((record) => record.id));
            const observations = checkpoint.records.filter(
              (record): record is Extract<EvolutionPayload, { type: "observation" }> =>
                record.type === "observation" && relatedNodeIds.has(record.value.nodeId),
            ).map((record) => record.value);
            const rolledBack = observations.some((value) => value.kind === "rolled_back");
            const verification = [...(root?.orchestration?.healing.verifications ?? [])].reverse().find((value) =>
              payload.value.verificationIds.includes(value.id) &&
              value.subjectType === "candidate" &&
              value.subjectId === payload.value.entityId &&
              (rolledBack
                ? value.mandatoryPassed === true && value.failureKind === null
                : value.mandatoryPassed === false && value.failureKind === "deterministic_gate_failure")) ?? null;
            const decision = await this.#auditor!.audit({
              project, record: payload.value, relatedRecords, observations, verification, fault,
            });
            decisions.push(decision);
            if (decision.quarantine) quarantines.push(decision.quarantine);
          }
          checkpoint = {
            ...checkpoint,
            auditOffset: offset,
            auditDecisions: decisions,
            quarantines,
            phase: offset >= checkpoint.records.length ? "complete" : "auditing",
            complete: offset >= checkpoint.records.length,
          };
          await this.#persistCheckpoint(checkpoint);
          if (!checkpoint.complete) {
            reconciliationIncomplete = true;
            pendingProjectIds.add(project.id);
            continue;
          }
        }
        for (const segmentHash of (await this.#evolutionStore.read({
          projectId: project.id, afterSequence: checkpoint.targetSequence, limit: 1,
        })).health.quarantinableSegmentHashes) {
          quarantineIds.add(deterministicEvolutionId("corrupt-evolution-segment", {
            projectId: project.id,
            segmentHash,
          }));
        }
        if (this.#auditor === null || !checkpoint.complete) {
          unavailable.add(project.id);
          continue;
        }
        for (const hash of new EvolutionProjector().referencedEvidenceHashes(checkpoint.records)) {
          evidencePins.add(hash);
        }
        const appendedQuarantines = await this.#appendQuarantines(
          project.id,
          checkpoint.quarantines,
          quarantineIds,
        );
        if (appendedQuarantines.length > 0) {
          const updatedHead = await this.#evolutionStore.head(project.id);
          checkpoint = {
            ...checkpoint,
            targetHeadHash: updatedHead.segmentHash,
            targetSequence: updatedHead.sequence,
            nextSequence: updatedHead.sequence,
            auditOffset: checkpoint.records.length + appendedQuarantines.length,
            records: [...checkpoint.records, ...appendedQuarantines],
          };
          await this.#persistCheckpoint(checkpoint);
        }
        trustedRecords.push(...checkpoint.records);
        auditDecisions.push(...checkpoint.auditDecisions as HistoricalAuditDecision[]);
      } catch {
        unavailable.add(project.id);
      }
    }
    await this.#evidenceStore?.cleanupTemps({ pinnedHashes: evidencePins }).catch(() => undefined);
    if (unavailable.size > 0 || reconciliationIncomplete) {
      if (reconciliationIncomplete) {
        for (const run of this.#store.snapshot().runs) {
          if (run.parentRunId === null && needsGroupReconciliation(run)) pendingRunIds.add(run.id);
        }
      }
      await this.#recordUnavailableHealth(
        unavailable,
        pendingRunIds,
        pendingProjectIds,
      ).catch(() => undefined);
    }
    const refreshAvailable = unavailable.size === 0 && !reconciliationIncomplete;
    if (this.#exactRepeatIndex !== null && refreshAvailable) {
      this.#exactRepeatIndex.rebuild(trustedRecords, auditDecisions);
    } else if (!refreshAvailable) {
      this.#exactRepeatIndex?.markUnavailable();
    }
    if (this.#failureCueService !== null && refreshAvailable) {
      this.#failureCueService.rebuild(
        trustedRecords.filter((payload): payload is Extract<EvolutionPayload, { type: "cue" }> =>
          payload.type === "cue").map((payload) => payload.value),
        auditDecisions,
      );
    } else if (!refreshAvailable) {
      this.#failureCueService?.markUnavailable();
    }
    return {
      deliveredOutboxIds: [...delivered].sort(),
      backfilledRunIds: [...backfilled].sort(),
      quarantineIds: [...quarantineIds].sort(),
      unavailableProjectIds: [...unavailable].sort(),
    };
  }

  #checkpoint(projectId: string): EvolutionReconciliationCheckpoint | null {
    return this.#store.snapshot().evolutionReconciliation?.[projectId] ?? null;
  }

  async #persistCheckpoint(checkpoint: EvolutionReconciliationCheckpoint): Promise<void> {
    await this.#store.mutate((database) => {
      database.evolutionReconciliation ??= {};
      database.evolutionReconciliation[checkpoint.projectId] = structuredClone(checkpoint);
    });
  }

  async #recordUnavailableHealth(
    projectIds: ReadonlySet<string>,
    pendingRunIds: ReadonlySet<string>,
    pendingProjectIds: ReadonlySet<string>,
  ): Promise<void> {
    await this.#store.mutate((database) => {
      for (const run of database.runs) {
        if (!run.orchestration || run.projectId === null) continue;
        const pending = pendingRunIds.has(run.id) || pendingProjectIds.has(run.projectId) ||
          run.orchestration.evolutionOutbox.some((entry) => entry.state === "pending");
        if (!projectIds.has(run.projectId) && !pending) continue;
        const previous = run.orchestration.evolutionHistory;
        run.orchestration.evolutionHistory = {
          state: projectIds.has(run.projectId) ? "unavailable" : previous?.state ?? "ready",
          droppedHistoryCount: previous?.droppedHistoryCount ?? 0,
          droppedReason: projectIds.has(run.projectId) ? "store_unavailable" : previous?.droppedReason ?? null,
          reconciliationPending: pending,
        };
      }
    });
  }

  async #appendQuarantines(
    projectId: string,
    values: readonly QuarantineRecord[],
    ids: Set<string>,
  ): Promise<EvolutionPayload[]> {
    if (values.length === 0) return [];
    const existing = await this.#evolutionStore.recordIds(projectId);
    const records = values.filter((value) => !existing.has(value.id)).map((value) => ({
      type: "quarantine" as const,
      value,
    }));
    if (records.length > 0) {
      const head = await this.#evolutionStore.head(projectId);
      await this.#evolutionStore.appendBatch({ projectId, expectedHeadHash: head.segmentHash, records });
    }
    for (const value of values) ids.add(value.id);
    return records;
  }
}

function needsGroupReconciliation(run: AgentRun): boolean {
  const orchestration = run.orchestration;
  if (!orchestration || !run.project) return false;
  if (orchestration.evolutionOutbox.some((entry) => entry.state === "pending")) return true;
  if (run.status !== "completed" || orchestration.evolutionOutbox.length > 0) return false;
  return orchestration.healing.candidates.some((candidate) =>
    candidate.state === "rejected" || candidate.state === "cancelled" ||
    candidate.state === "promoted" || candidate.state === "rolled_back");
}

function legacyTransitions(root: AgentRun, runs: readonly AgentRun[]): EvolutionTransitionInput[] {
  const state = root.orchestration!;
  const project = root.project!;
  const terminal = new Set<MutationCandidate["state"]>(["rejected", "cancelled", "promoted", "rolled_back"]);
  const inputs: EvolutionTransitionInput[] = [];
  for (const candidate of state.healing.candidates.filter((value) => terminal.has(value.state))) {
    const tournament = state.healing.tournaments.find((value) => value.id === candidate.tournamentId);
    const node = state.healing.nodes.find((value) => value.tournamentId === candidate.tournamentId);
    if (!tournament || !node) continue;
    const candidateRun = candidate.attemptId === null ? null : runs.find((value) => value.id === candidate.attemptId) ?? null;
    if (candidate.state !== "cancelled" && candidateRun === null) continue;
    const integration = candidate.state === "promoted" || candidate.state === "rolled_back"
      ? project.integrations.find((value) => value.contributionId === node.integrationContributionId) ?? null
      : null;
    if ((candidate.state === "promoted" || candidate.state === "rolled_back") && integration === null) continue;
    const verification = state.healing.verifications.find((value) => candidate.verificationIds.includes(value.id)) ?? null;
    inputs.push({
      run: root,
      project,
      node: node as TaskNodeState,
      fault: state.healing.faults.find((value) => value.id === node.faultId) ?? null,
      candidate,
      tournament,
      verification,
      integration,
      candidateRun,
      transition: terminalTransition(candidate.state),
      eventEvidenceRefs: [],
      occurredAt: root.completedAt ?? root.createdAt,
      runtimeCapabilityIdentity: candidate.evolutionFingerprints === null
        ? null
        : {
            runtimeCapabilityHash: candidate.evolutionFingerprints.runtimeCapabilityHash,
            manifestComplete: candidate.evolutionFingerprints.complete,
          },
    });
  }
  return inputs;
}

function terminalTransition(state: MutationCandidate["state"]): "rejected" | "cancelled" | "promoted" | "rolled_back" {
  if (state === "rejected" || state === "cancelled" || state === "promoted" || state === "rolled_back") return state;
  throw new Error("Nonterminal candidate cannot be backfilled");
}
