export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type AgentRole = "standalone" | "leader" | "worker";
export type ProjectSourceKind = "managed" | "external";

export interface ProjectRecord {
  id: string;
  displayName: string;
  sourceKind: ProjectSourceKind;
  repositoryPath: string;
  baselineBranch: string;
  baselineCommit: string;
  state: "ready" | "unavailable";
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** HTTP-safe Project: inode identity and baseline-transition recovery stay internal. */
export type Project = ProjectRecord;

export type CreateProjectRequest =
  | { kind: "managed"; displayName: string }
  | {
      kind: "external";
      displayName: string;
      repositoryPath: string;
      revision?: string;
    };

export interface CreateChatRequest {
  name: string;
  description?: string;
  instructions?: string;
  role?: "leader" | "standalone";
}

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
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  projectId: string | null;
  kind: "single" | "orchestration" | "subtask";
  parentRunId: string | null;
  orchestration: OrchestrationState | null;
  /** Absent only on runs persisted before project-source support. */
  workspaceSource?: WorkspaceSourceRequest;
  /** Absent only on runs persisted before project-source support. */
  project?: ProjectRunRecord;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  /** When the runner picked the Run up. Null while it is still queued. */
  startedAt: string | null;
  /** When the Run reached a terminal status. Null while it is still open. */
  completedAt: string | null;
  createdAt: string;
}

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
  subtaskId: string;
  baseCommit: string;
  workspacePath: string;
  state: "running" | "contribution_ready" | "integrated" | "failed" | "cancelled";
  cleanup: "active" | "removed" | "preserved";
  headCommit: string | null;
  reason: string | null;
}

export interface ContributionRecord {
  contributionId: string;
  attemptId: string;
  attemptRevision: number;
  ownerFingerprint: string;
  subtaskId: string;
  baseCommit: string;
  headCommit: string;
  changedPaths: string[];
  diffHash: string;
  verificationLevel: "structural";
}

export interface IntegrationRecord {
  contributionId: string;
  subtaskId: string;
  canonicalHeadBefore: string;
  canonicalHeadAfter: string | null;
  state: "integrating" | "integrated" | "conflicted" | "rolled_back";
  structuralDecision: StructuralDecision;
  reason: string | null;
}

export interface ProjectRunRecord {
  source: WorkspaceSourceRecord;
  runBranch: string | null;
  canonicalWorkspacePath: string;
  headCommit: string | null;
  state: "preflighting" | "ready" | "failed" | "completed" | "cancelled";
  attempts: AttemptWorkspaceRecord[];
  integrations: IntegrationRecord[];
}

