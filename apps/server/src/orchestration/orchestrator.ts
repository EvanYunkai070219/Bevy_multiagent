/**
 * The leader loop: plan, admit, dispatch, evaluate, synthesise.
 *
 * Two dispatch paths live here and they are not variants of each other. The
 * planned path runs a validated dependency graph wave by wave. The live path
 * lets a Codex leader dispatch workers as it goes, which means the graph grows
 * while it is being executed and every admission has to be checked against what
 * has already started.
 *
 * Almost every prompt the leader and its workers see is constructed in this
 * file, which is a large part of why it is 6k lines. The seams worth splitting
 * along are visible: the loop, live dispatch, the healing hooks, and prompt
 * construction. That split has not been done because a structural change here
 * is the highest-risk edit in the repository.
 *
 * See `README.md` in this directory for the module map.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EventLog } from "../event-log.js";
import { RunCancelledError } from "../errors.js";
import type { ModelCredentialIssuer } from "../model-proxy.js";
import type { RunEvent, RunEventDraft, RunEventSink } from "../run-events.js";
import { JsonStore, mergeEvolutionOutboxes } from "../store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  EvaluationRecord,
  ExecutionPolicy,
  IterationPlan,
  LeaderSubtask,
  OrchestrationState,
  OrchestrationUsage,
  RunnerResult,
  SkillInjectionPlan,
  RunUsage,
  WorkerResult,
  WorkerValidation,
} from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { Evaluator } from "./leader/evaluator.js";
import {
  EVALUATOR_PROMPT_VERSION,
  HARNESS_VERSION,
  PLANNER_PROMPT_VERSION,
  REPLANNER_PROMPT_VERSION,
  SYNTHESIZER_PROMPT_VERSION,
  DIAGNOSER_PROMPT_VERSION,
  REPAIR_CANDIDATE_PROMPT_VERSION,
  defaultExecutionPolicy,
} from "./policies.js";
import { Planner } from "./leader/planner.js";
import { Replanner } from "./leader/replanner.js";
import { Scheduler, classifyWorkerError } from "./scheduler.js";
import { Synthesizer } from "./leader/synthesizer.js";
import { WorkerResolver } from "./workers/worker-resolver.js";
import { validateWorker } from "./workers/worker-validator.js";
import { resolveOutcome } from "./healing/outcome-resolver.js";
import { isSkillCreationRequest } from "./skill-creation.js";
import {
  isSharedWorkspaceDeliverableRequest,
  requiresProjectContributionRequest,
} from "./project-contribution-intent.js";
import { ExecRuntime } from "../runtime/exec-runtime.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { TeamMessageQueued } from "../coordination/messages.js";
import { TeamJournal } from "../coordination/team-journal.js";
import { TeamCoordinationRuntime } from "../coordination/team-runtime.js";
import {
  CoordinationIngress,
  type DispatchSubagentRequest,
  type ExtendWorkerTimeoutRequest,
  type InspectWorkerRequest,
  type WaitWorkersRequest,
} from "../coordination/ingress.js";
import { AttemptWorkspaceManager } from "../attempt-workspace-manager.js";
import { GitClient } from "../git-client.js";
import { compactEventText } from "../event-log.js";
import { baselineCandidate, type ProjectRegistry } from "../project-registry.js";
import { ContributionCollector, ContributionError } from "../contribution-collector.js";
import { ContributionIntegrator } from "../contribution-integrator.js";
import { ProjectAttemptExecutor } from "../project-attempt-executor.js";
import type {
  AttemptWorkspaceRecord,
  ContributionRecord,
  DiagnosisRecord,
  EvidenceSnapshot,
  FaultRecord,
  HealingState,
  IntegrationRecord,
  ProjectRunRecord,
  RepairCheckpoint,
  SubtaskContract,
  TaskNodeState,
  TaskNodeStatus,
  VerificationResult,
} from "../types.js";
import { emptyHealingState, verificationDenial } from "../types.js";
import { LiveDagAdmission, leaderDispatchSubtask } from "./live-dag-admission.js";
import type { ContractCatalogEntry } from "./healing/contract-compiler.js";
import {
  RunControl,
  RunTerminalError,
  type RunClock,
} from "./run-control.js";
import { emitBudgetTerminal } from "./workers/budget-events.js";
import { TrajectoryMonitor, type TrajectoryClock } from "./workers/trajectory.js";
import {
  detectFault,
  persistFaultEvidence,
  TrajectoryStoppedError,
  type FaultEvidenceStore,
} from "./healing/fault-detector.js";
import { Diagnoser } from "./healing/diagnoser.js";
import {
  HealingCoordinator,
  leaderMayInterpretResults,
  type HealingAdmission,
} from "./healing/healing-coordinator.js";
import {
  hashRepairGraphFence,
  RepairTournamentRunner,
  type RepairCandidateRunRequest,
  type RepairCandidateRunResult,
  type RepairTournamentDeps,
  type TournamentOutcome,
} from "./healing/repair-tournament.js";
import { RepairWorkspaceManager } from "./healing/repair-workspaces.js";
import {
  REPAIR_CANDIDATE_STEP_CAP,
  REPAIR_CANDIDATE_TIMEOUT_MS,
  REPAIR_EXCLUDED_TOOLS,
} from "./healing/mutation-factory.js";
import { WORKER_ADVISORY_CALLS, WORKER_ADVISORY_TOKENS } from "./workers/budget.js";
import type {
  CandidateContextManifestV1,
  RepairRuntimeCapabilityEnvironmentV1,
} from "./evolution/evolution-types.js";
import { buildCandidateContextManifest, candidateContextHash } from "./healing/candidate-context-manifest.js";
import { buildRuntimeCapabilityManifest } from "./evolution/evolution-fingerprints.js";
import {
  LineageRecorder,
  type EvolutionTransitionInput,
} from "./evolution/lineage-recorder.js";
import type { ExactRepeatIndex } from "./evolution/exact-repeat-index.js";
import type { FailureCueService } from "./evolution/failure-cues.js";
import {
  buildSkillInjectionPlan,
  formatSkillPromptContext,
  installSelectedSkills,
  recordSkillRoutingOutcome,
} from "./skill-router.js";

const now = () => new Date().toISOString();

/**
 * A mission that finished with nothing to show for itself.
 *
 * An empty final answer from a leader that dispatched nobody is not a result,
 * and it used to be stored as `completed` with a blank assistant message --
 * green status, ticked phases, an empty result box, indistinguishable on screen
 * from a mission that worked. Whatever stopped the session, the transcript has
 * to say so rather than leave the reader to notice the blank.
 *
 * Workers having reported results is the dividing line: then the mission did
 * do something, and a blank closing summary is a different, milder problem.
 */
export function leaderProducedNothing(output: string, state: OrchestrationState): boolean {
  return output.trim() === "" && (state.workerResults?.length ?? 0) === 0;
}
const WAIT_FOR_WORKERS_SAFE_TIMEOUT_SECONDS = 110;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fileProbe(filePath: string, nowMs: number): Promise<{ exists: boolean; ageMs?: number }> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { exists: false };
    return { exists: true, ageMs: Math.max(0, nowMs - info.mtimeMs) };
  } catch {
    return { exists: false };
  }
}

export function repairCandidateRunRecord(
  parent: AgentRun,
  candidateRunId: string,
  prompt: string,
  timestamp = now(),
): AgentRun {
  return {
    id: candidateRunId,
    agentId: parent.agentId,
    projectId: parent.projectId,
    kind: "subtask",
    parentRunId: parent.id,
    orchestration: null,
    status: "running",
    prompt,
    output: null,
    error: null,
    usage: null,
    startedAt: timestamp,
    completedAt: null,
    createdAt: timestamp,
  };
}

function mergeHealingRecords<T>(
  incoming: readonly T[],
  durable: readonly T[],
  keyOf: (item: T) => string,
  choose: (incoming: T, durable: T) => T = (_incoming, durableItem) => durableItem,
): T[] {
  const durableByKey = new Map(durable.map((item) => [keyOf(item), item]));
  const incomingKeys = new Set(incoming.map(keyOf));
  return [
    ...incoming.map((item) => {
      const stored = durableByKey.get(keyOf(item));
      return stored ? choose(item, stored) : item;
    }),
    ...durable.filter((item) => !incomingKeys.has(keyOf(item))),
  ];
}

function mergeHealingState(incoming: HealingState, durable: HealingState): HealingState {
  return {
    contracts: mergeHealingRecords(
      incoming.contracts,
      durable.contracts,
      (item) => item.subtaskId,
      (next, stored) => next.revision > stored.revision ? next : stored,
    ),
    nodes: mergeHealingRecords(
      incoming.nodes,
      durable.nodes,
      (item) => item.subtaskId,
      (next, stored) => {
        if (next.revision !== stored.revision) return next.revision > stored.revision ? next : stored;
        return next.updatedAt > stored.updatedAt ? next : stored;
      },
    ),
    faults: mergeHealingRecords(incoming.faults, durable.faults, (item) => item.id),
    snapshots: mergeHealingRecords(incoming.snapshots, durable.snapshots, (item) => item.id),
    diagnoses: mergeHealingRecords(incoming.diagnoses, durable.diagnoses, (item) => item.id),
    candidates: mergeHealingRecords(incoming.candidates, durable.candidates, (item) => item.id),
    tournaments: mergeHealingRecords(incoming.tournaments, durable.tournaments, (item) => item.id),
    verifications: mergeHealingRecords(incoming.verifications, durable.verifications, (item) => item.id),
    repairGraphFence: durable.repairGraphFence ?? incoming.repairGraphFence,
    budget: durable.budget ?? incoming.budget,
  };
}

/** Either the authority admitted the contribution for import, or it said why not. */
type PreIntegrationDecision =
  | { admitted: true; verification: VerificationResult }
  | { admitted: false; reason: string };

/**
 * Which node states a settling contribution may pull into `verifying`.
 *
 * `repairing`, `completed`, and `cancelled` are excluded so a late or superseded
 * settlement cannot drag a repaired or finished node back and re-pin it to a
 * stale attempt; `verifying`, `integration_pending`, and `integrating` are
 * excluded because a newer settlement already owns the node. `failed` stays:
 * a replanned re-execution of the same subtask id must still be verifiable, and
 * settlement is serialized per run, so no two attempts race for the entry.
 * Repair winners enter verifying from `repairing` via a separate from-set.
 */
const VERIFIABLE_NODE_STATES: readonly TaskNodeStatus[] = [
  "pending",
  "ready",
  "blocked",
  "running",
  "failed",
];

export interface OrchestratorParts {
  planner: Planner;
  evaluator: Evaluator;
  replanner: Replanner;
  synthesizer: Synthesizer;
  scheduler?: Scheduler;
  workerResolver?: WorkerResolver;
  policy?: ExecutionPolicy;
  /**
   * How a worker turn is carried out. Defaults to the one-shot exec backend, so
   * this seam changes nothing until a session-capable runtime is supplied.
   */
  runtimeFactory?: (runner: AgentRunner) => AgentRuntime;
  /**
   * Present only when the coordination runtime is wired. Absent leaves workers
   * exactly as they were: they run, they finish, nobody can address them.
   */
  coordination?: CoordinationDeps;
  /** Outer-authority Git attempt isolation; required only for coding projects. */
  attemptWorkspaces?: AttemptWorkspaceManager;
  /** Outer-authority structural evidence collector; required only for coding projects. */
  contributionCollector?: ContributionCollector;
  /** Middleware-owned serialized canonical integration authority. */
  contributionIntegrator?: ContributionIntegrator;
  /** Durable Project baseline publisher; absent skips advancement. */
  projectRegistry?: ProjectRegistry;
  /** @internal Deterministic cancellation/publication barrier test hook. */
  beforeContributionReadyForTest?(): Promise<void>;
  /** @internal Deterministic cancellation-after-apply test hook. */
  afterCanonicalIntegrationForTest?(): Promise<void>;
  /** @internal Deterministic cancellation-after-decision test hook. */
  afterIntegrationDecisionForTest?(): Promise<void>;
  runtimeObserver?: {
    attach(agentId: string, runtime: AgentRuntime): void;
    detach(agentId: string, runtime: AgentRuntime): void;
  };
  /** When true, live leader dispatch compiles contracts and admits append-only DAG nodes. */
  healingEnabled?: boolean;
  contractCatalog?: ContractCatalogEntry[];
  verificationRunner?: import("./verification/verifier.js").VerificationRunner;
  verificationRegistry?: import("./verification/verification-profile.js").VerificationProfileRegistry;
  /** Test seam for the root deadline clock. */
  clock?: RunClock;
  git?: GitClient;
  trajectoryClock?: TrajectoryClock;
  trajectoryCheckpointMs?: number;
  diagnoser?: Diagnoser;
  /** Frozen runtime inputs used only to fingerprint repair capability. */
  runtimeCapabilityEnvironment?: RepairRuntimeCapabilityEnvironmentV1;
  /** Append-only observer attached only at authoritative persisted transition boundaries. */
  lineageRecorder?: LineageRecorder;
  /** Content-addressed authority for trajectory evidence referenced by historical faults. */
  faultEvidenceStore?: FaultEvidenceStore;
  /** Read-only trusted exact-negative history used before repair admission. */
  exactRepeatIndex?: ExactRepeatIndex;
  /** Bounded deterministic refresh of persisted/audited evolution history. */
  refreshEvolutionHistory?: () => Promise<void>;
  /** Deterministic local cue selection and passive transfer observation. */
  failureCueService?: FailureCueService;
  /** Enables middleware-owned Skill Hub routing before agent startup. */
  skillRouting?: {
    dataDirectory: string;
  };
}

export interface CoordinationDeps {
  dataDir: string;
  /** How a worker reaches the ingress from wherever it runs. */
  baseUrl: string;
  register(token: string, ingress: CoordinationIngress): void;
  unregister(token: string): void;
}

interface BlockedDependentStart {
  start: () => Promise<void>;
  settle: (result: WorkerResult) => void;
  workerRunId: string;
}

export class Orchestrator {
  private readonly runtimeFactory: (runner: AgentRunner) => AgentRuntime;
  private readonly coordination: CoordinationDeps | undefined;
  /** Live teams, one per leader run, torn down when the run settles. */
  private readonly teams = new Map<string, TeamCoordinationRuntime>();
  private readonly issuedTokens = new Map<string, string[]>();
  private readonly issuedModelRunIds = new Map<string, Set<string>>();
  private readonly backgroundDispatches = new Map<string, Set<Promise<WorkerResult>>>();
  private readonly workerTimeouts = new Map<
    string,
    {
      leaderRunId: string;
      runnerKey: string;
      startedAt: number;
      baseMs: number;
      extraMs: number;
      repairCandidate: boolean;
      grantedCheckpointIds: Set<string>;
    }
  >();
  private readonly scheduler: Scheduler;
  private readonly workerResolver: WorkerResolver;
  private readonly policy: ExecutionPolicy;
  private readonly activeRunKeys = new Map<string, Set<string>>();
  private readonly activeRuntimes = new Map<string, Map<string, AgentRuntime>>();
  private readonly workerCoordinationTokens = new Map<string, string>();
  private readonly cancellationEpochs = new Map<string, number>();
  private readonly authorityLocks = new Map<string, Promise<void>>();
  private readonly controls = new Map<string, RunControl>();
  private readonly terminalCancels = new Map<string, Promise<void>>();
  private readonly unprovenAbsences = new Map<string, Set<string>>();
  private readonly monitors = new Map<string, TrajectoryMonitor>();
  private readonly monitorsForRun = new Map<string, Set<string>>();
  /** One trajectory observation per VerificationResult, whichever caller gets there first. */
  private readonly observedVerifications = new Map<string, Set<string>>();
  private readonly git: GitClient;
  private readonly liveOrchestration = new Map<string, OrchestrationState>();
  private readonly nodePromises = new Map<string, Map<string, Promise<WorkerResult>>>();
  private readonly blockedStarts = new Map<string, Map<string, BlockedDependentStart>>();

  constructor(
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly events: EventLog,
    private readonly parts: OrchestratorParts,
    private readonly isCancelled: (agentId: string) => boolean,
    private readonly modelProxy?: ModelCredentialIssuer,
  ) {
    this.runtimeFactory = parts.runtimeFactory ?? ((runner) => new ExecRuntime(runner));
    this.coordination = parts.coordination;
    this.scheduler = parts.scheduler ?? new Scheduler();
    this.workerResolver = parts.workerResolver ?? new WorkerResolver();
    this.policy = parts.policy ?? defaultExecutionPolicy;
    this.git = parts.git ?? new GitClient(15_000);
    if (parts.healingEnabled === true) {
      if (!parts.contractCatalog || parts.contractCatalog.length === 0) {
        throw new Error(
          "missing contract catalog: healingEnabled requires a non-empty catalog before any runtime admission",
        );
      }
    }
  }

  async run(leaderAtStart: Agent, run: AgentRun): Promise<void> {
    if (this.coordination !== undefined) {
      await this.runCodexLeader(leaderAtStart, run);
      return;
    }
    const sink = this.events.createSink(run.id, leaderAtStart.id, {
      sessionId: run.id,
      member: "leader",
      role: "leader",
    });
    const state = this.initialState();
    const commonWorkspacePath = await this.sessionCommonWorkspacePath(run.id);
    const leaderSkillPlan = await this.routeSkillsForTask(
      run.id,
      run.prompt,
      commonWorkspacePath,
      state,
    );
    const startedAt = Date.now();
    await this.updateLeaderRun(run.id, {
      status: "running",
      startedAt: now(),
      orchestration: state,
    });
    // Orchestration runs took the early return in AgentService.executeRun and
    // so never got the lifecycle brackets an ordinary run has. Emit them here
    // so every Run's trace starts and ends with a "run" event.
    sink.emit(lifecycleEvent("in_progress", "started", null, { text: run.prompt }));
    sink.emit(delegationEvent("planning", "plan", 0, "Planning worker delegation."));
    const control = this.controlFor(run.id);

    try {
      this.throwIfCancelled(leaderAtStart.id, run.id);
      const planningResult = await this.parts.planner.plan(
        run.prompt,
        this.existingWorkers(leaderAtStart.id),
        this.policy,
        this.recorder(sink, state.iteration, run.id),
        formatSkillPromptContext(leaderSkillPlan),
      );
      if (planningResult.status === "available") {
        state.provenance.plannerModel = planningResult.model;
      }
      await this.persistState(run.id, state);

      if (planningResult.status === "unavailable") {
        const detail = [
          "Planner unavailable; falling back to a solo leader run.",
          "reason: " + planningResult.reason,
          ...(planningResult.error ? ["error: " + planningResult.error] : []),
        ].join("\n");
        sink.emit(
          delegationEvent(
            "planning_unavailable",
            "plan",
            0,
            detail,
            "warning",
            { reason: planningResult.reason, error: planningResult.error },
          ),
        );
        await this.runSoloFallback(leaderAtStart, run, sink, state, startedAt);
        return;
      }

      if (!planningResult.plan.needsSubagents) {
        sink.emit(
          delegationEvent(
            "solo_plan",
            "plan",
            0,
            planningResult.plan.rationale,
          ),
        );
        await this.runSoloFallback(leaderAtStart, run, sink, state, startedAt);
        return;
      }

      state.iteration = 1;
      state.iterationPlans.push({
        iteration: 1,
        createdAt: now(),
        reason: "initial",
        plan: planningResult.plan,
      });
      const initialAdmission = await this.admitPlannedGraph(run.id, state);
      if (!initialAdmission.ok) throw new Error(initialAdmission.error);
      await this.openTeam(run.id);
      await this.persistState(run.id, state);

      while (state.iteration <= this.policy.maxIterations) {
        this.throwIfCancelled(leaderAtStart.id, run.id);
        state.phase = "delegating";
        await this.persistState(run.id, state);
        const currentIterationPlan = state.iterationPlans.at(-1);
        if (!currentIterationPlan) throw new Error("No iteration plan available");
        const currentPlan = currentIterationPlan.plan;
        sink.emit(
          delegationEvent(
            "delegating",
            "plan",
            state.iteration,
            currentPlan.rationale,
            "in_progress",
            { subtaskCount: currentPlan.subtasks.length },
          ),
        );

        state.phase = "executing";
        await this.persistState(run.id, state);
        // Register the whole plan before anything runs: a message to a
        // downstream subtask must be holdable, not bounced.
        const team = this.teams.get(run.id);
        if (team !== undefined) {
          for (const subtask of currentPlan.subtasks) {
            if (team.roster.resolve(subtask.id) === undefined) {
              const worker = await this.resolveWorker(leaderAtStart, subtask);
              await team.register(
                this.plannedWorkerRunId(run.id, state.iteration, subtask.id),
                subtask.id,
                state.iteration,
                worker.name,
              );
            }
          }
        }
        const codingProject = this.projectAtWaveStart(run.id);
        const settlementEpoch = this.cancellationEpochs.get(run.id) ?? 0;
        const results = await this.scheduler.execute(
          currentPlan.subtasks,
          this.policy,
          realRunCount(state.workerResults),
          (subtask, attempt, upstream) =>
            this.runSubtask(
              leaderAtStart,
              run,
              subtask,
              state.iteration,
              attempt,
              upstream,
              sink,
              { orchestrationState: state },
            ),
          state.iteration,
          (waveSize, maxParallel) => {
            sink.emit(
              delegationEvent(
                "delegating",
                "plan",
                state.iteration,
                "Plan wave has " + waveSize + " subtasks but only " + maxParallel +
                  " run at once; they execute in batches. A plan whose subtasks wait on each other cannot complete this way.",
                "warning",
                { waveSize, maxParallel },
              ),
            );
          },
          codingProject
            ? (wave) => this.settleAndHealProjectWave(run.id, wave, settlementEpoch)
            : undefined,
          control,
          async (result) => {
            if (result.status !== "contribution_ready") {
              await this.classifyReturnedWorker(
                run.id,
                result.subtaskId,
                result,
                this.trajectoryContext(run.id).ephemeral,
              );
            }
            return result;
          },
        );
        const admissions = await this.healWave(run.id, results);
        sink.emit(
          delegationEvent(
            "delegating",
            "plan",
            state.iteration,
            "Worker delegation completed with " + results.length + " result" +
              (results.length === 1 ? "." : "s."),
            "ok",
            {
              resultCount: results.length,
              blocked: results.filter((result) => result.status === "blocked").length,
            },
          ),
        );
        state.workerResults.push(...results);
        state.usage = orchestrationUsage(state.workerResults);
        await this.persistState(run.id, state);
        this.throwIfCancelled(leaderAtStart.id, run.id);
        for (const result of results) {
          if (result.status !== "blocked") continue;
          sink.emit(
            delegationEvent(
              "blocked",
              "plan",
              state.iteration,
              result.error ?? "Subtask blocked: " + result.subtaskId,
              "warning",
              { subtaskId: result.subtaskId },
            ),
          );
        }

        if (!leaderMayInterpretResults(admissions, state.healing.nodes)) {
          const unresolvedRequired = state.workerResults.filter(
            (result) =>
              result.status === "failed" ||
              result.status === "blocked" ||
              result.status === "cancelled",
          );
          const reason = "Required subtasks unresolved: " + unresolvedRequired
            .map((result) => result.subtaskId + "=" + result.status)
            .join(", ");
          state.outcome = {
            value: "failed",
            reason: "Required subtasks did not complete successfully.",
            evidence: unresolvedRequired.map(
              (result) => result.subtaskId + "=" + result.status,
            ),
            resolvedAt: now(),
          };
          state.phase = "failed";
          state.usage = orchestrationUsage(state.workerResults);
          sink.emit(
            lifecycleEvent("error", "failed", Date.now() - startedAt, {
              workerRuns: realRunCount(state.workerResults),
              iterations: state.iterationPlans.length,
            }),
          );
          await this.failLeaderRun(run.id, leaderAtStart.id, reason, state, false);
          return;
        }

        state.phase = "evaluating";
        await this.persistState(run.id, state);
        const evaluationResult = await this.parts.evaluator.evaluate(
          run.prompt,
          currentPlan,
          state.workerResults,
          this.recorder(sink, state.iteration, run.id),
        );
        if (evaluationResult.status === "available") {
          state.provenance.evaluatorModel = evaluationResult.model;
        }
        const evaluationRecord: EvaluationRecord = {
          iteration: state.iteration,
          createdAt: now(),
          planIteration: currentIterationPlan.iteration,
          result: evaluationResult,
        };
        state.evaluationRecords.push(evaluationRecord);
        await this.persistState(run.id, state);
        sink.emit(
          delegationEvent(
            "evaluation",
            "evaluation",
            state.iteration,
            evaluationResult.status === "available"
              ? evaluationSummary(evaluationResult.evaluation)
              : "Evaluator unavailable; synthesizing from available worker evidence.",
            evaluationResult.status === "available" ? "ok" : "warning",
            { result: evaluationResult },
          ),
        );

        if (evaluationResult.status === "unavailable") break;
        if (
          evaluationResult.evaluation.sufficient ||
          state.iteration >= this.policy.maxIterations ||
          realRunCount(state.workerResults) >= this.policy.maxTotalWorkerRuns ||
          shouldStopAfterTimeouts(results)
        ) {
          if (!evaluationResult.evaluation.sufficient && shouldStopAfterTimeouts(results)) {
            sink.emit(
              delegationEvent(
                "timeout_limited_synthesis",
                "evaluation",
                state.iteration,
                "Worker timeouts consumed this iteration; synthesizing from partial evidence instead of starting another worker round.",
                "warning",
                {
                  timedOut: results.filter((result) => result.status === "timed_out")
                    .length,
                  total: results.length,
                },
              ),
            );
          }
          break;
        }

        state.phase = "replanning";
        await this.persistState(run.id, state);
        const replanResult = await this.parts.replanner.replan(
          run.prompt,
          currentPlan,
          evaluationResult.evaluation,
          state.workerResults,
          this.policy,
          this.recorder(sink, state.iteration, run.id),
        );
        if (replanResult.status === "unavailable") {
          sink.emit(
            delegationEvent(
              "replan_unavailable",
              "replan",
              state.iteration,
              "Replanner unavailable; synthesizing from available worker evidence.",
              "warning",
              { result: replanResult },
            ),
          );
          break;
        }
        state.provenance.replannerModel = replanResult.model;
        state.iteration += 1;
        state.iterationPlans.push({
          iteration: state.iteration,
          createdAt: now(),
          reason:
            evaluationResult.evaluation.missingInformation.join("; ") ||
            "evaluation requested more work",
          plan: {
            ...replanResult.plan,
            subtasks: replanResult.plan.subtasks.slice(
              0,
              Math.max(0, this.policy.maxTotalWorkerRuns - realRunCount(state.workerResults)),
            ),
          },
        });
        const replanAdmission = await this.admitPlannedGraph(run.id, state);
        if (!replanAdmission.ok) throw new Error(replanAdmission.error);
        await this.persistState(run.id, state);
        sink.emit(
          delegationEvent("replan", "replan", state.iteration, replanResult.plan.rationale),
        );
      }

      // Quiet notes whose recipient never took another turn: the sender believes
      // it passed the information on, and nothing else would say otherwise.
      await this.teams.get(run.id)?.settleUndeliveredQuiet();

      // Resolved before synthesis so the summary explains an already-decided
      // outcome rather than being able to argue for one.
      const lastEvaluation = state.evaluationRecords.at(-1)?.result;
      state.outcome = resolveOutcome({
        evaluatorAvailable: lastEvaluation?.status === "available",
        evaluationSufficient:
          lastEvaluation?.status === "available" &&
          lastEvaluation.evaluation.sufficient,
        results: state.workerResults,
      });
      const unresolvedRequired = state.workerResults.filter(
        (result) =>
          result.status === "failed" ||
          result.status === "blocked" ||
          result.status === "cancelled",
      );
      if (unresolvedRequired.length > 0) {
        const reason = "Required subtasks unresolved: " + unresolvedRequired
          .map((result) => result.subtaskId + "=" + result.status)
          .join(", ");
        state.outcome = {
          value: "failed",
          reason: "Required subtasks did not complete successfully.",
          evidence: unresolvedRequired.map(
            (result) => result.subtaskId + "=" + result.status,
          ),
          resolvedAt: new Date().toISOString(),
        };
        state.phase = "failed";
        state.usage = orchestrationUsage(state.workerResults);
        sink.emit(
          lifecycleEvent("error", "failed", Date.now() - startedAt, {
            workerRuns: realRunCount(state.workerResults),
            iterations: state.iterationPlans.length,
          }),
        );
        await this.failLeaderRun(run.id, leaderAtStart.id, reason, state, false);
        return;
      }

      state.phase = "synthesizing";
      await this.persistState(run.id, state);
      const synthesis = await this.parts.synthesizer.synthesize(
        run.prompt,
        state.iterationPlans,
        state.evaluationRecords,
        state.workerResults,
        this.recorder(sink, state.iteration, run.id),
      );
      if (synthesis.model !== undefined) {
        state.provenance.synthesizerModel = synthesis.model;
      }
      state.usage = orchestrationUsage(state.workerResults);
      sink.emit(delegationEvent("synthesis", "synthesis", state.iteration, synthesis.output));
      if (!await this.tryAdvanceProjectBaseline(run.id, state)) return;
      await this.drainBackgroundDispatches(run.id);
      this.controlFor(run.id).assertActive();
      state.phase = "completed";
      sink.emit(
        lifecycleEvent("ok", "completed", Date.now() - startedAt, {
          workerRuns: realRunCount(state.workerResults),
          iterations: state.iterationPlans.length,
        }),
      );
      await this.completeLeaderRun(run.id, leaderAtStart.id, synthesis.output, state);
    } catch (error) {
      if (state.phase === "completed") throw error;
      const terminal = error instanceof RunTerminalError
        ? error
        : this.terminalOf(run.id);
      const cancelled = error instanceof RunCancelledError
        || terminal?.reason === "user_cancelled";
      const failError = terminal ?? error;
      state.phase = cancelled ? "cancelled" : "failed";
      if (terminal) {
        emitBudgetTerminal(sink, terminal, control.snapshot(), {
          elapsedMs: Date.now() - startedAt,
          rootTimeoutMs: this.policy.rootTimeoutMs,
        });
        await this.quiesceOnTerminal(run.id, terminal);
      }
      await this.drainBackgroundDispatches(run.id);
      // A run that dies before synthesis never reached the resolver above, and
      // an absent outcome on a settled run is exactly the ambiguity this field
      // exists to remove. Record one here rather than leaving it unset.
      state.outcome ??= {
        value: cancelled ? "unknown" : "failed",
        reason: cancelled
          ? "Run was cancelled before an outcome could be established."
          : "Orchestration failed before synthesis: " +
            (failError instanceof Error ? failError.message : String(failError)),
        evidence: [
          "phase=" + state.phase,
          "workers=" + state.workerResults.length,
        ],
        resolvedAt: new Date().toISOString(),
      };
      sink.emit(
        delegationEvent(
          cancelled ? "cancelled" : "failed",
          "synthesis",
          state.iteration,
          cancelled ? "Orchestration cancelled." : "Orchestration failed.",
          "error",
        ),
      );
      sink.emit(
        lifecycleEvent(
          "error",
          cancelled ? "cancelled" : "failed",
          Date.now() - startedAt,
          {
            workerRuns: realRunCount(state.workerResults),
            iterations: state.iterationPlans.length,
          },
        ),
      );
      await this.failLeaderRun(
        run.id,
        leaderAtStart.id,
        failError instanceof Error ? failError.message : String(failError),
        state,
        cancelled,
      );
    } finally {
      await this.drainBackgroundDispatches(run.id);
      this.closeTeam(run.id);
      if ((this.activeRunKeys.get(run.id)?.size ?? 0) === 0) this.activeRunKeys.delete(run.id);
      if ((this.activeRuntimes.get(run.id)?.size ?? 0) === 0) this.activeRuntimes.delete(run.id);
      this.authorityLocks.delete(run.id);
      this.releaseControl(run.id);
    }
  }

