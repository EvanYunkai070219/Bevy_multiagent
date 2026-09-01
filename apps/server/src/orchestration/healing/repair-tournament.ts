import { createHash, randomUUID } from "node:crypto";
import type {
  FreezeRepairCheckpointInput,
  CreateRepairCandidateInput,
  SquashRepairWinnerInput,
} from "./repair-workspaces.js";
import {
  REPAIR_CANDIDATE_STEP_CAP,
  REPAIR_CANDIDATE_TIMEOUT_MS,
  createMutationCandidates,
  enrichContextCandidateWithFailureCues,
  validateRepairMutation,
} from "./mutation-factory.js";
import { RunTerminalError, type RunControl } from "../run-control.js";
import type { RunEventDraft } from "../../run-events.js";
import type {
  AttemptWorkspaceRecord,
  ContributionRecord,
  DiagnosisRecord,
  FaultRecord,
  GateResult,
  HealingState,
  MutationCandidate,
  ProjectRunRecord,
  RepairCheckpoint,
  RepairGraphFence,
  RepairTournament,
  SubtaskContract,
  TaskNodeState,
  VerificationResult,
  WorkerResult,
} from "../../types.js";
import type {
  CandidateContextManifestV1,
  RuntimeCapabilityManifestV2,
} from "../evolution/evolution-types.js";
import type { ExactRepeatIndex } from "../evolution/exact-repeat-index.js";
import { exactRepeatKey } from "../evolution/exact-repeat-index.js";
import type { FailureCueService } from "../evolution/failure-cues.js";
import { canonicalSerialize } from "../evolution/evolution-fingerprints.js";

export interface TournamentOutcome {
  tournament: RepairTournament;
  winner: MutationCandidate | null;
  contribution: ContributionRecord | null;
  status: "promoted" | "failed" | "cancelled";
}

export interface RepairCandidateRunRequest {
  candidate: MutationCandidate;
  attempt: AttemptWorkspaceRecord;
  contract: SubtaskContract;
  control: RunControl;
  env: Record<string, string>;
  timeoutMs: number;
  stepCap: number;
  threadId: string | null;
  tools: string[];
  prompt: string;
  runtimeImageId: string | null;
}

export interface RepairCandidateRunResult {
  status: "completed" | "failed" | "cancelled";
  error?: string;
  modelCalls: number;
  reservedTokens: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  elapsedMs: number;
  output?: string;
}

export interface RepairTournamentDeps {
  mutateHealing<T>(mutate: (healing: HealingState) => T): Promise<T>;
  withAuthorityLock<T>(operation: () => Promise<T>): Promise<T>;
  freeze(input: FreezeRepairCheckpointInput): Promise<RepairCheckpoint>;
  persistBoundCheckpoint(checkpoint: RepairCheckpoint): Promise<void>;
  createCandidate(input: CreateRepairCandidateInput): Promise<AttemptWorkspaceRecord>;
  squashWinner(input: SquashRepairWinnerInput): Promise<ContributionRecord>;
  runCandidate(input: RepairCandidateRunRequest): Promise<RepairCandidateRunResult>;
  verify(input: {
    subjectType: VerificationResult["subjectType"];
    subjectId: string;
    stage: VerificationResult["stage"];
    workspacePath: string;
    baseCommit: string;
    contract: SubtaskContract;
    control: RunControl;
  }): Promise<VerificationResult>;
  settleContribution(contribution: ContributionRecord): Promise<WorkerResult>;
  loadProject(): ProjectRunRecord;
  loadAttempt(attemptId: string): AttemptWorkspaceRecord | undefined;
  persistAttempt(attempt: AttemptWorkspaceRecord): Promise<void>;
  emit(draft: RunEventDraft): void;
  authorityManifestHash: string;
  /** Legacy M2 inputs remain accepted but produce incomplete v2 checkpoints. */
  runtimeCapabilityHash?: string;
  contextEvidenceRefs?: string[];
  runtimeCapabilityManifest?: RuntimeCapabilityManifestV2;
  candidateContextManifest?: CandidateContextManifestV1;
  contextAuditEvidenceRefs?: string[];
  /** Read-only trusted-history authority. Absence/unhealthy state disables pruning. */
  exactRepeatIndex?: ExactRepeatIndex;
  /** Stable Project identity used to prevent cross-Project history reuse. */
  projectId?: string;
  /** Refreshes persisted/audited history without model or runtime work. */
  refreshEvolutionHistory?: () => Promise<void>;
  failureCueService?: FailureCueService;
  failureCueTarget?: {
    gateTier: GateResult["tier"];
    failureFingerprint: string;
  };
  /** Persists passive cue transfer only after every candidate promise settles. */
  recordPassiveTransfers?: (tournamentId: string) => Promise<void>;
  /** Persists passive branch-return history from the authoritative frozen checkpoint. */
  recordBranchReturns?: (
    checkpoint: RepairCheckpoint,
    tournamentId: string,
    contribution: ContributionRecord | null,
  ) => Promise<void>;
}

