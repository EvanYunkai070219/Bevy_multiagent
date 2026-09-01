/**
 * The service layer behind the HTTP routes.
 *
 * `app.ts` decides what a request is allowed to say; this decides what happens
 * because of it. Agent and run lifecycle, project-scoped runs, and the reads
 * the browser polls all land here, which is why it is the second-largest file
 * in the tree.
 *
 * The reads are deliberately thin: they return what was persisted and derive
 * nothing. A number the system did not record is not something this layer may
 * invent on the way out.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type { EventLog } from "./event-log.js";
import { ArkClient } from "./orchestration/leader/ark-client.js";
import { Diagnoser } from "./orchestration/healing/diagnoser.js";
import { Evaluator } from "./orchestration/leader/evaluator.js";
import {
  Orchestrator,
  terminalEventHash,
  type CoordinationDeps,
  type OrchestratorParts,
} from "./orchestration/orchestrator.js";
import {
  executionPolicyFromConfig,
  repairRuntimeCapabilityEnvironmentFromConfig,
} from "./orchestration/policies.js";
import { Planner } from "./orchestration/leader/planner.js";
import { Replanner } from "./orchestration/leader/replanner.js";
import { Synthesizer } from "./orchestration/leader/synthesizer.js";
import type { ModelPricing } from "./pricing.js";
import type { ModelCredentialIssuer } from "./model-proxy.js";
import {
  listPublishedArtifacts,
  readPublishedArtifact,
  sessionRootRunId,
  type PublishedArtifact,
} from "./published-artifacts.js";
import { listSkills, readSkillFromHub, type SkillDetail, type SkillSummary } from "./skill-hub.js";
import type { RunEvent, RunEventDraft } from "./run-events.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Database,
  HealingState,
  Message,
  ProjectRecord,
  ProjectRunRecord,
  UpdateAgentInput,
  WorkspaceSourceRequest,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import {
  UPLOAD_DIR,
  WorkspaceFileError,
  contentTypeFor,
  decodeUpload,
  resolveInsideWorkspace,
  sanitiseUploadName,
} from "./workspace-files.js";
import { TeamJournal } from "./coordination/team-journal.js";
import { ExecRuntime } from "./runtime/exec-runtime.js";
import { SessionRuntime } from "./runtime/session-runtime.js";
import type { AgentRuntime } from "./runtime/agent-runtime.js";
import {
  assertCanonicalWorkspaceAuthority,
  createProjectPreflightRecord,
  ProjectPreflightError,
  type ProjectRunManager,
} from "./project-run-manager.js";
import { GitClient } from "./git-client.js";
import {
  baselineCandidate,
  orderProjects,
  ProjectRenameError,
  ProjectRegistry,
  ProjectUnavailableError,
} from "./project-registry.js";
import { migrateLegacyChats } from "./project-migration.js";
import { AttemptWorkspaceManager } from "./attempt-workspace-manager.js";
import { ContributionCollector } from "./contribution-collector.js";
import { ContributionIntegrator } from "./contribution-integrator.js";
import { StructuralGate } from "./structural-gate.js";
import { RepairWorkspaceManager } from "./orchestration/healing/repair-workspaces.js";
import { evolutionRunGroupFingerprint } from "./orchestration/evolution/evolution-reconciler.js";
import type {
  EvolutionQueryInput,
  EvolutionQueryService,
} from "./orchestration/evolution/evolution-query.js";
import type { EvolutionProjection } from "./orchestration/evolution/evolution-types.js";

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const RESOLVED_COMMIT = /^[0-9a-f]{40}$/;

function effectiveRun(run: AgentRun, events: EventLog): AgentRun {
  const intent = run.terminalPublicationIntent;
  if (
    !intent ||
    (run.status !== "running" && run.status !== "queued") ||
    !events.hasClosedTerminal(run.id, (terminal) =>
      terminal.kind === intent.eventKind &&
      terminal.name === intent.eventName &&
      terminal.status === intent.eventStatus &&
      terminalEventHash(terminal) === intent.eventHash)
  ) return run;
  return {
    ...run,
    status: intent.intendedRunStatus,
    output: intent.output,
    usage: intent.usage,
    completedAt: intent.completedAt,
  };
}

function effectiveAgent(agent: Agent, runs: AgentRun[], events: EventLog): Agent {
  if (agent.status !== "busy") return agent;
  const intent = runs.find((run) =>
    run.agentId === agent.id &&
    (run.status === "running" || run.status === "queued") &&
    effectiveRun(run, events).status === "completed",
  )?.terminalPublicationIntent;
  return intent ? {
    ...agent,
    status: intent.intendedAgentStatus,
    codexThreadId: intent.threadId,
    lastError: null,
    updatedAt: intent.completedAt,
  } : agent;
}

function restartRecoveryFingerprint(run: AgentRun, runs: readonly AgentRun[]): string {
  return evolutionRunGroupFingerprint(run, runs);
}

function recoverHealingAfterRestart(healing: HealingState): HealingState {
  const recovered = structuredClone(healing);
  const interruptedNodes = new Set([
    "pending",
    "ready",
    "running",
    "blocked",
    "verifying",
    "repairing",
    "integration_pending",
    "integrating",
  ]);
  const timestamp = now();
  for (const node of recovered.nodes) {
    if (interruptedNodes.has(node.state)) {
      node.state = "cancelled";
      node.updatedAt = timestamp;
    }
  }
  for (const tournament of recovered.tournaments) {
    if (
      tournament.status === "declared" ||
      tournament.status === "running" ||
      tournament.status === "promotion_pending"
    ) {
      tournament.status = "cancelled";
      tournament.failureReason = "server_restarted";
      tournament.completedAt = timestamp;
      if (recovered.repairGraphFence?.tournamentId === tournament.id) {
        recovered.repairGraphFence = null;
      }
    }
  }
  for (const candidate of recovered.candidates) {
    if (candidate.state === "declared") {
      candidate.state = "not_started";
      candidate.terminalReason = "server_restarted";
    } else if (
      candidate.state === "admitted" ||
      candidate.state === "running" ||
      candidate.state === "verifying" ||
      candidate.state === "promotion_pending"
    ) {
      candidate.state = "cancelled";
      candidate.terminalReason = "server_restarted";
    }
  }
  return recovered;
}

/** @internal Deterministic restart race seam. Never populate from request input. */
export interface AgentServiceHooks {
  afterRestartEventBarrierForTest?(runId: string): Promise<void>;
}