  private async runCodexLeader(leaderAtStart: Agent, run: AgentRun): Promise<void> {
    const codingProject = this.projectAtWaveStart(run.id);
    const leaderRequiresGitContribution =
      codingProject !== null && requiresProjectContributionRequest(run.prompt);
    const liveSessionId = this.liveLeaderSessionId(leaderAtStart, run, leaderRequiresGitContribution);
    const leaderPlacement = {
      sessionId: liveSessionId,
      member: "leader",
      role: "leader",
    };
    const sink = this.events.createSink(run.id, leaderAtStart.id, leaderPlacement);
    const leaderWorkspacePath = leaderRequiresGitContribution
      ? path.join(
          this.events.runDirectory(run.id, leaderAtStart.id, leaderPlacement),
          "workspace",
        )
      : leaderAtStart.workspacePath;
    const commonWorkspacePath = await this.sessionCommonWorkspacePath(liveSessionId);
    const state = this.initialState();
    state.iteration = 1;
    state.phase = "planning";
    const leaderSkillPlan = await this.routeSkillsForTask(
      run.id,
      run.prompt,
      commonWorkspacePath,
      state,
    );
    const startedAt = Date.now();
    await this.updateLeaderRun(run.id, {
      status: "running",
      startedAt: now(),
      orchestration: state,
    });
    this.liveOrchestration.set(run.id, state);
    sink.emit(lifecycleEvent("in_progress", "started", null, { text: run.prompt }));
    sink.emit(
      delegationEvent(
        "leader_codex_loop",
        "planning",
        1,
        "Leader is running as a live Codex session. User messages can steer this turn; the leader can dispatch and talk to workers through Launchpad MCP tools.",
        "in_progress",
      ),
    );
    const control = this.controlFor(run.id);
    let runtime: AgentRuntime | null = null;
    let runtimeQuiesced = false;
    try {
      if (leaderRequiresGitContribution) {
        await this.workspaces.createTaskScoped(leaderAtStart, leaderWorkspacePath);
      } else {
        await this.workspaces.writeInstructions(leaderAtStart);
      }
      await this.openTeam(run.id);
      const team = this.teams.get(run.id);
      await team?.register(run.id, "leader", 1, leaderAtStart.name);
      const dispatch = async (request: DispatchSubagentRequest) => {
        const dispatched = await this.dispatchFromLeader(
          leaderAtStart,
          run,
          state,
          request,
          sink,
        );
        return {
          ok: "status" in dispatched && (dispatched.status === "running" ||
            dispatched.status === "completed" ||
            dispatched.status === "partial"),
          result: dispatched,
        };
      };
      let leaderMonitor: TrajectoryMonitor | null = null;
      const guardedSink = guardLeaderSleepPolling(sink, () => runtime, {
        runId: run.id,
        leaderAgentId: leaderAtStart.id,
        control,
        healingEnabled: this.parts.healingEnabled === true,
      });
      const coordinationTools = {
        waitWorkers: (request: WaitWorkersRequest) =>
          this.waitForWorkers(run.id, state, request, commonWorkspacePath),
        inspectWorker: (request: InspectWorkerRequest) => this.inspectWorkerProgress(run.id, request),
        extendWorkerTimeout: (request: ExtendWorkerTimeoutRequest) =>
          this.extendWorkerTimeout(run.id, request, sink),
      };
      let result: RunnerResult;
      if (codingProject && leaderRequiresGitContribution) {
        const settlementEpoch = this.cancellationEpochs.get(run.id) ?? 0;
        const executed = await this.createAttemptExecutor().execute({
          runId: run.id,
          project: codingProject,
          attemptId: run.id + "-leader",
          revision: 1,
          subtaskId: "leader",
          baseCommit: codingProject.headCommit!,
          authorityEpoch: settlementEpoch,
          throwIfCancelled: () => this.throwIfCancelled(leaderAtStart.id, run.id),
          run: async (workspacePath) => {
            runtime = this.runtimeFactory(this.runner);
            await team?.attach(run.id, runtime);
            this.parts.runtimeObserver?.attach(leaderAtStart.id, runtime);
            this.rememberActiveRuntime(run.id, run.id, runtime);
            const coordinationEnv = this.leaderCoordinationEnv(run.id, dispatch, coordinationTools);
            const modelToken = this.modelProxy?.issue(
              run.id,
              leaderAtStart.id,
              this.controlFor(run.id),
              "root",
            );
            const ctx = this.trajectoryContext(run.id);
            if (!ctx.attach) {
              return this.raceControl(
                control,
                runtime.start({
                  runId: run.id,
                  agentId: leaderAtStart.id,
                  parentRunId: run.parentRunId,
                  workspacePath,
                  commonWorkspacePath,
                  prompt: buildLeaderCodexPrompt(run.prompt, true, leaderSkillPlan),
                  ...(coordinationEnv === undefined ? {} : { coordinationEnv }),
                  ...(modelToken === undefined ? {} : { modelToken }),
                  threadId: leaderAtStart.codexThreadId,
                  sink: guardedSink,
                }),
              );
            }
            leaderMonitor = this.ensureMonitor(run.id, run.id, workspacePath, state, "leader");
            return this.raceControl(
              control,
              this.raceMonitor(
                leaderMonitor,
                runtime.start({
                  runId: run.id,
                  agentId: leaderAtStart.id,
                  parentRunId: run.parentRunId,
                  workspacePath,
                  commonWorkspacePath,
                  prompt: buildLeaderCodexPrompt(run.prompt, true, leaderSkillPlan),
                  ...(coordinationEnv === undefined ? {} : { coordinationEnv }),
                  ...(modelToken === undefined ? {} : { modelToken }),
                  threadId: leaderAtStart.codexThreadId,
                  sink: leaderMonitor.wrapSink(guardedSink),
                }),
                () => runtime,
                {
                  leaderRunId: run.id,
                  subtaskId: "leader",
                  workerRunId: run.id,
                  ephemeral: ctx.ephemeral,
                },
              ),
            );
          },
          repairCommitMarker: async ({ runnerResult, error }) => {
            if (runtime === null || runtime.capability() !== "live_steer") return null;
            if (runtime.snapshot().state === "closed") return null;
            sink.emit(
              delegationEvent(
                "leader_contribution_marker_repair",
                "executing",
                1,
                "Leader ended with an invalid contribution marker; waking the same leader session once to resend a corrected final response.",
                "warning",
                { subtaskId: "leader", workerRunId: run.id, reason: error.code },
              ),
            );
            const repaired = await runtime.wake({
              id: randomUUID(),
              parentRunId: run.id,
              fromWorkerRunId: run.id,
              toWorkerRunId: run.id,
              delivery: "wakeup",
              workspaceRefs: [],
              createdAt: now(),
              content: [
                "Contribution repair required: your prior response did not produce a collectable project contribution.",
                "Original task: " + run.prompt,
                "Inspect the current Git state. If the intended work is already complete and exactly one commit exists, do not edit files or make another commit; resend the final handoff.",
                "If no committed contribution exists yet, continue the original task now, make exactly one commit, leave the worktree clean, then send the final handoff.",
                "The final non-empty line must be exactly LAUNCHPAD_COMMIT=<40 lowercase hex SHA>, with no code fence, no duplicate marker, and no trailing prose.",
              ].join("\n"),
            });
            if (repaired.state !== "delivered" || repaired.output === undefined) return null;
            return {
              output: repaired.output,
              threadId: runnerResult.threadId,
              usage: repaired.usage ?? runnerResult.usage,
            };
          },
          quiesce: async () => {
            if (runtime === null || runtimeQuiesced) return;
            this.detachWorkerIngress(run.id, run.id, runtime);
            await runtime.quiesce("structural_collection");
            runtimeQuiesced = true;
            this.releaseActiveRuntime(run.id, run.id, runtime);
            this.modelProxy?.revoke(run.id);
          },
        });
        await this.monitors.get(run.id)?.drain().catch(() => undefined);
        result = executed.runnerResult;
        const leaderResult: WorkerResult = {
          ...executed.workerResult,
          workerId: leaderAtStart.id,
          workerRunId: run.id,
        };
        await this.drainBackgroundDispatches(run.id);
        this.controlFor(run.id).assertActive();
        // Live dispatch settlement may publish through a durable-state CAS while
        // the leader turn still holds an older in-memory worker-results array.
        // Once every owned dispatch is drained, durable truth is authoritative
        // for deciding whether the coordinating leader's own return is a
        // required contribution. This prevents a no-commit wrapper response
        // from overriding completed append-only DAG nodes.
        const durable = this.getRunState(run.id);
        state.workerResults = structuredClone(durable.workerResults);
        state.healing = mergeHealingState(state.healing, durable.healing);
        const leaderResultRequired =
          claimedCommitMarker(result.output) ||
          !state.workerResults.some((item) => item.status === "completed");
        // Classification of a contribution-bearing return waits for settlement:
        // false_completion is only knowable once the VerificationResult exists.
        // A coordinating wrapper with completed child contributions is not a
        // fourth coding node and therefore is neither diagnosed nor healed.
        if (leaderResultRequired && leaderResult.status !== "contribution_ready") {
          await this.classifyReturnedWorker(
            run.id,
            "leader",
            leaderResult,
            this.trajectoryContext(run.id).ephemeral,
          );
          await this.beginHealing(run.id, "leader");
        }
        if (leaderResult.status === "contribution_ready") {
          const settled = await this.settleAndHealProjectWave(run.id, [leaderResult], settlementEpoch);
          state.workerResults.push(...settled);
        } else if (leaderResultRequired) {
          state.workerResults.push(leaderResult);
        }
        state.usage = orchestrationUsage(state.workerResults);
        state.outcome = this.resolveLiveLeaderProjectOutcome(run.id, state);
        const unresolvedRequired = state.workerResults.filter((item) =>
          item.status === "failed" || item.status === "blocked" || item.status === "cancelled"
        );
        if (state.outcome.value !== "succeeded" || unresolvedRequired.length > 0) {
          const cancelled = unresolvedRequired.some((item) => item.status === "cancelled");
          if (cancelled) {
            state.outcome = {
              value: "unknown",
              reason: "Run was cancelled before an outcome could be established.",
              evidence: unresolvedRequired.map((item) => item.subtaskId + "=" + item.status),
              resolvedAt: now(),
            };
          }
          state.phase = cancelled ? "cancelled" : "failed";
          await this.failLeaderRun(
            run.id,
            leaderAtStart.id,
            state.outcome.reason,
            state,
            cancelled,
          );
          sink.emit(
            delegationEvent(
              cancelled ? "cancelled" : "failed",
              "synthesis",
              1,
              cancelled
                ? "Leader Codex session cancelled."
                : "Leader Codex session produced no successful project contribution.",
              "error",
            ),
          );
          return;
        }
      } else {
        runtime = this.runtimeFactory(this.runner);
        await team?.attach(run.id, runtime);
        this.parts.runtimeObserver?.attach(leaderAtStart.id, runtime);
        this.rememberActiveRuntime(run.id, run.id, runtime);
        const coordinationEnv = this.leaderCoordinationEnv(run.id, dispatch, coordinationTools);
        const modelToken = this.modelProxy?.issue(
          run.id,
          leaderAtStart.id,
          control,
          "root",
        );
        const ctx = this.trajectoryContext(run.id);
        if (ctx.attach) {
          leaderMonitor = this.ensureMonitor(run.id, run.id, leaderWorkspacePath, state, "leader");
          result = await this.raceControl(
            control,
            this.raceMonitor(
              leaderMonitor,
              runtime.start({
                runId: run.id,
                agentId: leaderAtStart.id,
                parentRunId: run.parentRunId,
                workspacePath: leaderWorkspacePath,
                commonWorkspacePath,
                prompt: buildLeaderCodexPrompt(
                  run.prompt,
                  leaderRequiresGitContribution,
                  leaderSkillPlan,
                ),
                ...(coordinationEnv === undefined ? {} : { coordinationEnv }),
                ...(modelToken === undefined ? {} : { modelToken }),
                threadId: leaderAtStart.codexThreadId,
                sink: leaderMonitor.wrapSink(guardedSink),
              }),
              () => runtime,
              {
                leaderRunId: run.id,
                subtaskId: "leader",
                workerRunId: run.id,
                ephemeral: ctx.ephemeral,
              },
            ),
          );
        } else {
          result = await this.raceControl(control, runtime.start({
            runId: run.id,
            agentId: leaderAtStart.id,
            parentRunId: run.parentRunId,
            workspacePath: leaderWorkspacePath,
            commonWorkspacePath,
            prompt: buildLeaderCodexPrompt(
              run.prompt,
              leaderRequiresGitContribution,
              leaderSkillPlan,
            ),
            ...(coordinationEnv === undefined ? {} : { coordinationEnv }),
            ...(modelToken === undefined ? {} : { modelToken }),
            threadId: leaderAtStart.codexThreadId,
            sink: guardedSink,
          }));
        }
      }
      await this.drainBackgroundDispatches(run.id);
      this.controlFor(run.id).assertActive();
      if (codingProject && !leaderRequiresGitContribution) {
        if (!await this.evaluateLiveCoordinatorOutcome(run, state, sink)) return;
      }
      state.phase = "completed";
      state.usage = orchestrationUsage(state.workerResults);
      if (codingProject && leaderRequiresGitContribution) {
        state.outcome = this.resolveLiveLeaderProjectOutcome(run.id, state);
        const unresolvedRequired = state.workerResults.filter((item) =>
          item.status === "failed" || item.status === "blocked" || item.status === "cancelled"
        );
        if (state.outcome.value !== "succeeded" || unresolvedRequired.length > 0) {
          const cancelled = unresolvedRequired.some((item) => item.status === "cancelled");
          if (cancelled) {
            state.outcome = {
              value: "unknown",
              reason: "Run was cancelled before an outcome could be established.",
              evidence: unresolvedRequired.map((item) => item.subtaskId + "=" + item.status),
              resolvedAt: now(),
            };
          }
          state.phase = cancelled ? "cancelled" : "failed";
          await this.failLeaderRun(
            run.id,
            leaderAtStart.id,
            state.outcome.reason,
            state,
            cancelled,
          );
          sink.emit(
            delegationEvent(
              cancelled ? "cancelled" : "failed",
              "synthesis",
              1,
              cancelled
                ? "Leader Codex session cancelled."
                : "Leader Codex session produced no successful project contribution.",
              "error",
            ),
          );
          return;
        }
      }
      await this.completeLeaderRun(run.id, leaderAtStart.id, result.output, state, result);
      sink.emit(
        delegationEvent(
          "leader_codex_loop",
          "synthesis",
          1,
          "Leader Codex session completed.",
          "ok",
        ),
      );
    } catch (error) {
      const terminal = error instanceof RunTerminalError ? error : this.terminalOf(run.id);
      const cancelled = error instanceof RunCancelledError
        || terminal?.reason === "user_cancelled";
      const failError = terminal ?? error;
      state.phase = cancelled ? "cancelled" : "failed";
      if (terminal) {
        emitBudgetTerminal(sink, terminal, control.snapshot(), {
          elapsedMs: Date.now() - startedAt,
          rootTimeoutMs: this.policy.rootTimeoutMs,
        });
        await this.quiesceOnTerminal(run.id, terminal);
      }
      await this.drainBackgroundDispatches(run.id);
      await this.failLeaderRun(
        run.id,
        leaderAtStart.id,
        failError instanceof Error ? failError.message : String(failError),
        state,
        cancelled,
      );
      sink.emit(
        delegationEvent(
          cancelled ? "cancelled" : "failed",
          "synthesis",
          state.iteration,
          cancelled ? "Orchestration cancelled." : "Leader Codex orchestration failed.",
          "error",
        ),
      );
    } finally {
      await this.drainBackgroundDispatches(run.id).catch(() => undefined);
      if (runtime !== null) {
        this.parts.runtimeObserver?.detach(leaderAtStart.id, runtime);
        this.releaseActiveRuntimeIfProven(run.id, run.id, runtime);
      }
      this.modelProxy?.revoke(run.id);
      this.closeTeam(run.id);
      this.releaseControl(run.id);
      sink.emit(
        lifecycleEvent(
          state.phase === "completed" ? "ok" : "error",
          state.phase === "completed" ? "completed" : state.phase,
          Date.now() - startedAt,
          {
            workerRuns: realRunCount(state.workerResults),
            iterations: state.iterationPlans.length,
          },
        ),
      );
      this.activeRunKeys.delete(run.id);
    }
  }