export function selectWinner(
  control: MutationCandidate,
  candidates: MutationCandidate[],
  verifications: VerificationResult[],
): MutationCandidate {
  const controlVerification = verificationOf(control, verifications);
  if (!comparableControl(control, controlVerification)) return control;

  const mutants = candidates.filter((item) => item.id !== control.id);
  const eligible: MutationCandidate[] = [];
  for (const mutant of mutants) {
    const current = verificationOf(mutant, verifications);
    if (missing(mutant, current) || !current.mandatoryPassed) continue;
    if (
      controlVerification.mandatoryPassed &&
      current.hardProgress <= controlVerification.hardProgress
    ) {
      continue;
    }
    eligible.push(mutant);
  }
  if (eligible.length === 0) return control;

  const ranked = [...eligible].sort((left, right) =>
    compareMutants(left, right, verifications),
  );
  const best = ranked[0]!;
  const runnerUp = ranked[1];
  if (runnerUp && compareMutants(best, runnerUp, verifications) === 0) return control;
  return best;
}

export class RepairTournamentRunner {
  constructor(private readonly deps: RepairTournamentDeps) {}

  async run(input: {
    runId: string;
    node: TaskNodeState;
    contract: SubtaskContract;
    fault: FaultRecord;
    diagnosis: DiagnosisRecord;
    control: RunControl;
  }): Promise<TournamentOutcome> {
    const activeFence = await this.deps.withAuthorityLock(() =>
      this.deps.mutateHealing((healing) => structuredClone(healing.repairGraphFence)),
    );
    if (activeFence !== null) return frozenOutcome(input.node, activeFence);
    const existing = await this.deps.mutateHealing((healing) =>
      healing.tournaments.find(
        (item) => item.subtaskId === input.node.subtaskId && item.revision === input.node.revision,
      ) ?? null,
    );
    if (existing) {
      return {
        tournament: existing,
        winner: null,
        contribution: null,
        status: existing.status === "promoted"
          ? "promoted"
          : existing.status === "cancelled"
            ? "cancelled"
            : "failed",
      };
    }

    const project = this.deps.loadProject();
    const attempt = this.deps.loadAttempt(input.node.attemptId ?? "");
    if (!attempt) {
      return this.failClosed(input, "failed_attempt_missing");
    }

    const tournamentId = randomUUID();
    let checkpoint: RepairCheckpoint;
    try {
      input.control.assertActive();
      checkpoint = await this.deps.freeze({
        runId: input.runId,
        project,
        node: input.node,
        attempt,
        contract: input.contract,
        authorityManifestHash: this.deps.authorityManifestHash,
        ...(this.deps.candidateContextManifest === undefined
          ? { contextEvidenceRefs: this.deps.contextEvidenceRefs ?? [] }
          : {
              candidateContextManifest: this.deps.candidateContextManifest,
              contextAuditEvidenceRefs: this.deps.contextAuditEvidenceRefs ?? [],
            }),
        ...(this.deps.runtimeCapabilityManifest === undefined
          ? { runtimeCapabilityHash: this.deps.runtimeCapabilityHash ?? "" }
          : { runtimeCapabilityManifest: this.deps.runtimeCapabilityManifest }),
      });
    } catch (error) {
      if (error instanceof RunTerminalError) return this.cancel(input, error);
      return this.failClosed(input, "checkpoint_unavailable");
    }

    const declared = createMutationCandidates({
      tournamentId,
      checkpoint,
      fault: input.fault,
      diagnosis: input.diagnosis,
      contract: input.contract,
    });
    const tournament: RepairTournament = {
      id: tournamentId,
      subtaskId: input.node.subtaskId,
      revision: input.node.revision,
      checkpointId: checkpoint.id,
      candidateIds: [declared[0].id, declared[1].id, declared[2].id],
      status: "running",
      winnerCandidateId: null,
      failureReason: null,
      startedAt: now(),
      completedAt: null,
    };

    // Refresh against the prior durable head. Declaring this tournament first
    // would append its own non-terminal lineage and force a multi-pass audit,
    // making otherwise-ready exact history unavailable to this tournament.
    let refreshSucceeded = true;
    try {
      await this.deps.refreshEvolutionHistory?.();
    } catch {
      refreshSucceeded = false;
      this.deps.exactRepeatIndex?.markUnavailable();
      this.deps.failureCueService?.markUnavailable();
    }
    const historyReady = refreshSucceeded && this.deps.exactRepeatIndex?.health() === "ready" &&
      typeof this.deps.projectId === "string" && this.deps.projectId.length > 0;

    const persisted = await this.deps.withAuthorityLock(() =>
      this.deps.mutateHealing((healing) => {
        if (healing.repairGraphFence !== null) {
          return {
            tournament: null,
            fenceHash: null,
            activeFence: structuredClone(healing.repairGraphFence),
          };
        }
        if (
          healing.tournaments.some(
            (item) => item.subtaskId === input.node.subtaskId && item.revision === input.node.revision,
          )
        ) {
          return { tournament: healing.tournaments.find(
            (item) => item.subtaskId === input.node.subtaskId && item.revision === input.node.revision,
          )!, fenceHash: null, activeFence: null };
        }
        const current = healing.nodes.find((item) => item.subtaskId === input.node.subtaskId);
        if (!current || current.revision !== input.node.revision) {
          throw new Error("repair_node_revision_mismatch");
        }
        const fence = buildRepairGraphFence(input.runId, tournamentId, healing);
        const fenceHash = hashRepairGraphFence(fence);
        checkpoint.repairGraphFenceHash = fenceHash;
        tournament.repairGraphFenceHash = fenceHash;
        healing.repairGraphFence = fence;
        healing.tournaments.push(structuredClone(tournament));
        for (const candidate of declared) {
          candidate.repairGraphFenceHash = fenceHash;
          healing.candidates.push({ ...structuredClone(candidate), state: "declared" });
        }
        current.state = "repairing";
        current.tournamentId = tournamentId;
        current.updatedAt = now();
        return { tournament, fenceHash, activeFence: null };
      }),
    );
    if (persisted.tournament === null) {
      return persisted.activeFence === null
        ? frozenOutcomeUnavailable(input.node)
        : frozenOutcome(input.node, persisted.activeFence);
    }
    if (persisted.tournament.id !== tournamentId) {
      return {
        tournament: persisted.tournament,
        winner: null,
        contribution: null,
        status: persisted.tournament.status === "promoted" ? "promoted" : "failed",
      };
    }
    try {
      await this.deps.persistBoundCheckpoint(checkpoint);
    } catch {
      return this.finish(
        input,
        tournamentId,
        "failed",
        null,
        null,
        "checkpoint_fence_persistence_failed",
      );
    }

    this.deps.emit(healingDraft(
      "repair_tournament_started",
      input.node.subtaskId,
      "Repair tournament started.",
      "ok",
      { checkpointId: checkpoint.id, tournamentId },
    ));

    try {
      input.control.assertActive();
    } catch (error) {
      if (error instanceof RunTerminalError) return this.cancel(input, error, tournament);
      throw error;
    }

    if (this.deps.exactRepeatIndex !== undefined && !historyReady) {
      this.deps.emit(healingDraft(
        "evolution_history_unavailable",
        input.node.subtaskId,
        "Evolution history is unavailable; repair candidates will execute normally.",
        "warning",
      ));
    }
    const historicalControlBaselines = new Map<string, VerificationResult>();
    if (historyReady) {
      for (const candidate of declared) {
        const fingerprints = candidate.evolutionFingerprints;
        if (fingerprints === null) continue;
        const match = this.deps.exactRepeatIndex!.find({
          projectId: this.deps.projectId!,
          sourceFingerprint: project.source.sourceFingerprint,
          fingerprints,
          candidateFamily: candidate.delta.family,
        });
        if (match === null || match.candidateFamily !== candidate.delta.family) continue;
        if (candidate.delta.family === "control") {
          const baseline = historicalControlVerification(match.verification, candidate);
          if (baseline === null) continue;
          historicalControlBaselines.set(candidate.id, baseline);
        }
        await this.patchCandidate(candidate.id, (item) => {
          item.state = "pruned_duplicate";
          item.historicalMatchRecordId = match.candidateNodeId;
          item.historicalVerificationId = match.verificationId;
        });
        this.deps.emit(healingDraft(
          "candidate_pruned_exact_repeat",
          input.node.subtaskId,
          "Candidate pruned as a trusted exact negative repeat.",
          "ok",
          {
            candidateId: candidate.id,
            candidateFamily: candidate.delta.family,
            historicalMatchRecordId: match.candidateNodeId,
            historicalVerificationId: match.verificationId,
          },
        ));
      }
    }

    let currentCandidates = await this.snapshot(tournamentId).then((value) => value.candidates);
    const contextCandidate = currentCandidates.find((candidate) =>
      candidate.delta.family === "context_patch" && candidate.state !== "pruned_duplicate");
    if (historyReady && contextCandidate?.evolutionFingerprints !== null &&
      contextCandidate !== undefined && this.deps.failureCueService !== undefined &&
      this.deps.failureCueTarget !== undefined) {
      const baseRepeatKey = exactRepeatKey(contextCandidate.evolutionFingerprints);
      if (baseRepeatKey !== null) {
        const cues = this.deps.failureCueService.select({
          projectId: this.deps.projectId!,
          sourceFingerprint: project.source.sourceFingerprint,
          contractKey: input.contract.contractKey,
          contractHash: contextCandidate.evolutionFingerprints.contractHash,
          candidateFamily: "context_patch",
          gateTier: this.deps.failureCueTarget.gateTier,
          failureFingerprint: this.deps.failureCueTarget.failureFingerprint,
          excludeExactRepeatKey: baseRepeatKey,
          limit: 3,
          fingerprints: contextCandidate.evolutionFingerprints,
        });
        if (cues.length > 0) {
          const enriched = enrichContextCandidateWithFailureCues(
            contextCandidate,
            cues,
            this.deps.failureCueService.render(cues),
          );
          validateRepairMutation(enriched, checkpoint, input.contract, input.fault);
          await this.patchCandidate(enriched.id, (item) => {
            Object.assign(item, structuredClone(enriched));
          });
          const finalMatch = enriched.evolutionFingerprints === null
            ? null
            : this.deps.exactRepeatIndex!.find({
                projectId: this.deps.projectId!,
                sourceFingerprint: project.source.sourceFingerprint,
                fingerprints: enriched.evolutionFingerprints,
                candidateFamily: "context_patch",
              });
          if (finalMatch !== null && finalMatch.candidateFamily === "context_patch") {
            await this.patchCandidate(enriched.id, (item) => {
              item.state = "pruned_duplicate";
              item.historicalMatchRecordId = finalMatch.candidateNodeId;
              item.historicalVerificationId = finalMatch.verificationId;
            });
            this.deps.emit(healingDraft(
              "candidate_pruned_exact_repeat",
              input.node.subtaskId,
              "Cue-enriched candidate pruned as a trusted exact negative repeat.",
              "ok",
              {
                candidateId: enriched.id,
                candidateFamily: enriched.delta.family,
                historicalMatchRecordId: finalMatch.candidateNodeId,
                historicalVerificationId: finalMatch.verificationId,
              },
            ));
          }
        }
      }
      currentCandidates = await this.snapshot(tournamentId).then((value) => value.candidates);
    }
    const candidatesToRun = currentCandidates.filter((candidate) => candidate.state !== "pruned_duplicate");
    if (candidatesToRun.length === 0) {
      return this.finish(
        input,
        tournamentId,
        "failed",
        null,
        null,
        "repair_exhausted_exact_repeat",
      );
    }

    const workspaces = new Map<string, AttemptWorkspaceRecord>();
    for (const candidate of candidatesToRun) {
      try {
        input.control.assertActive();
        const created = await this.deps.createCandidate({
          runId: input.runId,
          project: this.deps.loadProject(),
          checkpoint,
          candidate,
          revision: input.node.revision,
        });
        await this.deps.persistAttempt(created);
        workspaces.set(candidate.id, created);
        await this.patchCandidate(candidate.id, (item) => {
          item.state = "admitted";
          item.attemptId = created.attemptId;
        });
      } catch (error) {
        if (error instanceof RunTerminalError) return this.cancel(input, error, tournament);
        return this.failClosed(input, "candidate_workspace_rejected", tournament);
      }
    }

    const runs: Promise<void>[] = [];
    for (const candidate of candidatesToRun) {
      try {
        input.control.assertActive();
      } catch (error) {
        if (error instanceof RunTerminalError) {
          await Promise.allSettled(runs);
          return this.cancel(input, error, tournament);
        }
        throw error;
      }
      const workspace = workspaces.get(candidate.id)!;
      await this.patchCandidate(candidate.id, (item) => {
        item.state = "running";
      });
      runs.push(this.executeOne(input, candidate, workspace));
    }

    const raced = await input.control.raceOutcome(Promise.allSettled(runs));
    if (!raced.ok) {
      if (raced.error instanceof RunTerminalError) return this.cancel(input, raced.error, tournament);
      throw raced.error;
    }
    if (raced.value.some((item) => item.status === "rejected" && item.reason instanceof RunTerminalError)) {
      const terminal = raced.value.find(
        (item): item is PromiseRejectedResult =>
          item.status === "rejected" && item.reason instanceof RunTerminalError,
      );
      return this.cancel(input, terminal!.reason as RunTerminalError, tournament);
    }
    try {
      await this.deps.recordPassiveTransfers?.(tournamentId);
    } catch {
      this.deps.emit(healingDraft(
        "evolution_history_unavailable",
        input.node.subtaskId,
        "Passive transfer history is unavailable; tournament ranking is unchanged.",
        "warning",
      ));
    }
    await this.recordBranchReturns(checkpoint, tournamentId, input.node.subtaskId, null);

    const latest = await this.snapshot(tournamentId);
    const ranking = [
      ...rankingVerifications(latest.candidates, latest.verifications),
      ...historicalControlBaselines.values(),
    ];
    const selected = selectWinner(latest.candidates[0]!, latest.candidates, ranking);
    const selectedVerification = verificationOf(selected, ranking);
    if (missing(selected, selectedVerification) || !selectedVerification.mandatoryPassed) {
      return this.finish(input, tournamentId, "failed", null, null, "no_passing_candidate");
    }

    await this.patchCandidate(selected.id, (item) => {
      item.state = "promotion_pending";
    });
    await this.deps.mutateHealing((healing) => {
      const current = healing.tournaments.find((item) => item.id === tournamentId);
      if (current) {
        current.status = "promotion_pending";
        current.winnerCandidateId = selected.id;
      }
    });

    try {
      input.control.assertActive();
      const winnerAttempt = this.deps.loadAttempt(selected.attemptId ?? "") ??
        [...workspaces.values()].find((item) => item.attemptId === selected.attemptId);
      if (!winnerAttempt) {
        return this.finish(input, tournamentId, "failed", null, null, "winner_attempt_missing");
      }
      const contribution = await this.deps.squashWinner({
        project: this.deps.loadProject(),
        checkpoint,
        candidate: selected,
        attempt: winnerAttempt,
        verificationIds: selected.verificationIds,
      });
      contribution.repairGraphFenceHash = persisted.fenceHash!;
      await this.assertRepairGraphFence(tournamentId, persisted.fenceHash!);
      const settled = await this.deps.settleContribution(contribution);
      if (settled.status !== "completed") {
        const outcome = await this.finish(
          input, tournamentId, "failed", selected, contribution, settled.error ?? "integration_failed", true,
        );
        await this.recordBranchReturns(checkpoint, tournamentId, input.node.subtaskId, contribution);
        return outcome;
      }
      return this.finish(input, tournamentId, "promoted", selected, contribution, null);
    } catch (error) {
      if (error instanceof RunTerminalError) return this.cancel(input, error, tournament);
      return this.finish(
        input,
        tournamentId,
        "failed",
        selected,
        null,
        error instanceof Error ? error.message : "promotion_failed",
        true,
      );
    }
  }

