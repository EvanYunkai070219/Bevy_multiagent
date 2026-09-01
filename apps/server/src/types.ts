/**
 * The shared domain shapes, most of which are persisted.
 *
 * Read this before changing anything here. Almost every type below is written
 * to disk by `store.ts` or the event log and read back by a later process, so
 * adding an optional field is cheap and changing the meaning of an existing one
 * silently reinterprets records that already exist.
 *
 * `RunUsage` is worth one note: `outputTokens` is what the provider billed,
 * which on a reasoning model includes the thinking pass. `visibleOutputTokens`
 * subtracts it, because that pass is not part of what the agent produced.
 */
import type { RunEventSink } from "./run-events.js";
import type {
  EvolutionFingerprints,
  EvolutionHistoryStatus,
  EvolutionOutboxEntry,
  EvolutionReconciliationCheckpoint,
} from "./orchestration/evolution/evolution-types.js";

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
export type AgentRole = "standalone" | "leader" | "worker";
export type AgentRunKind = "single" | "orchestration" | "subtask";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  role: AgentRole;
  parentAgentId: string | null;
  specialty: string | null;
  projectId: string | null;
  /** Persisted UI classification for non-project chats; null when project-backed. */
  unassignedPlacement: "temporary" | "previous" | null;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  /**
   * What the provider billed as output. On a reasoning model this includes
   * thinking tokens that never appear in the returned content, so it is not by
   * itself a measure of how much the model wrote.
   */
  outputTokens?: number;
  /** Thinking tokens billed as output but never returned as content. */
  reasoningTokens?: number;
}

/** Output a reader could actually see — billed total minus thinking. */
export function visibleOutputTokens(usage: RunUsage): number {
  return Math.max(0, (usage.outputTokens ?? 0) - (usage.reasoningTokens ?? 0));
}

export type OrchestrationPhase =
  | "planning"
  | "delegating"
  | "executing"
  | "evaluating"
  | "replanning"
  | "synthesizing"
  | "completed"
  | "failed"
  | "cancelled";

export interface ArtifactRef {
  id: string;
  type: string;
  path?: string;
  description?: string;
  ownerWorkerId: string;
  ownerWorkerRunId: string;
  iteration: number;
  attempt: number;
}

export interface LeaderSubtask {
  id: string;
  /** Human-readable display name for the worker agent that owns this subtask. */
  agentName?: string;
  /** False for read-only review, smoke-test, or forward-test workers in a project-backed live run. */
  requiresGitContribution?: boolean;
  /** Optional first talk message queued before the worker's first model turn. */
  initialMessage?: string;
  initialMessageWorkspaceRefs?: string[];
  title: string;
  role: string;
  prompt: string;
  objective: string;
  successCriteria: string[];
  expectedOutput: string;
  dependsOn: string[];
  contractKey?: string;
  inputs?: string[];
  outputs?: string[];
  mutationPaths?: string[];
}

/** Leader-declared fields that must never set gates, tools, budgets, or exceptions. */
export const FORBIDDEN_LEADER_CONTRACT_KEYS = [
  "targetedGateIds",
  "contractGateIds",
  "consumerGateIds",
  "regressionGateIds",
  "gateIds",
  "protectedPaths",
  "protectedPathExceptions",
  "authorizedTools",
  "permissions",
  "rawCommand",
  "verifierCommand",
  "verifierCommands",
  "timeoutMs",
  "timeout",
  "workerTimeoutMs",
  "additionalSeconds",
  "budget",
  "budgets",
] as const;

export function assertNoForbiddenLeaderKeys(value: object, context: string): void {
  const keys = Object.keys(value);
  for (const key of FORBIDDEN_LEADER_CONTRACT_KEYS) {
    if (keys.includes(key)) {
      throw new Error(context + " must not declare " + key);
    }
  }
}

export interface LeaderPlan {
  needsSubagents: boolean;
  rationale: string;
  subtasks: LeaderSubtask[];
}

export interface IterationPlan {
  iteration: number;
  createdAt: string;
  reason: string;
  plan: LeaderPlan;
}

export type PlannerResult =
  | {
      status: "available";
      plan: LeaderPlan;
      model: string;
      promptVersion: string;
    }
  | {
      status: "unavailable";
      reason: string;
      error?: string;
      model?: string;
      promptVersion: string;
    };