  private async dispatchFromLeader(
    leader: Agent,
    leaderRun: AgentRun,
    state: OrchestrationState,
    request: DispatchSubagentRequest,
    sink: RunEventSink,
  ): Promise<
    | WorkerResult
    | {
        status: "running" | "blocked" | "pending";
        subtaskId: string;
        workerRunId?: string;
        agentName?: string;
        title?: string;
        blockedBy?: string[];
        hint: string;
      }
    | { ok: false; error: "repair_graph_frozen" }
  > {
    this.controlFor(leaderRun.id).assertActive();
    const dispatchRequest =
      this.projectAtWaveStart(leaderRun.id) &&
      isSharedWorkspaceDeliverableRequest(leaderRun.prompt) &&
      request.requiresGitContribution === undefined
        ? { ...request, requiresGitContribution: false }
        : request;
    if (this.parts.healingEnabled) {
      const existingId = leaderDispatchSubtask(dispatchRequest, state.healing.nodes.length + 1).id;
      const existing = state.healing.nodes.find((item) => item.subtaskId === existingId);
      if (existing) {
        if (request.wait === true) {
          const pending = this.nodePromises.get(leaderRun.id)?.get(existing.subtaskId);
          if (pending) return await pending;
        }
        throw new Error("already admitted: " + existing.subtaskId);
      }
    }
    const admissionAttempt = this.parts.healingEnabled
      ? await this.withAuthorityLock(leaderRun.id, async () => {
          const attempt = new LiveDagAdmission(this.healingCatalog()).tryAdmit(state, dispatchRequest);
          if (!attempt.ok) return attempt;
          state.phase = "executing";
          await this.persistState(leaderRun.id, state);
          return attempt;
        })
      : null;
    if (admissionAttempt !== null && !admissionAttempt.ok) return admissionAttempt;
    const admitted = admissionAttempt?.admission ?? null;
    const subtask = admitted
      ? admitted.subtask
      : leaderDispatchSubtask(dispatchRequest, state.workerResults.length + 1);
    const startWorker = admitted ? admitted.startWorker : true;
    if (!this.parts.healingEnabled) {
      if (!state.iterationPlans.some((plan) => plan.reason === "leader_codex")) {
        state.iterationPlans.push({
          iteration: 1,
          createdAt: now(),
          reason: "leader_codex",
          plan: {
            needsSubagents: true,
            rationale: "Leader Codex session dispatches workers through Launchpad MCP tools.",
            subtasks: [],
          },
        });
      }
      state.iterationPlans.at(-1)?.plan.subtasks.push(subtask);
    }
    if (!this.parts.healingEnabled) this.assertKnownLiveDependencies(subtask, state);
    state.phase = "executing";
    const workerRunId = this.plannedWorkerRunId(leaderRun.id, 1, subtask.id);
    if (!this.parts.healingEnabled) await this.persistState(leaderRun.id, state);
    const runWorker = async (): Promise<WorkerResult> => {
      const team = this.teams.get(leaderRun.id);
      await team?.register(
        workerRunId,
        subtask.id,
        1,
        subtask.agentName ?? subtask.role,
      );
      if (subtask.initialMessage?.trim()) {
        await team?.queue({
          id: randomUUID(),
          parentRunId: leaderRun.id,
          fromWorkerRunId: leaderRun.id,
          toWorkerRunId: workerRunId,
          delivery: "talk",
          content: subtask.initialMessage,
          workspaceRefs: subtask.initialMessageWorkspaceRefs ?? [],
          createdAt: now(),
        });
      }
      let result: WorkerResult;
      try {
        const upstream = this.parts.healingEnabled
          ? state.workerResults.filter((item) => subtask.dependsOn.includes(item.subtaskId))
          : await this.waitForDependencyResults(leaderRun.id, state, subtask, sink);
        const failedDependency = upstream.find(
          (item) => item.status !== "completed" && item.status !== "contribution_ready",
        );
        if (failedDependency) {
          result = {
            subtaskId: subtask.id,
            workerId: "",
            workerRunId,
            iteration: 1,
            attempt: 1,
            status: "blocked",
            output: "",
            error:
              "Dependency " +
              failedDependency.subtaskId +
              " ended with status " +
              failedDependency.status +
              "; refusing to run dependent worker against incomplete handoff.",
            usage: null,
            durationMs: 0,
            artifacts: [],
            validation: {
              integrity: "valid",
              anomalyCodes: [],
              summary: "Dependent worker was not started because an upstream dependency was not completed.",
            },
          };
          this.teams.get(leaderRun.id)?.roster.setState(workerRunId, "closed");
          sink.emit(
            dispatchEvent(
              subtask,
              1,
              1,
              { ...leader, id: "", name: subtask.agentName ?? subtask.role },
              workerRunId,
              "warning",
              result.error,
            ),
          );
        } else {
          const settlementEpoch = this.cancellationEpochs.get(leaderRun.id) ?? 0;
          const raw = await this.runSubtask(
            leader,
            leaderRun,
            subtask,
            1,
            1,
            upstream,
            sink,
            {
              ...(leaderRun.parentRunId === null ? {} : { workspaceMode: "persistent_worker" }),
              orchestrationState: state,
            },
          );
          result = this.projectAtWaveStart(leaderRun.id) && subtask.requiresGitContribution !== false
            ? (await this.settleAndHealProjectWave(leaderRun.id, [raw], settlementEpoch))[0]!
            : raw;
        }
      } catch (error) {
        if (error instanceof RunTerminalError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        result = {
          subtaskId: subtask.id,
          workerId: "",
          workerRunId,
          iteration: 1,
          attempt: 1,
          status: "failed",
          output: "",
          error: message,
          usage: null,
          durationMs: 0,
          artifacts: [],
          validation: { integrity: "invalid", anomalyCodes: ["BACKGROUND_DISPATCH_FAILED"], summary: message },
        };
      }
      const terminal = this.terminalOf(leaderRun.id);
      if (terminal) throw terminal;
      if (!this.projectAtWaveStart(leaderRun.id)) {
        await this.classifyReturnedWorker(
          leaderRun.id,
          subtask.id,
          result,
          this.trajectoryContext(leaderRun.id).ephemeral,
        );
        await this.beginHealing(leaderRun.id, subtask.id);
      }
      state.workerResults.push(result);
      state.usage = orchestrationUsage(state.workerResults);
      await this.persistState(leaderRun.id, state);
      if (request.wait !== true) {
        await this.notifyLeaderOfAsyncWorkerResult(leaderRun.id, workerRunId, result);
      }
      if (result.status === "completed") {
        await this.resumeBlockedDependents(leader, leaderRun, state, sink);
      } else {
        await this.settleBlockedDependents(
          leaderRun,
          state,
          subtask.id,
          "Skipped: dependency " + subtask.id + " did not complete after its one healing decision",
        );
      }
      return result;
    };

    if (!startWorker) {
      let resolve!: (value: WorkerResult) => void;
      let reject!: (error: unknown) => void;
      const pending = new Promise<WorkerResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.rememberNodePromise(leaderRun.id, subtask.id, pending);
      const blocked = this.blockedStarts.get(leaderRun.id) ?? new Map<string, BlockedDependentStart>();
      blocked.set(subtask.id, {
        start: async () => {
          const running = runWorker().then(
            (value) => value,
            (error): WorkerResult => {
              if (error instanceof RunTerminalError) throw error;
              return {
                subtaskId: subtask.id,
                workerId: "",
                workerRunId,
                iteration: 1,
                attempt: 1,
                status: "failed",
                output: "",
                error: error instanceof Error ? error.message : String(error),
                usage: null,
                durationMs: 0,
                artifacts: [],
              };
            },
          );
          this.trackBackgroundDispatch(leaderRun.id, running);
          try {
            resolve(await running);
          } catch (error) {
            reject(error);
          }
        },
        settle: (result) => resolve(result),
        workerRunId,
      });
      this.blockedStarts.set(leaderRun.id, blocked);
      const terminalDependency = subtask.dependsOn.find((dependencyId) => {
        const result = state.workerResults.find((item) => item.subtaskId === dependencyId);
        return result?.status === "failed" || result?.status === "blocked" || result?.status === "cancelled";
      });
      if (terminalDependency) {
        await this.settleBlockedDependents(
          leaderRun,
          state,
          terminalDependency,
          "Skipped: dependency " + terminalDependency + " was already terminal at admission",
        );
      }
      if (request.wait === true) return await pending;
      const node = state.healing.nodes.find((item) => item.subtaskId === subtask.id);
      return {
        status: node?.state === "pending" ? "pending" : "blocked",
        subtaskId: subtask.id,
        blockedBy: node?.blockedBy ?? subtask.dependsOn,
        hint: "Queued until producer subtasks complete. The admitted node is append-only and will not start until its dependencies finish.",
      };
    }

    const tracked = runWorker().then(
      (value) => value,
      (error): WorkerResult => {
        if (error instanceof RunTerminalError) throw error;
        return {
          subtaskId: subtask.id,
          workerId: "",
          workerRunId,
          iteration: 1,
          attempt: 1,
          status: "failed",
          output: "",
          error: error instanceof Error ? error.message : String(error),
          usage: null,
          durationMs: 0,
          artifacts: [],
        };
      },
    );
    this.rememberNodePromise(leaderRun.id, subtask.id, tracked);
    if (request.wait === true) {
      return await tracked;
    }
    this.trackBackgroundDispatch(leaderRun.id, tracked);
    return {
      status: "running",
      subtaskId: subtask.id,
      workerRunId,
      agentName: subtask.agentName ?? subtask.role,
      title: subtask.title,
      hint: subtask.dependsOn.length > 0
        ? "Worker was queued asynchronously and will not start until dependsOn completes: " +
          subtask.dependsOn.join(", ") +
          ". Use one bounded wait_for_workers checkpoint, then read shared status/report files before waiting again."
        : "Worker was dispatched asynchronously. Use one bounded wait_for_workers checkpoint, then read shared status/report files before waiting again.",
    };
  }

  private async notifyLeaderOfAsyncWorkerResult(
    leaderRunId: string,
    workerRunId: string,
    result: WorkerResult,
  ): Promise<void> {
    const leaderRuntime = this.activeRuntimes.get(leaderRunId)?.get(leaderRunId);
    if (leaderRuntime === undefined) return;
    const run = this.store.snapshot().runs.find((item) => item.id === leaderRunId);
    if (!run || run.status !== "running") return;
    const preview = result.output.trim().replace(/\s+/g, " ").slice(0, 700);
    const member = this.teams.get(leaderRunId)?.roster.resolve(workerRunId);
    const handoffNames = [
      ...new Set([result.subtaskId, member?.displayName].filter((item): item is string => Boolean(item))),
    ];
    await leaderRuntime.wake({
      id: randomUUID(),
      parentRunId: leaderRunId,
      fromWorkerRunId: workerRunId,
      toWorkerRunId: leaderRunId,
      delivery: "talk",
      workspaceRefs: handoffNames.flatMap((name) => [
        "status/" + name + ".json",
        "reports/" + name + ".md",
      ]),
      createdAt: now(),
      content: [
        "Worker finished: " + result.subtaskId + " (" + result.status + ").",
        result.error ? "Error: " + result.error : "Summary: " + (preview || "(no output)"),
        "Read $COMMON_WORKSPACE/status/" + result.subtaskId +
          ".json or reports/" + result.subtaskId +
          ".md if present; call wait_for_workers for remaining async workers, then synthesize the final answer.",
      ].join("\n"),
    }).catch(() => undefined);
  }

  private assertKnownLiveDependencies(subtask: LeaderSubtask, state: OrchestrationState): void {
    const known = new Set<string>(state.workerResults.map((result) => result.subtaskId));
    for (const plan of state.iterationPlans) {
      for (const planned of plan.plan.subtasks) known.add(planned.id);
    }
    for (const dep of subtask.dependsOn) {
      if (dep === subtask.id) {
        throw new Error("SELF_DEPENDENCY: " + subtask.id + " cannot depend on itself");
      }
      if (!known.has(dep)) {
        throw new Error(
          "UNKNOWN_DEPENDENCY: " +
            subtask.id +
            " depends on " +
            dep +
            ", but no completed or already-dispatched subtask has that id. Dispatch the prerequisite first or remove the dependency.",
        );
      }
    }
  }

  private async waitForDependencyResults(
    leaderRunId: string,
    state: OrchestrationState,
    subtask: LeaderSubtask,
    sink: RunEventSink,
  ): Promise<WorkerResult[]> {
    if (subtask.dependsOn.length === 0) return [];
    sink.emit(
      delegationEvent(
        "dependency_wait",
        "executing",
        1,
        subtask.id + " is waiting for dependencies: " + subtask.dependsOn.join(", "),
        "ok",
        { subtaskId: subtask.id, dependsOn: subtask.dependsOn },
      ),
    );
    while (true) {
      const leaderId = this.store.snapshot().runs.find((run) => run.id === leaderRunId)?.agentId;
      if (leaderId) this.throwIfCancelled(leaderId);
      const upstream = state.workerResults.filter((result) =>
        subtask.dependsOn.includes(result.subtaskId),
      );
      if (upstream.length === subtask.dependsOn.length) return upstream;
      const dispatches = this.backgroundDispatches.get(leaderRunId);
      if (dispatches === undefined || dispatches.size === 0) {
        const missing = subtask.dependsOn.filter(
          (dep) => !upstream.some((result) => result.subtaskId === dep),
        );
        throw new Error("DEPENDENCY_NOT_RUNNING: " + subtask.id + " still needs " + missing.join(", "));
      }
      await Promise.race([
        ...[...dispatches].map((dispatch) => dispatch.catch(() => undefined)),
        sleep(250),
      ]);
    }
  }

  private trackBackgroundDispatch(leaderRunId: string, promise: Promise<WorkerResult>): void {
    void promise.catch(() => undefined);
    const dispatches = this.backgroundDispatches.get(leaderRunId) ?? new Set<Promise<WorkerResult>>();
    dispatches.add(promise);
    this.backgroundDispatches.set(leaderRunId, dispatches);
    void promise.finally(() => {
      const current = this.backgroundDispatches.get(leaderRunId);
      current?.delete(promise);
      if (current?.size === 0) this.backgroundDispatches.delete(leaderRunId);
    }).catch(() => undefined);
  }

  private rememberNodePromise(
    runId: string,
    subtaskId: string,
    promise: Promise<WorkerResult>,
  ): void {
    const pending = this.nodePromises.get(runId) ?? new Map<string, Promise<WorkerResult>>();
    pending.set(subtaskId, promise);
    this.nodePromises.set(runId, pending);
  }

  private async blockDependents(runId: string, producerId: string): Promise<void> {
    await this.mutateHealingWithEvents(runId, (healing) => {
      for (const node of healing.nodes) {
        if (node.subtaskId === producerId) continue;
        if (node.state === "completed" || node.state === "cancelled") continue;
        const contract = healing.contracts.find((item) => item.subtaskId === node.subtaskId);
        if (!contract?.dependencyIds.includes(producerId)) continue;
        if (!node.blockedBy.includes(producerId)) {
          node.blockedBy = [...node.blockedBy, producerId];
        }
        if (node.state !== "blocked") node.state = "blocked";
        node.updatedAt = now();
      }
    }).catch(() => undefined);
  }

  private async resumeBlockedDependents(
    _leader: Agent,
    leaderRun: AgentRun,
    state: OrchestrationState,
    _sink: RunEventSink,
  ): Promise<void> {
    const queued = this.blockedStarts.get(leaderRun.id);
    if (!queued || queued.size === 0) return;
    for (const [subtaskId, blocked] of [...queued]) {
      const contract = state.healing.contracts.find((item) => item.subtaskId === subtaskId);
      const deps = contract?.dependencyIds ?? [];
      const ready = deps.every(
        (dep) => state.healing.nodes.find((item) => item.subtaskId === dep)?.state === "completed",
      );
      if (!ready) continue;
      queued.delete(subtaskId);
      await this.mutateHealingWithEvents(leaderRun.id, (healing) => {
        const node = healing.nodes.find((item) => item.subtaskId === subtaskId);
        if (!node || node.state === "completed" || node.state === "cancelled") return;
        node.state = "ready";
        node.blockedBy = [];
        node.updatedAt = now();
      }).catch(() => undefined);
      void blocked.start();
    }
    if (queued.size === 0) this.blockedStarts.delete(leaderRun.id);
  }

  private async settleBlockedDependents(
    leaderRun: AgentRun,
    state: OrchestrationState,
    producerId: string | null,
    reason: string,
  ): Promise<void> {
    const queued = this.blockedStarts.get(leaderRun.id);
    if (!queued || queued.size === 0) return;
    for (const [subtaskId, blocked] of [...queued]) {
      const contract = state.healing.contracts.find((item) => item.subtaskId === subtaskId);
      if (producerId !== null && !(contract?.dependencyIds ?? []).includes(producerId)) continue;
      queued.delete(subtaskId);
      const result: WorkerResult = {
        subtaskId,
        workerId: "",
        workerRunId: blocked.workerRunId,
        iteration: 1,
        attempt: 0,
        status: "blocked",
        output: "",
        error: reason,
        usage: null,
        durationMs: 0,
        artifacts: [],
      };
      await this.persistBlockedSettlement(leaderRun.id, state, subtaskId, result);
      blocked.settle(result);
    }
    if (queued.size === 0) this.blockedStarts.delete(leaderRun.id);
  }

  private async persistBlockedSettlement(
    runId: string,
    state: OrchestrationState,
    subtaskId: string,
    result: WorkerResult,
  ): Promise<void> {
    const node = state.healing.nodes.find((item) => item.subtaskId === subtaskId);
    if (!node) throw new Error("blocked_settlement_node_unavailable: " + subtaskId);
    const settled = await this.persistNodeTransition(
      runId,
      subtaskId,
      { revision: node.revision, from: ["pending", "ready", "blocked"] },
      (item) => { item.state = "blocked"; },
    );
    if (!settled) throw new Error("blocked_settlement_node_superseded: " + subtaskId);
    await this.store.mutate((database) => {
      const orchestration = database.runs.find((item) => item.id === runId)?.orchestration;
      if (!orchestration) throw new Error("blocked_settlement_state_unavailable: " + runId);
      if (!orchestration.workerResults.some((item) => item.subtaskId === subtaskId)) {
        orchestration.workerResults.push(structuredClone(result));
      }
      orchestration.usage = orchestrationUsage(orchestration.workerResults);
      state.healing = structuredClone(orchestration.healing);
      state.workerResults = structuredClone(orchestration.workerResults);
      state.usage = structuredClone(orchestration.usage);
      const live = this.liveOrchestration.get(runId);
      if (live && live !== state) {
        live.healing = structuredClone(orchestration.healing);
        live.workerResults = structuredClone(orchestration.workerResults);
        live.usage = structuredClone(orchestration.usage);
      }
    });
  }

  private async runRepairTournament(
    runId: string,
    subtaskId: string,
    admission: Extract<HealingAdmission, { status: "admitted" }>,
  ): Promise<TournamentOutcome> {
    const state = this.liveOrchestration.get(runId);
    const node = state?.healing.nodes.find((item) => item.subtaskId === subtaskId);
    const contract = state?.healing.contracts.find((item) => item.subtaskId === subtaskId);
    const failed: TournamentOutcome = {
      tournament: {
        id: "undeclared",
        subtaskId,
        revision: node?.revision ?? 1,
        checkpointId: null,
        candidateIds: ["", "", ""],
        status: "failed",
        winnerCandidateId: null,
        failureReason: "repair_host_unavailable",
        startedAt: null,
        completedAt: now(),
      },
      winner: null,
      contribution: null,
      status: "failed",
    };
    if (!state || !node || !contract || !this.parts.attemptWorkspaces) return failed;
    const runner = this.parts.verificationRunner;
    if (!runner) return failed;
    const repairEvidence = await this.materializeRepairEvidence(
      runId,
      admission.fault,
      admission.diagnosis,
    );
    const commonWorkspacePath = await this.sessionCommonWorkspacePath(runId);
    const workspaces = new RepairWorkspaceManager(this.git, this.parts.attemptWorkspaces, {
      commonWorkspacePath,
      emitTournamentStarted: false,
      sink: this.events.createSink(
        runId,
        this.store.snapshot().runs.find((item) => item.id === runId)?.agentId ?? runId,
      ),
    });
    const historyProjectId = this.store.snapshot().runs.find((item) => item.id === runId)?.projectId;
    const currentFailureGate = [...state.healing.verifications].reverse()
      .filter((verification) => node.verificationIds.includes(verification.id) &&
        verification.failureKind === "deterministic_gate_failure")
      .flatMap((verification) => verification.gates)
      .find((gate) => !gate.passed && gate.failureFingerprint !== null);
    const deps: RepairTournamentDeps = {
      mutateHealing: (mutate) => this.mutateHealingWithEvents(runId, mutate),
      withAuthorityLock: (operation) => this.withAuthorityLock(runId, operation),
      freeze: (input) => workspaces.freeze(input),
      persistBoundCheckpoint: (checkpoint) => workspaces.persistBoundCheckpoint(checkpoint),
      createCandidate: (input) => workspaces.createCandidate(input),
      squashWinner: (input) => workspaces.squashWinner(input),
      runCandidate: (input) => this.runRepairCandidate(runId, input),
      verify: (input) => runner.verify(input),
      settleContribution: (contribution) => this.settleRepairContribution(runId, contribution),
      loadProject: () => this.requireReadyProject(runId),
      loadAttempt: (attemptId) =>
        this.store.snapshot().runs.find((item) => item.id === runId)?.project?.attempts
          .find((item) => item.attemptId === attemptId),
      persistAttempt: async (attempt) => {
        await this.persistAttemptStarted(runId, this.requireReadyProject(runId), attempt);
      },
      emit: (draft) => {
        const agentId = this.store.snapshot().runs.find((item) => item.id === runId)?.agentId;
        if (agentId === undefined) return;
        this.events.createSink(runId, agentId).emit(draft);
      },
      authorityManifestHash: this.parts.verificationRegistry?.profile().contentHash ?? "",
      runtimeCapabilityManifest: this.repairRuntimeCapabilityManifest(state, contract),
      candidateContextManifest: repairEvidence.candidateContextManifest,
      contextAuditEvidenceRefs: repairEvidence.auditEvidenceRefs,
      ...(this.parts.exactRepeatIndex === undefined
        ? {}
        : { exactRepeatIndex: this.parts.exactRepeatIndex }),
      ...(historyProjectId === undefined || historyProjectId === null
        ? {}
        : { projectId: historyProjectId }),
      ...(this.parts.refreshEvolutionHistory === undefined
        ? {}
        : { refreshEvolutionHistory: this.parts.refreshEvolutionHistory }),
      ...(this.parts.failureCueService === undefined
        ? {}
        : { failureCueService: this.parts.failureCueService }),
      ...(currentFailureGate === undefined || currentFailureGate.failureFingerprint === null
        ? {}
        : {
            failureCueTarget: {
              gateTier: currentFailureGate.tier,
              failureFingerprint: currentFailureGate.failureFingerprint,
            },
          }),
      ...(this.parts.lineageRecorder === undefined
        ? {}
        : {
            recordPassiveTransfers: (settledTournamentId: string) =>
              this.recordSettledPassiveTransfers(runId, settledTournamentId),
            recordBranchReturns: (
              checkpoint: RepairCheckpoint,
              settledTournamentId: string,
              contribution: ContributionRecord | null,
            ) => this.recordSettledBranchReturns(runId, settledTournamentId, checkpoint, contribution),
          }),
    };
    const before = structuredClone(state.healing);
    const outcome = await new RepairTournamentRunner(deps).run({
      runId,
      node: structuredClone(node),
      contract: structuredClone(contract),
      fault: structuredClone(admission.fault),
      diagnosis: structuredClone(admission.diagnosis),
      control: this.controlFor(runId),
    });
    if (outcome.tournament.failureReason === "checkpoint_unavailable") {
      this.publishHealingTransitionEvents(runId, before, before, {
        checkpointFailure: { subtaskId, reason: "checkpoint_unavailable" },
      });
    }
    return outcome;
  }

  private async runRepairCandidate(
    runId: string,
    input: RepairCandidateRunRequest,
  ): Promise<RepairCandidateRunResult> {
    const started = Date.now();
    const workerRunId = input.attempt.attemptId;
    const runnerKey = workerRunId;
    const budgetScopeId = "repair:" + input.candidate.id;
    let runtime: AgentRuntime | null = null;
    let runtimeQuiesced = false;
    const parent = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!parent) throw new Error("repair_parent_run_unavailable");
    await this.store.mutate((database) => {
      const durableParent = database.runs.find((item) => item.id === runId);
      if (!durableParent || durableParent.status !== "running") {
        throw new Error("repair_parent_run_unavailable");
      }
      const existing = database.runs.find((item) => item.id === workerRunId);
      if (existing) {
        if (existing.parentRunId !== runId || existing.status !== "running") {
          throw new Error("repair_candidate_run_identity_mismatch");
        }
        return;
      }
      database.runs.push(repairCandidateRunRecord(durableParent, workerRunId, input.prompt));
    });
    await this.recordRepairCandidateExecutionLineage(runId, input.candidate.id);
    this.controlFor(runId).budget.openScope(
      budgetScopeId,
      WORKER_ADVISORY_CALLS,
      WORKER_ADVISORY_TOKENS,
    );
    this.rememberActiveRunKey(runId, runnerKey);
    const sink = this.events.createSink(workerRunId, parent.agentId, {
      sessionId: runId,
      member: "repair-" + input.candidate.delta.family,
      role: "repair",
    });
    sink.emit(lifecycleEvent("in_progress", "repair_candidate_started", null));
    let outcome: RepairCandidateRunResult;
    try {
      input.control.assertActive();
      const modelToken = this.modelProxy?.issue(
        workerRunId,
        workerRunId,
        this.controlFor(runId),
        budgetScopeId,
      );
      if (modelToken !== undefined) this.rememberModelRunId(runId, workerRunId);
      runtime = this.runtimeFactory(this.runner);
      this.rememberActiveRuntime(runId, workerRunId, runtime);
      const result = await this.startWorkerTurn(
        runId,
        input.attempt.subtaskId,
        workerRunId,
        input.attempt.workspacePath,
        (turnSink) =>
          runtime!.start({
            runId: workerRunId,
            agentId: runnerKey,
            parentRunId: runId,
            workspacePath: input.attempt.workspacePath,
            prompt: input.prompt,
            threadId: input.threadId,
            ...(input.runtimeImageId === null
              ? {}
              : { runtimeImageId: input.runtimeImageId }),
            coordinationEnv: {
              ...input.env,
              LAUNCHPAD_COORDINATION_URL: "",
              LAUNCHPAD_COORDINATION_TOKEN: "",
              LAUNCHPAD_REPAIR_CANDIDATE: "1",
              LAUNCHPAD_REPAIR_ALLOWED_TOOLS: JSON.stringify(input.tools),
              LAUNCHPAD_ROOT_DEADLINE_AT: this.controlFor(runId).snapshot().deadlineAt ?? "",
            },
            ...(modelToken === undefined ? {} : { modelToken }),
            sink: turnSink,
          }),
        sink,
        () => runtime,
        runnerKey,
        {
          timeoutMs: input.timeoutMs,
          repairCandidate: true,
          maxSteps: input.stepCap,
        },
      );
      outcome = {
        status: "completed",
        ...this.repairCandidateUsage(runId, input.candidate.id, result),
        elapsedMs: Date.now() - started,
        output: result.output,
      };
    } catch (error) {
      if (error instanceof RunTerminalError) {
        outcome = {
          status: "cancelled",
          ...this.repairCandidateUsage(runId, input.candidate.id, null),
          elapsedMs: Date.now() - started,
        };
      } else {
        outcome = {
          status: "failed",
          ...this.repairCandidateUsage(runId, input.candidate.id, null),
          elapsedMs: Date.now() - started,
        };
      }
    } finally {
      if (runtime && !runtimeQuiesced) {
        try {
          await runtime.quiesce("repair_candidate_terminal");
          runtimeQuiesced = true;
        } catch {
          // Keep the runtime mapped until absence is proven.
          outcome = {
            status: "failed",
            error: "infrastructure_failure",
            ...this.repairCandidateUsage(runId, input.candidate.id, null),
            elapsedMs: Date.now() - started,
          };
        }
      }
      if (runtime && runtimeQuiesced) {
        this.releaseActiveRuntimeIfProven(runId, workerRunId, runtime);
      }
      this.forgetActiveRunKey(runId, runnerKey);
    }
    const terminalStatus = outcome.status === "completed" ? "ok" : "error";
    sink.emit(lifecycleEvent(
      terminalStatus,
      "repair_candidate_" + outcome.status,
      outcome.elapsedMs,
    ));
    await this.events.close(workerRunId);
    await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const candidateRun = database.runs.find((item) => item.id === workerRunId);
      if (!candidateRun || candidateRun.parentRunId !== runId || candidateRun.status !== "running") {
        throw new Error("repair_candidate_run_identity_mismatch");
      }
      candidateRun.status = outcome.status;
      candidateRun.output = outcome.output ?? null;
      candidateRun.error = outcome.status === "completed"
        ? null
        : (outcome.error ?? "repair_candidate_" + outcome.status);
      candidateRun.usage = {
        inputTokens: outcome.actualInputTokens,
        outputTokens: outcome.actualOutputTokens,
      };
      candidateRun.completedAt = now();
    }));
    return outcome;
  }

  private async recordRepairCandidateExecutionLineage(
    runId: string,
    candidateId: string,
  ): Promise<void> {
    const recorder = this.parts.lineageRecorder;
    if (recorder === undefined) return;
    const lineageErrors: string[] = [];
    await this.store.mutate((database) => {
      const run = database.runs.find((value) => value.id === runId);
      const orchestration = run?.orchestration;
      if (!run || !orchestration) return;
      const candidate = orchestration.healing.candidates.find((value) => value.id === candidateId);
      if (candidate?.state !== "running") return;
      const before = structuredClone(orchestration.healing);
      const previous = before.candidates.find((value) => value.id === candidateId);
      if (previous === undefined) return;
      previous.state = "admitted";
      lineageErrors.push(...this.enqueueHealingLineage(
        run,
        before,
        orchestration.healing,
        database.runs,
      ));
    });
    if (lineageErrors.length > 0) {
      this.publishEvolutionHistoryUnavailable(runId, lineageErrors[0]!);
      return;
    }
    try {
      await recorder.flush(runId);
    } catch (error) {
      this.publishEvolutionHistoryUnavailable(runId, workerErrorMessage(error));
    }
  }

  private async settleRepairContribution(
    runId: string,
    contribution: ContributionRecord,
  ): Promise<WorkerResult> {
    const project = this.requireReadyProject(runId);
    const attempt = project.attempts.find(
      (item) =>
        item.attemptId === contribution.attemptId && item.revision === contribution.attemptRevision,
    );
    if (!attempt) {
      return {
        subtaskId: contribution.subtaskId,
        workerId: "",
        workerRunId: contribution.attemptId,
        iteration: 1,
        attempt: contribution.attemptRevision,
        status: "failed",
        output: "",
        error: "repair_attempt_missing",
        usage: null,
        durationMs: 0,
        artifacts: [],
      };
    }
    await this.persistContributionReady(runId, attempt, contribution.headCommit, this.cancellationEpochs.get(runId) ?? 0);
    const ready: WorkerResult = {
      subtaskId: contribution.subtaskId,
      workerId: "",
      workerRunId: contribution.attemptId,
      iteration: 1,
      attempt: contribution.attemptRevision,
      status: "contribution_ready",
      output: "",
      usage: null,
      durationMs: 0,
      artifacts: [],
      contribution,
    };
    return this.withAuthorityLock(runId, async () => {
      const fence = this.liveOrchestration.get(runId)?.healing.repairGraphFence ??
        this.store.snapshot().runs.find((item) => item.id === runId)?.orchestration?.healing.repairGraphFence ?? null;
      if (
        fence === null || contribution.repairGraphFenceHash === undefined ||
        hashRepairGraphFence(fence) !== contribution.repairGraphFenceHash
      ) throw new Error("repair_graph_fence_changed");
      return this.settleProjectContribution(
        runId,
        ready,
        contribution,
        this.cancellationEpochs.get(runId) ?? 0,
      );
    });
  }

  private async waitForBackgroundDispatches(leaderRunId: string): Promise<void> {
    while (true) {
      const dispatches = this.backgroundDispatches.get(leaderRunId);
      if (dispatches === undefined || dispatches.size === 0) return;
      await Promise.allSettled([...dispatches]);
    }
  }

  private async waitForWorkers(
    leaderRunId: string,
    state: OrchestrationState,
    request: WaitWorkersRequest,
    commonWorkspacePath?: string,
  ): Promise<unknown> {
    const requestedTimeoutSeconds = Number(request.timeoutSeconds ?? 300);
    const timeoutSeconds = Math.max(
      1,
      Math.min(requestedTimeoutSeconds, WAIT_FOR_WORKERS_SAFE_TIMEOUT_SECONDS),
    );
    const deadline = Date.now() + timeoutSeconds * 1_000;
    const team = this.teams.get(leaderRunId);
    if (team === undefined) return { ok: false, error: "TEAM_NOT_ACTIVE" };
    const targets = (request.targets ?? []).map(String).filter((item) => item.trim().length > 0);
    const targetSubtaskIds = targets.map((target) => {
      const member = team.roster.resolve(target);
      if (member) return member.subtaskId;
      if (state.workerResults.some((result) => result.subtaskId === target)) return target;
      throw new Error("WORKER_NOT_FOUND: " + target);
    });
    const isDone = () => {
      if (targetSubtaskIds.length === 0) {
        const dispatches = this.backgroundDispatches.get(leaderRunId);
        return dispatches === undefined || dispatches.size === 0;
      }
      return targetSubtaskIds.every((id) =>
        state.workerResults.some((result) => result.subtaskId === id),
      );
    };
    while (!isDone() && Date.now() < deadline) {
      const dispatches = this.backgroundDispatches.get(leaderRunId);
      await Promise.race([
        ...[...(dispatches ?? [])].map((dispatch) => dispatch.catch(() => undefined)),
        sleep(Math.min(1_000, Math.max(25, deadline - Date.now()))),
      ]);
    }
    const wanted = new Set(targetSubtaskIds);
    const results = state.workerResults
      .filter((result) => wanted.size === 0 || wanted.has(result.subtaskId))
      .map((result) => ({
        subtaskId: result.subtaskId,
        workerRunId: result.workerRunId,
        status: result.status,
        durationMs: result.durationMs,
        error: result.error ?? null,
        outputPreview: result.output.slice(0, 1200),
      }));
    const finished = new Set(results.map((result) => result.subtaskId));
    const pending = team.roster.list()
      .filter((member) =>
        wanted.size === 0
          ? !finished.has(member.subtaskId) && member.state !== "closed"
          : wanted.has(member.subtaskId) && !finished.has(member.subtaskId),
      )
      .map((member) => ({
        workerRunId: member.workerRunId,
        subtaskId: member.subtaskId,
        displayName: member.displayName,
        state: member.state,
      }));
    const pendingHandoffs = await this.pendingWorkerHandoffs(commonWorkspacePath, pending);
    const completed = pending.length === 0 && isDone();
    return {
      ok: true,
      completed,
      timedOut: !completed,
      waitedMs: Math.max(0, timeoutSeconds * 1_000 - Math.max(0, deadline - Date.now())),
      results,
      pending,
      pendingHandoffs,
      hint: completed
        ? "Workers reached terminal results. Read $COMMON_WORKSPACE/status/*.json and reports/*.md for durable handoffs before inspecting trajectories."
        : requestedTimeoutSeconds > timeoutSeconds
          ? "This wait returned before the MCP client timeout. Follow pendingHandoffs.suggestedAction before waiting again; inspect only stale, blocked, or contradictory workers."
        : "Some workers are still pending. Follow pendingHandoffs.suggestedAction first; wait again only after doing useful synthesis or checks.",
    };
  }

  private async pendingWorkerHandoffs(
    commonWorkspacePath: string | undefined,
    pending: { subtaskId: string; displayName: string; state: string; workerRunId: string }[],
  ): Promise<
    {
      subtaskId: string;
      displayName: string;
      statusPaths: string[];
      reportPaths: string[];
      statusExists: boolean;
      reportExists: boolean;
      statusAgeMs?: number;
      reportAgeMs?: number;
    }[]
  > {
    if (!commonWorkspacePath || pending.length === 0) return [];
    const nowMs = Date.now();
    return Promise.all(
      pending.map(async (member) => {
        const names = [...new Set([member.subtaskId, member.displayName].filter(Boolean))];
        const statusCandidates = names.map((name) => path.join(commonWorkspacePath, "status", name + ".json"));
        const reportCandidates = names.map((name) => path.join(commonWorkspacePath, "reports", name + ".md"));
        const [statusInfos, reportInfos] = await Promise.all([
          Promise.all(statusCandidates.map((candidate) => fileProbe(candidate, nowMs))),
          Promise.all(reportCandidates.map((candidate) => fileProbe(candidate, nowMs))),
        ]);
        const statusInfo = statusInfos.find((info) => info.exists) ?? { exists: false };
        const reportInfo = reportInfos.find((info) => info.exists) ?? { exists: false };
        return {
          subtaskId: member.subtaskId,
          displayName: member.displayName,
          statusPaths: names.map((name) => "$COMMON_WORKSPACE/status/" + name + ".json"),
          reportPaths: names.map((name) => "$COMMON_WORKSPACE/reports/" + name + ".md"),
          statusExists: statusInfo.exists,
          reportExists: reportInfo.exists,
          ...(statusInfo.ageMs === undefined ? {} : { statusAgeMs: statusInfo.ageMs }),
          ...(reportInfo.ageMs === undefined ? {} : { reportAgeMs: reportInfo.ageMs }),
        };
      }),
    );
  }

  async cancel(runId: string): Promise<void> {
    this.cancellationEpochs.set(runId, (this.cancellationEpochs.get(runId) ?? 0) + 1);
    this.controlFor(runId).stop("user_cancelled", "Run cancelled");
    const state = this.liveOrchestration.get(runId);
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (state && run) {
      await this.settleBlockedDependents(
        run,
        state,
        null,
        "Skipped: root run was cancelled",
      );
    }
    await this.terminalCancels.get(runId);
    await this.withAuthorityLock(runId, () => this.persistCancellationFence(runId));
  }

  private async sessionCommonWorkspacePath(leaderRunId: string): Promise<string> {
    const workspacePath = path.join(
      this.events.sessionDirectory(leaderRunId),
      "common-workspace",
    );
    await mkdir(workspacePath, { recursive: true });
    return workspacePath;
  }

  private liveLeaderSessionId(leader: Agent, run: AgentRun, requiresGitContribution: boolean): string {
    if (run.parentRunId !== null) return this.rootRunId(run.parentRunId);
    if (run.projectId && !requiresGitContribution) {
      const previous = this.store.snapshot().runs
        .filter((candidate) =>
          candidate.id !== run.id &&
          candidate.agentId === leader.id &&
          candidate.projectId === run.projectId &&
          candidate.kind === "orchestration" &&
          candidate.createdAt < run.createdAt)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (previous) return this.rootRunId(previous.id);
    }
    return run.id;
  }

  private rootRunId(runId: string): string {
    const runs = this.store.snapshot().runs;
    const byId = new Map(runs.map((run) => [run.id, run]));
    let current = byId.get(runId);
    const seen = new Set<string>();
    while (current?.parentRunId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.parentRunId);
      if (!parent) return current.parentRunId;
      current = parent;
    }
    return current?.id ?? runId;
  }

  private repairCandidateUsage(
    runId: string,
    candidateId: string,
    result: RunnerResult | null,
  ): Pick<
    RepairCandidateRunResult,
    "modelCalls" | "reservedTokens" | "actualInputTokens" | "actualOutputTokens"
  > {
    const scope = this.controlFor(runId).budget.usageOf("repair:" + candidateId);
    return {
      modelCalls: scope?.modelCalls ?? 0,
      reservedTokens: scope?.reservedTokens ?? 0,
      actualInputTokens: result?.usage?.inputTokens ?? scope?.actualInputTokens ?? 0,
      actualOutputTokens: result?.usage?.outputTokens ?? scope?.actualOutputTokens ?? 0,
    };
  }

  private async materializeRepairEvidence(
    runId: string,
    fault: FaultRecord,
    diagnosis: DiagnosisRecord,
  ): Promise<{
    candidateContextManifest: CandidateContextManifestV1;
    auditEvidenceRefs: string[];
  }> {
    const common = await this.sessionCommonWorkspacePath(runId);
    const directory = path.join(common, ".launchpad-repair-evidence");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const state = this.liveOrchestration.get(runId);
    const hashes: string[] = [];
    const writePayload = async (payload: unknown) => {
      const bytes = Buffer.from(JSON.stringify(payload), "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      await writeFile(path.join(directory, hash), bytes);
      hashes.push(hash);
    };
    const node = state?.healing.nodes.find((item) => item.subtaskId === fault.subtaskId);
    const snapshots: EvidenceSnapshot[] = (state?.healing.snapshots ?? []).filter((item) => {
      if (fault.evidenceRefs.includes(item.id)) return true;
      if (fault.evidenceRefs.length > 0) return false;
      return node?.attemptId ? item.attemptId === node.attemptId : false;
    });
    const candidateContextManifest = buildCandidateContextManifest({
      fault,
      snapshots,
      diagnosis,
    });
    for (const snapshot of snapshots) await writePayload(snapshot);
    await writePayload(diagnosis);
    if (hashes.length === 0) await writePayload(fault);
    const unique = [...new Set(hashes)];
    const stableContextHash = candidateContextHash(candidateContextManifest);
    fault.evidenceRefs = [...new Set([
      ...fault.evidenceRefs,
      ...unique,
      ...(stableContextHash === null ? [] : [stableContextHash]),
    ])];
    return {
      candidateContextManifest,
      auditEvidenceRefs: unique,
    };
  }

  private repairRuntimeCapabilityManifest(
    state: OrchestrationState,
    contract: SubtaskContract,
  ) {
    const environment = this.parts.runtimeCapabilityEnvironment ?? {
      schemaVersion: 1 as const,
      modelId: "",
      runtimeMode: "",
      toolSchemas: [],
      sandboxPolicyHash: "",
      containerImageId: null,
    };
    return buildRuntimeCapabilityManifest({
      harnessVersion: state.provenance.harnessVersion,
      repairPromptVersion: REPAIR_CANDIDATE_PROMPT_VERSION,
      diagnosisPromptVersion: DIAGNOSER_PROMPT_VERSION,
      environment,
      authorizedTools: contract.authorizedTools,
      excludedTools: REPAIR_EXCLUDED_TOOLS,
      timeoutMs: REPAIR_CANDIDATE_TIMEOUT_MS,
      stepCap: REPAIR_CANDIDATE_STEP_CAP,
      rootResourceHorizon: {
        modelCallCap: state.policySnapshot.emergencyModelCallFuse,
        tokenCap: state.policySnapshot.emergencyTokenFuse,
        stepCap: state.policySnapshot.maxRuntimeSteps,
        timeoutMs: state.policySnapshot.rootTimeoutMs,
        repairBranchCap: state.policySnapshot.maxRepairBranches,
        repairBranchModelCallCap: WORKER_ADVISORY_CALLS,
        repairBranchTokenCap: WORKER_ADVISORY_TOKENS,
        repairBranchStepCap: REPAIR_CANDIDATE_STEP_CAP,
        repairBranchTimeoutMs: REPAIR_CANDIDATE_TIMEOUT_MS,
      },
    });
  }

  private async leaderSessionWorkspacePath(leader: Agent, run: AgentRun): Promise<string> {
    const workspacePath = path.join(
      this.events.runDirectory(run.id, leader.id, {
        sessionId: run.id,
        member: "leader",
        role: "leader",
      }),
      "workspace",
    );
    await this.workspaces.createTaskScoped(leader, workspacePath);
    return workspacePath;
  }

  private async runSubtask(
    leader: Agent,
    leaderRun: AgentRun,
    subtask: LeaderSubtask,
    iteration: number,
    attempt: number,
    upstream: WorkerResult[],
    leaderSink: RunEventSink,
    options: {
      workspaceMode?: "policy" | "persistent_worker";
      orchestrationState?: OrchestrationState;
    } = {},
  ): Promise<WorkerResult> {
    const subtaskId = subtask.id;
    const started = Date.now();
    let worker = await this.resolveWorker(leader, subtask);
    // Reuse the id the roster already advertised, so a message queued for this
    // subtask before it started reaches the worker that actually runs it.
    const workerRunId =
      this.teams.get(leaderRun.id) === undefined
        ? randomUUID()
        : this.plannedWorkerRunId(leaderRun.id, iteration, subtask.id);
    const runnerKey = workerRunId;
    const liveSessionId = this.liveLeaderSessionId(
      leader,
      leaderRun,
      this.projectAtWaveStart(leaderRun.id) !== null &&
        requiresProjectContributionRequest(leaderRun.prompt),
    );
    const placement = {
      sessionId: liveSessionId,
      member: worker.name,
      role: subtask.role,
    };
    const useTaskScopedWorkspace =
      options.workspaceMode !== "persistent_worker" &&
      this.policy.workerWorkspacePolicy === "fresh_task_scoped";
    let workspacePath =
      useTaskScopedWorkspace
        ? path.join(this.events.runDirectory(workerRunId, worker.id, placement), "workspace")
        : worker.workspacePath;
    let projectAttempt: AttemptWorkspaceRecord | null = null;
    let ownsPersistedAttempt = false;
    let runtime: AgentRuntime | null = null;
    let runtimeQuiesced = false;
    const authorityEpoch = this.cancellationEpochs.get(leaderRun.id) ?? 0;
    const commonWorkspacePath = await this.sessionCommonWorkspacePath(liveSessionId);
    const skillPlan = await this.routeSkillsForTask(
      leaderRun.id,
      [
        subtask.title,
        subtask.role,
        subtask.prompt,
        subtask.objective,
        subtask.expectedOutput,
        ...subtask.successCriteria,
      ].join("\n"),
      commonWorkspacePath,
      options.orchestrationState ?? this.liveOrchestration.get(leaderRun.id) ?? this.initialState(),
    );
    if (useTaskScopedWorkspace && !this.projectAtWaveStart(leaderRun.id)) {
      await this.workspaces.createTaskScoped(worker, workspacePath);
      worker = { ...worker, workspacePath };
    }
    await this.createSubtaskRun(worker, workerRunId, leaderRun.id, subtask.prompt);
    this.rememberActiveRunKey(leaderRun.id, runnerKey);
    leaderSink.emit(
      dispatchEvent(subtask, iteration, attempt, worker, workerRunId, "in_progress"),
    );
    const sink = this.events.createSink(workerRunId, worker.id, placement);
    let terminalPublicationStarted = false;
    try {
      this.throwIfCancelled(leader.id, leaderRun.id);
      const projectAtAttemptStart = this.projectAtWaveStart(leaderRun.id);
      if (projectAtAttemptStart && subtask.requiresGitContribution !== false) {
        const baseCommit = projectAtAttemptStart.headCommit;
        if (!baseCommit) throw new Error("project_wave_checkpoint_unavailable");
        let validation: WorkerValidation | undefined;
        const executed = await this.createAttemptExecutor().execute({
          runId: leaderRun.id,
          project: projectAtAttemptStart,
          attemptId: this.plannedAttemptId(leaderRun.id, subtaskId),
          revision: (iteration - 1) * this.policy.maxTotalWorkerRuns + attempt,
          subtaskId,
          baseCommit,
          authorityEpoch,
          throwIfCancelled: () => this.throwIfCancelled(leader.id, leaderRun.id),
          run: async (attemptWorkspace, attemptRecord) => {
            projectAttempt = attemptRecord;
            ownsPersistedAttempt = true;
            workspacePath = attemptWorkspace;
            worker = { ...worker, workspacePath };
            const modelToken = this.modelProxy?.issue(
              workerRunId,
              worker.id,
              this.controlFor(leaderRun.id),
              workerRunId,
            );
            if (modelToken !== undefined && this.teams.has(leaderRun.id)) {
              this.rememberModelRunId(leaderRun.id, workerRunId);
            }
            const coordinationEnv = this.coordinationEnv(leaderRun.id, workerRunId);
            runtime = this.runtimeFactory(this.runner);
            this.rememberActiveRuntime(leaderRun.id, workerRunId, runtime);
            await this.teams.get(leaderRun.id)?.attach(workerRunId, runtime);
            const startedTurn = await this.startWorkerTurn(
              leaderRun.id,
              subtask.id,
              workerRunId,
              workspacePath,
              (turnSink) =>
                runtime!.start({
                  runId: workerRunId,
                  agentId: runnerKey,
                  agentRole: subtask.role,
                  parentRunId: leaderRun.id,
                  workspacePath,
                  commonWorkspacePath,
                  prompt: buildWorkerPrompt(subtask, upstream, this.policy, true, skillPlan),
                  ...(coordinationEnv === undefined ? {} : { coordinationEnv }),
                  ...(modelToken === undefined ? {} : { modelToken }),
                  threadId:
                    this.policy.workerSessionPolicy === "fresh" ? null : worker.codexThreadId,
                  sink: turnSink,
                }),
              sink,
              () => runtime,
              runnerKey,
            );
            this.detachWorkerIngress(leaderRun.id, workerRunId, runtime);
            return startedTurn;
          },
          repairCommitMarker: async ({ runnerResult, error }) => {
            if (runtime === null || runtime.capability() !== "live_steer") return null;
            if (runtime.snapshot().state === "closed") return null;
            leaderSink.emit(
              delegationEvent(
                "contribution_marker_repair",
                "executing",
                iteration,
                subtask.id + " ended with an invalid contribution marker; waking the same worker once to resend a corrected final response.",
                "warning",
                { subtaskId: subtask.id, workerRunId, reason: error.code },
              ),
            );
            const repaired = await runtime.wake({
              id: randomUUID(),
              parentRunId: leaderRun.id,
              fromWorkerRunId: leaderRun.id,
              toWorkerRunId: workerRunId,
              delivery: "wakeup",
              workspaceRefs: [],
              createdAt: now(),
              content: [
                "Contribution repair required: your prior response did not produce a collectable project contribution.",
                "Original subtask: " + subtask.prompt,
                "Inspect the current Git state. If the intended work is already complete and exactly one commit exists, do not edit files or make another commit; resend the final handoff.",
                "If no committed contribution exists yet, continue the original subtask now, make exactly one commit, leave the worktree clean, then send the final handoff.",
                "The final non-empty line must be exactly LAUNCHPAD_COMMIT=<40 lowercase hex SHA>, with no code fence, no duplicate marker, and no trailing prose.",
              ].join("\n"),
            });
            if (repaired.state !== "delivered" || repaired.output === undefined) return null;
            return {
              output: repaired.output,
              threadId: runnerResult.threadId,
              usage: repaired.usage ?? runnerResult.usage,
            };
          },
          quiesce: async () => {
            if (runtime === null || runtimeQuiesced) return;
            await runtime.quiesce("structural_collection");
            runtimeQuiesced = true;
            this.releaseActiveRuntime(leaderRun.id, workerRunId, runtime);
            if (!this.teams.has(leaderRun.id)) {
              this.modelProxy?.revoke(workerRunId);
            }
          },
          afterQuiesce: async (startedTurn) => {
            validation = await this.validateWorkerTurn(
              workerRunId,
              subtask.prompt,
              startedTurn.output,
            );
            if (validation.integrity === "invalid") {
              throw new Error(validation.summary);
            }
          },
        });
        const workerResult: WorkerResult = {
          ...executed.workerResult,
          workerId: worker.id,
          workerRunId,
          iteration,
          attempt,
          durationMs: Date.now() - started,
          ...(validation ? { validation } : {}),
        };
        if (workerResult.status === "contribution_ready") {
          await this.completeSubtaskRun(
            worker.id,
            workerRunId,
            executed.runnerResult,
            sink,
            lifecycleEvent("ok", "contribution_ready", Date.now() - started),
          );
          terminalPublicationStarted = true;
          leaderSink.emit(
            dispatchEvent(
              subtask,
              iteration,
              attempt,
              worker,
              workerRunId,
              "ok",
              executed.runnerResult.output,
            ),
          );
          return workerResult;
        }
        const cancelled = workerResult.status === "cancelled";
        sink.emit(
          lifecycleEvent(
            "error",
            cancelled ? "cancelled" : "failed",
            Date.now() - started,
          ),
        );
        if (workerResult.error?.includes("attempt_failure_persistence_failed")) {
          this.events.createSink(leaderRun.id, leader.id).emit(
            delegationEvent(
              "attempt_failure_persistence_failed",
              "executing",
              iteration,
              "Attempt terminal state could not be published; workspace preserved for recovery.",
              "error",
            ),
          );
        }
        await this.failSubtaskRun(
          worker.id,
          workerRunId,
          workerResult.error ?? "project attempt failed",
          cancelled,
        );
        terminalPublicationStarted = true;
        leaderSink.emit(
          dispatchEvent(
            subtask,
            iteration,
            attempt,
            worker,
            workerRunId,
            cancelled ? "warning" : "error",
            workerResult.error,
          ),
        );
        return workerResult;
      } else if (useTaskScopedWorkspace) {
        workspacePath = this.workspaces.taskWorkspacePath(worker.id, leaderRun.id, workerRunId);
        await this.workspaces.createTaskScoped(worker, workspacePath);
        worker = { ...worker, workspacePath };
      }
      const modelToken = this.modelProxy?.issue(
        workerRunId,
        worker.id,
        this.controlFor(leaderRun.id),
        workerRunId,
      );
      if (modelToken !== undefined && this.teams.has(leaderRun.id)) {
        this.rememberModelRunId(leaderRun.id, workerRunId);
      }
      // One token per worker run: calling this twice would mint a second and
      // leave the first registered with nothing using it.
      const coordinationEnv = this.coordinationEnv(leaderRun.id, workerRunId);
      runtime = this.runtimeFactory(this.runner);
      this.rememberActiveRuntime(leaderRun.id, workerRunId, runtime);
      // Without this the team holds a roster entry with nothing behind it, and
      // every message to this worker sits queued forever while the sender is
      // told it was sent.
      await this.teams.get(leaderRun.id)?.attach(workerRunId, runtime);
      const result = await this.startWorkerTurn(
        leaderRun.id,
        subtask.id,
        workerRunId,
        workspacePath,
        (turnSink) =>
          runtime!.start({
            runId: workerRunId,
            agentId: runnerKey,
            parentRunId: leaderRun.id,
            workspacePath,
            commonWorkspacePath,
            prompt: buildWorkerPrompt(subtask, upstream, this.policy, false, skillPlan),
            ...(coordinationEnv === undefined ? {} : { coordinationEnv }),
            ...(modelToken === undefined ? {} : { modelToken }),
            threadId:
              this.policy.workerSessionPolicy === "fresh" ? null : worker.codexThreadId,
            sink: turnSink,
          }),
        sink,
        () => runtime,
        runnerKey,
      );
      this.detachWorkerIngress(leaderRun.id, workerRunId, runtime);
      await runtime.quiesce("structural_collection");
      runtimeQuiesced = true;
      this.releaseActiveRuntime(leaderRun.id, workerRunId, runtime);
      if (!this.teams.has(leaderRun.id)) {
        this.modelProxy?.revoke(workerRunId);
      }
      this.throwIfCancelled(leader.id, leaderRun.id);
      const validation = await this.validateWorkerTurn(
        workerRunId,
        subtask.prompt,
        result.output,
      );
      // A clean process exit is not the same claim as "the work happened".
      // Deterministic protocol breakage fails the worker so the scheduler's
      // existing failure path blocks its dependants, rather than letting them
      // read state this turn never produced.
      if (validation.integrity === "invalid") {
        sink.emit(lifecycleEvent("error", "failed", Date.now() - started));
        await this.failSubtaskRun(worker.id, workerRunId, validation.summary, false);
        terminalPublicationStarted = true;
        leaderSink.emit(
          dispatchEvent(
            subtask,
            iteration,
            attempt,
            worker,
            workerRunId,
            "error",
            validation.summary,
          ),
        );
        return {
          subtaskId,
          workerId: worker.id,
          workerRunId,
          iteration,
          attempt,
          status: "failed",
          // Output and events are kept: they are what makes the failure legible.
          output: result.output,
          error: validation.summary,
          usage: result.usage,
          durationMs: Date.now() - started,
          artifacts: [],
          validation,
        };
      }
      await this.completeSubtaskRun(
        worker.id,
        workerRunId,
        result,
        sink,
        lifecycleEvent("ok", "completed", Date.now() - started),
      );
      terminalPublicationStarted = true;
      leaderSink.emit(
        dispatchEvent(
          subtask,
          iteration,
          attempt,
          worker,
          workerRunId,
          "ok",
          result.output,
        ),
      );
      return {
        subtaskId,
        workerId: worker.id,
        workerRunId,
        iteration,
        attempt,
        status: "completed",
        output: result.output,
        usage: result.usage,
        durationMs: Date.now() - started,
        artifacts: [],
        validation,
      };
    } catch (error) {
      if (error instanceof RunTerminalError) throw error;
      if (terminalPublicationStarted) throw error;
      if (error instanceof TerminalPublicationError) {
        return {
          subtaskId,
          workerId: worker.id,
          workerRunId,
          iteration,
          attempt,
          status: "failed",
          output: "",
          error: error.message,
          usage: null,
          durationMs: Date.now() - started,
          artifacts: [],
        };
      }
      if (projectAttempt && !ownsPersistedAttempt && this.parts.attemptWorkspaces) {
        const latestProject = this.store.snapshot().runs.find((item) => item.id === leaderRun.id)?.project;
        if (latestProject) {
          const recovery = await this.parts.attemptWorkspaces.compensateUnpersisted(
            latestProject,
            projectAttempt,
          );
          if (recovery.action === "preserved") {
            await this.persistCompensationEvidence(
              leaderRun.id,
              projectAttempt,
              workerErrorMessage(error),
            ).catch(() => undefined);
          }
        }
      }
      const status = classifyWorkerError(error);
      let message = workerErrorMessage(error);
      sink.emit(
        lifecycleEvent(
          "error",
          status === "cancelled" ? "cancelled" : "failed",
          Date.now() - started,
        ),
      );
      if (projectAttempt && ownsPersistedAttempt) {
        try {
          await this.persistAttemptFailure(
            leaderRun.id,
            projectAttempt,
            status === "cancelled" ? "cancelled" : "failed",
            message,
          );
        } catch (persistenceError) {
          message += "; attempt_failure_persistence_failed";
          await this.persistAttemptRecoveryEvidence(leaderRun.id, projectAttempt).catch(() => undefined);
          this.events.createSink(leaderRun.id, leader.id).emit(
            delegationEvent(
              "attempt_failure_persistence_failed",
              "executing",
              iteration,
              "Attempt terminal state could not be published; workspace preserved for recovery.",
              "error",
            ),
          );
        }
      }
      await this.failSubtaskRun(worker.id, workerRunId, message, status === "cancelled");
      terminalPublicationStarted = true;
      leaderSink.emit(
        dispatchEvent(
          subtask,
          iteration,
          attempt,
          worker,
          workerRunId,
          status === "cancelled" ? "warning" : "error",
          message,
        ),
      );
      return {
        subtaskId,
        workerId: worker.id,
        workerRunId,
        iteration,
        attempt,
        status,
        output: "",
        error: message,
        usage: null,
        durationMs: Date.now() - started,
        artifacts: [],
      };
    } finally {
      if (runtime) {
        this.detachWorkerIngress(leaderRun.id, workerRunId, runtime);
        if (!runtimeQuiesced) {
          try {
            await runtime.quiesce("worker_terminal");
            runtimeQuiesced = true;
          } catch {
            // Keep the runtime in the cancellation map: absence was not proven.
          }
        }
        if (runtimeQuiesced) {
          this.releaseActiveRuntimeIfProven(leaderRun.id, workerRunId, runtime);
        }
      }
      if (!this.teams.has(leaderRun.id)) {
        this.modelProxy?.revoke(workerRunId);
      }
      this.forgetActiveRunKey(leaderRun.id, runnerKey);
      await this.monitors.get(workerRunId)?.drain().catch(() => undefined);
    }
  }

  private createAttemptExecutor(): ProjectAttemptExecutor {
    if (!this.parts.attemptWorkspaces || !this.parts.contributionCollector) {
      throw new Error("project_contribution_runtime_unavailable");
    }
    return new ProjectAttemptExecutor(
      this.parts.attemptWorkspaces,
      this.parts.contributionCollector,
      {
        persistAttemptStarted: (runId, project, attempt) =>
          this.persistAttemptStarted(runId, project, attempt),
        persistContributionReady: (runId, expected, headCommit, authorityEpoch) =>
          this.persistContributionReady(runId, expected, headCommit, authorityEpoch),
        persistAttemptFailure: (runId, expected, state, reason) =>
          this.persistAttemptFailure(runId, expected, state, reason),
        persistCompensationEvidence: (runId, attempt, reason) =>
          this.persistCompensationEvidence(runId, attempt, reason),
        persistAttemptRecoveryEvidence: (runId, expected) =>
          this.persistAttemptRecoveryEvidence(runId, expected),
        loadProject: (runId) =>
          this.store.snapshot().runs.find((item) => item.id === runId)?.project ?? null,
        withAuthorityLock: (runId, operation) => this.withAuthorityLock(runId, operation),
        ...(this.parts.beforeContributionReadyForTest
          ? { beforeContributionReadyForTest: () => this.parts.beforeContributionReadyForTest!() }
          : {}),
      },
    );
  }

  private resolveLiveLeaderProjectOutcome(
    runId: string,
    state: OrchestrationState,
  ): NonNullable<OrchestrationState["outcome"]> {
    const project = this.store.snapshot().runs.find((item) => item.id === runId)?.project;
    const passed = project?.integrations.filter((record) =>
      record.state === "integrated" && record.structuralDecision === "passed"
    ) ?? [];
    const unresolved = state.workerResults.filter((result) =>
      result.status === "failed" || result.status === "blocked" || result.status === "cancelled"
    );
    const evidence = [
      "integrations=" + passed.length,
      "workers=" + state.workerResults.length,
      ...unresolved.map((result) => result.subtaskId + "=" + result.status),
    ];
    if (passed.length >= 1 && unresolved.length === 0) {
      return {
        value: "succeeded",
        reason: "At least one contribution was integrated and passed the structural gate.",
        evidence,
        resolvedAt: now(),
      };
    }
    if (unresolved.length > 0) {
      return {
        value: "failed",
        reason: "Required contributions did not complete successfully.",
        evidence,
        resolvedAt: now(),
      };
    }
    return {
      value: "failed",
      reason: "Project-backed run produced no integrated contribution.",
      evidence,
      resolvedAt: now(),
    };
  }

  private async evaluateLiveCoordinatorOutcome(
    run: AgentRun,
    state: OrchestrationState,
    sink: RunEventSink,
  ): Promise<boolean> {
    state.phase = "evaluating";
    await this.persistState(run.id, state);
    const iterationPlan = [...state.iterationPlans].reverse().find((entry) =>
      entry.reason === "leader_codex"
    );
    const plannedIds = new Set(iterationPlan?.plan.subtasks.map((subtask) => subtask.id) ?? []);
    const resultIds = new Set(state.workerResults.map((result) => result.subtaskId));
    const planConsistent = iterationPlan !== undefined && plannedIds.size === resultIds.size &&
      [...plannedIds].every((subtaskId) => resultIds.has(subtaskId));
    const evaluationResult = planConsistent
      ? await this.parts.evaluator.evaluate(
          run.prompt,
          iterationPlan.plan,
          state.workerResults,
          this.recorder(sink, state.iteration, run.id),
        )
      : {
          status: "unavailable" as const,
          reason: "live_plan_unavailable",
          error: "Durable live coordinator plan did not match the settled worker results",
          promptVersion: EVALUATOR_PROMPT_VERSION,
        };
    if (evaluationResult.status === "available") {
      state.provenance.evaluatorModel = evaluationResult.model;
    }
    state.evaluationRecords.push({
      iteration: state.iteration,
      createdAt: now(),
      planIteration: iterationPlan?.iteration ?? state.iteration,
      result: evaluationResult,
    });
    state.outcome = resolveOutcome({
      evaluatorAvailable: evaluationResult.status === "available",
      evaluationSufficient:
        evaluationResult.status === "available" && evaluationResult.evaluation.sufficient,
      results: state.workerResults,
    });
    const unresolvedRequired = state.workerResults.filter((result) =>
      result.status === "failed" || result.status === "blocked" || result.status === "cancelled"
    );
    if (unresolvedRequired.length > 0) {
      const cancelled = unresolvedRequired.some((result) => result.status === "cancelled");
      state.outcome = {
        value: cancelled ? "unknown" : "failed",
        reason: cancelled
          ? "Run was cancelled before an outcome could be established."
          : "Required subtasks did not complete successfully.",
        evidence: unresolvedRequired.map((result) => result.subtaskId + "=" + result.status),
        resolvedAt: now(),
      };
      state.phase = cancelled ? "cancelled" : "failed";
      await this.failLeaderRun(
        run.id,
        run.agentId,
        state.outcome.reason,
        state,
        cancelled,
      );
      return false;
    }
    await this.persistState(run.id, state);
    sink.emit(
      delegationEvent(
        "evaluation",
        "evaluation",
        state.iteration,
        evaluationResult.status === "available"
          ? evaluationSummary(evaluationResult.evaluation)
          : "Evaluator unavailable; project outcome remains unestablished.",
        evaluationResult.status === "available" ? "ok" : "warning",
        { result: evaluationResult },
      ),
    );
    return true;
  }

  private projectAtWaveStart(runId: string): ProjectRunRecord | null {
    const project = this.store.snapshot().runs.find((run) => run.id === runId)?.project;
    if (!project || project.source.mode === "ephemeral_research") return null;
    if (project.state !== "ready" || !project.headCommit) {
      throw new Error("project_wave_checkpoint_unavailable");
    }
    return structuredClone(project);
  }

  private async settleAndHealProjectWave(
    runId: string,
    results: WorkerResult[],
    authorityEpoch: number,
  ): Promise<WorkerResult[]> {
    const settled: WorkerResult[] = [];
    for (const result of results) {
      let current = result;
      if (current.status === "contribution_ready") {
        if (!this.parts.attemptWorkspaces || !this.parts.contributionIntegrator) {
          throw new Error("project_integration_runtime_unavailable");
        }
        const contribution = current.contribution;
        if (!contribution || contribution.subtaskId !== current.subtaskId) {
          throw new Error("contribution_ready_missing_record");
        }
        const original = current;
        current = await this.withAuthorityLock(runId, () =>
          this.settleProjectContribution(runId, current, contribution, authorityEpoch));
        await this.classifyReturnedWorker(
          runId,
          original.subtaskId,
          current.status === "completed" ? current : original,
          false,
        );
      } else if (current.status !== "blocked") {
        await this.classifyReturnedWorker(
          runId,
          current.subtaskId,
          current,
          this.trajectoryContext(runId).ephemeral,
        );
      }
      if (
        (current.status === "failed" || current.status === "timed_out") &&
        this.healingProjectRun(runId)
      ) {
        await this.blockDependents(runId, current.subtaskId);
        const admission = await this.beginHealing(runId, current.subtaskId);
        if (admission?.status === "admitted") {
          const healed = await this.runRepairTournament(runId, current.subtaskId, admission);
          if (healed.status === "promoted") {
            const { error: _prior, ...rest } = current;
            current = {
              ...rest,
              status: "completed",
              ...(healed.contribution ? { contribution: healed.contribution } : {}),
            };
            await this.emitHealingEvent(
              runId,
              "dependency_resumed",
              current.subtaskId,
              "Producer " + current.subtaskId + " repaired; dependents may resume.",
              "ok",
            );
          } else {
            current = {
              ...current,
              status: "failed",
              error: healed.tournament.failureReason ?? "repair_unavailable:tournament_failed",
            };
          }
        } else if (admission?.status === "unavailable") {
          current = {
            ...current,
            status: "failed",
            error: "repair_unavailable:" + admission.reason,
          };
        }
      }
      settled.push(current);
    }
    return settled;
  }

  private async settleProjectContribution(
    runId: string,
    result: WorkerResult,
    contribution: ContributionRecord,
    authorityEpoch: number,
  ): Promise<WorkerResult> {
    if (!this.parts.attemptWorkspaces || !this.parts.contributionIntegrator) {
      throw new Error("project_integration_runtime_unavailable");
    }
    this.controlFor(runId).assertActive();
    const project = this.requireReadyProject(runId);
    const attempt = project.attempts.find((candidate) =>
      candidate.attemptId === contribution.attemptId &&
      candidate.revision === contribution.attemptRevision
    );
    if (!attempt) throw new Error("integration_attempt_unavailable");
    if (this.integrationCancelled(runId, authorityEpoch)) throw new RunCancelledError();
    const healing = this.healingProjectRun(runId)
      ? await this.verifyBeforeIntegration(runId, result, contribution, attempt)
      : null;
    if (healing && !healing.admitted) {
      return { ...result, status: "failed", error: healing.reason };
    }
    const integrating = await this.persistIntegrationStarted(
        runId,
        project,
        attempt,
        contribution,
        authorityEpoch,
    );
    if (this.integrationCancelled(runId, authorityEpoch)) {
      await this.cancelIntegratingContribution(runId, project, attempt, integrating);
    }
    try {
      await this.parts.attemptWorkspaces.importContribution(project, attempt, contribution);
    } catch (error) {
        const failed: IntegrationRecord = {
          ...integrating,
          state: "rolled_back",
          reason: "contribution_import_failed: " + workerErrorMessage(error),
        };
        if (this.integrationCancelled(runId, authorityEpoch)) {
          await this.cancelIntegratingContribution(runId, project, attempt, integrating);
        }
        const persistedFailure = await this.persistIntegrationDecision(
          runId, attempt, failed, integrating.canonicalHeadBefore, authorityEpoch,
        );
        if (!persistedFailure) {
          await this.cancelIntegratingContribution(runId, project, attempt, integrating);
        }
        const importReason = failed.reason ?? "contribution_import_failed";
        await this.failIntegrationPendingNode(runId, contribution, attempt, healing, importReason);
        return { ...result, status: "failed", error: importReason };
    }
    if (this.integrationCancelled(runId, authorityEpoch)) {
      await this.cancelIntegratingContribution(runId, project, attempt, integrating);
    }

      // If application or rollback authority itself fails, leave the durable
      // `integrating` record untouched for restart reconciliation.
    const entered = await this.enterIntegrating(runId, contribution, attempt, healing);
    const decision = await this.parts.contributionIntegrator.integrate(runId, project, contribution, {
      control: this.controlFor(runId),
      ...(healing
        ? {
            postIntegrationVerify: (workspacePath, appliedHead, canonicalHeadBefore) =>
              this.verifyAfterIntegration(
                runId,
                result,
                contribution,
                workspacePath,
                appliedHead,
                canonicalHeadBefore,
              ),
          }
        : {}),
    });
      await this.parts.afterCanonicalIntegrationForTest?.();
      if (this.integrationCancelled(runId, authorityEpoch)) {
        await this.cancelIntegratingContribution(runId, project, attempt, integrating);
      }
      if (healing) {
        decision.record.verificationIds = [
          healing.verification.id,
          ...decision.record.verificationIds.filter((id) => id !== healing.verification.id),
        ];
      }
      const persisted = await this.persistIntegrationDecision(
        runId,
        attempt,
        decision.record,
        decision.projectHead,
        authorityEpoch,
      );
      if (!persisted) {
        await this.cancelIntegratingContribution(runId, project, attempt, integrating);
      }
      await this.parts.afterIntegrationDecisionForTest?.();
      if (this.integrationCancelled(runId, authorityEpoch)) {
        if (decision.record.state === "integrated") {
          await this.cancelDecidedContribution(runId, project, attempt, decision.record, entered);
        }
        throw new RunCancelledError();
      }
      if (decision.record.state !== "integrated") {
        await this.settleNode(runId, contribution, entered, "failed", null);
        return {
          ...result,
          status: "failed",
          error: decision.record.reason ?? "integration_failed",
        };
      }
      await this.settleNode(runId, contribution, entered, "completed", contribution.contributionId);

      const integratedProject = this.requireReadyProject(runId);
      const integratedAttempt = integratedProject.attempts.find((candidate) =>
        candidate.attemptId === attempt.attemptId && candidate.revision === attempt.revision
      );
      if (!integratedAttempt) throw new Error("integrated_attempt_persistence_missing");
      const cleanup = await this.parts.attemptWorkspaces.removeIntegrated(
        integratedProject,
        integratedAttempt,
        contribution,
        decision.record,
      );
      if (cleanup.action !== "removed") {
        await this.persistIntegratedCleanup(runId, integratedAttempt, "preserved", cleanup.reason);
        return { ...result, status: "completed" };
      }
      await this.persistIntegratedCleanup(runId, integratedAttempt, "removed", null);
    return { ...result, status: "completed" };
  }

  /**
   * The outer authority decides before the contribution touches anything the
   * canonical checkout can see. A missing contract, a dirty attempt worktree, a
   * refused node transition, or an authority that throws all deny import — the
   * structural gate is never a fallback once healing is on.
   */
  private async verifyBeforeIntegration(
    runId: string,
    result: WorkerResult,
    contribution: ContributionRecord,
    attempt: AttemptWorkspaceRecord,
  ): Promise<PreIntegrationDecision> {
    const subtaskId = contribution.subtaskId;
    const runner = this.requireVerificationRunner();
    const contract = this.healingContract(runId, subtaskId);
    const entering = contract
      ? await this.persistNodeTransition(
          runId,
          subtaskId,
          {
            revision: contract.revision,
            from: attempt.kind === "repair" ? (["repairing"] as const) : VERIFIABLE_NODE_STATES,
          },
          (node) => {
            node.state = "verifying";
            node.attemptId = attempt.attemptId;
          },
        )
      : null;
    if (!contract || !entering) {
      const reason = contract
        ? "verification_node_unavailable: " + subtaskId
        : "verification_contract_unavailable: " + subtaskId;
      this.emitHealingEvent(runId, "verification_failed", subtaskId, reason, "error");
      return { admitted: false, reason };
    }
    this.emitHealingEvent(
      runId,
      "verification_started",
      subtaskId,
      "Pre-integration authority on " + contribution.contributionId,
      "in_progress",
      { stage: "pre_integration", attemptId: attempt.attemptId },
    );

    let verification: VerificationResult;
    try {
      if (!(await this.git.isClean(attempt.workspacePath))) {
        throw new Error("attempt_worktree_dirty: " + attempt.attemptId);
      }
      verification = await runner.verify({
        subjectType: "contribution",
        subjectId: contribution.contributionId,
        stage: "pre_integration",
        workspacePath: attempt.workspacePath,
        baseCommit: attempt.baseCommit,
        contract,
        control: this.controlFor(runId),
      });
    } catch (error) {
      const reason = "pre_integration_verification_error: " + workerErrorMessage(error);
      await this.persistNodeTransition(
        runId,
        subtaskId,
        { revision: entering.revision, from: ["verifying"], attemptId: attempt.attemptId },
        (node) => { node.state = "failed"; },
      );
      this.emitHealingEvent(runId, "verification_failed", subtaskId, reason, "error");
      if (error instanceof RunCancelledError || error instanceof RunTerminalError) throw error;
      return { admitted: false, reason };
    }

    await this.persistVerification(runId, subtaskId, verification);
    await this.observeVerification(runId, result.workerRunId ?? null, verification);
    const denial = verificationDenial(
      verification,
      "pre_integration",
      contribution.contributionId,
    );
    if (denial) {
      const reason = denial + ": " + subtaskId;
      await this.persistNodeTransition(
        runId,
        subtaskId,
        { revision: entering.revision, from: ["verifying"], attemptId: attempt.attemptId },
        (node) => { node.state = "failed"; },
      );
      this.emitHealingEvent(runId, "verification_failed", subtaskId, reason, "error", {
        stage: "pre_integration",
        verificationId: verification.id,
      });
      return { admitted: false, reason };
    }
    const admitted = await this.persistNodeTransition(
      runId,
      subtaskId,
      { revision: entering.revision, from: ["verifying"], attemptId: attempt.attemptId },
      (node) => { node.state = "integration_pending"; },
    );
    if (!admitted) {
      const reason = "verification_node_superseded: " + subtaskId;
      this.emitHealingEvent(runId, "verification_failed", subtaskId, reason, "error");
      return { admitted: false, reason };
    }
    this.emitHealingEvent(
      runId,
      "verification_passed",
      subtaskId,
      "Pre-integration authority passed for " + contribution.contributionId,
      "ok",
      { stage: "pre_integration", verificationId: verification.id },
    );
    return { admitted: true, verification };
  }

  /**
   * Runs inside the integrator's serialized turn, on the canonical checkout with
   * the contribution already applied. The integrator, not this method, decides
   * what to do with a failing verdict.
   *
   * The range base is the canonical head the integrator applied onto, never the
   * attempt's own base commit: on the canonical checkout the attempt's base can
   * sit several already-integrated contributions back, and a range-scoped gate
   * would then judge this contract against another subtask's files.
   */
  private async verifyAfterIntegration(
    runId: string,
    result: WorkerResult,
    contribution: ContributionRecord,
    workspacePath: string,
    appliedHead: string,
    canonicalHeadBefore: string,
  ): Promise<VerificationResult> {
    const subtaskId = contribution.subtaskId;
    const contract = this.healingContract(runId, subtaskId);
    if (!contract) throw new Error("verification_contract_unavailable: " + subtaskId);
    this.emitHealingEvent(
      runId,
      "verification_started",
      subtaskId,
      "Post-integration authority on " + appliedHead,
      "in_progress",
      { stage: "post_integration", appliedHead, baseCommit: canonicalHeadBefore },
    );
    const verification = await this.requireVerificationRunner().verify({
      subjectType: "contribution",
      subjectId: contribution.contributionId,
      stage: "post_integration",
      workspacePath,
      baseCommit: canonicalHeadBefore,
      contract,
      control: this.controlFor(runId),
    });
    await this.persistVerification(runId, subtaskId, verification);
    await this.observeVerification(runId, result.workerRunId ?? null, verification);
    this.emitHealingEvent(
      runId,
      verification.mandatoryPassed ? "verification_passed" : "verification_failed",
      subtaskId,
      "Post-integration authority on " + appliedHead,
      verification.mandatoryPassed ? "ok" : "error",
      { stage: "post_integration", verificationId: verification.id },
    );
    return verification;
  }

  private async enterIntegrating(
    runId: string,
    contribution: ContributionRecord,
    attempt: AttemptWorkspaceRecord,
    healing: PreIntegrationDecision & { admitted: true } | null,
  ): Promise<TaskNodeState | null> {
    if (!healing) return null;
    const contract = this.healingContract(runId, contribution.subtaskId);
    if (!contract) throw new Error("verification_contract_unavailable: " + contribution.subtaskId);
    const entered = await this.persistNodeTransition(
      runId,
      contribution.subtaskId,
      { revision: contract.revision, from: ["integration_pending"], attemptId: attempt.attemptId },
      (node) => { node.state = "integrating"; },
    );
    if (!entered) throw new Error("integration_node_superseded: " + contribution.subtaskId);
    this.emitHealingEvent(
      runId,
      "integration_started",
      contribution.subtaskId,
      "Canonical integration of " + contribution.contributionId,
      "in_progress",
      { contributionId: contribution.contributionId },
    );
    return entered;
  }

  /** Denies a contribution whose node never reached `integrating`. */
  private async failIntegrationPendingNode(
    runId: string,
    contribution: ContributionRecord,
    attempt: AttemptWorkspaceRecord,
    healing: PreIntegrationDecision & { admitted: true } | null,
    reason: string,
  ): Promise<void> {
    if (!healing) return;
    const contract = this.healingContract(runId, contribution.subtaskId);
    if (!contract) throw new Error("verification_contract_unavailable: " + contribution.subtaskId);
    const failed = await this.persistNodeTransition(
      runId,
      contribution.subtaskId,
      { revision: contract.revision, from: ["integration_pending"], attemptId: attempt.attemptId },
      (node) => { node.state = "failed"; },
    );
    if (!failed) throw new Error("integration_node_superseded: " + contribution.subtaskId);
    this.emitHealingEvent(runId, "verification_failed", contribution.subtaskId, reason, "error", {
      stage: "pre_integration",
      contributionId: contribution.contributionId,
    });
  }

  /**
   * The reported worker outcome and persisted node truth settle together: a
   * refused compare-and-set means the run may not claim the subtask finished,
   * and the `rollback` trace is emitted only from a transition that landed.
   */
  private async settleNode(
    runId: string,
    contribution: ContributionRecord,
    entered: TaskNodeState | null,
    state: "completed" | "failed",
    integrationContributionId: string | null,
  ): Promise<void> {
    if (!entered) return;
    const settled = await this.persistNodeTransition(
      runId,
      contribution.subtaskId,
      {
        revision: entered.revision,
        from: ["integrating"],
        ...(entered.attemptId === null ? {} : { attemptId: entered.attemptId }),
      },
      (item) => {
        item.state = state;
        item.integrationContributionId = integrationContributionId;
      },
    );
    if (!settled) throw new Error("integration_node_superseded: " + contribution.subtaskId);
    if (state === "failed") {
      this.emitHealingEvent(
        runId,
        "rollback",
        contribution.subtaskId,
        "Canonical integration rolled back " + contribution.contributionId,
        "error",
        { contributionId: contribution.contributionId },
      );
    }
  }

  private integrationCancelled(runId: string, authorityEpoch: number): boolean {
    return (this.cancellationEpochs.get(runId) ?? 0) !== authorityEpoch;
  }

  private async cancelIntegratingContribution(
    runId: string,
    project: ProjectRunRecord,
    attempt: AttemptWorkspaceRecord,
    integrating: IntegrationRecord,
  ): Promise<never> {
    await this.parts.contributionIntegrator!.restore(project, integrating.canonicalHeadBefore);
    await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const storedRun = database.runs.find((candidate) => candidate.id === runId);
      const storedProject = storedRun?.project;
      const storedAttempt = storedProject?.attempts.find((candidate) =>
        candidate.attemptId === attempt.attemptId &&
        candidate.revision === attempt.revision &&
        candidate.ownerToken === attempt.ownerToken
      );
      const record = storedProject?.integrations.find((candidate) =>
        candidate.contributionId === integrating.contributionId &&
        candidate.state === "integrating"
      );
      if (
        !storedProject || !storedAttempt || !record ||
        storedProject.headCommit !== integrating.canonicalHeadBefore ||
        storedAttempt.state !== "contribution_ready"
      ) throw new Error("integration_cancellation_persistence_stale");
      Object.assign(record, {
        state: "rolled_back" as const,
        structuralDecision: "failed" as const,
        canonicalHeadAfter: null,
        reason: "user_cancelled",
      });
      storedAttempt.state = "cancelled";
      storedAttempt.cleanup = "preserved";
      storedAttempt.reason = "user_cancelled";
    }));
    throw new RunCancelledError();
  }

  private async cancelDecidedContribution(
    runId: string,
    project: ProjectRunRecord,
    attempt: AttemptWorkspaceRecord,
    decision: IntegrationRecord,
    entered: TaskNodeState | null,
  ): Promise<never> {
    await this.parts.contributionIntegrator!.restore(project, decision.canonicalHeadBefore);
    await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const storedRun = database.runs.find((candidate) => candidate.id === runId);
      const storedProject = storedRun?.project;
      const storedAttempt = storedProject?.attempts.find((candidate) =>
        candidate.attemptId === attempt.attemptId &&
        candidate.revision === attempt.revision &&
        candidate.ownerToken === attempt.ownerToken
      );
      const record = storedProject?.integrations.find((candidate) =>
        candidate.contributionId === decision.contributionId &&
        candidate.state === "integrated"
      );
      const node = storedRun?.orchestration?.healing.nodes.find((candidate) =>
        candidate.subtaskId === decision.subtaskId
      );
      if (
        !storedProject || !storedAttempt || !record || !node || !entered ||
        storedProject.headCommit !== decision.canonicalHeadAfter ||
        storedAttempt.state !== "integrated" ||
        node.revision !== entered.revision || node.state !== "integrating" ||
        (entered.attemptId !== null && node.attemptId !== entered.attemptId)
      ) throw new Error("integration_decision_cancellation_persistence_stale");
      storedProject.headCommit = decision.canonicalHeadBefore;
      Object.assign(record, {
        state: "rolled_back" as const,
        structuralDecision: "failed" as const,
        canonicalHeadAfter: null,
        reason: "user_cancelled",
      });
      storedAttempt.state = "cancelled";
      storedAttempt.cleanup = "preserved";
      storedAttempt.reason = "user_cancelled";
      node.state = "cancelled";
      node.integrationContributionId = null;
      node.updatedAt = now();
      const live = this.liveOrchestration.get(runId);
      if (live && storedRun.orchestration) {
        live.healing = structuredClone(storedRun.orchestration.healing);
      }
    }));
    throw new RunCancelledError();
  }

  private requireReadyProject(runId: string): ProjectRunRecord {
    const project = this.store.snapshot().runs.find((run) => run.id === runId)?.project;
    if (
      !project || project.source.mode === "ephemeral_research" ||
      project.state !== "ready" || !project.headCommit || !project.canonicalAuthority
    ) throw new Error("project_integration_state_unavailable");
    return structuredClone(project);
  }

  private async persistIntegrationStarted(
    runId: string,
    expectedProject: ProjectRunRecord,
    expectedAttempt: AttemptWorkspaceRecord,
    contribution: ContributionRecord,
    authorityEpoch: number,
  ): Promise<IntegrationRecord> {
    const record: IntegrationRecord = {
      contributionId: contribution.contributionId,
      subtaskId: contribution.subtaskId,
      canonicalHeadBefore: expectedProject.headCommit!,
      canonicalHeadAfter: null,
      state: "integrating",
      structuralDecision: "failed",
      reason: null,
      verificationIds: [],
      ...(contribution.repairGraphFenceHash === undefined
        ? {}
        : { repairGraphFenceHash: contribution.repairGraphFenceHash }),
    };
    await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const run = database.runs.find((candidate) => candidate.id === runId);
      const project = run?.project;
      const attempt = project?.attempts.find((candidate) =>
        candidate.attemptId === expectedAttempt.attemptId &&
        candidate.revision === expectedAttempt.revision &&
        candidate.ownerToken === expectedAttempt.ownerToken
      );
      if (this.integrationCancelled(runId, authorityEpoch)) throw new RunCancelledError();
      if (
        run?.status !== "running" || !project || project.state !== "ready" ||
        project.source.sourceFingerprint !== expectedProject.source.sourceFingerprint ||
        project.canonicalWorkspacePath !== expectedProject.canonicalWorkspacePath ||
        project.headCommit !== record.canonicalHeadBefore ||
        !attempt || attempt.state !== "contribution_ready" || attempt.cleanup !== "active" ||
        attempt.subtaskId !== contribution.subtaskId || attempt.headCommit !== contribution.headCommit ||
        project.integrations.some((candidate) => candidate.contributionId === contribution.contributionId)
      ) throw new Error("integration_start_persistence_stale");
      project.integrations.push(structuredClone(record));
    }));
    return record;
  }

  private async persistIntegrationDecision(
    runId: string,
    expectedAttempt: AttemptWorkspaceRecord,
    decision: IntegrationRecord,
    projectHead: string,
    authorityEpoch: number,
  ): Promise<boolean> {
    const lineageErrors: string[] = [];
    const persisted = await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const run = database.runs.find((candidate) => candidate.id === runId);
      const project = run?.project;
      const attempt = project?.attempts.find((candidate) =>
        candidate.attemptId === expectedAttempt.attemptId &&
        candidate.revision === expectedAttempt.revision &&
        candidate.ownerToken === expectedAttempt.ownerToken
      );
      const integration = project?.integrations.find((candidate) =>
        candidate.contributionId === decision.contributionId &&
        candidate.subtaskId === decision.subtaskId &&
        candidate.canonicalHeadBefore === decision.canonicalHeadBefore
      );
      if (this.integrationCancelled(runId, authorityEpoch)) return false;
      if (
        run?.status !== "running" || !project || project.state !== "ready" ||
        project.headCommit !== decision.canonicalHeadBefore || !attempt ||
        attempt.state !== "contribution_ready" || attempt.cleanup !== "active" ||
        !integration || integration.state !== "integrating"
      ) throw new Error("integration_decision_persistence_stale");
      Object.assign(integration, structuredClone(decision));
      project.headCommit = projectHead;
      if (decision.state === "integrated") {
        attempt.state = "integrated";
        attempt.reason = null;
      } else {
        attempt.state = "failed";
        attempt.cleanup = "preserved";
        attempt.reason = decision.reason;
      }
      if (run) lineageErrors.push(...this.enqueueIntegrationLineage(
        run,
        expectedAttempt.attemptId,
        decision,
        database.runs,
      ));
      return true;
    }));
    if (lineageErrors.length > 0) this.publishEvolutionHistoryUnavailable(runId, lineageErrors[0]!);
    return persisted;
  }

  private enqueueIntegrationLineage(
    run: AgentRun,
    attemptId: string,
    decision: IntegrationRecord,
    runs: readonly AgentRun[],
  ): string[] {
    const recorder = this.parts.lineageRecorder;
    const orchestration = run.orchestration;
    const project = run.project;
    if (recorder === undefined || orchestration === null || project === undefined ||
      project.source.mode === "ephemeral_research") return [];
    const node = orchestration.healing.nodes.find((value) => value.subtaskId === decision.subtaskId);
    if (node === undefined) return [];
    const candidate = orchestration.healing.candidates.find((value) => value.attemptId === attemptId);
    if (candidate === undefined) return [];
    const tournament = orchestration.healing.tournaments.find((value) =>
      value.id === candidate.tournamentId) ?? null;
    const fault = orchestration.healing.faults.find((value) => value.id === node.faultId) ?? null;
    const verification = [...orchestration.healing.verifications].reverse().find((value) =>
      decision.verificationIds.includes(value.id) || candidate.verificationIds.includes(value.id)) ?? null;
    const candidateRun = candidate.attemptId === null
      ? null
      : runs.find((value) => value.id === candidate.attemptId) ?? null;
    try {
      recorder.enqueue(orchestration, {
        run,
        project,
        node,
        fault,
        candidate,
        tournament,
        verification,
        integration: decision,
        candidateRun,
        transition: decision.state === "integrated" ? "promotion_pending" : "rolled_back",
        eventEvidenceRefs: sortedUniqueStrings([
          ...(fault?.evidenceRefs ?? []),
          ...(verification?.gates.map((gate) => gate.evidenceRef) ?? []),
        ]),
        occurredAt: node.updatedAt,
        runtimeCapabilityIdentity: candidate.evolutionFingerprints === null
          ? null
          : {
              runtimeCapabilityHash: candidate.evolutionFingerprints.runtimeCapabilityHash,
              manifestComplete: candidate.evolutionFingerprints.complete,
            },
      });
      return [];
    } catch (error) {
      return [workerErrorMessage(error)];
    }
  }

  private async persistIntegratedCleanup(
    runId: string,
    expectedAttempt: AttemptWorkspaceRecord,
    cleanup: "removed" | "preserved",
    reason: string | null,
  ): Promise<void> {
    await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const project = database.runs.find((candidate) => candidate.id === runId)?.project;
      const attempt = project?.attempts.find((candidate) =>
        candidate.attemptId === expectedAttempt.attemptId &&
        candidate.revision === expectedAttempt.revision &&
        candidate.ownerToken === expectedAttempt.ownerToken
      );
      if (!project || !attempt || attempt.state !== "integrated") {
        throw new Error("integrated_cleanup_persistence_stale");
      }
      attempt.cleanup = cleanup;
      attempt.reason = reason;
    }));
  }

  private async persistAttemptStarted(
    runId: string,
    expectedProject: ProjectRunRecord,
    attempt: AttemptWorkspaceRecord,
  ): Promise<void> {
    await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      const project = run?.project;
      if (
        !project ||
        run?.status !== "running" ||
        project.state !== "ready" ||
        project.source.sourceFingerprint !== expectedProject.source.sourceFingerprint ||
        project.canonicalWorkspacePath !== expectedProject.canonicalWorkspacePath ||
        (attempt.kind !== "repair" && project.headCommit !== expectedProject.headCommit) ||
        project.attempts.some((item) =>
          item.attemptId === attempt.attemptId && item.revision >= attempt.revision
        )
      ) {
        throw new Error("attempt_start_persistence_stale");
      }
      project.attempts.push(structuredClone(attempt));
    }));
    if (attempt.kind !== "repair") {
      await this.mutateHealing(runId, (healing) => {
        const node = healing.nodes.find((item) => item.subtaskId === attempt.subtaskId);
        if (node && (node.attemptId === null || node.attemptId === attempt.attemptId)) {
          node.attemptId = attempt.attemptId;
          if (node.state === "ready" || node.state === "pending") node.state = "running";
          node.updatedAt = now();
        }
      }).catch(() => undefined);
    }
  }

  private async persistCompensationEvidence(
    runId: string,
    attempt: AttemptWorkspaceRecord,
    reason: string,
  ): Promise<void> {
    const evidence: AttemptWorkspaceRecord = {
      ...structuredClone(attempt),
      state: "failed",
      cleanup: "preserved",
      reason: "attempt_start_persistence_failed: " + reason,
    };
    await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const project = database.runs.find((item) => item.id === runId)?.project;
      if (!project || project.attempts.some((item) =>
        item.attemptId === evidence.attemptId && item.revision === evidence.revision
      )) throw new Error("attempt_compensation_persistence_stale");
      project.attempts.push(evidence);
    }));
  }

  private async persistContributionReady(
    runId: string,
    expected: AttemptWorkspaceRecord,
    headCommit: string,
    authorityEpoch: number,
  ): Promise<void> {
    const updated = await this.updateRunningAttempt(runId, expected, (attempt) => {
      attempt.state = "contribution_ready";
      attempt.headCommit = headCommit;
      attempt.reason = null;
    }, authorityEpoch);
    if (!updated) throw new Error("attempt_completion_stale");
  }

  private async persistAttemptFailure(
    runId: string,
    expected: AttemptWorkspaceRecord,
    state: "failed" | "cancelled",
    reason: string,
  ): Promise<void> {
    await this.updateRunningAttempt(runId, expected, (attempt) => {
      attempt.state = state;
      attempt.cleanup = "preserved";
      attempt.reason = reason;
    });
  }

  private async persistAttemptRecoveryEvidence(
    runId: string,
    expected: AttemptWorkspaceRecord,
  ): Promise<void> {
    const updated = await this.updateRunningAttempt(runId, expected, (attempt) => {
      attempt.cleanup = "preserved";
      attempt.reason = "attempt_failure_persistence_failed";
    });
    if (!updated) throw new Error("attempt_recovery_evidence_stale");
  }

  private async updateRunningAttempt(
    runId: string,
    expected: AttemptWorkspaceRecord,
    update: (attempt: AttemptWorkspaceRecord) => void,
    authorityEpoch?: number,
  ): Promise<boolean> {
    return this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      const project = run?.project;
      const attempt = project?.attempts.find((item) =>
        item.attemptId === expected.attemptId &&
        item.revision === expected.revision &&
        item.ownerToken === expected.ownerToken
      );
      if (
        !project ||
        run?.status !== "running" ||
        project.state !== "ready" ||
        (authorityEpoch !== undefined &&
          (this.cancellationEpochs.get(runId) ?? 0) !== authorityEpoch) ||
        !attempt ||
        attempt.state !== "running" ||
        attempt.revision !== expected.revision ||
        attempt.ownerToken !== expected.ownerToken ||
        attempt.subtaskId !== expected.subtaskId ||
        attempt.baseCommit !== expected.baseCommit ||
        attempt.workspacePath !== expected.workspacePath ||
        attempt.headCommit !== expected.headCommit
      ) return false;
      update(attempt);
      return true;
    }));
  }

  private async resolveWorker(leader: Agent, subtask: LeaderSubtask): Promise<Agent> {
    let shouldCreateWorkspace = false;
    const worker = await this.store.mutate((database) => {
      const resolved = this.workerResolver.resolve(
        leader,
        subtask,
        this.policy,
        database.agents,
        (agentId) => this.workspaces.workspacePath(agentId),
      );
      if (resolved.created) {
        database.agents.push(resolved.agent);
        shouldCreateWorkspace = true;
        return structuredClone(resolved.agent);
      }
      const existing = database.agents.find((agent) => agent.id === resolved.agent.id);
      if (existing && this.policy.workerSessionPolicy === "fresh") {
        existing.codexThreadId = null;
        existing.lastError = null;
        existing.updatedAt = now();
      }
      return structuredClone(resolved.agent);
    });
    if (shouldCreateWorkspace) await this.workspaces.create(worker);
    return worker;
  }

  /**
   * Count the turn's real tool activity, then judge the output against it.
   * Evidence that cannot be read yields `unverified`, never a silent pass.
   */
  /**
   * A team exists for the whole run, not just while workers are executing: the
   * roster has to cover members that have not started, or a message sent to a
   * downstream subtask would bounce instead of riding in with its first turn.
   */
  /**
   * Deterministic so the roster can name a worker before it exists. Scoped by
   * iteration: a replanned subtask is a new turn by the same participant, and
   * must not inherit messages queued for the previous one.
   */
  private plannedWorkerRunId(leaderRunId: string, iteration: number, subtaskId: string): string {
    // Shaped as a v4 UUID, not just 32 hex characters: run ids travel through
    // API routes that validate the format, and a bare digest made every worker
    // trajectory request fail with a 500 the UI could only show as
    // "Internal Server Error".
    const hex = createHash("sha1")
      .update(leaderRunId + "/" + iteration + "/" + subtaskId)
      .digest("hex");
    const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      "4" + hex.slice(13, 16),
      variant + hex.slice(17, 20),
      hex.slice(20, 32),
    ].join("-");
  }

  private plannedAttemptId(leaderRunId: string, subtaskId: string): string {
    return this.plannedWorkerRunId(leaderRunId, 0, subtaskId);
  }

  private async openTeam(leaderRunId: string): Promise<void> {
    if (this.coordination === undefined) return;
    const journal = await TeamJournal.open(this.coordination.dataDir, leaderRunId);
    this.teams.set(
      leaderRunId,
      new TeamCoordinationRuntime(leaderRunId, journal, {
        quiescenceMs: this.policy.quiescenceMs,
        maxFollowUpTurnsPerWorker: this.policy.maxFollowUpTurnsPerWorker,
      }),
    );
  }

  /** Tokens die with the run: a worker cannot address a team it has left. */
  private closeTeam(leaderRunId: string): void {
    for (const token of this.issuedTokens.get(leaderRunId) ?? []) {
      this.coordination?.unregister(token);
    }
    for (const runId of this.issuedModelRunIds.get(leaderRunId) ?? []) {
      this.modelProxy?.revoke(runId);
    }
    this.issuedTokens.delete(leaderRunId);
    this.issuedModelRunIds.delete(leaderRunId);
    this.teams.delete(leaderRunId);
    for (const monitorId of this.monitorsForRun.get(leaderRunId) ?? []) {
      this.monitors.get(monitorId)?.dispose();
      this.monitors.delete(monitorId);
    }
    this.monitorsForRun.delete(leaderRunId);
    this.observedVerifications.delete(leaderRunId);
    this.liveOrchestration.delete(leaderRunId);
  }

  private rememberModelRunId(leaderRunId: string, runId: string): void {
    const runIds = this.issuedModelRunIds.get(leaderRunId) ?? new Set<string>();
    runIds.add(runId);
    this.issuedModelRunIds.set(leaderRunId, runIds);
  }

  private coordinationEnv(
    leaderRunId: string,
    workerRunId: string,
  ): {
    LAUNCHPAD_COORDINATION_URL: string;
    LAUNCHPAD_COORDINATION_TOKEN: string;
    LAUNCHPAD_ROOT_DEADLINE_AT: string;
  } | undefined {
    const team = this.teams.get(leaderRunId);
    if (team === undefined || this.coordination === undefined) return undefined;
    const ingress = new CoordinationIngress(team.roster, (message) => team.queue(message));
    const token = ingress.issue(leaderRunId, workerRunId);
    this.workerCoordinationTokens.set(workerRunId, token);
    this.coordination.register(token, ingress);
    const tokens = this.issuedTokens.get(leaderRunId) ?? [];
    tokens.push(token);
    this.issuedTokens.set(leaderRunId, tokens);
    return {
      LAUNCHPAD_COORDINATION_URL: this.coordination.baseUrl,
      LAUNCHPAD_COORDINATION_TOKEN: token,
      LAUNCHPAD_ROOT_DEADLINE_AT: this.controlFor(leaderRunId).snapshot().deadlineAt ?? "",
    };
  }

  private rememberActiveRuntime(runId: string, workerRunId: string, runtime: AgentRuntime): void {
    const runtimes = this.activeRuntimes.get(runId) ?? new Map<string, AgentRuntime>();
    runtimes.set(workerRunId, runtime);
    this.activeRuntimes.set(runId, runtimes);
  }

  private detachWorkerIngress(runId: string, workerRunId: string, runtime: AgentRuntime): void {
    this.teams.get(runId)?.detach(workerRunId, runtime);
    const token = this.workerCoordinationTokens.get(workerRunId);
    if (token) this.coordination?.unregister(token);
    this.workerCoordinationTokens.delete(workerRunId);
  }

  private releaseActiveRuntime(runId: string, workerRunId: string, runtime: AgentRuntime): void {
    const runtimes = this.activeRuntimes.get(runId);
    if (runtimes?.get(workerRunId) === runtime) runtimes.delete(workerRunId);
    if (runtimes?.size === 0) this.activeRuntimes.delete(runId);
  }

  /**
   * The live orchestration state is the single owner of healing, exactly as it
   * is for the rest of the state that `persistState` writes. Seeding the store
   * copy from it and publishing back within one serialized store turn means a
   * node admitted in memory while this write was queued is folded in rather
   * than republished away, and there is no window where the two views differ.
   *
   * Deliberately not retried: every healing write is compare-and-set, so a
   * blind second attempt would evaluate its guard against its own first effect.
   */
  private async mutateHealing<T>(
    runId: string,
    mutate: (healing: HealingState) => T,
  ): Promise<T> {
    return this.store.mutate((database) => {
      const orchestration = database.runs.find((item) => item.id === runId)?.orchestration;
      if (!orchestration) throw new Error("healing_state_unavailable: " + runId);
      const live = this.liveOrchestration.get(runId);
      if (live) orchestration.healing = structuredClone(live.healing);
      const outcome = mutate(orchestration.healing);
      if (live) live.healing = structuredClone(orchestration.healing);
      return outcome;
    });
  }

  private async mutateHealingWithEvents<T>(
    runId: string,
    mutate: (healing: HealingState) => T,
  ): Promise<T> {
    if (this.parts.lineageRecorder === undefined) {
      const before = this.store.snapshot().runs.find((item) => item.id === runId)
        ?.orchestration?.healing;
      const outcome = await this.mutateHealing(runId, mutate);
      const after = this.store.snapshot().runs.find((item) => item.id === runId)
        ?.orchestration?.healing;
      if (before && after) this.publishHealingTransitionEvents(runId, before, after);
      return outcome;
    }
    let before!: HealingState;
    let after!: HealingState;
    let outcome!: T;
    const lineageErrors: string[] = [];
    await this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      const orchestration = run?.orchestration;
      if (!run || !orchestration) throw new Error("healing_state_unavailable: " + runId);
      const live = this.liveOrchestration.get(runId);
      if (live) orchestration.healing = structuredClone(live.healing);
      before = structuredClone(orchestration.healing);
      outcome = mutate(orchestration.healing);
      after = structuredClone(orchestration.healing);
      if (live) live.healing = structuredClone(orchestration.healing);
      lineageErrors.push(...this.enqueueHealingLineage(run, before, after, database.runs));
    });
    this.publishHealingTransitionEvents(runId, before, after);
    await this.events.flush(runId);
    if (lineageErrors.length > 0) this.publishEvolutionHistoryUnavailable(runId, lineageErrors[0]!);
    try {
      await this.parts.lineageRecorder.flush(runId);
    } catch (error) {
      this.publishEvolutionHistoryUnavailable(runId, workerErrorMessage(error));
    }
    return outcome;
  }

  private enqueueHealingLineage(
    run: AgentRun,
    before: HealingState,
    after: HealingState,
    runs: readonly AgentRun[],
  ): string[] {
    const recorder = this.parts.lineageRecorder;
    if (recorder === undefined || run.orchestration === null || run.project === undefined ||
      run.project.source.mode === "ephemeral_research") return [];
    const errors: string[] = [];
    const beforeCandidates = new Map(before.candidates.map((candidate) => [candidate.id, candidate]));
    for (const candidate of after.candidates) {
      const previous = beforeCandidates.get(candidate.id);
      if (previous?.state === candidate.state) continue;
      const transition = candidateTransition(candidate.state);
      if (transition === null) continue;
      const tournament = after.tournaments.find((value) => value.id === candidate.tournamentId) ?? null;
      const node = after.nodes.find((value) => value.subtaskId === candidate.delta.targetSubtaskId &&
        (tournament === null || value.tournamentId === tournament.id)) ?? null;
      if (node === null) continue;
      const fault = after.faults.find((value) => value.id === node.faultId) ?? null;
      const verification = [...after.verifications].reverse().find((value) =>
        candidate.verificationIds.includes(value.id)) ?? null;
      const integration = [...(run.project.integrations ?? [])].reverse().find((value) =>
        value.subtaskId === node.subtaskId &&
        (node.integrationContributionId === null || value.contributionId === node.integrationContributionId)) ?? null;
      const candidateRun = candidate.attemptId === null
        ? null
        : runs.find((value) => value.id === candidate.attemptId) ?? null;
      // The tournament publishes `running` immediately before runRepairCandidate
      // durably creates the child run. Preserve the evidence boundary by
      // recording `executed` only from the post-create replay below.
      if (transition === "executed" && candidateRun === null) continue;
      const input: EvolutionTransitionInput = {
        run,
        project: run.project,
        node,
        fault,
        candidate,
        tournament,
        verification,
        integration: transition === "promoted" || transition === "rolled_back" ||
          transition === "promotion_pending" ? integration : null,
        candidateRun,
        transition,
        eventEvidenceRefs: sortedUniqueStrings([
          ...(fault?.evidenceRefs ?? []),
          ...(verification?.gates.map((gate) => gate.evidenceRef) ?? []),
        ]),
        occurredAt: node.updatedAt,
        runtimeCapabilityIdentity: candidate.evolutionFingerprints === null
          ? null
          : {
              runtimeCapabilityHash: candidate.evolutionFingerprints.runtimeCapabilityHash,
              manifestComplete: candidate.evolutionFingerprints.complete,
            },
      };
      try {
        recorder.enqueue(run.orchestration, input);
      } catch (error) {
        errors.push(workerErrorMessage(error));
      }
    }
    return errors;
  }

  private async recordSettledPassiveTransfers(runId: string, tournamentId: string): Promise<void> {
    const recorder = this.parts.lineageRecorder;
    if (recorder === undefined) return;
    let lineageError: string | null = null;
    await this.store.mutate((database) => {
      const run = database.runs.find((value) => value.id === runId);
      const orchestration = run?.orchestration;
      const project = run?.project;
      if (!run || !orchestration || !project || project.source.mode === "ephemeral_research") return;
      const candidate = orchestration.healing.candidates.find((value) =>
        value.tournamentId === tournamentId && value.delta.family === "context_patch" &&
        (value.delta.failureCueIds?.length ?? 0) > 0);
      if (candidate === undefined || (candidate.state !== "verified" && candidate.state !== "rejected")) return;
      const tournament = orchestration.healing.tournaments.find((value) => value.id === tournamentId);
      const node = orchestration.healing.nodes.find((value) =>
        value.subtaskId === candidate.delta.targetSubtaskId && value.tournamentId === tournamentId);
      const verification = [...orchestration.healing.verifications].reverse().find((value) =>
        candidate.verificationIds.includes(value.id));
      const candidateRun = candidate.attemptId === null
        ? undefined
        : database.runs.find((value) => value.id === candidate.attemptId);
      if (tournament === undefined || node === undefined || verification === undefined ||
        candidateRun === undefined) return;
      const fault = orchestration.healing.faults.find((value) => value.id === node.faultId) ?? null;
      try {
        recorder.enqueue(orchestration, {
          run,
          project,
          node,
          fault,
          candidate,
          tournament,
          verification,
          integration: null,
          candidateRun,
          transition: candidate.state,
          eventEvidenceRefs: sortedUniqueStrings([
            ...(fault?.evidenceRefs ?? []),
            ...verification.gates.map((gate) => gate.evidenceRef),
          ]),
          occurredAt: node.updatedAt,
          runtimeCapabilityIdentity: candidate.evolutionFingerprints === null
            ? null
            : {
                runtimeCapabilityHash: candidate.evolutionFingerprints.runtimeCapabilityHash,
                manifestComplete: candidate.evolutionFingerprints.complete,
              },
          includeSettledTransfers: true,
        });
      } catch (error) {
        lineageError = workerErrorMessage(error);
      }
    });
    if (lineageError !== null) {
      this.publishEvolutionHistoryUnavailable(runId, lineageError);
      return;
    }
    try {
      await recorder.flush(runId);
    } catch (error) {
      this.publishEvolutionHistoryUnavailable(runId, workerErrorMessage(error));
    }
  }

  private async recordSettledBranchReturns(
    runId: string,
    tournamentId: string,
    checkpoint: RepairCheckpoint,
    contribution: ContributionRecord | null,
  ): Promise<void> {
    const recorder = this.parts.lineageRecorder;
    if (recorder === undefined) return;
    let lineageError: string | null = null;
    await this.store.mutate((database) => {
      const run = database.runs.find((value) => value.id === runId);
      const orchestration = run?.orchestration;
      const project = run?.project;
      if (!run || !orchestration || !project || project.source.mode === "ephemeral_research") return;
      const tournament = orchestration.healing.tournaments.find((value) => value.id === tournamentId);
      if (tournament === undefined || checkpoint.id !== tournament.checkpointId) return;
      for (const candidate of orchestration.healing.candidates.filter((value) =>
        value.tournamentId === tournamentId && (value.state === "rejected" || value.state === "rolled_back"))) {
        const node = orchestration.healing.nodes.find((value) =>
          value.subtaskId === candidate.delta.targetSubtaskId && value.tournamentId === tournamentId);
        const candidateRun = candidate.attemptId === null
          ? undefined
          : database.runs.find((value) => value.id === candidate.attemptId);
        if (node === undefined || candidateRun === undefined) continue;
        const integration = candidate.state === "rolled_back" && contribution !== null &&
          contribution.attemptId === candidate.attemptId
          ? project.integrations.find((value) => value.contributionId === contribution.contributionId &&
              value.subtaskId === contribution.subtaskId && value.state === "rolled_back") ?? null
          : null;
        const verification = candidate.state === "rolled_back"
          ? [...orchestration.healing.verifications].reverse().find((value) =>
              integration?.verificationIds.includes(value.id) && value.subjectType === "contribution" &&
              value.subjectId === integration.contributionId && value.stage === "post_integration") ?? null
          : [...orchestration.healing.verifications].reverse().find((value) =>
              candidate.verificationIds.includes(value.id) && value.subjectType === "candidate" &&
              value.subjectId === candidate.id) ?? null;
        const fault = orchestration.healing.faults.find((value) => value.id === node.faultId) ?? null;
        try {
          recorder.enqueue(orchestration, {
            run, project, node, fault, candidate, tournament, verification, integration, contribution, candidateRun,
            transition: candidate.state === "rolled_back" ? "rolled_back" : "rejected",
            eventEvidenceRefs: sortedUniqueStrings([
              ...(fault?.evidenceRefs ?? []),
              ...(verification?.gates.map((gate) => gate.evidenceRef) ?? []),
            ]),
            occurredAt: node.updatedAt,
            runtimeCapabilityIdentity: candidate.evolutionFingerprints === null ? null : {
              runtimeCapabilityHash: candidate.evolutionFingerprints.runtimeCapabilityHash,
              manifestComplete: candidate.evolutionFingerprints.complete,
            },
            repairCheckpoint: checkpoint,
          });
        } catch (error) {
          lineageError = workerErrorMessage(error);
        }
      }
    });
    if (lineageError !== null) this.publishEvolutionHistoryUnavailable(runId, lineageError);
  }

  private publishEvolutionHistoryUnavailable(runId: string, reason: string): void {
    const agentId = this.store.snapshot().runs.find((item) => item.id === runId)?.agentId;
    if (agentId === undefined) return;
    this.events.createSink(runId, agentId).emit(healingEvent(
      "evolution_history_unavailable",
      "history",
      "Evolution history unavailable; safe Milestone 2 state remains authoritative.",
      "warning",
      { reason: reason.slice(0, 512) },
    ));
  }

  private publishHealingTransitionEvents(
    runId: string,
    before: HealingState,
    after: HealingState,
    options: HealingTransitionOptions = {},
  ): void {
    const agentId = this.store.snapshot().runs.find((item) => item.id === runId)?.agentId;
    if (agentId === undefined) return;
    const sink = this.events.createSink(runId, agentId);
    const omitted = new Set(options.omitNames ?? []);
    for (const event of healingTransitionEvents(before, after, options)) {
      if (!omitted.has(event.name)) sink.emit(event);
    }
  }

  /**
   * Compare-and-set on persisted node truth. A stale revision, an unexpected
   * current state, or a different attempt owner refuses the write, so a late
   * verification or integration cannot overwrite a repaired or terminal node.
   */
  private async persistNodeTransition(
    runId: string,
    subtaskId: string,
    expected: { revision: number; from: readonly TaskNodeStatus[]; attemptId?: string },
    apply: (node: TaskNodeState) => void,
  ): Promise<TaskNodeState | null> {
    return this.mutateHealing(runId, (healing) => {
      const node = healing.nodes.find((item) => item.subtaskId === subtaskId);
      if (
        !node ||
        node.revision !== expected.revision ||
        !expected.from.includes(node.state) ||
        (expected.attemptId !== undefined && node.attemptId !== expected.attemptId)
      ) return null;
      apply(node);
      node.updatedAt = now();
      return structuredClone(node);
    });
  }

  private async persistVerification(
    runId: string,
    subtaskId: string,
    verification: VerificationResult,
  ): Promise<void> {
    await this.mutateHealing(runId, (healing) => {
      if (!healing.verifications.some((item) => item.id === verification.id)) {
        healing.verifications.push(structuredClone(verification));
      }
      const node = healing.nodes.find((item) => item.subtaskId === subtaskId);
      if (node && !node.verificationIds.includes(verification.id)) {
        node.verificationIds.push(verification.id);
      }
    });
  }

  private healingContract(runId: string, subtaskId: string): SubtaskContract | null {
    const contracts =
      this.liveOrchestration.get(runId)?.healing.contracts ??
      this.store.snapshot().runs.find((item) => item.id === runId)?.orchestration?.healing.contracts;
    return contracts?.find((item) => item.subtaskId === subtaskId) ?? null;
  }

  private async observeVerification(
    runId: string,
    workerRunId: string | null,
    verification: VerificationResult,
  ): Promise<void> {
    const monitor = workerRunId === null ? undefined : this.monitors.get(workerRunId);
    if (!monitor) return;
    const observed = this.observedVerifications.get(runId) ?? new Set<string>();
    this.observedVerifications.set(runId, observed);
    if (observed.has(verification.id)) return;
    observed.add(verification.id);
    await monitor.observeVerification(verification);
    const state = this.liveOrchestration.get(runId);
    if (state) this.mergeSnapshots(state, monitor);
  }

  private emitHealingEvent(
    runId: string,
    name: string,
    subtaskId: string,
    text: string,
    status: RunEventDraft["status"],
    attributes: Record<string, unknown> = {},
  ): void {
    const agentId = this.store.snapshot().runs.find((item) => item.id === runId)?.agentId;
    if (agentId === undefined) return;
    this.events
      .createSink(runId, agentId)
      .emit(healingEvent(name, subtaskId, text, status, attributes));
  }

  private async withAuthorityLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.authorityLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.catch(() => undefined).then(() => turn);
    this.authorityLocks.set(runId, tail);
    await predecessor.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.authorityLocks.get(runId) === tail) this.authorityLocks.delete(runId);
    }
  }

  private async persistCancellationFence(runId: string): Promise<void> {
    await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const project = database.runs.find((item) => item.id === runId)?.project;
      if (!project) return;
      for (const attempt of project.attempts) {
        if (attempt.state === "running" || attempt.state === "contribution_ready") {
          attempt.state = "cancelled";
          attempt.cleanup = "preserved";
          attempt.reason = "user_cancelled";
        }
      }
    }));
  }

  private leaderCoordinationEnv(
    leaderRunId: string,
    dispatchSubagent: (request: DispatchSubagentRequest) => Promise<unknown>,
    tools: {
      waitWorkers?: (request: WaitWorkersRequest) => Promise<unknown>;
      inspectWorker?: (request: InspectWorkerRequest) => Promise<unknown>;
      extendWorkerTimeout?: (request: ExtendWorkerTimeoutRequest) => Promise<unknown>;
    } = {},
  ): {
    LAUNCHPAD_COORDINATION_URL: string;
    LAUNCHPAD_COORDINATION_TOKEN: string;
    LAUNCHPAD_ROOT_DEADLINE_AT: string;
    LAUNCHPAD_PARENT_RUN_ID: string;
  } | undefined {
    const team = this.teams.get(leaderRunId);
    if (team === undefined || this.coordination === undefined) return undefined;
    const ingress = new CoordinationIngress(
      team.roster,
      (message) => team.queue(message),
      dispatchSubagent,
      tools.inspectWorker,
      tools.extendWorkerTimeout,
      tools.waitWorkers,
    );
    const token = ingress.issue(leaderRunId, leaderRunId);
    this.workerCoordinationTokens.set(leaderRunId, token);
    this.coordination.register(token, ingress);
    const tokens = this.issuedTokens.get(leaderRunId) ?? [];
    tokens.push(token);
    this.issuedTokens.set(leaderRunId, tokens);
    return {
      LAUNCHPAD_COORDINATION_URL: this.coordination.baseUrl,
      LAUNCHPAD_COORDINATION_TOKEN: token,
      LAUNCHPAD_ROOT_DEADLINE_AT: this.controlFor(leaderRunId).snapshot().deadlineAt ?? "",
      LAUNCHPAD_PARENT_RUN_ID: leaderRunId,
    };
  }

  private async validateWorkerTurn(
    workerRunId: string,
    subtaskPrompt: string,
    output: string,
  ): Promise<WorkerValidation> {
    let toolEventCount = 0;
    let openToolCallCount = 0;
    let evidenceAvailable = true;
    try {
      await this.events.flush(workerRunId);
      const open = new Set<string>();
      const pageSize = 500;
      let after = 0;
      while (true) {
        const { events, lastSeq } = await this.events.read(workerRunId, after, pageSize);
        for (const event of events) {
          if (event.kind !== "command" && event.kind !== "mcp_tool" && event.kind !== "web_search") {
            continue;
          }
          if (event.status === "in_progress") {
            open.add(event.spanId);
          } else {
            open.delete(event.spanId);
            toolEventCount += 1;
          }
        }
        if (events.length < pageSize || lastSeq <= after) break;
        after = lastSeq;
      }
      openToolCallCount = open.size;
    } catch {
      evidenceAvailable = false;
    }
    return validateWorker({
      output,
      subtaskPrompt,
      toolEventCount,
      openToolCallCount,
      evidenceAvailable,
    });
  }

  private async routeSkillsForTask(
    runId: string,
    task: string,
    commonWorkspacePath: string,
    state: OrchestrationState,
  ): Promise<SkillInjectionPlan | null> {
    const routing = this.parts.skillRouting;
    if (routing === undefined) return null;
    try {
      const planned = buildSkillInjectionPlan({
        runId,
        task,
        dataDirectory: routing.dataDirectory,
        commonWorkspacePath,
      });
      const installed = await installSelectedSkills(planned, {
        dataDirectory: routing.dataDirectory,
        commonWorkspacePath,
      });
      state.skillRouting ??= [];
      state.skillRouting.push(installed);
      return installed;
    } catch {
      return null;
    }
  }

  private async recordSkillRoutingFeedback(
    runId: string,
    runStatus: "completed" | "failed" | "cancelled",
    completedAt: string,
    state: OrchestrationState,
  ): Promise<void> {
    const routing = this.parts.skillRouting;
    if (routing === undefined || !state.skillRouting || state.skillRouting.length === 0) return;
    try {
      await recordSkillRoutingOutcome({
        dataDirectory: routing.dataDirectory,
        runId,
        runStatus,
        completedAt,
        plans: state.skillRouting,
        ...(state.outcome?.value === undefined ? {} : { taskOutcome: state.outcome.value }),
      });
    } catch {
      return;
    }
  }

  private initialState(): OrchestrationState {
    return {
      phase: "planning",
      iteration: 0,
      iterationPlans: [],
      evaluationRecords: [],
      workerResults: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, workerRuns: 0 },
      policySnapshot: this.policy,
      provenance: {
        harnessVersion: HARNESS_VERSION,
        plannerPromptVersion: PLANNER_PROMPT_VERSION,
        evaluatorPromptVersion: EVALUATOR_PROMPT_VERSION,
        replannerPromptVersion: REPLANNER_PROMPT_VERSION,
        synthesizerPromptVersion: SYNTHESIZER_PROMPT_VERSION,
      },
      healing: emptyHealingState(),
      evolutionOutbox: [],
      skillRouting: [],
    };
  }

  private healingCatalog(): ContractCatalogEntry[] {
    const catalog = this.parts.contractCatalog;
    if (!catalog || catalog.length === 0) {
      throw new Error(
        "missing contract catalog: healingEnabled requires a non-empty catalog before any runtime admission",
      );
    }
    return catalog;
  }

  /** Healing applies only to Git-backed managed or external Projects. */
  private healingProjectRun(runId: string): boolean {
    if (this.parts.healingEnabled !== true) return false;
    const mode = this.store.snapshot().runs.find((run) => run.id === runId)?.project?.source.mode;
    return mode === "existing_repository" || mode === "new_project";
  }

  private requireVerificationRunner(): import("./verification/verifier.js").VerificationRunner {
    const runner = this.parts.verificationRunner;
    if (!runner) {
      throw new Error(
        "verification_authority_unavailable: healingEnabled requires a verification runner before any project worker starts",
      );
    }
    return runner;
  }

  /**
   * Compile the admitted graph once, when the planner or replanner graph is
   * persisted and before any worker starts. Contracts already admitted by live
   * leader dispatch are never rewritten, and an undeclared contract key fails
   * the run here rather than at verification time.
   */
  private async admitPlannedGraph(
    runId: string,
    state: OrchestrationState,
  ): Promise<{ ok: true } | { ok: false; error: "repair_graph_frozen" }> {
    if (!this.healingProjectRun(runId)) return { ok: true };
    this.requireVerificationRunner();
    const plan = state.iterationPlans.at(-1)?.plan;
    if (!plan || plan.subtasks.length === 0) return { ok: true };
    return this.withAuthorityLock(runId, async () => {
      const result = new LiveDagAdmission(this.healingCatalog()).tryAdmitPlan(state, plan);
      if (result.ok) await this.persistState(runId, state);
      return result;
    });
  }

  private existingWorkers(leaderId: string): Agent[] {
    return this.store
      .snapshot()
      .agents.filter((agent) => agent.role === "worker" && agent.parentAgentId === leaderId);
  }

  private async raceControl<T>(control: RunControl, operation: Promise<T>): Promise<T> {
    const outcome = await control.raceOutcome(operation);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private terminalOf(runId: string): RunTerminalError | undefined {
    const control = this.controls.get(runId);
    if (!control) return undefined;
    try {
      control.assertActive();
      return undefined;
    } catch (error) {
      return error instanceof RunTerminalError ? error : undefined;
    }
  }

  private async drainBackgroundDispatches(runId: string): Promise<void> {
    const drain = this.waitForBackgroundDispatches(runId);
    const control = this.controls.get(runId);
    if (!control) {
      await drain;
      return;
    }
    await control.raceOutcome(drain);
  }

  private releaseControl(runId: string): void {
    this.controls.get(runId)?.close();
    this.controls.delete(runId);
    this.terminalCancels.delete(runId);
  }

  private controlFor(runId: string): RunControl {
    const existing = this.controls.get(runId);
    if (existing) return existing;
    const created = new RunControl(this.policy, this.parts.clock);
    this.controls.set(runId, created);
    created.onTerminal((error) => {
      void this.quiesceOnTerminal(runId, error).catch(() => undefined);
    });
    return created;
  }

  private async quiesceOnTerminal(runId: string, error: RunTerminalError): Promise<void> {
    const pending = this.terminalCancels.get(runId);
    if (pending) return pending;
    const work = this.cancelRunResources(runId, error.reason);
    this.terminalCancels.set(runId, work);
    await work;
  }

  private async cancelRunResources(runId: string, reason: string): Promise<void> {
    const keys = [...(this.activeRunKeys.get(runId) ?? [])];
    const runtimes = [...(this.activeRuntimes.get(runId)?.entries() ?? [])];
    const results = await Promise.allSettled([
      ...keys.map((key) => this.runner.cancel(key)),
      ...runtimes.map(([, runtime]) => runtime.cancel(reason)),
    ]);
    for (let index = 0; index < keys.length; index += 1) {
      if (results[index]?.status === "fulfilled") {
        this.activeRunKeys.get(runId)?.delete(keys[index]!);
      }
    }
    if ((this.activeRunKeys.get(runId)?.size ?? 0) === 0) this.activeRunKeys.delete(runId);
    const unproven = this.unprovenAbsences.get(runId) ?? new Set<string>();
    for (let index = 0; index < runtimes.length; index += 1) {
      const [workerRunId, runtime] = runtimes[index]!;
      const result = results[keys.length + index];
      this.detachWorkerIngress(runId, workerRunId, runtime);
      if (result?.status === "fulfilled") {
        this.releaseActiveRuntime(runId, workerRunId, runtime);
        continue;
      }
      unproven.add(workerRunId);
      const detail = result?.status === "rejected"
        ? (result.reason instanceof Error ? result.reason.message : String(result.reason))
        : "runtime cancel did not settle";
      this.events.createSink(runId, workerRunId).emit(
        lifecycleEvent("error", "runtime_absence_unproven", null, {
          workerRunId,
          text: detail,
        }),
      );
    }
    if (unproven.size > 0) this.unprovenAbsences.set(runId, unproven);
  }

  private releaseActiveRuntimeIfProven(
    runId: string,
    workerRunId: string,
    runtime: AgentRuntime,
  ): void {
    if (this.unprovenAbsences.get(runId)?.has(workerRunId)) return;
    this.releaseActiveRuntime(runId, workerRunId, runtime);
  }

  private recorder(sink: RunEventSink, iteration: number, runId: string) {
    const control = this.controlFor(runId);
    return {
      sink,
      iteration,
      control,
      budgetScopeId: "root",
    };
  }

  private throwIfCancelled(agentId: string, runId?: string): void {
    if (runId) this.controlFor(runId).assertActive();
    if (this.isCancelled(agentId)) {
      if (runId) this.controlFor(runId).stop("user_cancelled", "Run cancelled");
      throw new RunCancelledError();
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number | null,
    runnerKey: string,
    workerRunId: string,
    leaderRunId: string,
    repairCandidate = false,
  ): Promise<T> {
    const control = this.controlFor(leaderRunId);
    if (ms === null) return await this.raceControl(control, promise);
    const timeoutState = {
      leaderRunId,
      runnerKey,
      startedAt: Date.now(),
      baseMs: ms,
      extraMs: 0,
      repairCandidate,
      grantedCheckpointIds: new Set<string>(),
    };
    this.workerTimeouts.set(workerRunId, timeoutState);
    try {
      return await this.raceControl(control, this.lease(promise, timeoutState, runnerKey));
    } finally {
      this.workerTimeouts.delete(workerRunId);
    }
  }

  private async lease<T>(
    promise: Promise<T>,
    timeoutState: { startedAt: number; baseMs: number; extraMs: number; runnerKey: string },
    runnerKey: string,
  ): Promise<T> {
    const settled = promise.then(
      (value) => ({ type: "resolved" as const, value }),
      (error) => ({ type: "rejected" as const, error }),
    );
    while (true) {
      const deadline = timeoutState.startedAt + timeoutState.baseMs + timeoutState.extraMs;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        void this.runner.cancel(runnerKey);
        throw new Error(
          "Worker timed out after " +
            (timeoutState.baseMs + timeoutState.extraMs) +
            " ms" +
            (timeoutState.extraMs > 0 ? " (" + timeoutState.extraMs + " ms extended)" : ""),
        );
      }
      const tick = await Promise.race([
        settled,
        sleep(Math.min(remaining, 1_000)).then(() => ({ type: "tick" as const })),
      ]);
      if (tick.type === "resolved") return tick.value;
      if (tick.type === "rejected") throw tick.error;
    }
  }

  private liveState(runId: string): OrchestrationState | null {
    return this.liveOrchestration.get(runId) ?? null;
  }

  private trajectoryContext(runId: string): { attach: boolean; ephemeral: boolean } {
    if (this.parts.healingEnabled !== true) return { attach: false, ephemeral: false };
    const mode = this.store.snapshot().runs.find((run) => run.id === runId)?.project?.source.mode;
    if (mode === "ephemeral_research") return { attach: true, ephemeral: true };
    if (mode === "existing_repository" || mode === "new_project") {
      return { attach: true, ephemeral: false };
    }
    return { attach: false, ephemeral: false };
  }

  private async startWorkerTurn(
    leaderRunId: string,
    subtaskId: string,
    workerRunId: string,
    workspacePath: string,
    start: (sink: RunEventSink) => Promise<RunnerResult>,
    sink: RunEventSink,
    runtime: () => AgentRuntime | null,
    runnerKey: string,
    options: { timeoutMs?: number; repairCandidate?: boolean; maxSteps?: number } = {},
  ): Promise<RunnerResult> {
    const timeoutMs = options.timeoutMs ?? this.policy.workerTimeoutMs;
    const ctx = this.trajectoryContext(leaderRunId);
    if (!ctx.attach) {
      return this.withTimeout(
        start(sink),
        timeoutMs,
        runnerKey,
        workerRunId,
        leaderRunId,
        options.repairCandidate === true,
      );
    }
    const monitor = this.ensureMonitor(
      leaderRunId,
      workerRunId,
      workspacePath,
      this.liveState(leaderRunId),
      subtaskId,
      options.maxSteps,
    );
    return this.withTimeout(
      this.raceMonitor(monitor, start(monitor.wrapSink(sink)), runtime, {
        leaderRunId,
        subtaskId,
        workerRunId,
        ephemeral: ctx.ephemeral,
      }),
      timeoutMs,
      runnerKey,
      workerRunId,
      leaderRunId,
      options.repairCandidate === true,
    );
  }

  private mergeSnapshots(state: OrchestrationState, monitor: TrajectoryMonitor): void {
    const seen = new Set(state.healing.snapshots.map((item) => item.id));
    for (const snapshot of monitor.snapshots()) {
      if (seen.has(snapshot.id)) continue;
      state.healing.snapshots.push(snapshot);
      seen.add(snapshot.id);
    }
  }

  private async healReturnedWorker(runId: string, result: WorkerResult): Promise<HealingAdmission | null> {
    await this.classifyReturnedWorker(
      runId,
      result.subtaskId,
      result,
      this.trajectoryContext(runId).ephemeral,
    );
    return this.beginHealing(runId, result.subtaskId);
  }

  private async healWave(runId: string, results: WorkerResult[]): Promise<HealingAdmission[]> {
    const admissions: HealingAdmission[] = [];
    for (const result of results) {
      if (result.status === "blocked") continue;
      const admission = await this.healReturnedWorker(runId, result);
      if (admission) admissions.push(admission);
    }
    return admissions;
  }

  private async beginHealing(runId: string, subtaskId: string): Promise<HealingAdmission | null> {
    if (this.parts.healingEnabled !== true) return null;
    if (!this.healingProjectRun(runId)) return null;
    const state = this.liveOrchestration.get(runId);
    if (!state) return null;
    const node = state.healing.nodes.find((item) => item.subtaskId === subtaskId);
    const contract = state.healing.contracts.find((item) => item.subtaskId === subtaskId);
    const fault = [...state.healing.faults]
      .reverse()
      .find((item) =>
        item.subtaskId === subtaskId &&
        (node ? item.revision <= node.revision : true),
      );
    if (!fault || !node || !contract) return null;
    if (node.state === "completed" || node.state === "cancelled") return null;
    if (!this.parts.diagnoser) {
      return {
        status: "unavailable",
        fault,
        diagnosis: null,
        reason: "diagnoser_unavailable",
      };
    }
    const before = structuredClone(state.healing);
    const admission = await new HealingCoordinator({
      mutateHealing: (mutate) => this.mutateHealing(runId, mutate),
      withAuthorityLock: (operation) => this.withAuthorityLock(runId, operation),
      diagnoser: this.parts.diagnoser,
      control: this.controlFor(runId),
      sink: this.events.createSink(
        runId,
        this.store.snapshot().runs.find((item) => item.id === runId)?.agentId ?? runId,
      ),
      healingEnabled: true,
      projectReady: this.parts.verificationRunner !== undefined,
      evidenceFor: (record) =>
        state.healing.snapshots
          .filter((item) => record.evidenceRefs.includes(item.id))
          .map((item) => ({
            id: item.id,
            source: item.source,
            failureFingerprints: item.failureFingerprints,
            changedPaths: item.changedPaths,
            stateFingerprint: item.stateFingerprint,
          })),
      budgetScopeId: "diagnosis:" + runId + ":" + subtaskId,
    }).begin(fault, node, contract);
    const after = this.store.snapshot().runs.find((item) => item.id === runId)
      ?.orchestration?.healing;
    if (after) {
      this.publishHealingTransitionEvents(runId, before, after, {
        omitNames: ["diagnosis_started", "fault_detected"],
      });
    }
    return admission;
  }

  private async classifyReturnedWorker(
    leaderRunId: string,
    subtaskId: string,
    result: WorkerResult,
    ephemeral: boolean,
  ): Promise<void> {
    if (this.parts.healingEnabled !== true) return;
    const state = this.liveOrchestration.get(leaderRunId);
    if (!state) return;
    const workerRunId = result.workerRunId ?? this.plannedWorkerRunId(leaderRunId, 1, subtaskId);
    const monitor = this.monitors.get(workerRunId);
    if (monitor) this.mergeSnapshots(state, monitor);
    if (
      state.healing.faults.some((fault) => fault.subtaskId === subtaskId && fault.class === "stall") ||
      result.error?.startsWith("trajectory_stop:")
    ) {
      await this.persistState(leaderRunId, state).catch(() => undefined);
      return;
    }
    const node = state.healing.nodes.find((item) => item.subtaskId === subtaskId) ?? null;
    if (
      state.healing.faults.some(
        (item) => item.subtaskId === subtaskId && item.revision === (node?.revision ?? 1),
      )
    ) {
      await this.persistState(leaderRunId, state).catch(() => undefined);
      return;
    }
    const verification = result.contribution
      ? state.healing.verifications.find((item) => item.subjectId === result.contribution?.contributionId)
      : undefined;
    if (verification) await this.observeVerification(leaderRunId, workerRunId, verification);
    const contract = state.healing.contracts.find((item) => item.subtaskId === subtaskId) ?? null;
    const fault = detectFault({
      contract,
      node,
      result,
      verification: verification ?? null,
      ephemeral,
    });
    if (fault) {
      const evidenceSnapshots = monitor
        ? monitor.snapshots()
        : state.healing.snapshots.filter((item) => item.attemptId === workerRunId);
      if (this.parts.faultEvidenceStore === undefined) {
        fault.evidenceRefs = evidenceSnapshots.map((item) => item.id);
      } else {
        try {
          fault.evidenceRefs = await persistFaultEvidence(evidenceSnapshots, this.parts.faultEvidenceStore);
        } catch {
          fault.evidenceRefs = [];
        }
      }
      state.healing.faults.push(fault);
      if (
        node &&
        node.state !== "repairing" &&
        node.state !== "completed" &&
        node.state !== "cancelled" &&
        node.state !== "verifying" &&
        node.state !== "integration_pending" &&
        node.state !== "integrating"
      ) {
        node.faultId = fault.id;
        node.state = "failed";
      }
    }
    await this.persistState(leaderRunId, state).catch(() => undefined);
  }

  private ensureMonitor(
    leaderRunId: string,
    workerRunId: string,
    workspacePath: string,
    state: OrchestrationState | null,
    subtaskId: string,
    maxSteps?: number,
  ): TrajectoryMonitor {
    const owned = this.monitorsForRun.get(leaderRunId) ?? new Set<string>();
    owned.add(workerRunId);
    this.monitorsForRun.set(leaderRunId, owned);
    const existing = this.monitors.get(workerRunId);
    if (existing) return existing;
    const contract = state?.healing.contracts.find((item) => item.subtaskId === subtaskId);
    const monitor = new TrajectoryMonitor({
      attemptId: workerRunId,
      workspacePath,
      git: this.git,
      checkpointMs: this.parts.trajectoryCheckpointMs ?? this.policy.trajectoryCheckpointMs ?? 60_000,
      maxSteps: maxSteps ?? this.policy.maxRuntimeSteps,
      repeatedSignatureLimit: this.policy.repeatedSignatureLimit,
      ...(this.parts.trajectoryClock ? { clock: this.parts.trajectoryClock } : {}),
      ...(contract ? { contract } : {}),
    });
    this.monitors.set(workerRunId, monitor);
    return monitor;
  }

  private raceMonitor<T>(
    monitor: TrajectoryMonitor,
    operation: Promise<T>,
    runtime: () => AgentRuntime | null,
    context: { leaderRunId: string; subtaskId: string; workerRunId: string; ephemeral?: boolean },
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      void monitor.terminal().then(async (stop) => {
        if (settled) return;
        settled = true;
        const active = runtime();
        if (active) {
          await active.cancel("trajectory_stall").catch(() => undefined);
          await active.quiesce("trajectory_stall").catch(() => undefined);
        }
        await monitor.drain().catch(() => undefined);
        await this.persistTrajectoryFault(
          context.leaderRunId,
          context.subtaskId,
          context.workerRunId,
          stop,
          context.ephemeral === true,
        ).catch(() => undefined);
        reject(new TrajectoryStoppedError(stop));
      }, () => undefined);
      void operation.then(
        (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
  }

  private async persistTrajectoryFault(
    leaderRunId: string,
    subtaskId: string,
    workerRunId: string,
    stop: import("./workers/trajectory.js").TrajectoryStop,
    ephemeral: boolean,
  ): Promise<void> {
    const state = this.liveOrchestration.get(leaderRunId);
    if (!state) return;
    const contract = state.healing.contracts.find((item) => item.subtaskId === subtaskId) ?? null;
    const node = state.healing.nodes.find((item) => item.subtaskId === subtaskId) ?? null;
    const monitor = this.monitors.get(workerRunId);
    if (monitor) this.mergeSnapshots(state, monitor);
    const fault = detectFault({
      contract,
      node,
      result: {
        subtaskId,
        workerId: null,
        workerRunId,
        iteration: 1,
        attempt: 1,
        status: "failed",
        output: "",
        error: stop.reason,
        usage: null,
        durationMs: 0,
        artifacts: [],
      },
      trajectory: stop,
      ephemeral,
    });
    if (!fault) {
      await this.persistState(leaderRunId, state).catch(() => undefined);
      return;
    }
    const evidenceSnapshots = monitor ? monitor.snapshots() : state.healing.snapshots;
    if (this.parts.faultEvidenceStore === undefined) {
      fault.evidenceRefs = evidenceSnapshots.map((item) => item.id);
    } else {
      try {
        fault.evidenceRefs = await persistFaultEvidence(evidenceSnapshots, this.parts.faultEvidenceStore);
      } catch {
        fault.evidenceRefs = [];
      }
    }
    state.healing.faults.push(fault);
    if (node) {
      node.faultId = fault.id;
      node.state = "failed";
    }
    await this.persistState(leaderRunId, state).catch(() => undefined);
    await this.beginHealing(leaderRunId, subtaskId);
  }

  private async inspectWorkerProgress(
    leaderRunId: string,
    request: InspectWorkerRequest,
  ): Promise<unknown> {
    const team = this.teams.get(leaderRunId);
    if (team === undefined) return { ok: false, error: "TEAM_NOT_ACTIVE" };
    const member = team.roster.resolve(request.target);
    if (member === undefined) return { ok: false, error: "WORKER_NOT_FOUND: " + request.target };
    const maxEvents = Math.max(20, Math.min(Number(request.maxEvents ?? 120), 300));
    const monitor = this.monitors.get(member.workerRunId);
    const progress = monitor?.progress() ?? { state: "unknown" as const, checkpointId: null };
    const tail = await this.events.summarizeProgressTail(member.workerRunId, maxEvents, {
      checkpointId: progress.checkpointId,
      state: progress.state,
      snapshot: monitor?.snapshots().at(-1) ?? null,
    });
    const timeout = this.workerTimeouts.get(member.workerRunId);
    const nowMs = Date.now();
    const deadline = timeout ? timeout.startedAt + timeout.baseMs + timeout.extraMs : null;
    const { events } = await this.events.readTail(member.workerRunId, maxEvents);
    const completed = events.filter((event) => event.status !== "in_progress");
    const counts: Record<string, number> = {};
    for (const event of completed) {
      const key = event.kind + ":" + event.status;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const open = new Map<string, RunEvent>();
    for (const event of events) {
      if (event.status === "in_progress") open.set(event.spanId, event);
      else open.delete(event.spanId);
    }
    const recent = tail.recent.slice(-12);
    return {
      ok: true,
      observational: true,
      authorizesContinuation: false,
      worker: {
        workerRunId: member.workerRunId,
        displayName: member.displayName,
        subtaskId: member.subtaskId,
        state: member.state,
      },
      timeout:
        timeout === undefined
          ? null
          : {
              elapsedMs: nowMs - timeout.startedAt,
              baseMs: timeout.baseMs,
              extraMs: timeout.extraMs,
              remainingMs: Math.max(0, (deadline ?? nowMs) - nowMs),
            },
      counts,
      open: [...open.values()].slice(-8).map((event) => ({
        seq: event.seq,
        kind: event.kind,
        name: event.name,
        runningMs: nowMs - new Date(event.startedAt).getTime(),
        text: compactEventText(event),
      })),
      recent,
      checkpoint: monitor
        ? { checkpointId: progress.checkpointId, state: progress.state, snapshot: monitor.snapshots().at(-1) ?? null }
        : null,
      progress,
      hint: "Observational only. This view cannot invent progress or authorize continuation. Timeout leases require a fresh server-owned progressing checkpoint; the leader reason is telemetry.",
    };
  }

  private async extendWorkerTimeout(
    leaderRunId: string,
    request: ExtendWorkerTimeoutRequest,
    sink: RunEventSink,
  ): Promise<unknown> {
    const team = this.teams.get(leaderRunId);
    if (team === undefined) return { ok: false, error: "TEAM_NOT_ACTIVE" };
    const member = team.roster.resolve(request.target);
    if (member === undefined) return { ok: false, error: "WORKER_NOT_FOUND: " + request.target };
    const timeout = this.workerTimeouts.get(member.workerRunId);
    if (timeout === undefined) {
      return { ok: false, error: "WORKER_NOT_RUNNING: " + member.displayName };
    }
    if (this.terminalOf(leaderRunId)) {
      return { ok: false, error: "RUN_TERMINAL" };
    }
    if (!Number.isFinite(request.additionalSeconds) || request.additionalSeconds <= 0) {
      return { ok: false, error: "INVALID_TIMEOUT_EXTENSION" };
    }
    if (timeout.repairCandidate) {
      return { ok: false, error: "REPAIR_CANDIDATE_TIMEOUT_FROZEN" };
    }
    const requestedMs = request.additionalSeconds * 1000;
    const remainingRoot = this.controlFor(leaderRunId).remainingMs();
    const appliedMs = Math.max(
      0,
      Math.min(requestedMs, remainingRoot),
    );
    const monitor = this.monitors.get(member.workerRunId);
    if (appliedMs <= 0) {
      sink.emit(
        delegationEvent(
          "extend_worker_timeout",
          "executing",
          1,
          member.displayName + " timeout extension denied: root lease exhausted",
          "error",
          {
            workerRunId: member.workerRunId,
            workerName: member.displayName,
            reason: "[redacted]",
            denied: "WORKER_TIMEOUT_EXTENSION_LIMIT_REACHED",
          },
        ),
      );
      return { ok: false, error: "WORKER_TIMEOUT_EXTENSION_LIMIT_REACHED" };
    }
    let checkpointId: string | null = null;
    if (monitor) {
      checkpointId = monitor.consumeProgressLease();
      if (!checkpointId) {
        sink.emit(
          delegationEvent(
            "extend_worker_timeout",
            "executing",
            1,
            member.displayName + " timeout extension denied: no fresh progressing checkpoint",
            "error",
            {
              workerRunId: member.workerRunId,
              workerName: member.displayName,
              reason: "[redacted]",
              denied: "NO_FRESH_PROGRESS",
            },
          ),
        );
        return { ok: false, error: "NO_FRESH_PROGRESS" };
      }
      timeout.grantedCheckpointIds.add(checkpointId);
    }
    timeout.extraMs += appliedMs;
    const deadline = timeout.startedAt + timeout.baseMs + timeout.extraMs;
    sink.emit(
      delegationEvent(
        "extend_worker_timeout",
        "executing",
        1,
        member.displayName + " extended by " + appliedMs + " ms",
        "ok",
        {
          workerRunId: member.workerRunId,
          workerName: member.displayName,
          additionalMs: appliedMs,
          totalExtraMs: timeout.extraMs,
          deadlineAt: new Date(deadline).toISOString(),
          reason: "[redacted]",
          ...(checkpointId ? { checkpointId } : {}),
        },
      ),
    );
    return {
      ok: true,
      workerRunId: member.workerRunId,
      displayName: member.displayName,
      addedMs: appliedMs,
      totalExtraMs: timeout.extraMs,
      remainingMs: Math.max(0, deadline - Date.now()),
      deadlineAt: new Date(deadline).toISOString(),
    };
  }

  private async runSoloFallback(
    leader: Agent,
    run: AgentRun,
    sink: { emit(draft: RunEventDraft): void },
    state: OrchestrationState,
    startedAt: number,
  ): Promise<void> {
    // Every other run path issues one; without it the proxy has no entry for
    // this run and answers 401, so the fallback that exists to rescue a failed
    // plan could never itself succeed.
    const control = this.controlFor(run.id);
    const modelToken = this.modelProxy?.issue(run.id, leader.id, control, "root");
    const runtime = this.runtimeFactory(this.runner);
    this.parts.runtimeObserver?.attach(leader.id, runtime);
    this.rememberActiveRuntime(run.id, run.id, runtime);
    let result: RunnerResult;
    try {
      const workspacePath = await this.leaderSessionWorkspacePath(leader, run);
      result = await this.raceControl(control, runtime.start({
        runId: run.id,
        agentId: leader.id,
        agentRole: "leader",
        parentRunId: run.parentRunId,
        workspacePath,
        prompt: run.prompt,
        ...(modelToken === undefined ? {} : { modelToken }),
        threadId: leader.codexThreadId,
        sink,
      }));
    } finally {
      this.parts.runtimeObserver?.detach(leader.id, runtime);
      this.releaseActiveRuntimeIfProven(run.id, run.id, runtime);
    }
    if (!await this.tryAdvanceProjectBaseline(run.id, state)) return;
    state.phase = "completed";
    sink.emit(lifecycleEvent("ok", "completed", Date.now() - startedAt));
    await this.completeLeaderRun(run.id, leader.id, result.output, state, result);
  }

  private getRunState(runId: string): OrchestrationState {
    const state = this.store.snapshot().runs.find((run) => run.id === runId)?.orchestration;
    if (!state) throw new Error("Orchestration state not found");
    return state;
  }

  private rememberActiveRunKey(runId: string, key: string): void {
    const keys = this.activeRunKeys.get(runId) ?? new Set<string>();
    keys.add(key);
    this.activeRunKeys.set(runId, keys);
  }

  private forgetActiveRunKey(runId: string, key: string): void {
    this.activeRunKeys.get(runId)?.delete(key);
  }

  private async persistState(runId: string, state: OrchestrationState): Promise<void> {
    this.liveOrchestration.set(runId, state);
    let before: HealingState | null = null;
    let after: HealingState | null = null;
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      if (!storedRun) return;
      const next = structuredClone(state);
      if (storedRun.orchestration) {
        before = structuredClone(storedRun.orchestration.healing);
        next.healing = mergeHealingState(next.healing, storedRun.orchestration.healing);
        next.evolutionOutbox = mergeEvolutionOutboxes(
          next.evolutionOutbox,
          storedRun.orchestration.evolutionOutbox,
        );
      }
      storedRun.orchestration = next;
      after = structuredClone(next.healing);
      state.healing = structuredClone(next.healing);
      state.evolutionOutbox = structuredClone(next.evolutionOutbox);
      const live = this.liveOrchestration.get(runId);
      if (live && live !== state) {
        live.healing = structuredClone(next.healing);
        live.evolutionOutbox = structuredClone(next.evolutionOutbox);
      }
    });
    if (before && after) this.publishHealingTransitionEvents(runId, before, after);
  }

  private async updateLeaderRun(
    runId: string,
    updates: Partial<AgentRun>,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      if (!storedRun) return;
      Object.assign(storedRun, updates);
    });
  }

  private async createSubtaskRun(
    worker: Agent,
    runId: string,
    parentRunId: string,
    prompt: string,
  ): Promise<void> {
    const timestamp = now();
    await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === worker.id);
      if (agent) {
        agent.status = "busy";
        agent.lastError = null;
        agent.updatedAt = timestamp;
      }
      database.runs.push({
        id: runId,
        agentId: worker.id,
        projectId: null,
        kind: "subtask",
        parentRunId,
        orchestration: null,
        status: "running",
        prompt,
        output: null,
        error: null,
        usage: null,
        startedAt: timestamp,
        completedAt: null,
        createdAt: timestamp,
      });
      database.messages.push({
        id: randomUUID(),
        agentId: worker.id,
        runId,
        role: "user",
        content: prompt,
        createdAt: timestamp,
      });
    });
  }

  private async completeSubtaskRun(
    workerId: string,
    runId: string,
    result: RunnerResult,
    sink: { emit(draft: RunEventDraft): void },
    terminalEvent: RunEventDraft,
  ): Promise<void> {
    const completedAt = now();
    const intent = {
      revision: 1,
      intendedRunStatus: "completed" as const,
      intendedAgentStatus: "ready" as const,
      output: result.output,
      usage: result.usage,
      threadId: result.threadId,
      completedAt,
      eventKind: "run" as const,
      eventName: terminalEvent.name,
      eventStatus: "ok" as const,
      eventHash: terminalEventHash(terminalEvent),
    };
    await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      if (!run || run.status !== "running" || run.terminalPublicationIntent) {
        throw new Error("child_terminal_intent_stale");
      }
      run.terminalPublicationIntent = structuredClone(intent);
    }));
    sink.emit(terminalEvent);
    await this.events.close(runId);
    try {
      await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === runId);
        const agent = database.agents.find((item) => item.id === workerId);
        if (run) {
          run.status = "completed";
          run.output = result.output;
          run.usage = result.usage;
          run.completedAt = completedAt;
        }
        if (agent) {
          agent.status = "ready";
          agent.codexThreadId = result.threadId;
          agent.lastError = null;
          agent.updatedAt = completedAt;
        }
        database.messages.push({
          id: randomUUID(),
          agentId: workerId,
          runId,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
      }));
    } catch {
      // The durable intent plus matching closed event is now authoritative.
      // Restart reconciliation will complete the physical DB transition.
    }
  }

  private async failSubtaskRun(
    workerId: string,
    runId: string,
    message: string,
    cancelled: boolean,
  ): Promise<void> {
    const completedAt = now();
    await this.events.close(runId);
    await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      const agent = database.agents.find((item) => item.id === workerId);
      if (run) {
        run.status = cancelled ? "cancelled" : "failed";
        run.error = message;
        run.completedAt = completedAt;
      }
      if (agent) {
        agent.status = cancelled ? "ready" : "error";
        agent.lastError = cancelled ? null : message;
      }
    }));
  }

  private async tryAdvanceProjectBaseline(runId: string, state: OrchestrationState): Promise<boolean> {
    const stored = this.store.snapshot().runs.find((item) => item.id === runId);
    const registry = this.parts.projectRegistry;
    if (!stored || !registry) return true;
    const candidate = baselineCandidate({ ...stored, orchestration: state });
    if (!candidate || !stored.projectId) return true;
    try {
      if (registry.get(stored.projectId).baselineCommit === candidate.next) return true;
      await registry.advanceBaseline({
        projectId: stored.projectId,
        runId,
        expectedCommit: candidate.expected,
        nextCommit: candidate.next,
      });
      return true;
    } catch (error) {
      state.outcome = {
        value: "failed",
        reason: "Project baseline compare-and-swap failed.",
        evidence: [error instanceof Error ? error.message : String(error)],
        resolvedAt: now(),
      };
      state.phase = "failed";
      await this.failLeaderRun(
        runId,
        stored.agentId,
        error instanceof Error ? error.message : String(error),
        state,
        false,
      );
      return false;
    }
  }

  private async completeLeaderRun(
    runId: string,
    leaderId: string,
    output: string,
    state: OrchestrationState,
    runnerResult?: RunnerResult,
  ): Promise<void> {
    if (!await this.tryAdvanceProjectBaseline(runId, state)) return;
    if (leaderProducedNothing(output, state)) {
      await this.failLeaderRun(
        runId,
        leaderId,
        "The leader session ended without producing a result or dispatching any worker.",
        state,
        false,
      );
      return;
    }
    const completedAt = now();
    await this.recordSkillRoutingFeedback(runId, "completed", completedAt, state);
    await this.events.close(runId);
    await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      const agent = database.agents.find((item) => item.id === leaderId);
      if (run) {
        state.evolutionOutbox = mergeEvolutionOutboxes(
          state.evolutionOutbox,
          run.orchestration?.evolutionOutbox ?? [],
        );
        run.status = "completed";
        run.output = output;
        run.usage = runnerResult?.usage ?? usageFromOrchestration(state.usage);
        run.orchestration = structuredClone(state);
        run.completedAt = completedAt;
      }
      if (agent) {
        agent.status = "ready";
        if (runnerResult) agent.codexThreadId = runnerResult.threadId;
        agent.lastError = null;
      }
      database.messages.push({
        id: randomUUID(),
        agentId: leaderId,
        runId,
        role: "assistant",
        content: output,
        createdAt: completedAt,
      });
    }));
  }

  private async failLeaderRun(
    runId: string,
    leaderId: string,
    message: string,
    state: OrchestrationState,
    cancelled: boolean,
  ): Promise<void> {
    const completedAt = now();
    await this.recordSkillRoutingFeedback(
      runId,
      cancelled ? "cancelled" : "failed",
      completedAt,
      state,
    );
    await this.events.close(runId);
    await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === runId);
      const agent = database.agents.find((item) => item.id === leaderId);
      if (run) {
        state.evolutionOutbox = mergeEvolutionOutboxes(
          state.evolutionOutbox,
          run.orchestration?.evolutionOutbox ?? [],
        );
        run.status = cancelled ? "cancelled" : "failed";
        run.error = message;
        run.orchestration = structuredClone(state);
        run.completedAt = completedAt;
      }
      if (agent) {
        agent.status = cancelled ? "ready" : "error";
        agent.lastError = cancelled ? null : message;
      }
    }));
  }

  private async retryTerminalStoreWrite<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch {
      return await write();
    }
  }
}