  private async executeOne(
    input: {
      contract: SubtaskContract;
      control: RunControl;
    },
    candidate: MutationCandidate,
    attempt: AttemptWorkspaceRecord,
  ): Promise<void> {
    const result = await this.deps.runCandidate({
      candidate,
      attempt,
      contract: input.contract,
      control: input.control,
      env: {
        LAUNCHPAD_REPAIR_CANDIDATE: "1",
        LAUNCHPAD_COORDINATION_URL: "",
        LAUNCHPAD_COORDINATION_TOKEN: "",
      },
      timeoutMs: REPAIR_CANDIDATE_TIMEOUT_MS,
      stepCap: REPAIR_CANDIDATE_STEP_CAP,
      threadId: null,
      tools: candidate.delta.toolRoute,
      prompt: candidatePrompt(input.contract, candidate),
      runtimeImageId: this.deps.runtimeCapabilityManifest?.containerImageId ?? null,
    });
    await this.patchCandidate(candidate.id, (item) => {
      item.modelCalls = result.modelCalls;
      item.reservedTokens = result.reservedTokens;
      item.actualInputTokens = result.actualInputTokens;
      item.actualOutputTokens = result.actualOutputTokens;
      item.elapsedMs = result.elapsedMs;
      item.terminalReason = result.status === "completed" ? null : (result.error ?? result.status);
      item.state = result.status === "completed"
        ? "verifying"
        : result.status === "cancelled"
          ? "cancelled"
          : "rejected";
    });
    if (result.status !== "completed") return;
    if (malformedCommitMarker(result.output)) {
      await this.patchCandidate(candidate.id, (item) => {
        item.state = "rejected";
        item.terminalReason = "malformed_commit_marker";
      });
      return;
    }
    input.control.assertActive();
    let candidateVerification: VerificationResult;
    try {
      await this.assertRepairGraphFence(candidate.tournamentId, candidate.repairGraphFenceHash!);
      candidateVerification = await this.deps.verify({
        subjectType: "candidate",
        subjectId: candidate.id,
        stage: "candidate",
        workspacePath: attempt.workspacePath,
        baseCommit: attempt.baseCommit,
        contract: input.contract,
        control: input.control,
      });
    } catch (error) {
      if (error instanceof RunTerminalError) throw error;
      await this.patchCandidate(candidate.id, (item) => {
        item.state = "rejected";
        item.terminalReason = error instanceof Error ? error.message : "candidate_verify_failed";
      });
      return;
    }
    await this.recordVerification(candidate.id, candidateVerification);
    if (!candidateVerification.mandatoryPassed && candidate.delta.family !== "control") {
      await this.patchCandidate(candidate.id, (item) => {
        item.state = "rejected";
        if (candidateVerification.failureKind === "deterministic_gate_failure") {
          item.terminalReason = "deterministic_gate_failure";
        }
      });
      return;
    }
    input.control.assertActive();
    let finalist: VerificationResult;
    try {
      await this.assertRepairGraphFence(candidate.tournamentId, candidate.repairGraphFenceHash!);
      finalist = await this.deps.verify({
        subjectType: "candidate",
        subjectId: candidate.id,
        stage: "finalist",
        workspacePath: attempt.workspacePath,
        baseCommit: attempt.baseCommit,
        contract: input.contract,
        control: input.control,
      });
    } catch (error) {
      if (error instanceof RunTerminalError) throw error;
      await this.patchCandidate(candidate.id, (item) => {
        item.state = "rejected";
        item.terminalReason = error instanceof Error ? error.message : "finalist_verify_failed";
      });
      return;
    }
    await this.recordVerification(candidate.id, finalist);
    await this.patchCandidate(candidate.id, (item) => {
      item.state = candidateVerification.mandatoryPassed && finalist.mandatoryPassed
        ? "verified"
        : "rejected";
      if (item.state === "rejected" && item.delta.family !== "control" &&
        (candidateVerification.failureKind === "deterministic_gate_failure" ||
          finalist.failureKind === "deterministic_gate_failure")) {
        item.terminalReason = "deterministic_gate_failure";
      }
    });
  }