export type ReplannerResult = PlannerResult;

export type WorkerStatus =
  | "completed"
  /** A clean contribution exists but has not yet passed canonical integration. */
  | "contribution_ready"
  | "partial"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "blocked";

/**
 * Whether the user's task succeeded — orthogonal to `AgentRun.status`, which
 * only says the orchestration loop reached its end.
 */
export type TaskOutcome = "succeeded" | "partial" | "failed" | "unknown";

export interface OutcomeRecord {
  value: TaskOutcome;
  reason: string;
  evidence: string[];
  resolvedAt: string;
}

export interface OutcomeInput {
  evaluatorAvailable: boolean;
  evaluationSufficient: boolean;
  results: Pick<WorkerResult, "status" | "validation">[];
}

export interface SkillCapabilityNeed {
  id: string;
  label: string;
  confidence: number;
  evidence: string[];
  constraints: {
    mustBeLocal?: boolean;
    networkAllowed?: boolean;
    canModifyWorkspace?: boolean;
    requiresSandbox?: boolean;
  };
}

export interface SkillRouteCandidate {
  name: string;
  version: string;
  description: string;
  tags: string[];
  notes: string;
  createdAt: string;
  evidenceRefs: string[];
  provenanceWarnings: string[];
  installArguments: {
    name: string;
    version: string;
    scope: "run" | "codex_home";
    destination?: string;
  };
}

export interface SkillRouteRank {
  candidate: SkillRouteCandidate;
  score: number;
  reasons: string[];
  risks: string[];
}

export interface SkillRouteInstall {
  name: string;
  version: string;
  scope: "run" | "codex_home";
  destination?: string;
  installedPath?: string;
}

export interface SkillInjectionPlan {
  runId: string;
  task: string;
  createdAt: string;
  needs: SkillCapabilityNeed[];
  selected: SkillRouteRank[];
  rejected: SkillRouteRank[];
  install: SkillRouteInstall[];
  promptContext: string;
  mode: "selected" | "shortlist" | "none";
}

/** How much of a worker turn could be mechanically trusted. */
export type WorkerIntegrity = "valid" | "unverified" | "invalid";

export interface WorkerValidation {
  integrity: WorkerIntegrity;
  anomalyCodes: string[];
  summary: string;
}

export interface WorkerValidatorInput {
  output: string;
  /** The planner-authored prompt, needed to tell analysis from a broken turn. */
  subtaskPrompt: string;
  /** Completed command / MCP / web_search events for this run. */
  toolEventCount: number;
  openToolCallCount: number;
  evidenceAvailable: boolean;
}

export type ProjectSourceKind = "managed" | "external";

export interface ProjectBaselineTransition {
  runId: string;
  expectedCommit: string;
  nextCommit: string;
  state: "prepared" | "ref_updated";
}

export interface ProjectRecord {
  id: string;
  displayName: string;
  sourceKind: ProjectSourceKind;
  repositoryPath: string;
  repositoryRealPath: string;
  gitCommonRealPath: string;
  gitCommonDev: number;
  gitCommonIno: number;
  baselineBranch: string;
  baselineCommit: string;
  state: "ready" | "unavailable";
  lastError: string | null;
  baselineTransition?: ProjectBaselineTransition;
  createdAt: string;
  updatedAt: string;
}

/** HTTP-safe Project: inode identity and baseline-transition recovery stay internal. */
export type PublicProject = Omit<
  ProjectRecord,
  | "repositoryRealPath"
  | "gitCommonRealPath"
  | "gitCommonDev"
  | "gitCommonIno"
  | "baselineTransition"
>;

export type WorkspaceSourceRequest =
  | { mode: "existing_repository"; repositoryPath: string; revision: string }
  | { mode: "new_project"; projectName: string }
  | { mode: "ephemeral_research" };

export interface WorkspaceSourceRecord {
  mode: WorkspaceSourceRequest["mode"];
  repositoryPath: string | null;
  requestedRevision: string | null;
  baseCommit: string | null;
  sourceFingerprint: string;
}

export type StructuralDecision = "passed" | "failed";