function claimedCommitMarker(output: string): boolean {
  return /LAUNCHPAD_COMMIT=[0-9a-f]{40}/.test(output);
}

function realRunCount(results: WorkerResult[]): number {
  return results.filter((result) => result.status !== "blocked").length;
}

function orchestrationUsage(results: WorkerResult[]): OrchestrationUsage {
  const inputTokens = sum(results, (result) => result.usage?.inputTokens);
  const outputTokens = sum(results, (result) => result.usage?.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    workerRuns: results.filter((result) => result.status !== "blocked").length,
  };
}

function shouldStopAfterTimeouts(results: WorkerResult[]): boolean {
  const attempted = results.filter((result) => result.status !== "blocked");
  if (attempted.length === 0) return false;
  const timedOut = attempted.filter((result) => result.status === "timed_out").length;
  return timedOut > 0 && timedOut / attempted.length >= 0.5;
}

function workerErrorMessage(error: unknown): string {
  if (error instanceof ContributionError) return error.code + ": " + error.message;
  return error instanceof Error ? error.message : String(error);
}

function candidateTransition(
  state: HealingState["candidates"][number]["state"],
): EvolutionTransitionInput["transition"] | null {
  switch (state) {
    case "declared": return "declared";
    case "pruned_duplicate": return "pruned_duplicate";
    case "admitted": return "admitted";
    case "running": return "executed";
    case "verifying": return "verifying";
    case "verified": return "verified";
    case "rejected": return "rejected";
    case "cancelled":
    case "not_started": return "cancelled";
    case "promotion_pending": return "promotion_pending";
    case "promoted": return "promoted";
    case "rolled_back": return "rolled_back";
    default: return null;
  }
}

function sortedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

class TerminalPublicationError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "TerminalPublicationError";
  }
}

export function terminalEventHash(event: Pick<RunEventDraft, "kind" | "name" | "status" | "error">): string {
  return createHash("sha256").update(JSON.stringify({
    kind: event.kind,
    name: event.name,
    status: event.status,
    errorCode: event.error?.code ?? null,
  })).digest("hex");
}

export function buildWorkerPrompt(
  subtask: LeaderSubtask,
  upstream: WorkerResult[],
  policy: ExecutionPolicy,
  requiresGitContribution = false,
  skillPlan?: SkillInjectionPlan | null,
): string {
  const skillCreation = isSkillCreationRequest([
    subtask.title,
    subtask.role,
    subtask.prompt,
    subtask.objective,
    subtask.expectedOutput,
    ...subtask.successCriteria,
  ].join("\n"));
  const lines = [
    subtask.prompt,
    "",
    "Leader execution constraints for this worker run:",
    policy.workerTimeoutMs === null
      ? "- Time budget: no per-worker wall-clock timeout is configured. Still produce useful checkpoints and stop cleanly if blocked."
      : "- Time budget: about " + Math.max(1, Math.floor(policy.workerTimeoutMs / 60_000)) + " minutes wall-clock. Produce the best partial answer before the budget expires.",
    "- Stay inside this subtask's objective and success criteria; do not broaden into adjacent workstreams.",
    "- Prefer targeted repository inspection: clone once if needed, use `rg --files`, `rg`, and focused file reads before broad scans.",
    "- For GitHub repositories with large media/LFS assets, use shallow clone tactics such as `GIT_LFS_SKIP_SMUDGE=1 git clone --depth=1 ...` when appropriate.",
    "- Avoid repeating equivalent searches or rereading the same files. If evidence is incomplete, say what is missing and stop cleanly.",
    "- Minimize model round-trips: plan once, then do the largest safe work phase before asking the model again. Use one scratch script or here-doc script instead of repeated `node -e`/`python3 -c`; batch independent shell work or Launchpad reads with batch_tool_call.",
    "- One-shot handoff default: fetch/inspect inputs, write deliverables, write status JSON, write the final report, and self-check in one execution phase whenever the task is not blocked.",
    "- Use Launchpad MCP tools when they fit. At startup call bootstrap_context instead of separate whiteboard_read/list_artifacts/list_teammates/list_custom_tools/search_skills/search_skill_wiki calls. For independent reads use batch_tool_call; for source repos prefer `git clone` plus local search.",
    "- Skill hub: before rebuilding a reusable workflow, inspect bootstrap_context.skills or tool_search/search_skills; read_skill, then install_skill to $COMMON_WORKSPACE/skills/<name> or scope=codex_home only for durable CODEX_HOME reuse. Before skill edits, inspect bootstrap_context.skillWiki, bootstrap_context.skillProposals, or search_skill_wiki/read_skill_wiki/list_skill_proposals; consolidate trace patterns with update_skill_wiki; stage_skill_proposal, validate, then finalize_skill_proposal so accepted/rejected changes are recorded.",
    "- For shell commands likely to run longer than 30-60 seconds, use launchpad.start_job, then read_job_output or short wait_job calls, so you can keep responding to steering and coordinating while work continues.",
    "- Runtime: node, git, ripgrep (rg), and python3 are available. If a Python package is missing, run `python3 -m pip install <package>`; pip is lazy-bootstrapped and cache-backed.",
    "- Workspaces: `/workspace` is PRIVATE scratch. Siblings share `$COMMON_WORKSPACE` (`/common-workspace`); put contracts, status, reports, validation artifacts, and deliverables there or publish_artifact them. Never hand off files through `/workspace`.",
    "- Shared reads: launchpad.read_file/read_many_files can read files under $COMMON_WORKSPACE; prefer paths like `$COMMON_WORKSPACE/reports/<name>.md` or `/common-workspace/reports/<name>.md` for sibling outputs.",
    "- Shared status protocol: create `$COMMON_WORKSPACE/status/<subtask-id>.json` early with small `state`, `summary`, `files`, `blocked_on`, `next`; update it only on material phase changes, not after every probe. Write final handoff to `$COMMON_WORKSPACE/reports/<subtask-id>.md` or `$COMMON_WORKSPACE/reports/<agent-name>.md`.",
    "- Diagnostic shell probes should not fail the turn for optional checks: use `|| true` on optional `ls`, `cat`, or `git` probes and avoid chaining noncritical probes under `set -e`.",
    "- Dependency cache: reuse `$LAUNCHPAD_DEPENDENCY_CACHE` plus `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `NPM_CONFIG_CACHE`, and `PYTHONUSERBASE`; keep caches/venvs out of deliverables.",
    "- Prior-art check before custom tool work: for parsing/extraction/conversion/rendering/format tasks, do one web_search plus one local probe (`which <cmd>` or `node -e \"require('pkg')\"`), then wrap a mature tool when available.",
    "- Custom tools: list_custom_tools first; put shared helpers under $COMMON_WORKSPACE, register_custom_tool, then siblings can call_custom_tool. Names must be distinct.",
    "- You are one of several workers on this task. At the start, call bootstrap_context to see what siblings or earlier iterations already found or produced, and build on it instead of duplicating.",
    "- Build against the shared contract in $COMMON_WORKSPACE; if interlocking work lacks a contract, write blocked status/report under `$COMMON_WORKSPACE/status` and `$COMMON_WORKSPACE/reports` and ask the leader.",
    "- Publish durable results with publish_artifact and whiteboard_post a short factual pointer.",
    "- Self-verify before hand-off against success criteria and shared acceptance checks; report observed results, and fix or flag failures explicitly instead of leaving them for someone else to catch downstream.",
  ];
  const skillContext = formatSkillPromptContext(skillPlan);
  if (skillContext) lines.push(skillContext.trim());
  if (skillCreation) {
    lines.push("", ...skillCreationWorkerGuidance());
  }
  if (upstream.length > 0) {
    lines.push(
      "",
      "Upstream results you depend on (use these as authoritative inputs):",
      ...upstream.map((result) =>
        "- [" + result.subtaskId + "] (" + result.status + "): " +
        result.output.slice(0, 4000),
      ),
    );
  }
  lines.push(
    "- Final output must include: findings, evidence, unresolved gaps, and recommended next checks.",
  );
  if (requiresGitContribution) {
    lines.push(
      "",
      "Git contribution contract (the middleware verifies this independently):",
      "- Commit exactly once after all intended changes are complete.",
      "- Leave the Git worktree clean.",
      "- Do not edit the shared exchange as source code.",
      "- Do not alter verifier configuration, budget policy, credentials, permissions, or middleware-owned .launchpad paths.",
      "- Later leader talk or steering cannot waive this middleware-owned contract. If asked to leave code changes uncommitted, report the conflict and still create the required commit.",
      "- End your response with exactly one marker line: LAUNCHPAD_COMMIT=<40 lowercase hex SHA>.",
      "- The marker must be the final non-empty line, with no code fence, no trailing prose, no duplicate marker, and no placeholder marker.",
    );
  } else {
    lines.push(
      "",
      "Non-git worker contract:",
      "- `requiresGitContribution:false`: do not make a git commit and do not print a Launchpad contribution marker.",
      "- If this is a conversation-only or talk-first role, answer incoming launchpad.talk messages directly and keep durable files to the minimum explicitly requested by the leader.",
    );
  }
  return lines.join("\n");
}