  private async recordBranchReturns(
    checkpoint: RepairCheckpoint,
    tournamentId: string,
    subtaskId: string,
    contribution: ContributionRecord | null,
  ): Promise<void> {
    try {
      await this.deps.recordBranchReturns?.(checkpoint, tournamentId, contribution);
    } catch {
      this.deps.emit(healingDraft(
        "evolution_history_unavailable",
        subtaskId,
        "Passive branch-return history is unavailable; tournament settlement is unchanged.",
        "warning",
      ));
    }
  }

  private async recordVerification(candidateId: string, verification: VerificationResult): Promise<void> {
    await this.deps.mutateHealing((healing) => {
      const candidate = healing.candidates.find((item) => item.id === candidateId);
      if (candidate?.repairGraphFenceHash !== undefined) {
        verification.repairGraphFenceHash = candidate.repairGraphFenceHash;
      }
      if (!healing.verifications.some((item) => item.id === verification.id)) {
        healing.verifications.push(structuredClone(verification));
      }
      if (candidate && !candidate.verificationIds.includes(verification.id)) {
        candidate.verificationIds.push(verification.id);
      }
    });
  }

  private async patchCandidate(
    candidateId: string,
    apply: (candidate: MutationCandidate) => void,
  ): Promise<void> {
    await this.deps.mutateHealing((healing) => {
      const candidate = healing.candidates.find((item) => item.id === candidateId);
      if (candidate) apply(candidate);
    });
  }