export interface AttemptWorkspaceRecord {
  attemptId: string;
  revision: number;
  ownerToken: string;
  subtaskId: string;
  baseCommit: string;
  workspacePath: string;
  state: "running" | "contribution_ready" | "integrated" | "failed" | "cancelled";
  cleanup: "active" | "removed" | "preserved";
  headCommit: string | null;
  reason: string | null;
  kind: "task" | "repair";
  checkpointId: string | null;
}

export interface ContributionRecord {
  contributionId: string;
  attemptId: string;
  attemptRevision: number;
  /** One-way binding to the server-internal attempt owner token. */
  ownerFingerprint: string;
  subtaskId: string;
  baseCommit: string;
  headCommit: string;
  changedPaths: string[];
  diffHash: string;
  verificationLevel: "structural";
  verificationIds: string[];
  /** Present for repair contributions and bound to the active graph authority. */
  repairGraphFenceHash?: string;
}

export interface IntegrationRecord {
  contributionId: string;
  subtaskId: string;
  canonicalHeadBefore: string;
  canonicalHeadAfter: string | null;
  state: "integrating" | "integrated" | "conflicted" | "rolled_back";
  structuralDecision: StructuralDecision;
  reason: string | null;
  verificationIds: string[];
  repairGraphFenceHash?: string;
}

/** Internal persisted inode/branch authority for the run-owned canonical checkout. */
export interface CanonicalWorkspaceAuthority {
  workspaceRealPath: string;
  workspaceDev: number;
  workspaceIno: number;
  gitCommonRealPath: string;
  gitCommonDev: number;
  gitCommonIno: number;
  runBranch: string;
}

export interface ProjectRunRecord {
  source: WorkspaceSourceRecord;
  runBranch: string | null;
  canonicalWorkspacePath: string;
  headCommit: string | null;
  /** Absent only on legacy/preflight/ephemeral records. Never exposed publicly. */
  canonicalAuthority?: CanonicalWorkspaceAuthority;
  state: "preflighting" | "ready" | "failed" | "completed" | "cancelled";
  attempts: AttemptWorkspaceRecord[];
  integrations: IntegrationRecord[];
}

export interface WorkerResult {
  subtaskId: string;
  workerId: string | null;
  workerRunId: string | null;
  iteration: number;
  attempt: number;
  status: WorkerStatus;
  output: string;
  error?: string;
  usage: RunUsage | null;
  durationMs: number;
  artifacts: ArtifactRef[];
  /** Present only when the worker produced a clean, unintegrated contribution. */
  contribution?: ContributionRecord;
  /** Absent on results recorded before validation existed. */
  validation?: WorkerValidation;
}

export interface SubtaskEvaluation {
  subtaskId: string;
  status: "satisfied" | "partial" | "unsatisfied";
  criteria: { criterion: string; satisfied: boolean; evidence?: string | undefined }[];
  issues: string[];
}

export interface LeaderEvaluation {
  sufficient: boolean;
  subtaskEvaluations: SubtaskEvaluation[];
  missingInformation: string[];
}

export type EvaluationResult =
  | {
      status: "available";
      evaluation: LeaderEvaluation;
      model: string;
      promptVersion: string;
    }
  | {
      status: "unavailable";
      reason: string;
      error?: string;
      model?: string;
      promptVersion: string;
    };

export interface EvaluationRecord {
  iteration: number;
  createdAt: string;
  planIteration: number;
  result: EvaluationResult;
}

export interface ExecutionPolicy {
  maxParallel: number;
  maxSubtasks: number;
  maxIterations: number;
  maxTotalWorkerRuns: number;
  workerTimeoutMs: number | null;
  workerSessionPolicy: "fresh" | "resume" | "auto";
  workerWorkspacePolicy: "fresh_task_scoped" | "reuse_worker_workspace";
  /**
   * What makes two subtasks the same participant.
   *
   * `per_subtask` — each subtask is its own agent with its own workspace and
   * trajectory. A plan that reads as five collaborating agents shows up as five.
   * `per_role` — subtasks sharing a role slug share one agent, so several
   * "researcher" steps are one researcher doing several things.
   */
  workerIdentityPolicy: "per_subtask" | "per_role";
  /** How long the team must stay silent before its results are read. */
  quiescenceMs: number;
  /** Automatic wakeups one worker may receive; a spending cap, not a brake. */
  maxFollowUpTurnsPerWorker: number;
  maxRepairTournaments: number;
  maxRepairBranches: number;
  repairBranchTimeoutMs: number;
  budgetAdvisoryTokens: number | null;
  budgetSevereTokens: number | null;
  budgetAdvisoryModelCalls: number | null;
  budgetSevereModelCalls: number | null;
  emergencyTokenFuse: number | null;
  emergencyModelCallFuse: number | null;
  rootTimeoutMs: number | null;
  maxRuntimeSteps: number | null;
  repeatedSignatureLimit: number | null;
  trajectoryCheckpointMs: number;
}