export interface LeaderSubtask {
  id: string;
  agentName?: string;
  title: string;
  role: string;
  objective: string;
  successCriteria: string[];
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

export interface EvaluationRecord {
  iteration: number;
  createdAt: string;
  result: {
    status: "available" | "unavailable";
    evaluation?: {
      sufficient: boolean;
      missingInformation: string[];
    };
    reason?: string;
  };
}

export interface WorkerResult {
  subtaskId: string;
  workerId: string | null;
  workerRunId: string | null;
  iteration: number;
  attempt: number;
  status:
    | "completed"
    | "contribution_ready"
    | "partial"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "blocked";
  output: string;
  error?: string;
  contribution?: ContributionRecord;
}

export interface CoordinationMessage {
  id: string;
  from: string;
  to: string;
  delivery: "quiet" | "talk" | "wakeup";
  state: "queued" | "delivered" | "undeliverable";
  via?: string;
  reason?: string;
  content: string;
}

export interface CoordinationView {
  messages: CoordinationMessage[];
  members: { workerRunId: string; displayName: string; runtimeState: string }[];
}

export interface OutcomeRecord {
  value: "succeeded" | "partial" | "failed" | "unknown";
  reason: string;
  evidence: string[];
  resolvedAt: string;
}

export interface SkillCapabilityNeed {
  id: string;
  label: string;
  confidence: number;
  evidence: string[];
  constraints: Record<string, boolean | undefined>;
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

export interface OrchestrationState {
  phase: string;
  /** Absent while running, and on runs recorded before outcomes existed. */
  outcome?: OutcomeRecord;
  iteration: number;
  iterationPlans: IterationPlan[];
  evaluationRecords: EvaluationRecord[];
  workerResults: WorkerResult[];
  provenance: {
    harnessVersion: string;
    plannerModel?: string;
    evaluatorModel?: string;
    replannerModel?: string;
    synthesizerModel?: string;
  };
  skillRouting?: SkillInjectionPlan[];
}

export type CandidateState =
  | "declared" | "pruned_duplicate" | "not_started" | "admitted" | "running"
  | "verifying" | "verified" | "rejected" | "cancelled" | "promotion_pending"
  | "promoted" | "rolled_back";

export interface EvolutionFingerprints {
  schemaVersion: 2;
  complete: boolean;
  repositoryBaseHash: string;
  contractHash: string;
  authorityManifestHash: string;
  runtimeCapabilityHash: string;
  faultEvidenceHash: string;
  mutationContentHash: string;
}

export interface LineageNode {
  id: string;
  projectId: string;
  sourceFingerprint: string;
  runId: string;
  subtaskId: string | null;
  kind: "source" | "harness" | "attempt" | "candidate" | "integration" | "promotion" | "rollback";
  entityId: string;
  revision: number;
  harnessVersionHash: string;
  baseCommit: string | null;
  headCommit: string | null;
  faultId: string | null;
  fingerprints: EvolutionFingerprints | null;
  verificationIds: string[];
  evidenceRefs: string[];
  changedPaths: string[];
  createdAt: string;
}

export interface LineageEdge {
  id: string;
  projectId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: "continuation" | "executed_by" | "repair_fork" | "verified_by" | "integrated_as" | "promoted_as" | "rolled_back_to" | "returned_to";
  createdAt: string;
}

export interface LineageObservation {
  id: string;
  projectId: string;
  runId: string;
  nodeId: string;
  kind: "declared" | "pruned_duplicate" | "admitted" | "executed" | "verifying" | "verified" | "rejected" | "cancelled" | "promotion_pending" | "promoted" | "rolled_back" | "restart_cancelled" | "history_sync_pending" | "history_synced" | "branch_pruned";
  candidateState: CandidateState | null;
  terminalReason: string | null;
  modelCalls: number;
  reservedTokens: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  elapsedMs: number;
  occurredAt: string;
}

export interface FailureCue {
  id: string;
  projectId: string;
  sourceCandidateNodeId: string;
  contractKey: string;
  gateTier: "integrity" | "targeted" | "contract" | "consumer" | "held_out" | "mutation_quality" | "regression" | "post_integration";
  failureFingerprint: string;
  summary: string;
  evidenceRefs: string[];
  exactRepeatKey: string;
  createdAt: string;
}

export interface TransferObservation {
  id: string;
  projectId: string;
  cueId: string;
  targetCandidateNodeId: string;
  differingFingerprintFields: (keyof EvolutionFingerprints)[];
  outcome: "helped" | "neutral" | "regressed" | "inconclusive";
  evidenceRefs: string[];
  createdAt: string;
}

export type BranchReturnStopReason =
  | "no_evidence_progress"
  | "protected_rejection"
  | "verified_rollback";

/** Public capsule shape after the server removes mutation and authority hashes. */
export interface SanitizedFailureCapsule {
  id: string;
  projectId: string;
  runId: string;
  tournamentId: string;
  candidateId: string;
  candidateFamily: "control" | "context_patch" | "strategy_patch";
  returnCheckpointId: string;
  stopReason: BranchReturnStopReason;
  summary: string;
  evidenceRefs: string[];
  createdAt: string;
}

export interface BranchReturnRecord {
  id: string;
  projectId: string;
  runId: string;
  candidateNodeId: string;
  checkpointNodeId: string;
  capsuleId: string;
  createdAt: string;
}

export interface QuarantineRecord {
  id: string;
  projectId: string;
  targetRecordId: string;
  reason: "schema_invalid" | "hash_mismatch" | "evidence_missing" | "evidence_hash_mismatch" | "authority_untrusted" | "infrastructure_fault" | "provider_fault" | "classification_contradicted" | "ownership_mismatch" | "fingerprint_incomplete" | "legacy_fingerprint";
  evidenceRefs: string[];
  quarantinedAt: string;
}

export interface EvolutionCounts {
  declared: number;
  prunedDuplicate: number;
  admitted: number;
  executed: number;
  verified: number;
  promoted: number;
  rolledBack: number;
  branchPruned: number;
  branchReturned: number;
  historicalEvidenceUsed: number;
}

export interface EvolutionProjection {
  syncState: "synced" | "pending" | "unavailable" | "quarantined";
  historyHealth: {
    droppedHistoryCount: number;
    droppedReason:
      | "outbox_entry_limit"
      | "outbox_byte_limit"
      | "store_over_quota"
      | "store_unavailable"
      | null;
    reconciliationPending: boolean;
  };
  primaryFault: { class: string; summary: string; evidenceRefs: string[] } | null;
  warningLevel: "advisory" | "severe" | null;
  terminalReason: string | null;
  runBranch: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  counts: EvolutionCounts;
  nodes: LineageNode[];
  edges: LineageEdge[];
  observations: LineageObservation[];
  cues: FailureCue[];
  transfers: TransferObservation[];
  capsules: SanitizedFailureCapsule[];
  branchReturns: BranchReturnRecord[];
  quarantines: QuarantineRecord[];
  nextCursor: string | null;
}

export interface RunResponse {
  run: AgentRun;
  evolution?: EvolutionProjection;
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
  source: "config" | "provider";
  contextWindow?: number;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
  pricing: ModelPricing | null;
}

export type RunEventKind =
  | "run"
  | "turn"
  | "reasoning"
  | "command"
  | "file_change"
  | "mcp_tool"
  | "web_search"
  | "todo"
  | "delegation"
  | "api_call"
  | "message"
  | "error";

export type RunEventStatus = "in_progress" | "ok" | "warning" | "error";

export interface PlanItem {
  text: string;
  done: boolean;
}

export interface RunEvent {
  seq: number;
  runId: string;
  agentId: string;
  spanId: string;
  parentSpanId: string | null;
  kind: RunEventKind;
  name: string;
  status: RunEventStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  input: { command?: string; tool?: string; paths?: string[]; text?: string };
  output: {
    text?: string;
    exitCode?: number;
    changedFiles?: string[];
    todos?: PlanItem[];
  };
  error: { message: string; code?: string } | null;
  attributes: Record<string, unknown>;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
}

/** An artifact an agent published with `publish_artifact`, read back by the control plane. */
export interface PublishedArtifact {
  id: string;
  type: string;
  description: string;
  sourcePath: string | null;
  ownerWorkerId: string | null;
  ownerWorkerRunId: string | null;
  createdAt: string;
  bytes: number;
}

/** One skill in the persistent hub, at one version. */
export interface SkillSummary {
  name: string;
  version: string;
  description: string;
  tags: string[];
  notes: string;
  ownerAgentId: string | null;
  ownerRunId: string | null;
  createdAt: string;
  versions: string[];
}

export interface SkillDetail extends SkillSummary {
  sourcePath: string | null;
  hubPath: string | null;
  originPatterns: string[];
  evidenceRefs: string[];
  supersedesVersion: string | null;
  provenanceWarnings: string[];
  skillMarkdown: string | null;
  files: string[];
}