/**
 * Whether a leader shell command is a busy-wait poll — a `sleep N` (N seconds
 * above a trivial threshold) used to idle while workers run. This is the pattern
 * that burned roughly half the leader's wall-clock in early runs: sleep, wake,
 * inspect, sleep again. The leader has proper primitives (wait_job, dispatch
 * wait=true) and should never poll with sleep, so any non-trivial top-level
 * sleep in a leader command is treated as the anti-pattern.
 *
 * Kept deliberately narrow: it matches a `sleep` token (optionally quoted or
 * chained with ; && || |) followed by an integer >= the threshold, so a short
 * `sleep 1` inside a legitimate script does not trip it.
 */
export function isLeaderPollSleep(command: string | undefined, thresholdSeconds = 2): boolean {
  if (!command) return false;
  const match = command.match(/(?:^|['"\s;&|(])sleep\s+(\d+)(?:\.\d+)?\b/);
  if (!match) return false;
  return Number(match[1]) >= thresholdSeconds;
}

/**
 * Wrap the leader's event sink so that when the leader *starts* a poll-sleep
 * command, we steer the live turn: interrupt it and tell it to use the real
 * wait primitives instead. Enforcement, not just prompt guidance — the prompt
 * rule alone did not stop the leader from sleep-polling when it had wait_job
 * available.
 *
 * Bounded on purpose: at most `maxInterventions` steers per run and no more
 * than one per `cooldownMs`, so a leader that keeps trying cannot turn the
 * guard itself into a steer storm. The steer rides the existing wake() path
 * (turn/steer on the active turn), so it costs nothing beyond the model turn it
 * interrupts — which was going to be a wasted sleep anyway.
 */
export function guardLeaderSleepPolling(
  sink: RunEventSink,
  getRuntime: () => AgentRuntime | null,
  options: {
    runId: string;
    leaderAgentId: string;
    maxInterventions?: number;
    cooldownMs?: number;
    control?: RunControl;
    healingEnabled?: boolean;
    monitor?: { observe(draft: RunEventDraft): unknown };
  } = {
    runId: "",
    leaderAgentId: "",
  },
): RunEventSink {
  const maxInterventions = options.maxInterventions
    ?? (options.healingEnabled === true ? 1 : 3);
  const cooldownMs = options.cooldownMs ?? 8_000;
  let fired = 0;
  let lastFiredAt = 0;
  return {
    emit(draft: RunEventDraft): void {
      sink.emit(draft);
      if (
        draft.kind === "command" &&
        draft.status === "in_progress" &&
        draft.endedAt === null &&
        isLeaderPollSleep(draft.input.command)
      ) {
        options.monitor?.observe(draft);
      }
      if (
        draft.kind !== "command" ||
        draft.status !== "in_progress" ||
        draft.endedAt !== null ||
        !isLeaderPollSleep(draft.input.command)
      ) {
        return;
      }
      try {
        options.control?.assertActive();
      } catch {
        return;
      }
      const nowMs = Date.now();
      if (fired >= maxInterventions || nowMs - lastFiredAt < cooldownMs) return;
      const runtime = getRuntime();
      if (runtime === null) return;
      fired += 1;
      lastFiredAt = nowMs;
      const message: TeamMessageQueued = {
        id: randomUUID(),
        parentRunId: options.runId,
        fromWorkerRunId: "launchpad-leader-guard",
        toWorkerRunId: options.leaderAgentId,
        delivery: "wakeup",
        content:
          "Stop: do not use shell `sleep` to wait for workers. Every wake is a wasted model turn and idles the run. " +
          "Use async dispatch for long workers; call launchpad.wait_for_workers as a bounded checkpoint, then follow pendingHandoffs.suggestedAction or advance synthesis before waiting again. " +
          "Use launchpad.wait_job only for background shell jobs. Inspect a worker only when its handoff is missing/stale, it is blocked, or its evidence contradicts another result.",
        workspaceRefs: [],
        createdAt: new Date(nowMs).toISOString(),
      };
      // Fire-and-forget: the sink contract is synchronous, and a failed steer
      // (turn already ended, runtime closed) is not worth surfacing here.
      void runtime.wake(message).catch(() => undefined);
    },
  };
}

export function buildLeaderCodexPrompt(
  userTask: string,
  requiresGitContribution = false,
  skillPlan?: SkillInjectionPlan | null,
): string {
  const skillCreation = isSkillCreationRequest(userTask);
  const sharedWorkspaceDeliverable = isSharedWorkspaceDeliverableRequest(userTask);
  const lines = [
    userTask,
    "",
    "Launchpad leader harness instructions:",
    "- You are the live leader agent for this run, inside a steerable Codex ReAct loop.",
    "- The user may send steering messages while you run. Incorporate the latest steering before committing to irreversible choices.",
    "- Use launchpad.dispatch_subagent for parallel/specialized work. It is async by default; keep builders, researchers, validators, and forward-testers async unless they should finish well under 2 minutes. For talk-first workers, pass `initialMessage` in dispatch_subagent.",
    ...(sharedWorkspaceDeliverable
      ? [
        "- Preserve shared-workspace semantics: this run uses $COMMON_WORKSPACE as deliverable/exchange; dispatch shared builders/validators/forward-testers with requiresGitContribution:false unless the user asks for project commits.",
      ]
      : [
        "- In project-backed runs, workers commit by default. For read-only review, smoke-test, validation, or forward-test, pass requiresGitContribution:false.",
        "- Every code-producing worker owns an isolated contribution workspace and must make its own single clean commit. Your one-commit contract applies only to your leader workspace; it does not replace or absorb worker commits.",
        "- Never tell a code-producing worker to leave changes uncommitted for you; private worker workspace changes cannot be committed from the leader workspace.",
        "- Partition code-producing work by non-overlapping file ownership. Do not implement or commit a scope assigned to an active worker; wait for that contribution to integrate, or cancel the worker before taking ownership of its scope.",
      ]),
    "- Contract-first before fan-out: define only the minimal shared layout, signatures, entrypoint, and acceptance criteria needed to unblock workers, then dispatch all independent workers immediately. Handoff paths are `$COMMON_WORKSPACE/...`, never `/workspace/...`.",
    "- Dispatch workers with one-phase prompts: tell them to fetch/inspect, produce files, write `$COMMON_WORKSPACE/status/<subtask-id>.json`, write `$COMMON_WORKSPACE/reports/<subtask-id>.md`, self-check, and reply once unless blocked.",
    "- Live dispatch enforces dependsOn for contract->build, build->test, validation->publish; use wait_for_workers as a bounded checkpoint, then follow returned pendingHandoffs.suggestedAction before any second wait.",
    "- Give every worker a distinct, human-readable agentName. Names must remain unique.",
    "- Keep workers that need real-time conversation dependency-free, then use launchpad.talk for lightweight coordination.",
    "- Never use shell `sleep` or busy-wait loops for workers. Use launchpad.wait_for_workers for one bounded checkpoint, then do useful work: read all available handoff files with one read_many_files or batch_tool_call, synthesize, prepare acceptance checks, or steer a blocked worker.",
    "- Inspect on triggers only: handoff missing/stale, worker blocked/done/near-timeout, or contradictory evidence. Batch reads with launchpad.batch_tool_call/read_many_files; extend productive near-timeout workers with launchpad.extend_worker_timeout. inspect_worker_progress is observational: it cannot invent progress or authorize continuation.",
    "- Prefer worker status/report files: `$COMMON_WORKSPACE/status/<subtask-id>.json` and `$COMMON_WORKSPACE/reports/<subtask-id>.md`; inspect trajectories only if missing, stale, blocked, or contradictory.",
    "- Shared reads: launchpad.read_file/read_many_files can read `$COMMON_WORKSPACE/...`, `/common-workspace/...`, and relative shared paths that exist only in $COMMON_WORKSPACE; use those before shelling out to cat shared files.",
    "- If a root deadline is configured, it is immutable. launchpad.extend_worker_timeout is telemetry only: a leader request cannot extend the root, and worker leases can only narrow to the remaining root time. A lease requires a fresh server-owned progressing checkpoint; the leader reason is never authority.",
    "- Put large shared content in $COMMON_WORKSPACE and send paths instead of long messages.",
    "- Use launchpad.bootstrap_context once for teammates, artifacts, whiteboard, custom tools, published hub skills, skill wiki, skillProposals, and shared files; use launchpad.batch_tool_call for other independent reads. For reusable workflows check bootstrap_context.skills or launchpad.tool_search/search_skills, then read_skill/install_skill. For skill improvement check bootstrap_context.skillWiki/skillProposals or launchpad.search_skill_wiki/read_skill_wiki/list_skill_proposals; trace-derived changes should update_skill_wiki, then stage_skill_proposal/finalize_skill_proposal. Put reusable scripts in $COMMON_WORKSPACE and register_custom_tool.",
    "- For slow shell work such as tool generation, installs, rendering, or tests, prefer launchpad.start_job plus read_job_output/short wait_job calls instead of blocking the whole ReAct loop; for short mechanical batches, run one script directly.",
    "- Reuse `$LAUNCHPAD_DEPENDENCY_CACHE` plus `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `NPM_CONFIG_CACHE`, `PYTHONUSERBASE`; pip is lazy-bootstrapped, so install directly with `python3 -m pip install <package>`.",
    "- Use launchpad.list_teammates to see active workers and launchpad.talk to steer or answer them while they run.",
    "- Synthesize the final answer yourself from worker outputs, artifacts, whiteboard notes, and any user steering.",
    "- If no subagents are needed, do the work directly in this Codex session.",
  ];
  const skillContext = formatSkillPromptContext(skillPlan);
  if (skillContext) lines.push(skillContext.trim());
  if (skillCreation) {
    lines.push("", ...skillCreationLeaderGuidance({ sharedWorkspaceDeliverable }));
  }
  if (requiresGitContribution) {
    lines.push(
      "",
      "Git contribution contract (the middleware verifies this independently):",
      "- Commit exactly once after all intended changes are complete.",
      "- Leave the Git worktree clean.",
      "- Do not edit the shared exchange as source code.",
      "- Do not alter verifier configuration, budget policy, credentials, permissions, or middleware-owned .launchpad paths.",
      "- End your response with exactly one marker line: LAUNCHPAD_COMMIT=<40 lowercase hex SHA>.",
      "- The marker must be the final non-empty line, with no code fence, no trailing prose, no duplicate marker, and no placeholder marker.",
    );
  }
  return lines.join("\n");
}

export { isSkillCreationRequest } from "./skill-creation.js";
export {
  isSharedWorkspaceDeliverableRequest,
  requiresProjectContributionRequest,
} from "./project-contribution-intent.js";

function skillCreationLeaderGuidance(options: { sharedWorkspaceDeliverable: boolean }): string[] {
  return [
    "Skill creation quality mode:",
    "- When the `skill-creator` skill is available, require the responsible worker to read it and use its scaffold/validation workflow, including `init_skill.py` and `quick_validate.py` when those scripts exist.",
    "- Treat the deliverable as a reusable Codex skill, not a one-off CLI, script, or repo. The expected output is a skill folder with `SKILL.md` and only the resource directories that are actually useful (`scripts/`, `references/`, `assets/`, plus `agents/openai.yaml` when supported).",
    "- Contract-first for skills: require the first skill-design worker to define the skill name, trigger examples, exact folder layout, reusable scripts/assets/references, validation command, and forward-test tasks before implementation workers fill resources.",
    "- Keep the initial skill-creation cast small unless the user explicitly asks for a large campaign: one contract/scaffold worker, at most two implementation workers, one integration/gate worker, and one independent tester per required test class. Do not spawn duplicate replacements or corroborating retests while an original worker is still productive.",
    "- Run one clustered fix wave per evaluation cycle. First gather tester findings into a shared defect register, group them by root cause, then dispatch patch workers by cluster. After the patch wave, run one retest per failed gate/category; do not launch parallel retests for the same test unless the first retest is blocked, timed out, or gives contradictory evidence.",
    "- Keep `SKILL.md` concise and procedural. Put detailed schemas, examples, prompts, templates, and domain notes in referenced files so future agents can load them only when needed.",
    "- For source-derived skills, preserve useful source artifacts in `references/` or `assets/`, copy resource paths exactly, avoid local scratch paths in final instructions, and reject steps or assets that are not grounded in the provided material.",
    options.sharedWorkspaceDeliverable
      ? "- Dispatch implementation/package-building, smoke-test, validator, review, and forward-test workers with `requiresGitContribution:false` when they are collaborating on the shared skill folder under $COMMON_WORKSPACE; their authority is the shared deliverable and reported evidence, not a separate project commit."
      : "- Dispatch implementation/package-building workers as commit contributors. Dispatch smoke-test, validator, review, and forward-test workers with `requiresGitContribution:false`; their job is evidence, not a separate patch.",
    "- Require an integration gate before critique or forward-test: verify the real skill folder exists at the contracted path, exact required files are present, stale bundle paths are not being reviewed, quick_validate/validate_skill pass, representative scripts run, and all referenced resources resolve.",
    "- Require a skill quality gate before final acceptance: call `validate_skill` on the skill folder when that Launchpad tool is available, ensure structural validation passes, all referenced resources resolve, representative scripts run, clutter docs are removed, and the skill can be used from a fresh context without seeing the build history.",
    "- Cap secondary-artifact validation loops: run one structural validation and one fresh-context smoke test; if either fails, run one clustered fix wave and one retest for the failed category, then report remaining gaps instead of looping.",
    "- For creative artifact skills, add a qualitative reviewer gate in addition to structural checks: judge whether the output is natural, domain-faithful, non-generic, and not merely valid by schema.",
    "- Forward-test with a fresh worker using a natural prompt such as `Use $skill-name at /path/to/skill-name to solve <realistic task>`. Pass raw inputs only; do not leak intended fixes, hidden rubrics, or the prior implementation discussion.",
    "- The final answer must distinguish functional completion from skill quality: report validator results, forward-test result, remaining gaps, and the exact skill folder path.",
  ];
}

function skillCreationWorkerGuidance(): string[] {
  return [
    "Skill creation quality contract:",
    "- If the `skill-creator` skill is listed in your available skills, read its `SKILL.md` before editing and use its scaffold/validation scripts (`init_skill.py`, `quick_validate.py`) when present.",
    "- Build or review a real skill package, not just a helper script or application. The root must contain `SKILL.md`; include `scripts/`, `references/`, `assets/`, and `agents/openai.yaml` only when they materially improve reuse or quality.",
    "- `SKILL.md` frontmatter must include clear `name` and `description`; the description must say what the skill does and when it should trigger, because future agents decide whether to load the body from that text.",
    "- Use progressive disclosure: keep core workflow in `SKILL.md`, move large details to one-hop reference files, and ensure every referenced file/path exists.",
    "- Ground generated guidance in the actual source material. Package source notes, manifests, screenshots, examples, or reusable assets under `references/` or `assets/`; copy paths exactly and do not leave `/tmp`, `/workspace`, or machine-specific paths in the finished skill.",
    "- Put fragile, repeated, or deterministic operations into scripts and run representative smoke tests for those scripts. Prefer bundled templates/assets when output quality depends on consistent structure or visual/material inputs.",
    "- Remove one-off clutter such as README/INSTALLATION/CHANGELOG files unless the user explicitly requested them; reusable skill instructions belong in `SKILL.md` and its referenced resources.",
    "- Validate the skill before hand-off with `validate_skill` when available, and include a fresh-context forward-test prompt plus observed result or a clear blocker. Do not claim the skill is high quality solely because its code runs.",
    "- If `search_skill_wiki` and `read_skill_wiki` are available, consult the skill wiki before changing an existing skill so you do not repeat rejected interventions and can ground the update in prior patterns.",
    "- If `update_skill_wiki` is available and trace analysis reveals a reusable failure mode or success strategy, create or update a concise pattern page and index/log entry before proposing the skill patch.",
    "- If `stage_skill_proposal` and `finalize_skill_proposal` are available, stage candidate skill folders before validation and finalize them afterward so the skill wiki records the accepted or rejected intervention.",
    "- If `list_skill_proposals` is available, check for existing staged or finalized proposals before creating another proposal for the same skill.",
    "- If `record_skill_impact` is available, record the validation result for both accepted and rejected skill proposals, including origin patterns, evidence refs, and the diff or patch summary.",
    "- If `publish_skill` and `search_skills` are available, publish validated reusable skills to the Launchpad skill hub after the user or leader accepts them, so future runs can discover and install the exact package.",
  ];
}

export function boundedWorkerPrompt(subtask: LeaderSubtask, policy: ExecutionPolicy): string {
  return buildWorkerPrompt(subtask, [], policy);
}

function usageFromOrchestration(usage: OrchestrationUsage): RunUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

function sum<T>(items: T[], read: (item: T) => number | undefined): number {
  return items.reduce((total, item) => total + (read(item) ?? 0), 0);
}

function evaluationSummary(evaluation: {
  sufficient: boolean;
  missingInformation: string[];
}): string {
  if (evaluation.sufficient) return "Worker results satisfy the task.";
  return evaluation.missingInformation.length > 0
    ? "Missing: " + evaluation.missingInformation.join("; ")
    : "Worker results are not sufficient.";
}

/** Mirrors AgentService's run brackets so both Run kinds trace alike. */
function lifecycleEvent(
  status: RunEventDraft["status"],
  reason: string,
  durationMs: number | null,
  extra: Record<string, unknown> = {},
): RunEventDraft {
  const timestamp = now();
  const { text, ...attributes } = extra as { text?: string };
  return {
    spanId: "run",
    parentSpanId: null,
    kind: "run",
    name: reason,
    status,
    startedAt: timestamp,
    endedAt: status === "in_progress" ? null : timestamp,
    durationMs,
    input: text === undefined ? {} : { text },
    output: {},
    error: status === "error" ? { message: "Orchestration " + reason, code: reason } : null,
    attributes: { reason, ...attributes },
    usage: null,
  };
}

function delegationEvent(
  name: string,
  phase: string,
  iteration: number,
  text: string,
  status: RunEventDraft["status"] = "ok",
  attributes: Record<string, unknown> = {},
): RunEventDraft {
  const timestamp = now();
  return {
    spanId: "delegation-" + name + "-" + iteration,
    parentSpanId: "run",
    kind: "delegation",
    name,
    status,
    startedAt: timestamp,
    endedAt: status === "in_progress" ? null : timestamp,
    durationMs: status === "in_progress" ? null : 0,
    input: {},
    output: { text },
    error:
      status === "error" || status === "warning"
        ? { message: text, code: name }
        : null,
    attributes: { phase, iteration, ...attributes },
    usage: null,
  };
}

/** Healing traces hang off the run span so a subtask's evidence reads in order. */
export interface HealingTransitionOptions {
  checkpointFailure?: { subtaskId: string; reason: string };
  /** Internal de-duplication for transitions with an existing synchronous start event. */
  omitNames?: readonly string[];
}

export function healingTransitionEvents(
  before: HealingState,
  after: HealingState,
  options: HealingTransitionOptions = {},
): RunEventDraft[] {
  const events: RunEventDraft[] = [];
  const emit = (
    name: string,
    subtaskId: string,
    text: string,
    status: RunEventDraft["status"] = "ok",
    attributes: Record<string, unknown> = {},
  ) => events.push(healingEvent(name, subtaskId, text, status, attributes));
  const priorFaults = new Set(before.faults.map((item) => item.id));
  for (const fault of after.faults) {
    if (!priorFaults.has(fault.id)) {
      emit("fault_detected", fault.subtaskId, "A repairable task fault was persisted.", "warning", {
        faultId: fault.id,
        revision: fault.revision,
        reasonCode: fault.reasonCode,
      });
    }
  }

  const priorNodes = new Map(before.nodes.map((item) => [item.subtaskId, item]));
  for (const node of after.nodes) {
    const prior = priorNodes.get(node.subtaskId);
    if (node.diagnosisId && prior?.diagnosisId !== node.diagnosisId) {
      emit("diagnosis_started", node.subtaskId, "Diagnosis was durably claimed.", "in_progress", {
        diagnosisId: node.diagnosisId,
        revision: node.revision,
      });
    }
  }

  const priorDiagnoses = new Set(before.diagnoses.map((item) => item.id));
  for (const diagnosis of after.diagnoses) {
    if (priorDiagnoses.has(diagnosis.id)) continue;
    const fault = after.faults.find((item) => item.id === diagnosis.faultId);
    emit(
      diagnosis.status === "available" ? "diagnosis_completed" : "diagnosis_unavailable",
      fault?.subtaskId ?? "unknown",
      diagnosis.status === "available" ? "Diagnosis completed." : "Diagnosis unavailable.",
      diagnosis.status === "available" ? "ok" : "warning",
      { diagnosisId: diagnosis.id, faultId: diagnosis.faultId },
    );
  }

  if (options.checkpointFailure) {
    emit(
      "checkpoint_failed",
      options.checkpointFailure.subtaskId,
      "Repair checkpoint creation failed.",
      "error",
      { reason: options.checkpointFailure.reason },
    );
  }
  const priorTournaments = new Map(before.tournaments.map((item) => [item.id, item]));
  for (const tournament of after.tournaments) {
    const prior = priorTournaments.get(tournament.id);
    if (!prior && tournament.checkpointId) {
      emit("checkpoint_created", tournament.subtaskId, "Repair checkpoint was persisted.", "ok", {
        checkpointId: tournament.checkpointId,
        tournamentId: tournament.id,
        revision: tournament.revision,
      });
    }
  }

  const priorCandidates = new Map(before.candidates.map((item) => [item.id, item]));
  for (const candidate of after.candidates) {
    const prior = priorCandidates.get(candidate.id);
    if (!prior) {
      emit("candidate_declared", candidate.delta.targetSubtaskId, "Repair candidate declared.", "ok", {
        candidateId: candidate.id,
        tournamentId: candidate.tournamentId,
        family: candidate.delta.family,
        executed: false,
      });
    }
    if (prior?.state === candidate.state || candidate.state === "declared") continue;
    if (candidate.state === "admitted") {
      emit("candidate_admitted", candidate.delta.targetSubtaskId, "Repair candidate admitted.", "ok", {
        candidateId: candidate.id,
        tournamentId: candidate.tournamentId,
      });
    } else if (candidate.state === "running") {
      emit("candidate_started", candidate.delta.targetSubtaskId, "Repair candidate started.", "in_progress", {
        candidateId: candidate.id,
        tournamentId: candidate.tournamentId,
        executed: true,
      });
    } else if (
      prior?.state === "running" || prior?.state === "admitted"
    ) {
      emit("candidate_stopped", candidate.delta.targetSubtaskId, "Repair candidate stopped.", "ok", {
        candidateId: candidate.id,
        tournamentId: candidate.tournamentId,
        candidateState: candidate.state,
        executed: prior.state === "running",
      });
    }
  }

  const priorVerifications = new Set(before.verifications.map((item) => item.id));
  for (const verification of after.verifications) {
    if (priorVerifications.has(verification.id)) continue;
    const candidate = after.candidates.find((item) => item.id === verification.subjectId);
    emit(
      verification.mandatoryPassed ? "verification_passed" : "verification_failed",
      candidate?.delta.targetSubtaskId ?? verification.subjectId,
      verification.mandatoryPassed ? "Trusted verification passed." : "Trusted verification failed.",
      verification.mandatoryPassed ? "ok" : "error",
      {
        verificationId: verification.id,
        subjectId: verification.subjectId,
        stage: verification.stage,
      },
    );
  }

  for (const tournament of after.tournaments) {
    const prior = priorTournaments.get(tournament.id);
    if (prior?.status === tournament.status) continue;
    if (tournament.status === "promotion_pending") {
      emit("promotion_pending", tournament.subtaskId, "Verified repair is pending integration.", "in_progress", {
        tournamentId: tournament.id,
        candidateId: tournament.winnerCandidateId,
      });
    } else if (tournament.status === "promoted") {
      emit("promoted", tournament.subtaskId, "Verified repair was promoted.", "ok", {
        tournamentId: tournament.id,
        candidateId: tournament.winnerCandidateId,
      });
    } else if (tournament.status === "rolled_back") {
      emit("rollback", tournament.subtaskId, "Repair promotion was rolled back.", "error", {
        tournamentId: tournament.id,
        reason: tournament.failureReason,
      });
    }
  }

  for (const node of after.nodes) {
    const prior = priorNodes.get(node.subtaskId);
    const wasBlocked = (prior?.blockedBy.length ?? 0) > 0 || prior?.state === "blocked";
    const isBlocked = node.blockedBy.length > 0 || node.state === "blocked";
    if (!wasBlocked && isBlocked) {
      emit("dependency_blocked", node.subtaskId, "Task blocked on a required producer.", "warning", {
        blockedBy: [...node.blockedBy],
      });
    } else if (wasBlocked && !isBlocked) {
      emit("dependency_resumed", node.subtaskId, "Required producers completed; task resumed.", "ok");
    }
  }

  if (after.budget?.warningLevel && after.budget.warningLevel !== before.budget?.warningLevel) {
    emit("budget_warning", "run", "Healing budget warning persisted.", "warning", {
      warningLevel: after.budget.warningLevel,
      usedModelCalls: after.budget.usedModelCalls,
      reservedTokens: after.budget.reservedTokens,
    });
  }
  if (after.budget?.terminalReason && after.budget.terminalReason !== before.budget?.terminalReason) {
    emit("terminal_denied", "run", "Run-wide terminal state denied further healing work.", "error", {
      reason: after.budget.terminalReason,
    });
  }
  return events;
}

function healingEvent(
  name: string,
  subtaskId: string,
  text: string,
  status: RunEventDraft["status"],
  attributes: Record<string, unknown> = {},
): RunEventDraft {
  const timestamp = now();
  const stage = typeof attributes.stage === "string" ? "-" + attributes.stage : "";
  return {
    spanId: "healing-" + name + "-" + subtaskId + stage,
    parentSpanId: "run",
    kind: "delegation",
    name,
    status,
    startedAt: timestamp,
    endedAt: status === "in_progress" ? null : timestamp,
    durationMs: status === "in_progress" ? null : 0,
    input: {},
    output: { text },
    error:
      status === "error" || status === "warning"
        ? { message: text, code: name }
        : null,
    attributes: { subtaskId, ...attributes },
    usage: null,
  };
}

function dispatchEvent(
  subtask: LeaderSubtask,
  iteration: number,
  attempt: number,
  worker: Agent,
  workerRunId: string,
  status: RunEventDraft["status"],
  text?: string,
): RunEventDraft {
  const timestamp = now();
  const label = (subtask.agentName ?? subtask.role) + ": " + subtask.title;
  return {
    spanId: "delegation-dispatch-" + iteration + "-" + attempt + "-" + subtask.id,
    parentSpanId: "delegation-delegating-" + iteration,
    kind: "delegation",
    name: "dispatch_subagent",
    status,
    startedAt: timestamp,
    endedAt: status === "in_progress" ? null : timestamp,
    durationMs: status === "in_progress" ? null : 0,
    input: { text: label },
    output: text === undefined ? {} : { text },
    error:
      status === "error" || status === "warning"
        ? { message: text ?? "Subagent dispatch did not complete", code: "dispatch_subagent" }
        : null,
    attributes: {
      phase: "executing",
      iteration,
      attempt,
      subtaskId: subtask.id,
      subtaskTitle: subtask.title,
      subtaskRole: subtask.role,
      objective: subtask.objective,
      prompt: subtask.prompt,
      workerId: worker.id,
      workerName: worker.name,
      workerRunId,
    },
    usage: null,
  };
}