  private async snapshot(tournamentId: string): Promise<{
    tournament: RepairTournament;
    candidates: MutationCandidate[];
    verifications: VerificationResult[];
  }> {
    return this.deps.mutateHealing((healing) => {
      const tournament = healing.tournaments.find((item) => item.id === tournamentId)!;
      const candidates = tournament.candidateIds.map((id) =>
        healing.candidates.find((item) => item.id === id)!,
      );
      return {
        tournament: structuredClone(tournament),
        candidates: structuredClone(candidates),
        verifications: structuredClone(healing.verifications),
      };
    });
  }

  private async failClosed(
    input: { node: TaskNodeState },
    reason: string,
    tournament?: RepairTournament,
  ): Promise<TournamentOutcome> {
    return this.finish(input, tournament?.id ?? null, "failed", null, null, reason);
  }

  private async cancel(
    input: { node: TaskNodeState },
    _error: RunTerminalError,
    tournament?: RepairTournament,
  ): Promise<TournamentOutcome> {
    return this.finish(input, tournament?.id ?? null, "cancelled", null, null, "cancelled");
  }

  private async finish(
    input: { node: TaskNodeState },
    tournamentId: string | null,
    status: TournamentOutcome["status"],
    winner: MutationCandidate | null,
    contribution: ContributionRecord | null,
    failureReason: string | null,
    rolledBack = false,
  ): Promise<TournamentOutcome> {
    const tournament = await this.deps.withAuthorityLock(() => this.deps.mutateHealing((healing) => {
      const current = tournamentId
        ? healing.tournaments.find((item) => item.id === tournamentId)
        : undefined;
      const node = healing.nodes.find((item) => item.subtaskId === input.node.subtaskId);
      const recordedStatus: RepairTournament["status"] = rolledBack
        ? "rolled_back"
        : status === "promoted"
          ? "promoted"
          : status === "cancelled"
            ? "cancelled"
            : "failed";
      if (current) {
        if (healing.repairGraphFence?.tournamentId !== current.id) {
          throw new Error("repair_graph_fence_changed");
        }
        current.status = recordedStatus;
        current.winnerCandidateId = winner?.id ?? current.winnerCandidateId;
        current.failureReason = failureReason;
        current.completedAt = now();
      }
      if (winner) {
        const candidate = healing.candidates.find((item) => item.id === winner.id);
        if (candidate) {
          candidate.state = status === "promoted" ? "promoted" : rolledBack ? "rolled_back" : candidate.state;
        }
      }
      if (status === "cancelled") {
        for (const candidate of healing.candidates.filter((item) => item.tournamentId === tournamentId)) {
          if (candidate.state === "running" || candidate.state === "admitted" || candidate.state === "declared") {
            candidate.state = "cancelled";
          }
        }
      }
      if (node && node.revision === input.node.revision) {
        node.state = status === "promoted" ? "completed" : "failed";
        node.updatedAt = now();
        if (status === "promoted" && contribution) {
          node.integrationContributionId = contribution.contributionId;
        }
      }
      if (current) healing.repairGraphFence = null;
      return current
        ? structuredClone(current)
        : {
            id: tournamentId ?? "undeclared",
            subtaskId: input.node.subtaskId,
            revision: input.node.revision,
            checkpointId: null,
            candidateIds: ["", "", ""] as [string, string, string],
            status: recordedStatus,
            winnerCandidateId: winner?.id ?? null,
            failureReason,
            startedAt: null,
            completedAt: now(),
          };
    }));
    return {
      tournament,
      winner: status === "promoted" ? winner : rolledBack ? winner : status === "failed" && winner ? winner : null,
      contribution: status === "promoted" ? contribution : null,
      status,
    };
  }