export interface OrchestrationUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  workerRuns: number;
}

export interface OrchestrationProvenance {
  harnessVersion: string;
  plannerModel?: string;
  evaluatorModel?: string;
  replannerModel?: string;
  synthesizerModel?: string;
  plannerPromptVersion: string;
  evaluatorPromptVersion: string;
  replannerPromptVersion: string;
  synthesizerPromptVersion: string;
}

export type TaskNodeStatus =
  | "pending" | "ready" | "running" | "blocked" | "verifying"
  | "failed" | "repairing" | "integration_pending" | "integrating"
  | "completed" | "cancelled";

export interface SubtaskContract {
  subtaskId: string;
  revision: number;
  contractKey: string;
  inputs: string[];
  outputs: string[];
  dependencyIds: string[];
  downstreamConsumers: string[];
  allowedMutationPaths: string[];
  protectedPaths: string[];
  artifactSchemaIds: string[];
  targetedGateIds: string[];
  contractGateIds: string[];
  consumerGateIds: string[];
  regressionGateIds: string[];
  authorizedTools: string[];
}

export interface TaskNodeState {
  subtaskId: string;
  revision: number;
  state: TaskNodeStatus;
  blockedBy: string[];
  attemptId: string | null;
  faultId: string | null;
  diagnosisId: string | null;
  tournamentId: string | null;
  verificationIds: string[];
  integrationContributionId: string | null;
  updatedAt: string;
}

export type FaultClass =
  | "hard_failure" | "stall" | "false_completion" | "coordination_failure"
  | "budget_failure" | "deadline_failure" | "provider_rate_limited"
  | "infrastructure_failure" | "authority_failure" | "integration_conflict"
  | "cancelled";

export interface FaultRecord {
  id: string;
  subtaskId: string;
  revision: number;
  class: FaultClass;
  reasonCode: string;
  summary: string;
  repairable: boolean;
  evidenceRefs: string[];
  affectedConsumers: string[];
  detectedAt: string;
}

export interface EvidenceSnapshot {
  id: string;
  attemptId: string;
  sequence: number;
  source: "runtime" | "verification";
  mandatoryFailures: number;
  consumerPassed: boolean;
  regressionCount: number;
  failureFingerprints: string[];
  changedPaths: string[];
  protectedViolations: string[];
  diffRiskUnits: number;
  modelCalls: number;
  commands: number;
  toolCalls: number;
  elapsedMs: number;
  stateFingerprint: string;
  contentHash: string;
  createdAt: string;
}

export interface DiagnosisRecord {
  id: string;
  faultId: string;
  status: "available" | "unavailable";
  classification: string;
  rationale: string;
  allowedMutationFamilies: ("control" | "context_patch" | "strategy_patch")[];
  createdAt: string;
}

export type CandidateState =
  | "declared" | "pruned_duplicate" | "not_started" | "admitted" | "running" | "verifying"
  | "verified" | "rejected" | "cancelled" | "promotion_pending"
  | "promoted" | "rolled_back";

export interface MutationDelta {
  family: "control" | "context_patch" | "strategy_patch";
  targetSubtaskId: string;
  diagnosisId: string;
  addedEvidenceRefs: string[];
  failureCueIds: string[];
  instructionPatch: string;
  toolRoute: string[];
  expectedEffect: string;
  contentHash: string;
}

export interface MutationCandidate {
  id: string;
  tournamentId: string;
  checkpointId: string;
  delta: MutationDelta;
  state: CandidateState;
  attemptId: string | null;
  verificationIds: string[];
  modelCalls: number;
  reservedTokens: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  elapsedMs: number;
  terminalReason: string | null;
  historicalMatchRecordId: string | null;
  historicalVerificationId: string | null;
  /** Frozen at declaration from the authoritative repair checkpoint. */
  evolutionFingerprints: EvolutionFingerprints | null;
  repairGraphFenceHash?: string;
}