/**
 * Which backend carries a worker turn.
 *
 * app-server keeps the worker addressable between turns; exec does not. The
 * choice is explicit because it changes what the system can honestly promise —
 * a message can reach an exec worker only at its start.
 */
function buildRuntimeFactory(config: AppConfig): (runner: AgentRunner) => AgentRuntime {
  if (config.codexRuntimeMode !== "app_server") {
    return (runner) => new ExecRuntime(runner);
  }
  return (runner) => new SessionRuntime(runner, config);
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly activeRuntimes = new Map<string, AgentRuntime>();
  private readonly cancellationRequests = new Set<string>();
  private readonly orchestrator: Orchestrator;
  private readonly projectGit: GitClient;
  private readonly attemptWorkspaces: AttemptWorkspaceManager;
  private readonly runtimeFactory: (runner: AgentRunner) => AgentRuntime;
  private pricing: ModelPricing | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly events: EventLog,
    orchestrationParts?: Partial<OrchestratorParts>,
    private readonly modelProxy?: ModelCredentialIssuer,
    coordination?: CoordinationDeps,
    private readonly projectRunManager?: ProjectRunManager,
    private readonly hooks: AgentServiceHooks = {},
    private readonly projectRegistry?: ProjectRegistry,
    git?: GitClient,
    private readonly evolutionReconciler?: {
      initialize?(): Promise<void>;
      reconcile(): Promise<unknown>;
    },
    private readonly evolutionQuery?: Pick<EvolutionQueryService, "get">,
  ) {
    const ark = new ArkClient(config);
    const projectGit = git ?? new GitClient(config.gitCommandTimeoutMs);
    this.projectGit = projectGit;
    const catalog = orchestrationParts?.contractCatalog;
    if (config.orchestrationHealingEnabled === true) {
      if (!Array.isArray(catalog) || catalog.length === 0) {
        throw new Error(
          "missing contract catalog: healingEnabled requires a non-empty catalog before any runtime admission",
        );
      }
    }
    const healingEnabled =
      config.orchestrationHealingEnabled === true || orchestrationParts?.healingEnabled === true;
    const defaultParts: OrchestratorParts = {
      planner: new Planner(ark),
      evaluator: new Evaluator(ark),
      replanner: new Replanner(ark),
      synthesizer: new Synthesizer(ark),
      diagnoser: new Diagnoser(ark),
      policy: executionPolicyFromConfig(config),
      runtimeCapabilityEnvironment: repairRuntimeCapabilityEnvironmentFromConfig(config),
      skillRouting: { dataDirectory: config.dataDirectory },
      ...(coordination === undefined ? {} : { coordination }),
      runtimeFactory: buildRuntimeFactory(config),
      ...(healingEnabled ? { healingEnabled: true } : {}),
    };
    const parts: OrchestratorParts = {
      ...defaultParts,
      ...(orchestrationParts ?? {}),
      runtimeObserver: {
        attach: (agentId, runtime) => this.activeRuntimes.set(agentId, runtime),
        detach: (agentId, runtime) => {
          if (this.activeRuntimes.get(agentId) === runtime) {
            this.activeRuntimes.delete(agentId);
          }
        },
      },
    };
    this.runtimeFactory = parts.runtimeFactory ?? buildRuntimeFactory(config);
    this.attemptWorkspaces =
      parts.attemptWorkspaces ?? new AttemptWorkspaceManager(projectGit);
    this.orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        ...parts,
        attemptWorkspaces: this.attemptWorkspaces,
        contributionCollector:
          parts.contributionCollector ?? new ContributionCollector(projectGit),
        contributionIntegrator:
          parts.contributionIntegrator ??
          new ContributionIntegrator(projectGit, new StructuralGate(projectGit)),
        ...(this.projectRegistry ? { projectRegistry: this.projectRegistry } : {}),
      },
      (agentId) => this.cancellationRequests.has(agentId),
      modelProxy,
    );
  }

  /** Rates are resolved asynchronously at startup, after the service exists. */
  setPricing(pricing: ModelPricing | null): void {
    this.pricing = pricing;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.events.initialize();
    let evolutionReady = true;
    try {
      await this.evolutionReconciler?.initialize?.();
    } catch {
      evolutionReady = false;
    }
    if (this.projectRegistry) {
      await this.projectRegistry.recoverBaselineTransitions();
      await migrateLegacyChats(this.store, this.projectRegistry);
    }
    await this.recoverInterruptedRuns();
    if (evolutionReady) {
      try {
        await this.evolutionReconciler?.reconcile();
      } catch {
        // Evolution history is auxiliary: malformed/unavailable history must not block M2 startup.
      }
    }
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const intentHandled = await this.reconcileTerminalPublicationIntents();
    const interrupted = this.store
      .snapshot()
      .runs.filter((run) =>
        (run.status === "queued" || run.status === "running") && !intentHandled.has(run.id))
      .map((run) => structuredClone(run));
    const restartSnapshot = this.store.snapshot();
    const interruptedIds = new Set(interrupted.map((run) => run.id));
    const recoveryGroups = interrupted
      .filter((run) => !run.parentRunId || !interruptedIds.has(run.parentRunId))
      .map((root) => ({
        root,
        members: interrupted.filter((run) => run.id === root.id || run.parentRunId === root.id),
        fingerprint: restartRecoveryFingerprint(root, restartSnapshot.runs),
      }));
    for (const { root } of recoveryGroups) {
      await this.hooks.afterRestartEventBarrierForTest?.(root.id);
    }
    const publishedGroups = new Set<string>();
    await this.retryTerminalStoreWrite(() => this.store.mutate(async (database) => {
      const cancelledAgentIds = new Set<string>();
      for (const group of recoveryGroups) {
        const run = database.runs.find((item) => item.id === group.root.id);
        if (
          !run ||
          restartRecoveryFingerprint(run, database.runs) !== group.fingerprint
        ) continue;

        if (!publishedGroups.has(group.root.id)) {
          for (const member of group.members) {
            this.events.reopenForRecovery(member.id);
            this.events.createSink(member.id, member.agentId).emit(this.restartCancellationEvent());
            await this.events.close(member.id);
          }
          publishedGroups.add(group.root.id);
        }
        const recoveredProject = run.project
          ? await this.recoverProjectAfterRestart(run.project, run.orchestration?.healing)
          : undefined;
        // Recovery runs while the store's serialized mutation is held. Recheck
        // the exact snapshotted run/project version before publishing so stale
        // cleanup evidence can never overwrite a newer owner or revision.
        if (restartRecoveryFingerprint(run, database.runs) !== group.fingerprint) continue;
        for (const member of group.members) {
          const durableMember = database.runs.find((item) => item.id === member.id);
          if (!durableMember) continue;
          if (durableMember.orchestration) {
            durableMember.orchestration.healing = recoverHealingAfterRestart(
              durableMember.orchestration.healing,
            );
          }
          durableMember.status = "cancelled";
          durableMember.error = "Server restarted while this run was active";
          durableMember.completedAt = now();
          if (durableMember.id === run.id && recoveredProject) {
            durableMember.project = structuredClone(recoveredProject);
          }
          cancelledAgentIds.add(durableMember.agentId);
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy" && cancelledAgentIds.has(agent.id)) {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    }));
  }

  private async recoverProjectAfterRestart(
    project: ProjectRunRecord,
    healing?: NonNullable<AgentRun["orchestration"]>["healing"],
  ): Promise<ProjectRunRecord> {
    const recovered = structuredClone(project);
    if (recovered.state !== "ready" || recovered.source.mode === "ephemeral_research") {
      recovered.state = "cancelled";
      return recovered;
    }

    const repairRecoveries = healing
      ? await new RepairWorkspaceManager(this.projectGit, this.attemptWorkspaces)
          .recoverCandidates(recovered, healing)
      : new Map();
    for (let index = 0; index < recovered.attempts.length; index += 1) {
      const attempt = recovered.attempts[index]!;
      if (attempt.cleanup === "active") {
        const result = attempt.state === "failed"
          ? { action: "preserved" as const, attemptId: attempt.attemptId, reason: "unverifiable" as const }
          : repairRecoveries.get(attempt.attemptId) ??
            await this.attemptWorkspaces.recover(recovered, attempt);
        attempt.cleanup = result.action === "removed" ? "removed" : "preserved";
        attempt.reason = result.action === "preserved" ? result.reason : "server_restarted";
      }
      if (attempt.state === "running" || attempt.state === "contribution_ready") {
        attempt.state = "cancelled";
      }
    }

    const integrating = recovered.integrations.filter((record) => record.state === "integrating");
    for (const record of integrating) {
      let matchesRecordedAuthority = recovered.headCommit === record.canonicalHeadBefore;
      if (matchesRecordedAuthority) {
        try {
          await assertCanonicalWorkspaceAuthority(
            this.projectGit,
            recovered,
            record.canonicalHeadBefore,
          );
          matchesRecordedAuthority = await this.projectGit.isClean(recovered.canonicalWorkspacePath);
        } catch {
          matchesRecordedAuthority = false;
        }
      }
      if (matchesRecordedAuthority) {
        record.state = "rolled_back";
        record.canonicalHeadAfter = null;
        record.structuralDecision = "failed";
        record.reason = "server_restarted";
      } else {
        record.reason = "restart_canonical_head_mismatch";
      }
    }
    recovered.state = "cancelled";
    return recovered;
  }

  /**
   * Chats in the order the operator last put them to work.
   *
   * Ordering by `updatedAt` ordered by "last write to the row", which is not
   * the same thing: stopping a chat, or any status change, rewrote the record
   * and jumped it to the top without the operator having asked for anything. A
   * run is only ever created by a message being sent, so the newest run is the
   * honest answer to "what did I last start here".
   */
  listAgents(): Agent[] {
    const snapshot = this.store.snapshot();
    const lastStarted = new Map<string, string>();
    for (const run of snapshot.runs) {
      const current = lastStarted.get(run.agentId);
      if (current === undefined || run.createdAt > current) {
        lastStarted.set(run.agentId, run.createdAt);
      }
    }
    const activity = (agent: Agent): string =>
      lastStarted.get(agent.id) ?? agent.createdAt;
    return snapshot.agents
      .map((agent) => effectiveAgent(agent, snapshot.runs, this.events))
      .sort((left, right) => activity(right).localeCompare(activity(left)));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return effectiveAgent(agent, this.store.snapshot().runs, this.events);
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const name = input.name.trim();
    this.assertAgentNameAvailable(name);
    const agent: Agent = {
      id,
      name,
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      role: input.role ?? "standalone",
      parentAgentId: input.parentAgentId ?? null,
      specialty: null,
      projectId: null,
      unassignedPlacement: "temporary",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => {
      this.assertAgentNameAvailable(name, undefined, database.agents);
      database.agents.push(agent);
    });
    return agent;
  }

  /** Newest first: a project you just made is the one you are looking for. */
  listProjects(): ProjectRecord[] {
    return orderProjects(this.projectRegistry?.list() ?? []);
  }

  async createManagedProject(input: { displayName: string }): Promise<ProjectRecord> {
    try {
      return await this.requireRegistry().createManaged(input);
    } catch (error) {
      throw this.asProjectHttpError(error);
    }
  }

  async openProject(input: {
    displayName: string;
    repositoryPath: string;
    revision: string;
  }): Promise<ProjectRecord> {
    try {
      return await this.requireRegistry().openExternal(input);
    } catch (error) {
      throw this.asProjectHttpError(error);
    }
  }

  async renameProject(input: { projectId: string; displayName: string }): Promise<ProjectRecord> {
    try {
      return await this.requireRegistry().rename(input.projectId, input.displayName);
    } catch (error) {
      throw this.asProjectHttpError(error);
    }
  }

  /**
   * Delete a project and the chats that live in it.
   *
   * A project with chats still in it cannot simply be forgotten: those chats
   * name a `projectId` that would no longer resolve, and every run they start
   * resolves its workspace through that project. So they go with it, through
   * the same `deleteAgent` path that archives a workspace rather than
   * discarding it.
   *
   * A busy chat refuses the whole delete instead of being killed underneath a
   * run in flight. Deleting is not an emergency stop; Stop is.
   */
  async deleteProject(
    projectId: string,
  ): Promise<{ deletedChats: number; removedRepository: boolean }> {
    const registry = this.requireRegistry();
    try {
      registry.get(projectId);
    } catch (error) {
      throw this.asProjectHttpError(error);
    }

    const chats = this.store
      .snapshot()
      .agents.filter((agent) => agent.projectId === projectId);
    const busy = chats.find((agent) => agent.status === "busy");
    if (busy !== undefined) {
      throw new HttpError(
        409,
        busy.name + " is still running. Stop it before deleting this project.",
      );
    }

    for (const chat of chats) {
      await this.deleteAgent(chat.id);
    }
    const { removedRepository } = await registry.delete(projectId);
    return { deletedChats: chats.length, removedRepository };
  }

  async createProjectChat(
    projectId: string,
    input: Omit<CreateAgentInput, "parentAgentId">,
  ): Promise<Agent> {
    try {
      await this.requireRegistry().admit(projectId);
    } catch (error) {
      throw this.asProjectHttpError(error);
    }
    if (input.role === "worker") {
      throw new HttpError(400, "Project chats cannot be workers");
    }
    const timestamp = now();
    const id = randomUUID();
    const name = input.name.trim();
    this.assertAgentNameAvailable(name);
    const agent: Agent = {
      id,
      name,
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      role: input.role ?? "leader",
      parentAgentId: null,
      specialty: null,
      projectId,
      unassignedPlacement: null,
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => {
      const current = database.projects.find((item) => item.id === projectId);
      if (!current) {
        throw new HttpError(404, "Project not found");
      }
      if (current.state !== "ready") {
        throw new HttpError(409, "Project is unavailable");
      }
      this.assertAgentNameAvailable(name, undefined, database.agents);
      database.agents.push(agent);
    });
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    const nameOnly = input.name !== undefined && Object.keys(input).length === 1;
    if (current.status === "busy" && !nameOnly) {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy" && !nameOnly) {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) {
        const name = input.name.trim();
        this.assertAgentNameAvailable(name, id, database.agents);
        agent.name = name;
      }
      if (nameOnly) {
        agent.updatedAt = now();
        return structuredClone(agent);
      }
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      if (input.role !== undefined) agent.role = input.role;
      if (input.parentAgentId !== undefined) agent.parentAgentId = input.parentAgentId;
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    if (!nameOnly) {
      await this.workspaces.writeInstructions(updated);
    }
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const runIds = this.store
      .snapshot()
      .runs.filter((run) => run.agentId === id)
      .map((run) => run.id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.events.archive(runIds);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  /**
   * Bytes out of one Agent's workspace.
   *
   * The path comes from a browser or from model output, so it is resolved
   * against that Agent's workspace and refused if it lands anywhere else. A
   * worker addresses files by the same call: its workspace is its own.
   */
  readWorkspaceFile(
    agentId: string,
    requested: string,
  ): { bytes: Buffer; contentType: string; filename: string } {
    const agent = this.getAgent(agentId);
    try {
      const target = resolveInsideWorkspace(agent.workspacePath, requested, {
        mustExist: true,
      });
      const stats = statSync(target);
      if (!stats.isFile()) {
        throw new WorkspaceFileError("not_a_file", "Not a file: " + requested);
      }
      return {
        bytes: readFileSync(target),
        contentType: contentTypeFor(target),
        filename: path.basename(target),
      };
    } catch (error) {
      throw this.asWorkspaceFileHttpError(error);
    }
  }

  /**
   * Put a file the operator chose into the Agent's workspace, where the Agent
   * can read it. Uploads land in one known directory rather than anywhere the
   * caller names, so a prompt can refer to them by a predictable path.
   */
  async writeWorkspaceUpload(
    agentId: string,
    name: string,
    contentBase64: string,
  ): Promise<{ path: string; bytes: number }> {
    const agent = this.getAgent(agentId);
    try {
      const safeName = sanitiseUploadName(name);
      const bytes = decodeUpload(contentBase64);
      const directory = resolveInsideWorkspace(agent.workspacePath, UPLOAD_DIR, {
        mustExist: false,
      });
      await mkdir(directory, { recursive: true });
      const target = resolveInsideWorkspace(
        agent.workspacePath,
        path.join(UPLOAD_DIR, safeName),
        { mustExist: false },
      );
      await writeFile(target, bytes);
      return { path: UPLOAD_DIR + "/" + safeName, bytes: bytes.byteLength };
    } catch (error) {
      throw this.asWorkspaceFileHttpError(error);
    }
  }

  private asWorkspaceFileHttpError(error: unknown): unknown {
    if (!(error instanceof WorkspaceFileError)) return error;
    const status =
      error.code === "not_a_file" ? 404 : error.code === "too_large" ? 413 : 400;
    return new HttpError(status, error.message);
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return effectiveRun(run, this.events);
  }

  async getEvolution(input: EvolutionQueryInput): Promise<EvolutionProjection> {
    this.getRun(input.runId);
    if (this.evolutionQuery === undefined) {
      throw new HttpError(503, "Evolution history is unavailable");
    }
    return this.evolutionQuery.get(input);
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .map((run) => effectiveRun(run, this.events))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /**
   * The team's message log for one leader run, read back from the journal.
   * Returns an empty projection for runs that predate coordination rather than
   * failing, so old runs stay openable.
   */
  async getCoordination(runId: string): Promise<{
    messages: {
      id: string;
      from: string;
      to: string;
      delivery: string;
      state: string;
      via?: string;
      reason?: string;
      content: string;
    }[];
    members: { workerRunId: string; displayName: string; runtimeState: string }[];
  }> {
    // Read from disk rather than from a live handle: a run that finished, or
    // one from before this process started, is exactly when someone wants to
    // see what the team said to each other.
    const journal = await TeamJournal.open(this.config.dataDirectory, runId);
    const projection = journal.projection();
    const database = this.store.snapshot();
    const agentNameForRun = (workerRunId: string): string | undefined => {
      const run = database.runs.find((item) => item.id === workerRunId);
      if (run === undefined) return undefined;
      return database.agents.find((agent) => agent.id === run.agentId)?.name;
    };
    return {
      messages: [...projection.messages.values()].map((entry) => ({
        id: entry.message.id,
        from: entry.message.fromWorkerRunId,
        to: entry.message.toWorkerRunId,
        delivery: entry.message.delivery,
        state: entry.state,
        ...(entry.receipt?.deliveredVia === undefined
          ? {}
          : { via: entry.receipt.deliveredVia }),
        ...(entry.receipt?.reason === undefined ? {} : { reason: entry.receipt.reason }),
        content: entry.message.content,
      })),
      members: [...projection.members.entries()].map(([workerRunId, member]) => ({
        workerRunId,
        displayName: agentNameForRun(workerRunId) ?? member.displayName,
        runtimeState: member.runtimeState,
      })),
    };
  }

  /**
   * What the mission published, readable by the operator.
   *
   * Asked of any run in the mission -- leader or worker -- and answered from
   * the one shared directory they all publish into, because that is where the
   * runtime put them. Existence of the run is checked first so an unknown id
   * gets a 404 rather than an empty list that reads as "produced nothing".
   */
  listRunArtifacts(runId: string): { artifacts: PublishedArtifact[] } {
    this.getRun(runId);
    return {
      artifacts: listPublishedArtifacts(this.config.dataDirectory, this.sessionRootOf(runId)),
    };
  }

  readRunArtifact(
    runId: string,
    artifactId: string,
  ): { artifact: PublishedArtifact; text: string } {
    this.getRun(runId);
    return readPublishedArtifact(
      this.config.dataDirectory,
      this.sessionRootOf(runId),
      artifactId,
    );
  }

  private sessionRootOf(runId: string): string {
    return sessionRootRunId(this.store.snapshot().runs, runId);
  }

  /** Skills agents have published to the persistent hub. */
  listSkills(): { skills: SkillSummary[] } {
    return { skills: listSkills(this.config.dataDirectory) };
  }

  readSkill(name: string, version?: string): { skill: SkillDetail } {
    return { skill: readSkillFromHub(this.config.dataDirectory, name, version) };
  }

  getChildRuns(runId: string): AgentRun[] {
    return this.store
      .snapshot()
      .runs.filter((run) => run.parentRunId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const snapshot = this.store.snapshot();
    const currentAgent = snapshot.agents.find((item) => item.id === agentId);
    if (!currentAgent) {
      throw new HttpError(404, "Agent not found");
    }
    if (currentAgent.status === "busy") {
      return await this.steerActiveRun(currentAgent, prompt, timestamp);
    }
    if (currentAgent.projectId) {
      try {
        await this.requireRegistry().admit(currentAgent.projectId);
      } catch (error) {
        throw this.asProjectHttpError(error);
      }
    }
    const admitted = this.store.snapshot();
    const admittedAgent = admitted.agents.find((item) => item.id === agentId) ?? currentAgent;
    const continuation = this.continuationContext(admittedAgent, admitted, prompt);
    const workspaceSource =
      continuation?.workspaceSource ?? this.deriveRunSource(admittedAgent, admitted);
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      projectId: currentAgent.projectId,
      kind: "single",
      parentRunId: continuation?.parentRunId ?? null,
      orchestration: null,
      workspaceSource: structuredClone(workspaceSource),
      project:
        this.projectRunManager?.preflightRecord(runId, workspaceSource) ??
        createProjectPreflightRecord(this.config.workspaceRoot, runId, workspaceSource),
      status: "queued",
      prompt: continuation?.prompt ?? prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      if (storedAgent.role === "worker") {
        throw new HttpError(409, "Workers can only be run by their leader");
      }
      if (storedAgent.role === "leader" || storedAgent.projectId) {
        run.kind = "orchestration";
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  private async steerActiveRun(
    agent: Agent,
    prompt: string,
    timestamp: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (agent.role === "worker") {
      throw new HttpError(409, "Workers can only be run by their leader");
    }
    const run = this.store
      .snapshot()
      .runs.filter(
        (item) =>
          item.agentId === agent.id &&
          (item.status === "queued" || item.status === "running"),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!run) {
      throw new HttpError(409, "This Agent is busy but has no active run to steer");
    }
    const runtime = await this.waitForActiveRuntime(agent.id, run.id, 2_000);
    if (!runtime) {
      throw new HttpError(
        409,
        "This run is not currently inside a steerable Codex turn. It may be in orchestration planning/evaluation or using the one-shot Codex backend.",
      );
    }
    const delivered = await runtime.wake({
      id: randomUUID(),
      parentRunId: run.id,
      fromWorkerRunId: "user",
      toWorkerRunId: run.id,
      delivery: "wakeup",
      content: prompt,
      workspaceRefs: [],
      createdAt: timestamp,
    });
    if (delivered.state !== "delivered") {
      throw new HttpError(
        409,
        "This run could not be steered live: " + (delivered.reason ?? "delivery failed"),
      );
    }
    const message: Message = {
      id: randomUUID(),
      agentId: agent.id,
      runId: run.id,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    await this.store.mutate((database) => {
      database.messages.push(message);
      const storedAgent = database.agents.find((item) => item.id === agent.id);
      if (storedAgent) storedAgent.updatedAt = timestamp;
    });
    return { run, message };
  }

  private async waitForActiveRuntime(
    agentId: string,
    runId: string,
    timeoutMs: number,
  ): Promise<AgentRuntime | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const runtime = this.activeRuntimes.get(agentId);
      if (runtime) return runtime;
      const run = this.store.snapshot().runs.find((item) => item.id === runId);
      if (!run || (run.status !== "queued" && run.status !== "running")) return null;
      await sleep(25);
    }
    return this.activeRuntimes.get(agentId) ?? null;
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      pricing: this.pricing,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    try {
      await this.executeRunInner(agentAtStart, run);
    } finally {
      // Revoking only closes admission; a call already streaming finishes.
      this.modelProxy?.revoke(run.id);
    }
  }

  private async reconcileTerminalPublicationIntents(): Promise<Set<string>> {
    const handled = new Set<string>();
    for (const candidate of this.store.snapshot().runs) {
      const intent = candidate.terminalPublicationIntent;
      if (!intent || (candidate.status !== "running" && candidate.status !== "queued")) continue;
      handled.add(candidate.id);
      let matches = false;
      try {
        const terminal = await this.events.lastTerminalEvent(candidate.id);
        matches = terminal !== null &&
          terminal.kind === intent.eventKind &&
          terminal.name === intent.eventName &&
          terminal.status === intent.eventStatus &&
          terminalEventHash(terminal) === intent.eventHash;
      } catch {
        matches = false;
      }
      if (matches) {
        await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
          const run = database.runs.find((item) => item.id === candidate.id);
          const agent = database.agents.find((item) => item.id === candidate.agentId);
          if (!run?.terminalPublicationIntent) return;
          const durable = run.terminalPublicationIntent;
          run.status = durable.intendedRunStatus;
          run.output = durable.output;
          run.usage = durable.usage;
          run.completedAt = durable.completedAt;
          if (!database.messages.some((message) => message.runId === run.id && message.role === "assistant")) {
            database.messages.push({
              id: randomUUID(), agentId: run.agentId, runId: run.id, role: "assistant",
              content: durable.output, createdAt: durable.completedAt,
            });
          }
          if (agent) {
            agent.status = durable.intendedAgentStatus;
            agent.codexThreadId = durable.threadId;
            agent.lastError = null;
            agent.updatedAt = durable.completedAt;
          }
        }));
        continue;
      }
      this.events.reopenForRecovery(candidate.id);
      this.events.createSink(candidate.id, candidate.agentId).emit(this.lifecycleEvent("error", {
        reason: "terminal_publication_intent_mismatch",
        message: "Durable terminal intent did not match the closed terminal event",
      }));
      await this.events.close(candidate.id);
      await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === candidate.id);
        const agent = database.agents.find((item) => item.id === candidate.agentId);
        if (run) {
          run.status = "cancelled";
          run.error = "terminal_publication_intent_mismatch";
          run.completedAt = now();
        }
        if (agent?.status === "busy") agent.status = "ready";
      }));
    }
    return handled;
  }

  private async executeRunInner(agentAtStart: Agent, run: AgentRun): Promise<void> {
    const project = await this.preflightProject(agentAtStart, run);
    if (!project) return;
    if (run.kind === "orchestration") {
      await this.orchestrator.run(agentAtStart, run);
      return;
    }
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    const sink = this.events.createSink(run.id, agentAtStart.id);
    let terminalPublicationStarted = false;
    sink.emit(
      this.lifecycleEvent("in_progress", {
        reason: "started",
        text: run.prompt,
        instructionsHash: this.workspaces.instructionsHash(agentAtStart),
      }),
    );
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const modelToken = this.modelProxy?.issue(run.id, agentAtStart.id);
      const runtime = this.runtimeFactory(this.runner);
      this.activeRuntimes.set(agentAtStart.id, runtime);
      let result;
      try {
        result = await runtime.start({
          runId: run.id,
          agentId: agentAtStart.id,
          parentRunId: run.parentRunId,
          workspacePath:
            run.workspaceSource?.mode === "ephemeral_research"
              ? agentAtStart.workspacePath
              : project.canonicalWorkspacePath,
          prompt: run.prompt,
          threadId: agentAtStart.codexThreadId,
          ...(modelToken === undefined ? {} : { modelToken }),
          sink,
        });
      } finally {
        if (this.activeRuntimes.get(agentAtStart.id) === runtime) {
          this.activeRuntimes.delete(agentAtStart.id);
        }
      }
      await this.publishProjectBaseline(run);
      sink.emit(this.lifecycleEvent("ok", { reason: "completed" }));
      await this.events.close(run.id);
      terminalPublicationStarted = true;
      const completedAt = now();
      await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
      }));
    } catch (error) {
      if (terminalPublicationStarted) throw error;
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      sink.emit(
        this.lifecycleEvent("error", {
          reason: failureReason(cancelled, message),
          message,
        }),
      );
      await this.events.close(run.id);
      await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
        }
      }));
    }
  }

  private async publishProjectBaseline(run: AgentRun): Promise<void> {
    if (!this.projectRegistry) return;
    const stored = this.store.snapshot().runs.find((item) => item.id === run.id) ?? run;
    const candidate = baselineCandidate(stored);
    if (!candidate || !stored.projectId) return;
    await this.projectRegistry.advanceBaseline({
      projectId: stored.projectId,
      runId: stored.id,
      expectedCommit: candidate.expected,
      nextCommit: candidate.next,
    });
  }

  private async preflightProject(agentAtStart: Agent, run: AgentRun): Promise<ProjectRunRecord | null> {
    // No sink is opened here on the happy path. The first createSink for a run
    // fixes its session bundle (EventLog keys run-log state by runId), so a
    // default sink opened before the orchestrator runs would pin a live leader's
    // trajectory to a per-run folder and defeat the leader's own placement.
    // Only a preflight failure needs to log, and it opens the sink then.
    if (!run.workspaceSource) {
      return this.publishPreflightFailure(
        agentAtStart,
        run,
        new ProjectPreflightError(
          "workspace_source_preparation_failed",
          "Run does not declare a workspace source",
        ),
      );
    }
    if (!this.projectRunManager) {
      return this.publishPreflightFailure(
        agentAtStart,
        run,
        new ProjectPreflightError(
          "workspace_source_preparation_failed",
          "Project source preflight is unavailable",
        ),
      );
    }

    let project: ProjectRunRecord;
    try {
      project = await this.projectRunManager.prepare(run.id, run.workspaceSource);
    } catch (error) {
      return this.publishPreflightFailure(
        agentAtStart,
        run,
        this.asProjectPreflightError(error),
      );
    }

    try {
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (!storedRun) throw new Error("Run disappeared before project persistence");
        storedRun.project = structuredClone(project);
      });
    } catch (persistenceError) {
      let rollbackError: unknown;
      try {
        await this.projectRunManager.abortPrepared(run.id);
      } catch (error) {
        rollbackError = error;
      }
      const preflightError =
        rollbackError === undefined
          ? new ProjectPreflightError(
              "workspace_source_preparation_failed",
              "Prepared project evidence could not be persisted; owned state was rolled back",
              persistenceError,
              {
                originalCode: "project_record_persistence_failed",
                cleanupCode: "prepared_project_aborted",
              },
            )
          : new ProjectPreflightError(
              "workspace_source_cleanup_failed",
              "Prepared project evidence could not be persisted and safe rollback could not complete",
              persistenceError,
              {
                originalCode: "project_record_persistence_failed",
                cleanupCode:
                  rollbackError instanceof ProjectPreflightError
                    ? rollbackError.code
                    : "workspace_source_cleanup_failed",
              },
              rollbackError,
            );
      return this.publishPreflightFailure(agentAtStart, run, preflightError);
    }
    await this.projectRunManager.acknowledgePrepared(run.id, project);
    run.project = structuredClone(project);
    return project;
  }

  private asProjectPreflightError(error: unknown): ProjectPreflightError {
    return error instanceof ProjectPreflightError
      ? error
      : new ProjectPreflightError(
          "workspace_source_preparation_failed",
          "Unable to prepare the project source",
          error,
        );
  }

  private async publishPreflightFailure(
    agentAtStart: Agent,
    run: AgentRun,
    preflightError: ProjectPreflightError,
  ): Promise<null> {
    const sink = this.events.createSink(run.id, agentAtStart.id);
    const completedAt = now();
    const evidence = preflightError.details
      ? " [" +
        Object.entries(preflightError.details)
          .map(([key, value]) => key + "=" + value)
          .join(",") +
        "]"
      : "";
    const message = preflightError.code + ": " + preflightError.message + evidence;
    const failedProject = run.project
      ? { ...structuredClone(run.project), state: "failed" as const }
      : undefined;
    sink.emit(
      this.lifecycleEvent("error", {
        reason: preflightError.code,
        message,
      }),
    );
    await this.events.close(run.id);
    await this.retryTerminalStoreWrite(() => this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      const agent = database.agents.find((item) => item.id === agentAtStart.id);
      if (storedRun) {
        storedRun.status = "failed";
        storedRun.error = message;
        storedRun.completedAt = completedAt;
        if (failedProject) storedRun.project = structuredClone(failedProject);
      }
      if (agent) {
        if (agent.status !== "stopped") agent.status = "error";
        agent.lastError = message;
        agent.updatedAt = completedAt;
      }
    }));
    if (failedProject) run.project = structuredClone(failedProject);
    return null;
  }

  private async retryTerminalStoreWrite(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch {
      await write();
    }
  }

  /**
   * Read a Run's events from a sequence cursor.
   *
   * Flushes first when the Run is terminal, so a Run the API already reports as
   * finished can never come back missing its final events.
   */
  async getRunEvents(
    runId: string,
    after: number,
    limit?: number,
  ): Promise<{ events: RunEvent[]; lastSeq: number; complete: boolean }> {
    const run = this.getRun(runId);
    const terminal = ["completed", "failed", "cancelled"].includes(run.status);
    if (terminal) await this.events.flush(runId);
    const result = await this.events.read(runId, after, limit);
    return { ...result, complete: terminal };
  }

  private lifecycleEvent(
    status: RunEvent["status"],
    options: {
      reason: string;
      text?: string;
      message?: string;
      instructionsHash?: string;
    },
  ): RunEventDraft {
    const timestamp = now();
    return {
      spanId: "run",
      parentSpanId: null,
      kind: "run",
      name: options.reason,
      status,
      startedAt: timestamp,
      endedAt: status === "in_progress" ? null : timestamp,
      durationMs: null,
      input: options.text === undefined ? {} : { text: options.text },
      output: {},
      error:
        status === "error"
          ? { message: options.message ?? options.reason, code: options.reason }
          : null,
      attributes: {
        reason: options.reason,
        ...(options.instructionsHash === undefined
          ? {}
          : { instructionsHash: options.instructionsHash }),
      },
      usage: null,
    };
  }

  private restartCancellationEvent(): RunEventDraft {
    const event = this.lifecycleEvent("error", {
      reason: "server_restarted",
      message: "Server restarted while this run was active",
    });
    return {
      ...event,
      name: "restart_cancelled",
      attributes: { ...event.attributes, lifecycle: "restart_cancellation" },
    };
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private requireRegistry(): ProjectRegistry {
    if (!this.projectRegistry) {
      throw new HttpError(503, "Project registry is not configured");
    }
    return this.projectRegistry;
  }

  private requireProject(projectId: string): ProjectRecord {
    try {
      return this.requireRegistry().get(projectId);
    } catch (error) {
      throw this.asProjectHttpError(error);
    }
  }

  private assertProjectReady(project: ProjectRecord): void {
    if (project.state !== "ready") {
      throw new HttpError(409, "Project is unavailable");
    }
  }

  private deriveRunSource(agent: Agent, snapshot: Database): WorkspaceSourceRequest {
    if (!agent.projectId) {
      return { mode: "ephemeral_research" };
    }
    const project = snapshot.projects.find((item) => item.id === agent.projectId);
    if (!project) {
      throw new HttpError(404, "Project not found");
    }
    this.assertProjectReady(project);
    return this.requireRegistry().runSource(agent.projectId);
  }

  private continuationContext(
    agent: Agent,
    snapshot: Database,
    prompt: string,
  ): { parentRunId: string; prompt: string; workspaceSource?: WorkspaceSourceRequest } | null {
    if (!agent.projectId || !isPlainContinuationPrompt(prompt)) return null;
    const previous = snapshot.runs
      .filter((run) =>
        run.agentId === agent.id &&
        run.projectId === agent.projectId &&
        run.kind === "orchestration" &&
        run.status === "cancelled" &&
        run.parentRunId === null &&
        run.project?.state === "cancelled" &&
        run.prompt.trim().length > 0)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!previous) return null;

    const headCommit = previous.project?.headCommit;
    const source = previous.project?.source;
    const workspaceSource =
      source?.mode === "existing_repository" &&
      typeof source.repositoryPath === "string" &&
      typeof headCommit === "string" &&
      RESOLVED_COMMIT.test(headCommit)
        ? {
            mode: "existing_repository" as const,
            repositoryPath: source.repositoryPath,
            revision: headCommit,
          }
        : undefined;

    return {
      parentRunId: previous.id,
      prompt: [
        "Continue the previously stopped run.",
        "",
        "Original user request:",
        previous.prompt,
        "",
        "Latest user message:",
        prompt,
        "",
        "Use the prior Launchpad run state when available. Continue from the interrupted work instead of restarting from the project baseline.",
      ].join("\n"),
      ...(workspaceSource === undefined ? {} : { workspaceSource }),
    };
  }

  private asProjectHttpError(error: unknown): HttpError {
    if (error instanceof HttpError) return error;
    if (error instanceof ProjectRenameError) {
      return new HttpError(
        error.code === "project_not_found" ? 404 : 400,
        error.code === "project_not_found" ? "Project not found" : "Invalid project name",
      );
    }
    if (error instanceof ProjectUnavailableError) {
      return new HttpError(409, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/i.test(message)) {
      return new HttpError(404, "Project not found");
    }
    return new HttpError(400, message);
  }

  private assertAgentNameAvailable(
    name: string,
    exceptId?: string,
    agents = this.store.snapshot().agents,
  ): void {
    const normalized = name.trim().toLowerCase();
    if (!normalized) throw new HttpError(400, "Agent name is required");
    if (normalized.length > 80 || /[\r\n]/u.test(normalized)) {
      throw new HttpError(400, "Invalid agent name");
    }
    const duplicate = agents.find(
      (agent) => agent.id !== exceptId && agent.name.trim().toLowerCase() === normalized,
    );
    // Names are unique across the whole install, not per project, because a
    // leader addresses its workers by name. Saying only "must be distinct" left
    // the operator hunting for a clash they could not see -- especially when
    // the other chat lives under a different project.
    if (duplicate) {
      throw new HttpError(
        409,
        'The name "' + name.trim() + '" is already in use by another agent or chat' +
          (duplicate.projectId === null ? " outside any project" : "") +
          ". Agent and chat names are shared globally across every project, so pick a different one.",
      );
    }
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      const activeRunIds = this.store
        .snapshot()
        .runs.filter(
          (run) =>
            run.agentId === agentId &&
            run.kind === "orchestration" &&
            ["queued", "running"].includes(run.status),
        )
        .map((run) => run.id);
      await Promise.all(activeRunIds.map((runId) => this.orchestrator.cancel(runId)));
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}

/** Distinguish the ways a run can end so the trace records a specific cause. */
function failureReason(cancelled: boolean, message: string): string {
  if (cancelled) return "cancelled";
  if (message.includes("timed out")) return "timeout";
  if (message.includes("CODEX_MAX_OUTPUT_BYTES")) return "output_exceeded";
  return "failed";
}

function isPlainContinuationPrompt(text: string): boolean {
  return /^(continue|resume|go on|keep going|carry on|continue please|please continue)[.!?]*$/i
    .test(text.replace(/\s+/g, " ").trim());
}