  private async assertRepairGraphFence(tournamentId: string, fenceHash: string): Promise<void> {
    await this.deps.withAuthorityLock(() => this.deps.mutateHealing((healing) => {
      const fence = healing.repairGraphFence;
      if (fence === null || fence.tournamentId !== tournamentId || hashRepairGraphFence(fence) !== fenceHash) {
        throw new Error("repair_graph_fence_changed");
      }
    }));
  }
}

export function buildRepairGraphFence(
  runId: string,
  tournamentId: string,
  healing: HealingState,
  admittedAt: string = now(),
): RepairGraphFence {
  const contractHashes = healing.contracts.map((contract) => sha256(canonicalSerialize(contract)));
  const graph = healing.nodes.map((node) => ({
    subtaskId: node.subtaskId,
    revision: node.revision,
    dependencyIds: [...(healing.contracts.find((contract) => contract.subtaskId === node.subtaskId)
      ?.dependencyIds ?? [])],
  }));
  return {
    runId,
    tournamentId,
    graphRevision: healing.nodes.length,
    graphHash: sha256(canonicalSerialize(graph)),
    contractHashes,
    admittedAt,
  };
}

export function hashRepairGraphFence(fence: RepairGraphFence): string {
  return sha256(canonicalSerialize(fence));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function frozenOutcome(node: TaskNodeState, fence: RepairGraphFence): TournamentOutcome {
  return {
    tournament: {
      id: fence.tournamentId,
      subtaskId: node.subtaskId,
      revision: node.revision,
      checkpointId: null,
      candidateIds: ["", "", ""],
      status: "failed",
      winnerCandidateId: null,
      failureReason: "repair_graph_frozen",
      startedAt: null,
      completedAt: null,
      repairGraphFenceHash: hashRepairGraphFence(fence),
    },
    winner: null,
    contribution: null,
    status: "failed",
  };
}

function frozenOutcomeUnavailable(node: TaskNodeState): TournamentOutcome {
  return {
    tournament: {
      id: "undeclared",
      subtaskId: node.subtaskId,
      revision: node.revision,
      checkpointId: null,
      candidateIds: ["", "", ""],
      status: "failed",
      winnerCandidateId: null,
      failureReason: "repair_graph_fence_changed",
      startedAt: null,
      completedAt: null,
    },
    winner: null,
    contribution: null,
    status: "failed",
  };
}

function candidatePrompt(contract: SubtaskContract, candidate: MutationCandidate): string {
  return [
    "Repair the failed subtask " + contract.subtaskId + " from the frozen checkpoint.",
    candidate.delta.instructionPatch,
    "Expected effect: " + candidate.delta.expectedEffect,
  ].filter((line) => line.trim().length > 0).join("\n");
}

function rankingVerifications(
  candidates: MutationCandidate[],
  verifications: VerificationResult[],
): VerificationResult[] {
  return candidates.map((candidate, index) => {
    if (index === 0) {
      if (candidate.state !== "verified" && candidate.state !== "rejected") return undefined;
    } else if (candidate.state !== "verified") {
      return undefined;
    }
    const owned = verifications.filter((item) => item.subjectId === candidate.id);
    const finalists = owned.filter((item) => item.stage === "finalist");
    const candidateStage = owned.filter(
      (item) => item.stage === "candidate",
    );
    const base = finalists.length === 1 ? finalists[0] : undefined;
    if (!base || !consistentVerificationVerdict(base)) return undefined;
    const ranked = {
      ...base,
      modelCalls: candidate.modelCalls,
      reservedTokens: candidate.reservedTokens,
      actualInputTokens: candidate.actualInputTokens,
      actualOutputTokens: candidate.actualOutputTokens,
      elapsedMs: candidate.elapsedMs,
    };
    if (index === 0 && candidate.state === "rejected" && base.mandatoryPassed) {
      const candidateResult = candidateStage.length === 1 ? candidateStage[0] : undefined;
      if (
        !candidateResult ||
        !consistentVerificationVerdict(candidateResult) ||
        candidateResult.mandatoryPassed ||
        candidateResult.failureKind !== "deterministic_gate_failure"
      ) {
        return undefined;
      }
      return {
        ...ranked,
        mandatoryPassed: false,
        failureKind: "deterministic_gate_failure" as const,
      };
    }
    return ranked;
  }).filter((item): item is VerificationResult => item !== undefined);
}

function verificationOf(
  candidate: MutationCandidate,
  verifications: VerificationResult[],
): VerificationResult | undefined {
  const finalists = verifications.filter(
    (item) => item.subjectId === candidate.id && item.stage === "finalist",
  );
  return finalists.length === 1 ? finalists[0] : undefined;
}

function missing(
  candidate: MutationCandidate,
  result: VerificationResult | undefined,
): result is undefined {
  if (!result) return true;
  if (candidate.state !== "verified") return true;
  return missingComparisonFields(candidate, result);
}

function comparableControl(
  candidate: MutationCandidate,
  result: VerificationResult | undefined,
): result is VerificationResult {
  if (!result || candidate.terminalReason !== null) return false;
  if (missingComparisonFields(candidate, result)) return false;
  if (candidate.state === "verified") return result.failureKind !== "authority_failure";
  return (candidate.state === "rejected" || candidate.state === "pruned_duplicate") &&
    !result.mandatoryPassed &&
    result.failureKind === "deterministic_gate_failure";
}

function historicalControlVerification(
  result: VerificationResult | null,
  candidate: MutationCandidate,
): VerificationResult | null {
  if (result == null || result.subjectType !== "candidate" || result.mandatoryPassed ||
    result.failureKind !== "deterministic_gate_failure" ||
    !result.gates.some((gate) => !gate.passed && gate.failureFingerprint !== null) ||
    candidate.evolutionFingerprints === null ||
    result.authorityManifestHash !== candidate.evolutionFingerprints.authorityManifestHash ||
    !consistentVerificationVerdict(result) ||
    [result.hardProgress, result.regressionCount].some((value) =>
      !Number.isSafeInteger(value) || value < 0)) return null;
  return {
    ...structuredClone(result),
    subjectId: candidate.id,
    stage: "finalist",
  };
}

function missingComparisonFields(
  candidate: MutationCandidate,
  result: VerificationResult,
): boolean {
  if (!consistentVerificationVerdict(result)) return true;
  return [
    result.mandatoryPassed,
    result.hardProgress,
    result.regressionCount,
    candidate.modelCalls,
    candidate.actualInputTokens,
    candidate.actualOutputTokens,
    candidate.elapsedMs,
  ].some((value) => value === undefined || value === null || Number.isNaN(value as number));
}

function consistentVerificationVerdict(result: VerificationResult): boolean {
  if (result.mandatoryPassed) return result.failureKind === null;
  return result.failureKind === "deterministic_gate_failure" ||
    result.failureKind === "authority_failure";
}

function compareMutants(
  left: MutationCandidate,
  right: MutationCandidate,
  verifications: VerificationResult[],
): number {
  const a = verificationOf(left, verifications)!;
  const b = verificationOf(right, verifications)!;
  if (a.hardProgress !== b.hardProgress) return b.hardProgress - a.hardProgress;
  if (a.regressionCount !== b.regressionCount) return a.regressionCount - b.regressionCount;
  if (left.modelCalls !== right.modelCalls) return left.modelCalls - right.modelCalls;
  const aTokens = left.actualInputTokens + left.actualOutputTokens;
  const bTokens = right.actualInputTokens + right.actualOutputTokens;
  if (aTokens !== bTokens) return aTokens - bTokens;
  if (left.elapsedMs !== right.elapsedMs) return left.elapsedMs - right.elapsedMs;
  return 0;
}

function malformedCommitMarker(output: string | undefined): boolean {
  if (!output) return false;
  return output.replace(/\r\n/g, "\n").split("\n").some((line) => {
    if (!/^\s*launchpad_commit\b/i.test(line)) return false;
    if (line === "LAUNCHPAD_COMMIT=<40 lowercase hex SHA>") return false;
    return !/^LAUNCHPAD_COMMIT=[0-9a-f]{40}$/.test(line.trim());
  });
}

function healingDraft(
  name: string,
  subtaskId: string,
  text: string,
  status: RunEventDraft["status"],
  attributes: Record<string, unknown> = {},
): RunEventDraft {
  const timestamp = now();
  return {
    spanId: "healing-" + name + "-" + subtaskId,
    parentSpanId: "run",
    kind: "delegation",
    name,
    status,
    startedAt: timestamp,
    endedAt: timestamp,
    durationMs: 0,
    input: {},
    output: { text },
    error: status === "error" || status === "warning" ? { message: text, code: name } : null,
    attributes: { subtaskId, ...attributes },
    usage: null,
  };
}

const now = () => new Date().toISOString();