export interface RepairCheckpoint {
  id: string;
  runId: string;
  subtaskId: string;
  taskRevision: number;
  sourceAttemptId: string;
  sourceAttemptRevision: number;
  originalBaseCommit: string;
  checkpointCommit: string;
  treeHash: string;
  fingerprintSchemaVersion: 2;
  fingerprintComplete: boolean;
  repositoryBaseHash: string;
  contractHash: string;
  authorityManifestHash: string;
  contextBundleHash: string;
  faultEvidenceHash: string;
  contextEvidenceRefs: string[];
  contextAuditEvidenceRefs: string[];
  runtimeCapabilityHash: string;
  allowedMutationPaths: string[];
  protectedPaths: string[];
  createdAt: string;
  repairGraphFenceHash?: string;
}

export interface RepairTournament {
  id: string;
  subtaskId: string;
  revision: number;
  checkpointId: string | null;
  candidateIds: [string, string, string];
  status: "declared" | "running" | "failed" | "promotion_pending" | "promoted" | "rolled_back" | "cancelled";
  winnerCandidateId: string | null;
  failureReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  repairGraphFenceHash?: string;
}

/** Durable authority snapshot that freezes DAG and contract mutation during repair. */
export interface RepairGraphFence {
  runId: string;
  tournamentId: string;
  graphRevision: number;
  graphHash: string;
  contractHashes: readonly string[];
  admittedAt: string;
}

export interface GateResult {
  gateId: string;
  tier: "integrity" | "targeted" | "contract" | "consumer" | "held_out" | "mutation_quality" | "regression" | "post_integration";
  passed: boolean;
  evidenceRef: string;
  failureFingerprint: string | null;
}

export type VerificationFailureKind =
  | "deterministic_gate_failure"
  | "authority_failure";

export interface VerificationResult {
  id: string;
  subjectType: "contribution" | "candidate" | "promoted";
  subjectId: string;
  stage: "candidate" | "finalist" | "pre_integration" | "post_integration";
  authorityManifestHash: string;
  gates: GateResult[];
  failureKind: VerificationFailureKind | null;
  mandatoryPassed: boolean;
  hardProgress: number;
  regressionCount: number;
  modelCalls: number;
  reservedTokens: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  elapsedMs: number;
  verifiedAt: string;
  repairGraphFenceHash?: string;
}

/**
 * Why an authority result may not authorize its subject, or null when it may.
 * Shape is checked before the verdict, so a missing, malformed, or
 * candidate-controlled result cannot authorize import, completion, or promotion
 * merely by stamping `mandatoryPassed`.
 */
export function verificationDenial(
  result: VerificationResult | null | undefined,
  expectedStage: VerificationResult["stage"],
  expectedSubjectId: string,
): string | null {
  if (
    !result ||
    typeof result.id !== "string" ||
    result.id.length === 0 ||
    result.stage !== expectedStage ||
    result.subjectId !== expectedSubjectId
  ) {
    return expectedStage + "_verification_malformed";
  }
  if (
    (result.mandatoryPassed === true && result.failureKind !== null) ||
    (result.mandatoryPassed === false &&
      result.failureKind !== "deterministic_gate_failure" &&
      result.failureKind !== "authority_failure")
  ) {
    return expectedStage + "_verification_malformed";
  }
  return result.mandatoryPassed === true ? null : expectedStage + "_verification_failed";
}

export interface BudgetSnapshot {
  advisoryTokens: number | null;
  severeTokens: number | null;
  advisoryModelCalls: number | null;
  severeModelCalls: number | null;
  emergencyTokenFuse: number | null;
  emergencyModelCallFuse: number | null;
  usedModelCalls: number;
  reservedTokens: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  estimatedDollars: number | null;
  warningLevel: "advisory" | "severe" | null;
  deadlineAt: string | null;
  terminalReason: string | null;
}

export interface HealingState {
  contracts: SubtaskContract[];
  nodes: TaskNodeState[];
  faults: FaultRecord[];
  snapshots: EvidenceSnapshot[];
  diagnoses: DiagnosisRecord[];
  candidates: MutationCandidate[];
  tournaments: RepairTournament[];
  verifications: VerificationResult[];
  repairGraphFence: RepairGraphFence | null;
  budget: BudgetSnapshot | null;
}

export function emptyHealingState(): HealingState {
  return {
    contracts: [],
    nodes: [],
    faults: [],
    snapshots: [],
    diagnoses: [],
    candidates: [],
    tournaments: [],
    verifications: [],
    repairGraphFence: null,
    budget: null,
  };
}

export interface OrchestrationState {
  phase: OrchestrationPhase;
  iteration: number;
  iterationPlans: IterationPlan[];
  evaluationRecords: EvaluationRecord[];
  workerResults: WorkerResult[];
  usage: OrchestrationUsage;
  policySnapshot: ExecutionPolicy;
  provenance: OrchestrationProvenance;
  healing: HealingState;
  /** Internal delivery buffer. The HTTP boundary must never serialize it. */
  evolutionOutbox: EvolutionOutboxEntry[];
  /** Durable auxiliary-history health. It never changes Milestone 2 truth. */
  evolutionHistory?: EvolutionHistoryStatus;
  /** Middleware-selected Skill Hub context injected before model startup. */
  skillRouting?: SkillInjectionPlan[];
  /**
   * Absent while the run is still going, and on runs recorded before outcomes
   * existed. A missing outcome must never be read as success.
   */
  outcome?: OutcomeRecord;
}

export type OrchestrationRecord = OrchestrationState;

export interface AgentRun {
  id: string;
  agentId: string;
  projectId: string | null;
  kind: AgentRunKind;
  parentRunId: string | null;
  orchestration: OrchestrationRecord | null;
  /** Absent only on runs persisted before project-source support. */
  workspaceSource?: WorkspaceSourceRequest;
  /** Absent only on runs persisted before project-source support. */
  project?: ProjectRunRecord;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  /** Durable, nonterminal authority when the event log closed before DB finalization. */
  terminalPublicationIntent?: TerminalPublicationIntent;
}

export interface TerminalPublicationIntent {
  revision: number;
  intendedRunStatus: "completed";
  intendedAgentStatus: "ready";
  output: string;
  usage: RunUsage | null;
  threadId: string | null;
  completedAt: string;
  eventKind: "run";
  eventName: string;
  eventStatus: "ok";
  eventHash: string;
}

export interface Database {
  version: 1;
  projects: ProjectRecord[];
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  /** Internal restart-safe staging; never public pruning/cue authority while incomplete. */
  evolutionReconciliation?: Record<string, EvolutionReconciliationCheckpoint>;
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  role?: AgentRole | undefined;
  parentAgentId?: string | null | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  role?: AgentRole | undefined;
  parentAgentId?: string | null | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  runId: string;
  agentId: string;
  agentRole?: string | undefined;
  parentRunId?: string | null;
  workspacePath: string;
  commonWorkspacePath?: string | undefined;
  /**
   * How this worker reaches the team, when a coordination runtime is wired.
   * Absent leaves the worker exactly as it was: it runs, it finishes, and
   * nobody can address it.
   */
  coordinationEnv?: {
    LAUNCHPAD_COORDINATION_URL: string;
    LAUNCHPAD_COORDINATION_TOKEN: string;
    LAUNCHPAD_ROOT_DEADLINE_AT?: string;
    LAUNCHPAD_PARENT_RUN_ID?: string;
    LAUNCHPAD_REPAIR_CANDIDATE?: string;
    LAUNCHPAD_REPAIR_ALLOWED_TOOLS?: string;
  };
  prompt: string;
  threadId: string | null;
  /** Immutable container identity selected by repair policy; never a mutable tag. */
  runtimeImageId?: string;
  /**
   * Per-Run credential for the model egress proxy, when one is running.
   *
   * The container never receives the real provider key: this token is only
   * meaningful to the proxy, only for this Run, and is how the proxy attributes
   * a call. Absent when no proxy is configured, in which case the runner falls
   * back to the real key and the calls go unobserved.
   */
  modelToken?: string;
  /**
   * Where the runner reports normalised execution events.
   *
   * Optional: a runner without a sink still runs, it just goes unobserved.
   * The control plane always supplies one.
   */
  sink?: RunEventSink;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

export type {
  RunEvent,
  RunEventDraft,
  RunEventError,
  RunEventInput,
  RunEventKind,
  RunEventOutput,
  RunEventSink,
  RunEventStatus,
} from "./run-events.js";
