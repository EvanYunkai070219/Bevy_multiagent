/** Exercises AgentService persistence, event lifecycle, and runner integration. */
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../src/agent-service.js";
import { EventLog } from "../src/event-log.js";
import {
  terminalEventHash,
  type OrchestratorParts,
} from "../src/orchestration/orchestrator.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { loadConfig } from "../src/config.js";
import { JsonStore } from "../src/store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  Database,
  LeaderPlan,
  RunnerRequest,
  RunnerResult,
} from "../src/types.js";
import { ProjectRegistry } from "../src/project-registry.js";
import { ProjectRepositoryManager } from "../src/project-repository-manager.js";
import { migrateLegacyChats } from "../src/project-migration.js";
import type {
  AgentRuntime,
  DeliveryResult,
  RuntimeSnapshot,
  WorkerCheckpoint,
} from "../src/runtime/agent-runtime.js";
import type { TeamMessageQueued } from "../src/coordination/messages.js";
import { WorkspaceManager } from "../src/workspace.js";
import { GitClient } from "../src/git-client.js";
import { ProjectRunManager } from "../src/project-run-manager.js";
import { AttemptWorkspaceManager } from "../src/attempt-workspace-manager.js";
import { TeamJournal } from "../src/coordination/team-journal.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    request.sink?.emit({
      spanId: "fake-span",
      parentSpanId: "run",
      kind: "command",
      name: "bash",
      status: "ok",
      startedAt: "2026-08-26T00:00:00.000Z",
      endedAt: "2026-08-26T00:00:01.000Z",
      durationMs: 1000,
      input: { command: "echo hi" },
      output: { exitCode: 0, text: "hi" },
      error: null,
      attributes: { itemType: "command_execution" },
      usage: null,
    });
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class FailOnceTerminalStore extends JsonStore {
  private shouldFailTerminalMutation = true;

  override async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    if (this.shouldFailTerminalMutation) {
      const before = this.snapshot();
      const next = structuredClone(before);
      await mutation(next);
      const terminalTransition = next.runs.some((run) => {
        const previous = before.runs.find((item) => item.id === run.id);
        return (
          previous !== undefined &&
          !["completed", "failed", "cancelled"].includes(previous.status) &&
          ["completed", "failed", "cancelled"].includes(run.status)
        );
      });
      if (terminalTransition) {
        this.shouldFailTerminalMutation = false;
        throw new Error("terminal store write failed once");
      }
    }
    return super.mutate(mutation);
  }
}

class RejectChildFinalizationStore extends JsonStore {
  finalizationAttempts = 0;

  override async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    const before = this.snapshot();
    const next = structuredClone(before);
    const result = await mutation(next);
    const finalizesChild = next.runs.some((run) => {
      const previous = before.runs.find((item) => item.id === run.id);
      return previous?.kind === "subtask" && previous.status === "running" && run.status === "completed";
    });
    if (finalizesChild) {
      this.finalizationAttempts += 1;
      throw new Error("persistent child finalization denial");
    }
    return super.mutate(mutation);
  }
}

class RejectInitialProjectEvidenceStore extends JsonStore {
  evidenceWrites = 0;

  override async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    const next = structuredClone(this.snapshot());
    const result = await mutation(next);
    const writesInitialEvidence = next.runs.some(
      (run) =>
        !this.snapshot().runs.some((current) => current.id === run.id) &&
        run.project?.state === "preflighting",
    );
    if (writesInitialEvidence) {
      this.evidenceWrites += 1;
      throw new Error("initial project evidence store failure");
    }
    return super.mutate(mutation);
  }
}

class RejectReadyProjectStore extends JsonStore {
  readyWrites = 0;

  constructor(
    filePath: string,
    private remainingFailures: number,
    private readonly fixtureSecret: string,
    private readonly beforeReject?: (run: Database["runs"][number]) => Promise<void>,
  ) {
    super(filePath);
  }

  override async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    const before = this.snapshot();
    const next = structuredClone(before);
    await mutation(next);
    const ready = next.runs.find((run) => {
      const previous = before.runs.find((item) => item.id === run.id);
      return previous?.project?.state === "preflighting" && run.project?.state === "ready";
    });
    if (ready && this.remainingFailures > 0) {
      this.readyWrites += 1;
      this.remainingFailures -= 1;
      await this.beforeReject?.(ready);
      throw Object.assign(new Error("ready project persistence failed"), {
        path: ready.project?.canonicalWorkspacePath,
        token: this.fixtureSecret,
        secret: this.fixtureSecret,
      });
    }
    return super.mutate(mutation);
  }
}

class RejectRestartRecoveryStore extends JsonStore {
  recoveryWrites = 0;

  override async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    const before = this.snapshot();
    const next = structuredClone(before);
    await mutation(next);
    const writesRestartRecovery = next.runs.some((run) => {
      const previous = before.runs.find((item) => item.id === run.id);
      return previous?.status === "running" && run.status === "cancelled" &&
        run.project?.attempts.some((attempt) => attempt.cleanup === "removed");
    });
    if (writesRestartRecovery && this.recoveryWrites < 2) {
      this.recoveryWrites += 1;
      throw new Error("restart recovery store write denied");
    }
    return super.mutate(mutation);
  }
}

class CountingProjectRunManager extends ProjectRunManager {
  prepareCalls = 0;
  abortCalls = 0;
  acknowledgeCalls = 0;

  override async prepare(...args: Parameters<ProjectRunManager["prepare"]>) {
    this.prepareCalls += 1;
    return super.prepare(...args);
  }

  override async abortPrepared(...args: Parameters<ProjectRunManager["abortPrepared"]>) {
    this.abortCalls += 1;
    return super.abortPrepared(...args);
  }

  override async acknowledgePrepared(
    ...args: Parameters<ProjectRunManager["acknowledgePrepared"]>
  ) {
    this.acknowledgeCalls += 1;
    return super.acknowledgePrepared(...args);
  }
}

class FakeLiveRuntime implements AgentRuntime {
  state: RuntimeSnapshot["state"] = "not_started";
  activeTurnId: string | null = null;
  threadId: string | null = null;
  wakes: TeamMessageQueued[] = [];
  private finish: ((checkpoint: WorkerCheckpoint) => void) | null = null;

  async start(request: RunnerRequest): Promise<WorkerCheckpoint> {
    this.state = "active";
    this.threadId = request.threadId ?? "fake-live-thread";
    this.activeTurnId = "turn-1";
    return await new Promise<WorkerCheckpoint>((resolve) => {
      this.finish = resolve;
    });
  }

  complete(output = "live completed"): void {
    this.activeTurnId = null;
    this.state = "idle";
    this.finish?.({
      output,
      threadId: this.threadId,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }

  async inject(_message: TeamMessageQueued): Promise<DeliveryResult> {
    return { state: "delivered", via: "pending_quiet" };
  }

  async wake(message: TeamMessageQueued): Promise<DeliveryResult> {
    this.wakes.push(message);
    return { state: "delivered", via: "steer", turnId: this.activeTurnId ?? undefined };
  }

  async waitForIdle(): Promise<void> {}

  async quiesce(_reason: string): Promise<void> {}

  snapshot(): RuntimeSnapshot {
    return { state: this.state, threadId: this.threadId, activeTurnId: this.activeTurnId };
  }

  capability(): "live_steer" {
    return "live_steer";
  }

  async close(_reason: string): Promise<void> {
    this.state = "closed";
  }

  async cancel(_reason: string): Promise<void> {
    this.state = "closed";
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeServiceFixture(
  runner: AgentRunner = new FakeRunner(),
  environment: NodeJS.ProcessEnv = {},
  orchestrationParts?: OrchestratorParts,
  eventLogOptions?: { append?: typeof appendFile },
  storeFactory: (filePath: string) => JsonStore = (filePath) => new JsonStore(filePath),
  projectRunManagerFactory: (root: string) => ProjectRunManager = (root) =>
    new ProjectRunManager(path.join(root, "project-runs"), [root], new GitClient(5_000)),
) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    WORKSPACE_SOURCE_ROOTS: root,
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    CODEX_RUNTIME_MODE: "exec",
    ...environment,
  });
  const store = storeFactory(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const events = new EventLog(path.join(root, "data", "events"), {
    secrets: [config.arkApiKey],
    ...eventLogOptions,
  });
  const git = new GitClient(5_000);
  const projectRegistry = new ProjectRegistry(
    store,
    new ProjectRepositoryManager(config.workspaceRoot, config.workspaceSourceRoots, git),
    git,
  );
  const service = new AgentService(
    config,
    store,
    workspaces,
    runner,
    events,
    orchestrationParts,
    undefined,
    undefined,
    projectRunManagerFactory(root),
    {},
    projectRegistry,
    git,
  );
  await service.initialize();
  return { config, events, root, service, store, workspaces, projectRegistry };
}

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  orchestrationParts?: OrchestratorParts,
): Promise<AgentService> {
  return (await makeServiceFixture(runner, {}, orchestrationParts)).service;
}

async function projectChat(
  service: AgentService,
  name: string,
  input: { role?: "leader" | "standalone" } = {},
) {
  const project = await service.createManagedProject({ displayName: name });
  const chat = await service.createProjectChat(project.id, { name, ...input });
  return { project, chat };
}

async function eventLogFile(root: string, runId: string): Promise<string> {
  const eventRoot = path.join(root, "data", "events");
  const entries = await readdir(eventRoot, { withFileTypes: true });
  const match = entries.find(
    (entry) => entry.isDirectory() && entry.name.endsWith("_" + runId),
  );
  if (!match) throw new Error("Missing event log for " + runId);
  // A standalone run is its own single-agent session: {ts}_{runId}/agent/trajectory.jsonl.
  return path.join(eventRoot, match.name, "agent", "trajectory.jsonl");
}

async function branchExists(git: GitClient, repository: string, branch: string): Promise<boolean> {
  try {
    await git.run(repository, ["show-ref", "--verify", "--quiet", "refs/heads/" + branch]);
    return true;
  } catch {
    return false;
  }
}

async function prepareRestartProject(root: string, runId: string) {
  const git = new GitClient(5_000);
  const manager = new ProjectRunManager(path.join(root, "project-runs"), [root], git);
  const project = await manager.prepare(runId, {
    mode: "new_project",
    projectName: "restart-recovery",
  });
  await manager.acknowledgePrepared(runId, project);
  return { git, project };
}

async function persistInterruptedProjectRun(
  store: JsonStore,
  agentId: string,
  runId: string,
  project: NonNullable<Database["runs"][number]["project"]>,
): Promise<void> {
  await store.mutate((database) => {
    const storedAgent = database.agents.find((item) => item.id === agentId)!;
    storedAgent.status = "busy";
    database.runs.push({
      id: runId,
      agentId,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      workspaceSource: { mode: "new_project", projectName: "restart-recovery" },
      project,
      status: "running",
      prompt: "interrupted project work",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-28T00:00:00.000Z",
    });
  });
}

describe("Agent lifecycle", () => {
  it("recovers interrupted project attempts once without resuming execution", async () => {
    const runnerRequests: RunnerRequest[] = [];
    const { config, root, service, store } = await makeServiceFixture();
    const agent = await service.createAgent({ name: "Restart recovery", role: "leader" });
    const git = new GitClient(5_000);
    const projectManager = new ProjectRunManager(path.join(root, "project-runs"), [root], git);
    const runId = "restart-project-run";
    const project = await projectManager.prepare(runId, {
      mode: "new_project",
      projectName: "restart-recovery",
    });
    await projectManager.acknowledgePrepared(runId, project);
    const attempts = new AttemptWorkspaceManager(git);
    const clean = await attempts.create({
      runId,
      project,
      attemptId: "clean",
      subtaskId: "clean-task",
      baseCommit: project.headCommit!,
    });
    project.attempts.push(clean);
    const changed = await attempts.create({
      runId,
      project,
      attemptId: "changed",
      subtaskId: "changed-task",
      baseCommit: project.headCommit!,
    });
    await writeFile(path.join(changed.workspacePath, "unfinished.txt"), "keep\n", "utf8");
    project.attempts.push(changed);
    const committed = await attempts.create({
      runId,
      project,
      attemptId: "committed",
      subtaskId: "committed-task",
      baseCommit: project.headCommit!,
    });
    await writeFile(path.join(committed.workspacePath, "candidate.txt"), "candidate\n", "utf8");
    await git.run(committed.workspacePath, ["add", "--", "candidate.txt"]);
    await git.run(committed.workspacePath, ["commit", "-m", "candidate"]);
    const committedHead = await git.head(committed.workspacePath);
    project.attempts.push({
      ...committed,
      state: "contribution_ready",
      headCommit: committedHead,
    });
    project.integrations.push({
      contributionId: "interrupted-contribution",
      subtaskId: "committed-task",
      canonicalHeadBefore: project.headCommit!,
      canonicalHeadAfter: null,
      state: "integrating",
      structuralDecision: "failed",
      reason: null,
    });
    await store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agent.id)!;
      storedAgent.status = "busy";
      database.runs.push({
        id: runId,
        agentId: agent.id,
        kind: "orchestration",
        parentRunId: null,
        orchestration: null,
        workspaceSource: { mode: "new_project", projectName: "restart-recovery" },
        project,
        status: "running",
        prompt: "interrupted project work",
        output: null,
        error: null,
        usage: null,
        startedAt: "2026-08-28T00:00:00.000Z",
        completedAt: null,
        createdAt: "2026-08-28T00:00:00.000Z",
      });
    });

    const forbiddenCalls: string[] = [];
    const forbidden = (label: string) => async () => {
      forbiddenCalls.push(label);
      throw new Error(label + " must not run during restart recovery");
    };
    const restartParts: OrchestratorParts = {
      planner: { plan: forbidden("planner") } as unknown as OrchestratorParts["planner"],
      evaluator: { evaluate: forbidden("evaluator") } as unknown as OrchestratorParts["evaluator"],
      replanner: { replan: forbidden("replanner") } as unknown as OrchestratorParts["replanner"],
      synthesizer: { synthesize: forbidden("synthesizer") } as unknown as OrchestratorParts["synthesizer"],
      attemptWorkspaces: new AttemptWorkspaceManager(new GitClient(5_000)),
      contributionIntegrator: {
        integrate: forbidden("integrator"),
        restore: forbidden("integrator.restore"),
      } as unknown as OrchestratorParts["contributionIntegrator"],
    };
    const modelProxyCalls: string[] = [];
    const forbiddenModelProxy = {
      issue: () => {
        modelProxyCalls.push("issue");
        throw new Error("model proxy must not issue during restart recovery");
      },
      revoke: () => {
        modelProxyCalls.push("revoke");
      },
    };
    const cherryPick = vi.spyOn(GitClient.prototype, "cherryPick");
    const resetHard = vi.spyOn(GitClient.prototype, "resetHard");
    const importExactCommit = vi.spyOn(GitClient.prototype, "importExactCommit");
    const restartStore = new JsonStore(path.join(root, "data", "db.json"));
    const evolutionInitializationStatuses: string[] = [];
    const reconciledStatuses: string[] = [];
    const restarted = new AgentService(
      config,
      restartStore,
      new WorkspaceManager(path.join(root, "workspaces")),
      {
        run: async (request) => {
          runnerRequests.push(request);
          throw new Error("restart must not run workers");
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      new EventLog(path.join(root, "data", "events"), { secrets: [config.arkApiKey] }),
      restartParts,
      forbiddenModelProxy,
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      { initialize: async () => {
        evolutionInitializationStatuses.push(
          restartStore.snapshot().runs.find((run) => run.id === runId)!.status,
        );
      }, reconcile: async () => {
        reconciledStatuses.push(restartStore.snapshot().runs.find((run) => run.id === runId)!.status);
        throw Object.assign(new Error("malformed evolution history"), { code: "evolution_history_unavailable" });
      } },
    );
    await restarted.initialize();

    const recovered = restarted.getRun(runId);
    expect(recovered.status).toBe("cancelled");
    expect(runnerRequests).toHaveLength(0);
    expect(forbiddenCalls).toEqual([]);
    expect(modelProxyCalls).toEqual([]);
    expect(cherryPick).not.toHaveBeenCalled();
    expect(resetHard).not.toHaveBeenCalled();
    expect(importExactCommit).not.toHaveBeenCalled();
    expect(evolutionInitializationStatuses).toEqual(["running"]);
    expect(reconciledStatuses).toEqual(["cancelled"]);
    expect((await restarted.getRunEvents(runId, 0)).events.at(-1)?.error?.code)
      .toBe("server_restarted");
    expect(recovered.project?.attempts).toEqual([
      expect.objectContaining({ attemptId: "clean", state: "cancelled", cleanup: "removed" }),
      expect.objectContaining({ attemptId: "changed", state: "cancelled", cleanup: "preserved", reason: "changed" }),
      expect.objectContaining({ attemptId: "committed", state: "cancelled", cleanup: "preserved", reason: "committed" }),
    ]);
    expect(recovered.project?.integrations.at(-1)).toMatchObject({
      state: "rolled_back",
      canonicalHeadAfter: null,
      reason: "server_restarted",
    });
    expect(recovered.project?.state).toBe("cancelled");
    expect(await git.head(project.canonicalWorkspacePath)).toBe(project.headCommit);
    await expect(readFile(path.join(changed.workspacePath, "unfinished.txt"), "utf8"))
      .resolves.toBe("keep\n");
    await expect(readFile(path.join(committed.workspacePath, "candidate.txt"), "utf8"))
      .resolves.toBe("candidate\n");

    const firstProjectState = structuredClone(recovered.project);
    const restartedAgain = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
      new EventLog(path.join(root, "data", "events"), { secrets: [config.arkApiKey] }),
      { ...singleWorkerParts(), attemptWorkspaces: new AttemptWorkspaceManager(new GitClient(5_000)) },
    );
    await restartedAgain.initialize();
    expect(restartedAgain.getRun(runId).project).toEqual(firstProjectState);
  }, 30_000);

  it("preserves an interrupted integration when the canonical head advanced", async () => {
    const { config, root, service, store } = await makeServiceFixture();
    const agent = await service.createAgent({ name: "Restart mismatch", role: "leader" });
    const runId = "restart-head-mismatch";
    const { git, project } = await prepareRestartProject(root, runId);
    const recordedHead = project.headCommit!;
    project.integrations.push({
      contributionId: "interrupted-contribution",
      subtaskId: "build",
      canonicalHeadBefore: recordedHead,
      canonicalHeadAfter: null,
      state: "integrating",
      structuralDecision: "failed",
      reason: null,
    });
    await writeFile(path.join(project.canonicalWorkspacePath, "unexpected.txt"), "advanced\n", "utf8");
    await git.run(project.canonicalWorkspacePath, ["add", "--", "unexpected.txt"]);
    await git.run(project.canonicalWorkspacePath, ["commit", "-m", "unexpected advance"]);
    const advancedHead = await git.head(project.canonicalWorkspacePath);
    await persistInterruptedProjectRun(store, agent.id, runId, project);

    const restarted = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
      new EventLog(path.join(root, "data", "events"), { secrets: [config.arkApiKey] }),
      { ...singleWorkerParts(), attemptWorkspaces: new AttemptWorkspaceManager(new GitClient(5_000)) },
    );
    await restarted.initialize();

    expect(restarted.getRun(runId).project?.integrations.at(-1)).toMatchObject({
      state: "integrating",
      canonicalHeadBefore: recordedHead,
      canonicalHeadAfter: null,
      reason: "restart_canonical_head_mismatch",
    });
    expect(await git.head(project.canonicalWorkspacePath)).toBe(advancedHead);
  });

  it("does not clean attempts when the restart event cannot be durably closed", async () => {
    const { config, root, service, store } = await makeServiceFixture();
    const agent = await service.createAgent({ name: "Restart event failure", role: "leader" });
    const runId = "restart-event-failure";
    const { git, project } = await prepareRestartProject(root, runId);
    const manager = new AttemptWorkspaceManager(git);
    const clean = await manager.create({
      runId,
      project,
      attemptId: "clean",
      subtaskId: "clean-task",
      baseCommit: project.headCommit!,
    });
    project.attempts.push(clean);
    await persistInterruptedProjectRun(store, agent.id, runId, project);

    const restarted = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
      new EventLog(path.join(root, "data", "events"), {
        secrets: [config.arkApiKey],
        append: async (...args) => {
          if (String(args[1]).includes('"name":"restart_cancelled"')) {
            throw new Error("restart event append denied");
          }
          await appendFile(...args);
        },
      }),
      { ...singleWorkerParts(), attemptWorkspaces: new AttemptWorkspaceManager(new GitClient(5_000)) },
    );
    await expect(restarted.initialize()).rejects.toThrow("restart event append denied");
    await expect(readFile(path.join(clean.workspacePath, "README.md"), "utf8")).resolves.toBeDefined();
    const persisted = new JsonStore(path.join(root, "data", "db.json"));
    await persisted.initialize();
    expect(persisted.snapshot().runs.find((run) => run.id === runId)).toMatchObject({
      status: "running",
      project: { attempts: [expect.objectContaining({ cleanup: "active", state: "running" })] },
    });
  });

  it("does not clean or overwrite a run whose project revision changes after the restart barrier", async () => {
    const { config, root, service, store } = await makeServiceFixture();
    const agent = await service.createAgent({ name: "Restart CAS", role: "leader" });
    const runId = "restart-project-cas";
    const { git, project } = await prepareRestartProject(root, runId);
    const manager = new AttemptWorkspaceManager(git);
    const clean = await manager.create({
      runId,
      project,
      attemptId: "clean",
      subtaskId: "clean-task",
      baseCommit: project.headCommit!,
    });
    project.attempts.push(clean);
    await persistInterruptedProjectRun(store, agent.id, runId, project);
    const restartStore = new JsonStore(path.join(root, "data", "db.json"));

    const restarted = new AgentService(
      config,
      restartStore,
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
      new EventLog(path.join(root, "data", "events"), { secrets: [config.arkApiKey] }),
      { ...singleWorkerParts(), attemptWorkspaces: new AttemptWorkspaceManager(new GitClient(5_000)) },
      undefined,
      undefined,
      undefined,
      {
        afterRestartEventBarrierForTest: async (barrierRunId) => {
          expect(barrierRunId).toBe(runId);
          await restartStore.mutate((database) => {
            const advanced = database.runs.find((run) => run.id === runId)!;
            advanced.prompt = "newer owner work";
            advanced.project = {
              ...advanced.project!,
              attempts: [{
                ...advanced.project!.attempts[0]!,
                revision: 2,
                ownerToken: "00000000-0000-4000-8000-000000000002",
                reason: "newer owner",
              }],
            };
          });
        },
      },
    );
    await restarted.initialize();

    expect(restarted.getRun(runId)).toMatchObject({
      status: "running",
      prompt: "newer owner work",
      project: {
        state: "ready",
        attempts: [expect.objectContaining({
          revision: 2,
          ownerToken: "00000000-0000-4000-8000-000000000002",
          state: "running",
          cleanup: "active",
          reason: "newer owner",
        })],
      },
    });
    expect(restarted.getAgent(agent.id).status).toBe("busy");
    await expect(readFile(path.join(clean.workspacePath, "README.md"), "utf8")).resolves.toBeDefined();
  });

  it("repeats safe cleanup after restart recovery persistence is denied", async () => {
    const { config, root, service, store } = await makeServiceFixture();
    const agent = await service.createAgent({ name: "Restart store failure", role: "leader" });
    const runId = "restart-store-failure";
    const { git, project } = await prepareRestartProject(root, runId);
    const manager = new AttemptWorkspaceManager(git);
    const clean = await manager.create({
      runId,
      project,
      attemptId: "clean",
      subtaskId: "clean-task",
      baseCommit: project.headCommit!,
    });
    project.attempts.push(clean);
    await persistInterruptedProjectRun(store, agent.id, runId, project);

    const rejectingStore = new RejectRestartRecoveryStore(path.join(root, "data", "db.json"));
    const rejectedRestart = new AgentService(
      config,
      rejectingStore,
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
      new EventLog(path.join(root, "data", "events"), { secrets: [config.arkApiKey] }),
      { ...singleWorkerParts(), attemptWorkspaces: new AttemptWorkspaceManager(new GitClient(5_000)) },
    );
    await expect(rejectedRestart.initialize()).rejects.toThrow("restart recovery store write denied");
    expect(rejectingStore.recoveryWrites).toBe(2);

    const finalRestart = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
      new EventLog(path.join(root, "data", "events"), { secrets: [config.arkApiKey] }),
      { ...singleWorkerParts(), attemptWorkspaces: new AttemptWorkspaceManager(new GitClient(5_000)) },
    );
    await finalRestart.initialize();
    expect(finalRestart.getRun(runId)).toMatchObject({
      status: "cancelled",
      project: {
        state: "cancelled",
        attempts: [expect.objectContaining({ state: "cancelled", cleanup: "removed" })],
      },
    });
  });
  it("hands off successful prepared ownership without retaining destructive authority", async () => {
    let projectRunManager: ProjectRunManager | undefined;
    const runnerRequests: RunnerRequest[] = [];
    const { service } = await makeServiceFixture(
      {
        run: async (request) => {
          runnerRequests.push(request);
          return { output: "complete", threadId: null, usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      {},
      undefined,
      undefined,
      undefined,
      (root) =>
        (projectRunManager = new ProjectRunManager(
          path.join(root, "project-runs"),
          [root],
          new GitClient(5_000),
        )),
    );
    const agent = await service.createAgent({ name: "Ownership handoff" });

    for (let index = 0; index < 8; index += 1) {
      const { run } = await service.sendMessage(agent.id, "research " + index, {
        mode: "ephemeral_research",
      });
      await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    }

    expect(runnerRequests).toHaveLength(8);
    expect(projectRunManager?.preparedOwnershipSnapshotForTest()).toEqual({
      current: 0,
      peak: 1,
    });
  });

  it("does not prepare or admit execution when initial preflight evidence cannot be persisted", async () => {
    const runnerRequests: RunnerRequest[] = [];
    const calls = { planner: 0, evaluator: 0, replanner: 0, synthesizer: 0 };
    const parts: OrchestratorParts = {
      planner: { plan: async () => { calls.planner += 1; throw new Error("not admitted"); } } as OrchestratorParts["planner"],
      evaluator: { evaluate: async () => { calls.evaluator += 1; throw new Error("not admitted"); } } as OrchestratorParts["evaluator"],
      replanner: { replan: async () => { calls.replanner += 1; throw new Error("not admitted"); } } as OrchestratorParts["replanner"],
      synthesizer: { synthesize: async () => { calls.synthesizer += 1; throw new Error("not admitted"); } } as OrchestratorParts["synthesizer"],
    };
    let rejectingStore: RejectInitialProjectEvidenceStore | undefined;
    let projectRunManager: CountingProjectRunManager | undefined;
    const { service } = await makeServiceFixture(
      {
        run: async (request) => {
          runnerRequests.push(request);
          return { output: "unexpected", threadId: null, usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      {},
      parts,
      undefined,
      (filePath) => (rejectingStore = new RejectInitialProjectEvidenceStore(filePath)),
      (root) =>
        (projectRunManager = new CountingProjectRunManager(
          path.join(root, "project-runs"),
          [root],
          new GitClient(5_000),
        )),
    );
    const leader = await service.createAgent({ name: "Evidence gate", role: "leader" });

    await expect(
      service.sendMessage(leader.id, "coordinate", {
        mode: "new_project",
        projectName: "evidence-gate",
      }),
    ).rejects.toThrow("initial project evidence store failure");

    expect(rejectingStore?.evidenceWrites).toBe(1);
    expect(projectRunManager?.prepareCalls).toBe(0);
    expect(calls).toEqual({ planner: 0, evaluator: 0, replanner: 0, synthesizer: 0 });
    expect(runnerRequests).toHaveLength(0);
    expect(service.getRuns(leader.id)).toEqual([]);
  });

  it("aborts prepared Git state when ready-project persistence fails and keeps failed evidence reloadable", async () => {
    const fixtureSecret = "fixture-ready-store-secret";
    let rejectingStore: RejectReadyProjectStore | undefined;
    let projectRunManager: CountingProjectRunManager | undefined;
    const runnerRequests: RunnerRequest[] = [];
    const { config, root, service } = await makeServiceFixture(
      {
        run: async (request) => {
          runnerRequests.push(request);
          return { output: "unexpected", threadId: null, usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      {},
      undefined,
      undefined,
      (filePath) => (rejectingStore = new RejectReadyProjectStore(filePath, 1, fixtureSecret)),
      (fixtureRoot) =>
        (projectRunManager = new CountingProjectRunManager(
          path.join(fixtureRoot, "project-runs"),
          [fixtureRoot],
          new GitClient(5_000),
        )),
    );
    const sourceParent = path.join(root, "allowed");
    const sourceRoot = path.join(sourceParent, "repository");
    const git = new GitClient(5_000);
    await mkdir(sourceParent, { recursive: true });
    await git.run(sourceParent, ["init", "-b", "main", "--", sourceRoot]);
    await writeFile(path.join(sourceRoot, "README.md"), "source\n", "utf8");
    await git.run(sourceRoot, ["add", "--", "README.md"]);
    await git.run(sourceRoot, ["commit", "-m", "source"]);
    const sourceHead = await git.head(sourceRoot);
    const project = await service.openProject({
      displayName: "Persistence rollback",
      repositoryPath: sourceRoot,
      revision: "HEAD",
    });
    const agent = await service.createProjectChat(project.id, { name: "Persistence rollback" });
    const source = {
      mode: "existing_repository" as const,
      repositoryPath: project.repositoryPath,
      revision: project.baselineCommit,
    };

    const { run } = await service.sendMessage(agent.id, "edit source");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 5_000 }).toBe("failed");
    expect(rejectingStore?.readyWrites).toBe(1);
    expect(projectRunManager?.abortCalls).toBe(1);
    expect(projectRunManager?.acknowledgeCalls).toBe(0);
    expect(runnerRequests).toHaveLength(0);
    expect(await git.head(sourceRoot)).toBe(sourceHead);
    expect(await git.isClean(sourceRoot)).toBe(true);
    expect(await branchExists(git, sourceRoot, "launchpad/run/" + run.id)).toBe(false);
    expect(await git.run(sourceRoot, ["worktree", "list", "--porcelain"])).not.toContain(run.id);
    await expect(readdir(path.join(root, "project-runs", ".runs"))).resolves.toEqual([]);
    expect(service.getRun(run.id).project).toMatchObject({
      state: "failed",
      source: {
        mode: "existing_repository",
        repositoryPath: project.repositoryPath,
        requestedRevision: project.baselineCommit,
        baseCommit: null,
        sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      runBranch: "launchpad/run/" + run.id,
      headCommit: null,
    });
    const rawEvents = await readFile(await eventLogFile(root, run.id), "utf8");
    expect(rawEvents).not.toContain(sourceRoot);
    expect(rawEvents).not.toContain(fixtureSecret);

    const restarted = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
      new EventLog(path.join(root, "data", "events"), { secrets: [config.arkApiKey] }),
      undefined,
      undefined,
      undefined,
      new ProjectRunManager(path.join(root, "project-runs"), [root], new GitClient(5_000)),
    );
    await restarted.initialize();
    expect(restarted.getRun(run.id).project).toMatchObject({
      state: "failed",
      source: { baseCommit: null },
      headCommit: null,
    });

    await expect(projectRunManager!.prepare(run.id, source)).resolves.toMatchObject({
      runBranch: "launchpad/run/" + run.id,
    });
    await projectRunManager!.abortPrepared(run.id);
  });

  it("preserves sanitized initiating and rollback evidence when owned cleanup cannot complete", async () => {
    const fixtureSecret = "fixture-rollback-secret";
    let rejectingStore: RejectReadyProjectStore | undefined;
    const runnerRequests: RunnerRequest[] = [];
    const { root, service } = await makeServiceFixture(
      {
        run: async (request) => {
          runnerRequests.push(request);
          return { output: "unexpected", threadId: null, usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      {},
      undefined,
      undefined,
      (filePath) =>
        (rejectingStore = new RejectReadyProjectStore(
          filePath,
          1,
          fixtureSecret,
          async (ready) => {
            if (!ready.project) throw new Error("ready project evidence missing");
            const markerPath = path.join(
              path.dirname(ready.project.canonicalWorkspacePath),
              ".launchpad-reservation",
            );
            await writeFile(markerPath, "contradictory-" + fixtureSecret + "\n", "utf8");
          },
        )),
    );
    const agent = await service.createAgent({ name: "Rollback evidence" });

    const { run } = await service.sendMessage(agent.id, "build", {
      mode: "new_project",
      projectName: "rollback-evidence",
    });

    await expect.poll(() => service.getRun(run.id).status, { timeout: 15_000 }).toBe("failed");
    expect(rejectingStore?.readyWrites).toBe(1);
    expect(runnerRequests).toHaveLength(0);
    expect(service.getRun(run.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("workspace_source_cleanup_failed"),
      project: { state: "failed", source: { baseCommit: null }, headCommit: null },
    });
    expect(service.getRun(run.id).error).toContain(
      "originalCode=project_record_persistence_failed",
    );
    expect(service.getRun(run.id).error).toContain(
      "cleanupCode=workspace_source_cleanup_failed",
    );
    const rawEvents = await readFile(await eventLogFile(root, run.id), "utf8");
    expect(rawEvents).not.toContain(fixtureSecret);
    expect(rawEvents).not.toContain(path.join(root, "project-runs", ".runs", run.id));
    await expect(readdir(path.join(root, "project-runs", ".runs"))).resolves.toEqual([
      expect.stringMatching(/^\.quarantine-/),
    ]);
  }, 20_000);

  it("does not loop ready-project persistence when the store keeps rejecting it", async () => {
    let rejectingStore: RejectReadyProjectStore | undefined;
    const runnerRequests: RunnerRequest[] = [];
    const { root, service } = await makeServiceFixture(
      {
        run: async (request) => {
          runnerRequests.push(request);
          return { output: "unexpected", threadId: null, usage: null };
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      {},
      undefined,
      undefined,
      (filePath) =>
        (rejectingStore = new RejectReadyProjectStore(
          filePath,
          Number.MAX_SAFE_INTEGER,
          "persistent-ready-secret",
        )),
    );
    const agent = await service.createAgent({ name: "Persistent persistence failure" });

    const { run } = await service.sendMessage(agent.id, "build", {
      mode: "new_project",
      projectName: "persistent-store-failure",
    });

    await expect.poll(() => service.getRun(run.id).status, { timeout: 5_000 }).toBe("failed");
    expect(rejectingStore?.readyWrites).toBe(1);
    expect(runnerRequests).toHaveLength(0);
    expect(service.getRun(run.id).project).toMatchObject({ state: "failed", headCommit: null });
    await expect(readdir(path.join(root, "project-runs", ".runs"))).resolves.toEqual([]);
  });

  it("fails source preflight before planner or runner admission", async () => {
    const calls = { planner: 0, evaluator: 0, replanner: 0, synthesizer: 0 };
    const runnerRequests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        runnerRequests.push(request);
        return { output: "unexpected", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const parts: OrchestratorParts = {
      planner: {
        plan: async () => {
          calls.planner += 1;
          throw new Error("planner must not be admitted");
        },
      } as OrchestratorParts["planner"],
      evaluator: {
        evaluate: async () => {
          calls.evaluator += 1;
          throw new Error("evaluator must not be admitted");
        },
      } as OrchestratorParts["evaluator"],
      replanner: {
        replan: async () => {
          calls.replanner += 1;
          throw new Error("replanner must not be admitted");
        },
      } as OrchestratorParts["replanner"],
      synthesizer: {
        synthesize: async () => {
          calls.synthesizer += 1;
          throw new Error("synthesizer must not be admitted");
        },
      } as OrchestratorParts["synthesizer"],
    };
    const { root, service } = await makeServiceFixture(runner, {}, parts);
    const nonGitDirectory = path.join(root, "not-a-git-repository");
    await mkdir(nonGitDirectory, { recursive: true });

    await expect(
      service.openProject({
        displayName: "Preflight leader",
        repositoryPath: nonGitDirectory,
        revision: "HEAD",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toEqual({ planner: 0, evaluator: 0, replanner: 0, synthesizer: 0 });
    expect(runnerRequests).toHaveLength(0);
  });

  it("persists the prepared project and runs coding work in its canonical workspace", async () => {
    const { service } = await makeServiceFixture(
      {
        run: async () => ({ output: "created project", threadId: null, usage: null }),
        cancel: async () => false,
        isAvailable: async () => true,
      },
      {},
      soloParts("canonical project coding"),
    );
    const { project, chat: agent } = await projectChat(service, "Canonical coder", { role: "standalone" });

    const { run } = await service.sendMessage(agent.id, "build it");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("completed");
    const completed = service.getRun(run.id);
    expect(completed.kind).toBe("orchestration");
    expect(completed.workspaceSource).toEqual({
      mode: "existing_repository",
      repositoryPath: project.repositoryPath,
      revision: project.baselineCommit,
    });
    expect(completed.project).toMatchObject({
      source: { mode: "existing_repository", repositoryPath: project.repositoryPath },
      runBranch: "launchpad/run/" + run.id,
      state: "ready",
    });
    expect(completed.project?.canonicalWorkspacePath).not.toBe(agent.workspacePath);
  });

  it("retries a solo terminal store write without publishing a conflicting terminal event", async () => {
    const { service } = await makeServiceFixture(
      new FakeRunner(),
      {},
      undefined,
      undefined,
      (filePath) => new FailOnceTerminalStore(filePath),
    );
    const agent = await service.createAgent({ name: "Solo terminal retry" });
    const { run } = await service.sendMessage(agent.id, "persist once more", { mode: "ephemeral_research" });

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(
      (await service.getRunEvents(run.id, 0)).events.filter(
        (event) => event.kind === "run" && event.status !== "in_progress",
      ).map((event) => event.name),
    ).toEqual(["completed"]);
  });

  it("retries a leader terminal store write without publishing a conflicting terminal event", async () => {
    const { service } = await makeServiceFixture(
      soloRunner(),
      {},
      soloParts("run solo"),
      undefined,
      (filePath) => new FailOnceTerminalStore(filePath),
    );
    const leader = await service.createAgent({ name: "Leader terminal retry", role: "leader" });
    const { run } = await service.sendMessage(leader.id, "persist once more", { mode: "new_project", projectName: "leader-terminal-retry" });

    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("completed");
    expect(
      (await service.getRunEvents(run.id, 0)).events.filter(
        (event) => event.kind === "run" && event.status !== "in_progress",
      ).map((event) => event.name),
    ).toEqual(["completed"]);
  });

  it("retries a solo failure store write without publishing a conflicting terminal event", async () => {
    const failingRunner: AgentRunner = {
      run: async () => {
        throw new Error("solo runner failed");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service } = await makeServiceFixture(
      failingRunner,
      {},
      undefined,
      undefined,
      (filePath) => new FailOnceTerminalStore(filePath),
    );
    const agent = await service.createAgent({ name: "Solo failure retry" });
    const { run } = await service.sendMessage(agent.id, "fail and persist", { mode: "ephemeral_research" });

    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(
      (await service.getRunEvents(run.id, 0)).events.filter(
        (event) => event.kind === "run" && event.status !== "in_progress",
      ).map((event) => event.status),
    ).toEqual(["error"]);
  });

  it("retries a leader failure store write without publishing a conflicting terminal event", async () => {
    const failingRunner: AgentRunner = {
      run: async () => {
        throw new Error("leader runner failed");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service } = await makeServiceFixture(
      failingRunner,
      {},
      soloParts("run solo"),
      undefined,
      (filePath) => new FailOnceTerminalStore(filePath),
    );
    const leader = await service.createAgent({ name: "Leader failure retry", role: "leader" });
    const { run } = await service.sendMessage(leader.id, "fail and persist", { mode: "new_project", projectName: "leader-terminal-failure" });

    await expect.poll(() => service.getRun(run.id).status, { timeout: 5_000 }).toBe("failed");
    expect(
      (await service.getRunEvents(run.id, 0)).events.filter(
        (event) => event.kind === "run" && event.status !== "in_progress",
      ).map((event) => event.status),
    ).toEqual(["error"]);
  });

  it("records server_restarted before cancelling a running run with a stale terminal log", async () => {
    const { config, events, root, service, store } = await makeServiceFixture();
    const agent = await service.createAgent({ name: "Restarted after terminal" });
    const runId = "run-restart-after-terminal";
    await store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agent.id);
      if (storedAgent) storedAgent.status = "busy";
      database.runs.push({
        id: runId,
        agentId: agent.id,
        status: "running",
        prompt: "interrupted after terminal log",
        output: null,
        error: null,
        usage: null,
        startedAt: "2026-08-26T00:00:00.000Z",
        completedAt: null,
        createdAt: "2026-08-26T00:00:00.000Z",
      });
    });
    events.createSink(runId, agent.id).emit({
      spanId: "run",
      parentSpanId: null,
      kind: "run",
      name: "completed",
      status: "ok",
      startedAt: "2026-08-26T00:00:00.000Z",
      endedAt: "2026-08-26T00:00:01.000Z",
      durationMs: 1000,
      input: {},
      output: {},
      error: null,
      attributes: {},
      usage: null,
    });
    await events.close(runId);

    const restarted = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
      new EventLog(path.join(root, "data", "events"), { secrets: [config.arkApiKey] }),
    );
    await restarted.initialize();

    expect(restarted.getRun(runId).status).toBe("cancelled");
    expect((await restarted.getRunEvents(runId, 0)).events.at(-1)?.error?.code).toBe(
      "server_restarted",
    );
  });

  it("fails closed on a terminal-intent and closed-event mismatch without guessing", async () => {
    const { config, events, root, service, store, workspaces } = await makeServiceFixture();
    const agent = await service.createAgent({ name: "Intent mismatch" });
    const runId = "run-terminal-intent-mismatch";
    await store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agent.id);
      if (storedAgent) storedAgent.status = "busy";
      database.runs.push({
        id: runId, agentId: agent.id, kind: "subtask", parentRunId: null,
        orchestration: null, status: "running", prompt: "work", output: null,
        error: null, usage: null, startedAt: "2026-08-28T00:00:00.000Z", completedAt: null,
        createdAt: "2026-08-28T00:00:00.000Z",
        terminalPublicationIntent: {
          revision: 1, intendedRunStatus: "completed", intendedAgentStatus: "ready",
          output: "intended", usage: null, threadId: null, completedAt: "2026-08-28T00:00:01.000Z",
          eventKind: "run", eventName: "completed", eventStatus: "ok",
          eventHash: "0".repeat(64),
        },
      });
    });
    events.createSink(runId, agent.id).emit({
      spanId: "run", parentSpanId: null, kind: "run", name: "different_terminal",
      status: "ok", startedAt: "2026-08-28T00:00:00.000Z", endedAt: "2026-08-28T00:00:01.000Z", durationMs: 1_000,
      input: {}, output: {}, error: null, attributes: {}, usage: null,
    });
    await events.close(runId);

    const restarted = new AgentService(
      config, new JsonStore(path.join(root, "data", "db.json")), workspaces,
      new FakeRunner(), events,
    );
    await restarted.initialize();
    expect(restarted.getRun(runId)).toMatchObject({
      status: "cancelled", error: "terminal_publication_intent_mismatch",
    });
    expect((await restarted.getRunEvents(runId, 0)).events.at(-1)?.error?.code)
      .toBe("terminal_publication_intent_mismatch");
  });

  it("does not project a terminal intent when its matching event append fails", async () => {
    const appendFailure = new Error("terminal event append failed");
    const terminalEvent = {
      spanId: "run", parentSpanId: null, kind: "run" as const, name: "contribution_ready",
      status: "ok" as const, startedAt: "2026-08-28T00:00:00.000Z",
      endedAt: "2026-08-28T00:00:01.000Z", durationMs: 1_000,
      input: {}, output: {}, error: null, attributes: {}, usage: null,
    };
    const { events, service, store } = await makeServiceFixture(
      new FakeRunner(),
      {},
      undefined,
      {
        append: async (...args) => {
          if (
            (String(args[0]).endsWith("events.jsonl") ||
              String(args[0]).endsWith("trajectory.jsonl")) &&
            String(args[1]).includes('"name":"contribution_ready"')
          ) throw appendFailure;
          await appendFile(...args);
        },
      },
    );
    const agent = await service.createAgent({ name: "Failed terminal append" });
    const runId = "run-failed-terminal-append";
    await store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agent.id);
      if (storedAgent) storedAgent.status = "busy";
      database.runs.push({
        id: runId, agentId: agent.id, kind: "subtask", parentRunId: null,
        orchestration: null, status: "running", prompt: "work", output: null,
        error: null, usage: null, startedAt: terminalEvent.startedAt, completedAt: null,
        createdAt: terminalEvent.startedAt,
        terminalPublicationIntent: {
          revision: 1, intendedRunStatus: "completed", intendedAgentStatus: "ready",
          output: "candidate", usage: null, threadId: null,
          completedAt: terminalEvent.endedAt, eventKind: terminalEvent.kind,
          eventName: terminalEvent.name, eventStatus: terminalEvent.status,
          eventHash: terminalEventHash(terminalEvent),
        },
      });
    });

    events.createSink(runId, agent.id).emit(terminalEvent);

    await expect(events.close(runId)).rejects.toBe(appendFailure);
    expect(service.getRun(runId).status).toBe("running");
  });

  it("keeps a run running until its terminal event has been appended and the log closes", async () => {
    let release!: () => void;
    let appendStarted = false;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service } = await makeServiceFixture(
      new FakeRunner(),
      {},
      undefined,
      {
        append: async (...args) => {
          await appendFile(...args);
          if (!appendStarted) {
            appendStarted = true;
            await blocked;
          }
        },
      },
    );
    const agent = await service.createAgent({ name: "Delayed terminal" });
    const { run } = await service.sendMessage(agent.id, "wait for the log", { mode: "ephemeral_research" });

    await expect.poll(() => appendStarted).toBe(true);
    await expect.poll(() => service.getRun(run.id).status).toBe("running");

    release();
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect((await service.getRunEvents(run.id, 0)).events.at(-1)?.name).toBe("completed");
  });

  it("allows immediate fixture removal after 50 terminal runs", async () => {
    for (let index = 0; index < 50; index += 1) {
      const { root, service } = await makeServiceFixture();
      const agent = await service.createAgent({ name: "Cleanup " + index });
      const { run } = await service.sendMessage(agent.id, "run " + index, { mode: "ephemeral_research" });
      await expect.poll(() => service.getRun(run.id).status, { timeout: 5_000 }).toBe("completed");

      await expect(rm(root, { recursive: true })).resolves.toBeUndefined();
      temporaryDirectories.splice(temporaryDirectories.indexOf(root), 1);
    }
  }, 30_000);

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("rejects duplicate Agent names", async () => {
    const service = await makeService();
    const first = await service.createAgent({ name: "Builder" });
    await expect(service.createAgent({ name: " builder " })).rejects.toMatchObject({
      statusCode: 409,
    });
    const second = await service.createAgent({ name: "Reviewer" });
    await expect(service.updateAgent(second.id, { name: first.name })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("renames idle and busy chats without changing their state or workspace bytes", async () => {
    const { service, store } = await makeServiceFixture();
    const project = await service.createManagedProject({ displayName: "Rename state" });
    const idle = await service.createProjectChat(project.id, {
      name: "Idle rename",
      description: "Preserve this description",
      instructions: "Preserve these instructions",
      role: "standalone",
    });
    await store.mutate((database) => {
      database.agents.find((agent) => agent.id === idle.id)!.lastError = "preserve this error";
    });
    const idleBefore = service.getAgent(idle.id);
    const idleMessagesBefore = service.getMessages(idle.id);
    const idleRunsBefore = store.snapshot().runs.filter((run) => run.agentId === idle.id);
    const idleInstructionsBefore = await readFile(path.join(idle.workspacePath, "AGENTS.md"));

    const idleRenamed = await service.updateAgent(idle.id, { name: "  Idle renamed  " });

    expect(idleRenamed).toMatchObject({ id: idle.id, name: "Idle renamed", status: "ready" });
    expect({ ...idleRenamed, name: idleBefore.name, updatedAt: idleBefore.updatedAt }).toEqual(idleBefore);
    expect(service.getMessages(idle.id)).toEqual(idleMessagesBefore);
    expect(store.snapshot().runs.filter((run) => run.agentId === idle.id)).toEqual(idleRunsBefore);
    expect(await readFile(path.join(idle.workspacePath, "AGENTS.md"))).toEqual(idleInstructionsBefore);

    const runtime = new FakeLiveRuntime();
    const { service: busyService, store: busyStore } = await makeServiceFixture(
      new FakeRunner(),
      {},
      { runtimeFactory: () => runtime } as OrchestratorParts,
    );
    const busyProject = await busyService.createManagedProject({ displayName: "Busy rename state" });
    const busy = await busyService.createProjectChat(busyProject.id, {
      name: "Busy rename",
      description: "Keep busy description",
      instructions: "Keep busy instructions",
      role: "standalone",
    });
    const busyRun = await busyService.sendMessage(busy.id, "keep working");
    await expect.poll(() => busyService.getRun(busyRun.run.id).status).toBe("running");
    await busyStore.mutate((database) => {
      database.agents.find((agent) => agent.id === busy.id)!.lastError = "preserve busy error";
    });
    const busyBefore = busyService.getAgent(busy.id);
    const busyMessagesBefore = busyService.getMessages(busy.id);
    const busyRunsBefore = busyStore.snapshot().runs.filter((run) => run.agentId === busy.id);
    const busyInstructionsBefore = await readFile(path.join(busy.workspacePath, "AGENTS.md"));

    const busyRenamed = await busyService.updateAgent(busy.id, { name: "Busy renamed" });

    expect(busyRenamed).toMatchObject({ id: busy.id, name: "Busy renamed", status: "busy" });
    expect({ ...busyRenamed, name: busyBefore.name, updatedAt: busyBefore.updatedAt }).toEqual(busyBefore);
    expect(busyService.getMessages(busy.id)).toEqual(busyMessagesBefore);
    expect(busyStore.snapshot().runs.filter((run) => run.agentId === busy.id)).toEqual(busyRunsBefore);
    expect(await readFile(path.join(busy.workspacePath, "AGENTS.md"))).toEqual(busyInstructionsBefore);

    await busyService.stopAgent(busy.id);
    expect(busyService.getAgent(busy.id).status).toBe("stopped");
  });

  it("rewrites workspace instructions for non-name Agent updates", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Instruction writer" });
    const instructionsPath = path.join(agent.workspacePath, "AGENTS.md");
    const before = await readFile(instructionsPath, "utf8");

    await service.updateAgent(agent.id, { description: "Updated purpose" });

    const after = await readFile(instructionsPath, "utf8");
    expect(after).not.toBe(before);
    expect(after).toContain("Purpose: Updated purpose");
  });

  it("validates chat rename names and leaves conflicts unchanged", async () => {
    const { service, store } = await makeServiceFixture();
    const project = await service.createManagedProject({ displayName: "Rename validation" });
    const first = await service.createProjectChat(project.id, { name: "Existing chat" });
    const second = await service.createProjectChat(project.id, {
      name: "Other chat",
      description: "Do not mutate on conflict",
    });
    const before = service.getAgent(second.id);
    const runsBefore = store.snapshot().runs.filter((run) => run.agentId === second.id);
    const messagesBefore = service.getMessages(second.id);

    await expect(service.updateAgent(second.id, { name: " existing CHAT " })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(service.getAgent(second.id)).toEqual(before);
    expect(store.snapshot().runs.filter((run) => run.agentId === second.id)).toEqual(runsBefore);
    expect(service.getMessages(second.id)).toEqual(messagesBefore);
    await expect(service.updateAgent(first.id, { name: "EXISTING CHAT" })).resolves.toMatchObject({
      name: "EXISTING CHAT",
    });
    await expect(service.updateAgent(second.id, { name: "bad\r\nname" })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(service.updateAgent(second.id, { name: "x".repeat(81) })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("explains that a duplicate chat name in another project conflicts globally", async () => {
    const service = await makeService();
    const firstProject = await service.createManagedProject({ displayName: "First project" });
    const secondProject = await service.createManagedProject({ displayName: "Second project" });
    await service.createProjectChat(firstProject.id, { name: "bug-3" });

    await expect(
      service.createProjectChat(secondProject.id, { name: " BUG-3 " }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/"BUG-3".*globally.*across every project/i),
    });
  });

  it("keeps names unique when temporary and project chats are created concurrently", async () => {
    const { service, workspaces } = await makeServiceFixture();
    const project = await service.createManagedProject({ displayName: "Concurrent names" });
    const createWorkspace = workspaces.create.bind(workspaces);
    let releaseTemporary!: () => void;
    let markTemporaryStarted!: () => void;
    const temporaryStarted = new Promise<void>((resolve) => {
      markTemporaryStarted = resolve;
    });
    const temporaryCanContinue = new Promise<void>((resolve) => {
      releaseTemporary = resolve;
    });
    vi.spyOn(workspaces, "create").mockImplementation(async (agent) => {
      if (agent.projectId === null) {
        markTemporaryStarted();
        await temporaryCanContinue;
      }
      await createWorkspace(agent);
    });

    const temporary = service.createAgent({ name: "bug-3" });
    await temporaryStarted;
    await service.createProjectChat(project.id, { name: "BUG-3" });
    releaseTemporary();

    await expect(temporary).rejects.toMatchObject({ statusCode: 409 });
    expect(
      service.listAgents().filter((agent) => agent.name.trim().toLowerCase() === "bug-3"),
    ).toHaveLength(1);
  });

  it("labels coordination members with worker agent names for old journals", async () => {
    const { config, service, store } = await makeServiceFixture();
    const leader = await service.createAgent({ name: "Lead", role: "leader" });
    const worker = await service.createAgent({
      name: "HarnessPragmatist",
      role: "worker",
      parentAgentId: leader.id,
    });
    const leaderRunId = "11111111-1111-4111-8111-111111111111";
    const workerRunId = "22222222-2222-4222-8222-222222222222";
    await store.mutate((database) => {
      database.runs.push({
        id: leaderRunId,
        agentId: leader.id,
        kind: "orchestration",
        parentRunId: null,
        orchestration: null,
        status: "running",
        prompt: "lead",
        output: null,
        error: null,
        usage: null,
        startedAt: null,
        completedAt: null,
        createdAt: "2026-08-27T00:00:00.000Z",
      });
      database.runs.push({
        id: workerRunId,
        agentId: worker.id,
        kind: "subtask",
        parentRunId: leaderRunId,
        orchestration: null,
        status: "running",
        prompt: "worker",
        output: null,
        error: null,
        usage: null,
        startedAt: null,
        completedAt: null,
        createdAt: "2026-08-27T00:00:01.000Z",
      });
    });
    const journal = await TeamJournal.open(config.dataDirectory, leaderRunId);
    await journal.append({
      type: "team.member.registered",
      workerRunId,
      subtaskId: "step2",
      displayName: "it1/step2",
    });

    expect((await service.getCoordination(leaderRunId)).members).toContainEqual({
      workerRunId,
      displayName: "HarnessPragmatist",
      runtimeState: "not_started",
    });
  });

  it("persists a playground conversation", async () => {
    let runnerWorkspacePath: string | undefined;
    const service = await makeService({
      run: async (request) => {
        runnerWorkspacePath = request.workspacePath;
        return {
          output: "Completed: " + request.prompt,
          threadId: request.threadId ?? "fake-thread",
          usage: { inputTokens: 12, outputTokens: 5 },
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world", { mode: "ephemeral_research" });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
    expect(runnerWorkspacePath).toBe(agent.workspacePath);
    expect(service.getRun(run.id).project).toMatchObject({
      source: { mode: "ephemeral_research" },
      runBranch: null,
    });
  });

  it("steers a busy live Codex run instead of rejecting the message", async () => {
    const runtime = new FakeLiveRuntime();
    const service = await makeService(new FakeRunner(), {
      runtimeFactory: () => runtime,
    } as OrchestratorParts);
    const agent = await service.createAgent({ name: "Steerable" });

    const first = await service.sendMessage(agent.id, "start doing work", {
      mode: "ephemeral_research",
    });
    await expect.poll(() => service.getRun(first.run.id).status).toBe("running");

    const second = await service.sendMessage(agent.id, "actually focus on the CLI bug", {
      mode: "ephemeral_research",
    });
    expect(second.run.id).toBe(first.run.id);
    expect(runtime.wakes.map((message) => message.content)).toEqual([
      "actually focus on the CLI bug",
    ]);
    expect(service.getMessages(agent.id).map((message) => message.content)).toEqual([
      "start doing work",
      "actually focus on the CLI bug",
    ]);

    runtime.complete();
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
  });

  it("waits through the runtime attachment race when steering immediately", async () => {
    const runtime = new FakeLiveRuntime();
    const service = await makeService(new FakeRunner(), {
      runtimeFactory: () => runtime,
    } as OrchestratorParts);
    const agent = await service.createAgent({ name: "Fast Steerable" });

    const first = await service.sendMessage(agent.id, "start", { mode: "ephemeral_research" });
    const second = await service.sendMessage(agent.id, "steer before runtime attaches", {
      mode: "ephemeral_research",
    });

    expect(second.run.id).toBe(first.run.id);
    expect(runtime.wakes.map((message) => message.content)).toEqual([
      "steer before runtime attaches",
    ]);

    runtime.complete();
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
  });

  it("orders Agents by the latest user message, not assistant completion", async () => {
    const pending = new Map<string, (result: RunnerResult) => void>();
    const service = await makeService({
      run: (request) =>
        new Promise<RunnerResult>((resolve) => {
          pending.set(request.prompt, resolve);
        }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const older = await service.createAgent({ name: "Older run" });
    const newer = await service.createAgent({ name: "Newer user message" });

    const first = await service.sendMessage(older.id, "first", { mode: "ephemeral_research" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await service.sendMessage(newer.id, "second", { mode: "ephemeral_research" });
    expect(service.listAgents().map((agent) => agent.id).slice(0, 2)).toEqual([
      newer.id,
      older.id,
    ]);

    await expect.poll(() => pending.has("second")).toBe(true);
    pending.get("second")?.({ output: "done second", threadId: "thread-second", usage: null });
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    await expect.poll(() => pending.has("first")).toBe(true);
    pending.get("first")?.({ output: "done first", threadId: "thread-first", usage: null });
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");

    expect(service.listAgents().map((agent) => agent.id).slice(0, 2)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it("keeps a chat in place when it is stopped, because stopping is not sending", async () => {
    const service = await makeService();
    const older = await service.createAgent({ name: "Stopped later" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await service.createAgent({ name: "Most recent" });

    expect(service.listAgents().map((agent) => agent.id).slice(0, 2)).toEqual([
      newer.id,
      older.id,
    ]);

    // Pressing stop touches the older chat's record. Ordering must follow what
    // the operator started, not every write to the row.
    await service.stopAgent(older.id);

    expect(service.listAgents().map((agent) => agent.id).slice(0, 2)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it("lists the newest project first", async () => {
    const service = await makeService();
    const first = await service.createManagedProject({ displayName: "First" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await service.createManagedProject({ displayName: "Second" });

    expect(service.listProjects().map((project) => project.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("renames a project through the service and maps registry errors to HTTP status", async () => {
    const service = await makeService();
    const project = await service.createManagedProject({ displayName: "Before" });

    await expect(service.renameProject({ projectId: project.id, displayName: "  After  " })).resolves
      .toMatchObject({ id: project.id, displayName: "After" });
    await expect(service.renameProject({
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      displayName: "Missing",
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.renameProject({ projectId: project.id, displayName: "\n" })).rejects
      .toMatchObject({ statusCode: 400 });
  });

  it("records run events bracketed by lifecycle events", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Traced" });
    const { run } = await service.sendMessage(agent.id, "do something", { mode: "ephemeral_research" });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const result = await service.getRunEvents(run.id, 0);
    expect(result.complete).toBe(true);
    const kinds = result.events.map((event) => event.kind);
    expect(kinds[0]).toBe("run");
    expect(kinds.at(-1)).toBe("run");
    expect(kinds).toContain("command");
    expect(result.events.every((event) => event.runId === run.id)).toBe(true);
    expect(result.events.every((event) => event.agentId === agent.id)).toBe(true);
    expect(result.lastSeq).toBe(result.events.length);
  });

  it("stamps the run start with the instructions hash actually used", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Versioned" });

    const first = await service.sendMessage(agent.id, "one", { mode: "ephemeral_research" });
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const before = await service.getRunEvents(first.run.id, 0);

    await service.updateAgent(agent.id, { instructions: "Always run tests." });

    const second = await service.sendMessage(agent.id, "two", { mode: "ephemeral_research" });
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    const after = await service.getRunEvents(second.run.id, 0);

    const hashOf = (events: { attributes: Record<string, unknown> }[]) =>
      events[0]?.attributes.instructionsHash;
    expect(hashOf(before.events)).toBeTypeOf("string");
    expect(hashOf(after.events)).not.toBe(hashOf(before.events));
  });

  it("records a terminal event when a run fails", async () => {
    const service = await makeService({
      run: async () => {
        throw new Error("Codex timed out after 1000 ms");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Doomed" });
    const { run } = await service.sendMessage(agent.id, "boom", { mode: "ephemeral_research" });
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");

    const result = await service.getRunEvents(run.id, 0);
    const last = result.events.at(-1);
    expect(last?.kind).toBe("run");
    expect(last?.status).toBe("error");
    expect(last?.error?.code).toBe("timeout");
  });

  it("never persists lifecycle prompts or runner failures containing the Ark key", async () => {
    const secret = "s3k";
    const { root, service } = await makeServiceFixture(
      {
        run: async () => {
          throw new Error("runner exposed " + secret);
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      { ARK_API_KEY: secret },
    );
    const agent = await service.createAgent({ name: "Sanitised" });
    const { run } = await service.sendMessage(
      agent.id,
      "prompt accidentally contains " + secret,
      { mode: "ephemeral_research" },
    );
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    await service.getRunEvents(run.id, 0);

    const raw = await readFile(await eventLogFile(root, run.id), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("***");
  });

  it("recovers an interrupted run with gap-free persisted history", async () => {
    const { config, events, root, service, store } = await makeServiceFixture();
    const agent = await service.createAgent({ name: "Interrupted" });
    const runId = "run-interrupted";
    await store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agent.id);
      if (storedAgent) storedAgent.status = "busy";
      database.runs.push({
        id: runId,
        agentId: agent.id,
        status: "running",
        prompt: "unfinished",
        output: null,
        error: null,
        usage: null,
        startedAt: "2026-08-26T00:00:00.000Z",
        completedAt: null,
        createdAt: "2026-08-26T00:00:00.000Z",
      });
    });
    const firstSink = events.createSink(runId, agent.id);
    firstSink.emit({
      spanId: "before-restart",
      parentSpanId: "run",
      kind: "command",
      name: "bash",
      status: "ok",
      startedAt: "2026-08-26T00:00:00.000Z",
      endedAt: "2026-08-26T00:00:01.000Z",
      durationMs: 1000,
      input: { command: "echo before" },
      output: { text: "before", exitCode: 0 },
      error: null,
      attributes: {},
      usage: null,
    });
    await events.flush(runId);

    const restarted = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
      new EventLog(path.join(root, "data", "events"), {
        secrets: [config.arkApiKey],
      }),
    );
    await restarted.initialize();

    const result = await restarted.getRunEvents(runId, 0);
    expect(result.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(result.events.map((event) => event.spanId)).toEqual([
      "before-restart",
      "run",
    ]);
    expect(result.events.at(-1)?.error?.code).toBe("server_restarted");
  });

  it("archives run events when the Agent is deleted", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Deleted" });
    const { run } = await service.sendMessage(agent.id, "do something", { mode: "ephemeral_research" });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    await service.deleteAgent(agent.id);

    await expect(service.getRunEvents(run.id, 0)).rejects.toMatchObject({
      statusCode: 404,
      message: "Run not found",
    });
  });

  it("distinguishes an unknown run from an existing empty terminal run", async () => {
    const { service, store } = await makeServiceFixture();
    const agent = await service.createAgent({ name: "Known" });
    const runId = "known-empty-run";
    await store.mutate((database) => {
      database.runs.push({
        id: runId,
        agentId: agent.id,
        status: "completed",
        prompt: "already done",
        output: "done",
        error: null,
        usage: null,
        startedAt: "2026-08-26T00:00:00.000Z",
        completedAt: "2026-08-26T00:00:01.000Z",
        createdAt: "2026-08-26T00:00:00.000Z",
      });
    });

    await expect(service.getRunEvents("unknown-run", 0)).rejects.toMatchObject({
      statusCode: 404,
      message: "Run not found",
    });
    await expect(service.getRunEvents(runId, 0)).resolves.toEqual({
      events: [],
      lastSeq: 0,
      complete: true,
    });
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first", { mode: "ephemeral_research" }),
      service.sendMessage(agent.id, "second", { mode: "ephemeral_research" }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first", { mode: "ephemeral_research" });

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second", { mode: "ephemeral_research" })).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("orchestrates leader runs with persisted evaluations and worker attempts", async () => {
    const requests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        requests.push(request);
        const changedPath = "worker-" + request.runId + ".txt";
        await writeFile(path.join(request.workspacePath, changedPath), "worker contribution\n", "utf8");
        const git = new GitClient(5_000);
        await git.run(request.workspacePath, ["add", "--", changedPath]);
        await git.run(request.workspacePath, ["commit", "-m", "worker contribution"]);
        const head = await git.head(request.workspacePath);
        return {
          output: "worker output for " + request.prompt + "\nLAUNCHPAD_COMMIT=" + head,
          threadId: "thread-" + request.prompt,
          usage: { inputTokens: 4, outputTokens: 2 },
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const plan: LeaderPlan = {
      needsSubagents: true,
      rationale: "Two focused checks are useful.",
      subtasks: [
        {
          id: "review-a",
          agentName: "API Reviewer",
          title: "Review A",
          role: "Reviewer",
          prompt: "check a",
          objective: "Check a",
          successCriteria: ["a checked"],
          expectedOutput: "notes",
          dependsOn: [],
        },
        {
          id: "review-b",
          agentName: "UI Reviewer",
          title: "Review B",
          role: "Reviewer",
          prompt: "check b",
          objective: "Check b",
          successCriteria: ["b checked"],
          expectedOutput: "notes",
          dependsOn: [],
        },
      ],
    };
    const parts: OrchestratorParts = {
      planner: {
        plan: async () => ({
          status: "available",
          plan,
          model: "planner-model",
          promptVersion: "planner-v1",
        }),
      } as OrchestratorParts["planner"],
      evaluator: {
        evaluate: async () => ({
          status: "available",
          model: "evaluator-model",
          promptVersion: "evaluator-v1",
          evaluation: {
            sufficient: true,
            subtaskEvaluations: [],
            missingInformation: [],
          },
        }),
      } as OrchestratorParts["evaluator"],
      replanner: {
        replan: async () => {
          throw new Error("should not replan");
        },
      } as OrchestratorParts["replanner"],
      synthesizer: {
        synthesize: async (_task, _plans, evaluations, results) => ({
          output:
            "synthesized " +
            evaluations.length +
            " evaluations and " +
            results.length +
            " results",
          model: "synth-model",
          promptVersion: "synthesizer-v1",
        }),
      } as OrchestratorParts["synthesizer"],
    };
    const { service } = await makeServiceFixture(runner, {}, parts);
    const { chat: leader } = await projectChat(service, "Lead");
    const { run } = await service.sendMessage(leader.id, "coordinate");

    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("completed");

    const completed = service.getRun(run.id);
    expect(completed.kind).toBe("orchestration");
    expect(completed.output).toBe("synthesized 1 evaluations and 2 results");
    expect(completed.orchestration?.iterationPlans).toHaveLength(1);
    expect(completed.orchestration?.evaluationRecords).toHaveLength(1);
    expect(completed.orchestration?.workerResults).toHaveLength(2);
    expect(completed.orchestration?.workerResults.map((result) => result.iteration))
      .toEqual([1, 1]);
    expect(completed.orchestration?.workerResults.map((result) => result.attempt))
      .toEqual([1, 1]);
    expect(completed.orchestration?.workerResults.map((result) => result.error))
      .toEqual([undefined, undefined]);
    expect(completed.orchestration?.workerResults.map((result) => result.status))
      .toEqual(["completed", "completed"]);
    expect(completed.project?.attempts).toHaveLength(2);
    expect(completed.project?.attempts.every((attempt) =>
      attempt.state === "integrated" && attempt.cleanup === "removed"))
      .toBe(true);
    expect(completed.orchestration?.provenance).toMatchObject({
      plannerModel: "planner-model",
      evaluatorModel: "evaluator-model",
      synthesizerModel: "synth-model",
    });
    // One agent per subtask, not one per role slug. A planner labels every peer
    // "worker", so the old per-role key turned a two-subtask plan into a single
    // agent run twice — the delegation was real, the cast was not.
    const workers = service.listAgents().filter((agent) => agent.role === "worker");
    expect(workers).toHaveLength(2);
    expect(workers.map((agent) => agent.name).sort()).toEqual([
      "API Reviewer",
      "UI Reviewer",
    ]);
    expect(new Set(workers.map((agent) => agent.specialty)).size).toBe(2);
    expect(requests.map((request) => request.threadId)).toEqual([null, null]);
    expect(
      requests.every((request) =>
        request.workspacePath.includes(path.join(".runs", run.id, "attempts")),
      ),
    ).toBe(true);
    expect(requests.every((request) => request.commonWorkspacePath)).toBe(true);
    expect(new Set(requests.map((request) => request.commonWorkspacePath)).size).toBe(1);
    expect(requests[0]?.commonWorkspacePath).toContain(path.join("data", "events"));
    expect(requests[0]?.commonWorkspacePath).toContain(run.id);
    expect(requests[0]?.commonWorkspacePath).not.toContain(leader.id);
    expect(requests[0]?.commonWorkspacePath).toContain("common-workspace");
    expect(requests[0]?.prompt).toContain("Leader execution constraints");
    expect(requests[0]?.prompt).toContain("GIT_LFS_SKIP_SMUDGE=1 git clone --depth=1");
  });

  it("keeps a durable child terminal intent authoritative across finalization denial and restart", async () => {
    let rejectingStore: RejectChildFinalizationStore | undefined;
    let releaseTerminalAppend!: () => void;
    let terminalAppendStarted = false;
    const terminalAppendBlocked = new Promise<void>((resolve) => {
      releaseTerminalAppend = resolve;
    });
    const git = new GitClient(5_000);
    const runner: AgentRunner = {
      run: async (request) => {
        for (let index = 0; index < 520; index += 1) {
          request.sink?.emit({
            spanId: "bulk-" + index, parentSpanId: "run", kind: "command", name: "bulk-" + index,
            status: "ok", startedAt: "2026-08-28T00:00:00.000Z", endedAt: "2026-08-28T00:00:00.001Z",
            durationMs: 1, input: {}, output: {}, error: null, attributes: {}, usage: null,
          });
        }
        await writeFile(path.join(request.workspacePath, "candidate.txt"), "candidate\n", "utf8");
        await git.run(request.workspacePath, ["add", "--", "candidate.txt"]);
        await git.run(request.workspacePath, ["commit", "-m", "candidate"]);
        return {
          output: "done\nLAUNCHPAD_COMMIT=" + await git.head(request.workspacePath),
          threadId: "durable-child-thread",
          usage: { inputTokens: 3, outputTokens: 2 },
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { config, events, root, service, store, workspaces } = await makeServiceFixture(
      runner,
      {},
      singleWorkerParts(),
      {
        append: async (...args) => {
          await appendFile(...args);
          if (String(args[1]).includes('"name":"contribution_ready"')) {
            terminalAppendStarted = true;
            await terminalAppendBlocked;
          }
        },
      },
      (filePath) => (rejectingStore = new RejectChildFinalizationStore(filePath)),
    );
    const leader = await service.createProjectChat(
      (await service.createManagedProject({ displayName: "durable-child-intent" })).id,
      { name: "Durable child" },
    );
    const { run } = await service.sendMessage(leader.id, "coordinate");

    await expect.poll(() => terminalAppendStarted, { timeout: 10_000 }).toBe(true);
    const intentPendingChild = store.snapshot().runs.find((item) => item.kind === "subtask");
    expect(intentPendingChild?.terminalPublicationIntent).toBeTruthy();
    expect(service.getRun(intentPendingChild!.id).status).toBe("running");
    releaseTerminalAppend();

    await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 }).toBe("completed");
    const rawChild = store.snapshot().runs.find((item) => item.kind === "subtask");
    expect(rejectingStore?.finalizationAttempts).toBe(2);
    expect(rawChild?.status).toBe("running");
    expect((rawChild as unknown as { terminalPublicationIntent?: unknown })?.terminalPublicationIntent)
      .toBeTruthy();
    expect(service.getRun(rawChild!.id)).toMatchObject({ status: "completed", output: expect.stringContaining("done") });
    expect(service.getAgent(rawChild!.agentId).status).toBe("ready");

    const restarted = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      workspaces,
      runner,
      events,
      singleWorkerParts(),
      undefined,
      undefined,
      new ProjectRunManager(path.join(root, "project-runs"), [root], new GitClient(5_000)),
    );
    await restarted.initialize();
    expect(restarted.getRun(rawChild!.id).status).toBe("completed");
    expect((await events.lastTerminalEvent(rawChild!.id))?.name).toBe("contribution_ready");
    expect((await restarted.getRunEvents(rawChild!.id, 500)).lastSeq).toBeGreaterThan(500);
  }, 20_000);

  it("lets cancellation queued after collection win before contribution-ready publication", async () => {
    let collectionReached!: () => void;
    let releaseCollection!: () => void;
    const reached = new Promise<void>((resolve) => { collectionReached = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseCollection = resolve; });
    const git = new GitClient(5_000);
    const plan: LeaderPlan = {
      needsSubagents: true,
      rationale: "one bounded contribution",
      subtasks: [{
        id: "build",
        title: "Build",
        role: "Builder",
        prompt: "build",
        objective: "Build",
        successCriteria: ["built"],
        expectedOutput: "commit",
        dependsOn: [],
      }],
    };
    const runner: AgentRunner = {
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "candidate.txt"), "candidate\n", "utf8");
        await git.run(request.workspacePath, ["add", "--", "candidate.txt"]);
        await git.run(request.workspacePath, ["commit", "-m", "candidate"]);
        const head = await git.head(request.workspacePath);
        request.sink?.emit({
          spanId: "commit", parentSpanId: "run", kind: "command", name: "git commit", status: "ok",
          startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1,
          input: {}, output: { exitCode: 0 }, error: null, attributes: {}, usage: null,
        });
        return { output: "done\nLAUNCHPAD_COMMIT=" + head, threadId: null, usage: null };
      },
      cancel: async () => true,
      isAvailable: async () => true,
    };
    const parts: OrchestratorParts = {
      planner: { plan: async () => ({ status: "available", plan, model: "p", promptVersion: "p1" }) } as OrchestratorParts["planner"],
      evaluator: {} as OrchestratorParts["evaluator"],
      replanner: {} as OrchestratorParts["replanner"],
      synthesizer: {} as OrchestratorParts["synthesizer"],
      beforeContributionReadyForTest: async () => {
        collectionReached();
        await blocked;
      },
    };
    const { service } = await makeServiceFixture(runner, {}, parts);
    const { chat: leader } = await projectChat(service, "Cancellation fence");
    const { run } = await service.sendMessage(leader.id, "build");
    await reached;

    const stopping = service.stopAgent(leader.id);
    // stopAgent synchronously requests cancellation before its first await;
    // release the publication barrier only after that request is queued.
    await Promise.resolve();
    releaseCollection();
    await stopping;

    expect(service.getRun(run.id).project?.attempts[0]?.state).toBe("cancelled");
    expect(service.getRun(run.id).orchestration?.workerResults.some((item) => item.status === "contribution_ready"))
      .toBe(false);
  });

  it("brackets a leader orchestration run with lifecycle events", async () => {
    const { service } = await makeServiceFixture(
      soloRunner(),
      {},
      soloParts("no split needed"),
    );
    const leader = await service.createAgent({ name: "Lead", role: "leader" });
    const { run } = await service.sendMessage(leader.id, "coordinate", { mode: "new_project", projectName: "lifecycle-project" });
    await expect.poll(() => service.getRun(run.id).status, { timeout: 5_000 }).toBe("completed");

    const kinds = (await service.getRunEvents(run.id, 0)).events.map(
      (event) => event.kind,
    );
    expect(kinds[0]).toBe("run");
    expect(kinds.at(-1)).toBe("run");
  });

  it("closes the delegating span after worker execution completes", async () => {
    const plan: LeaderPlan = {
      needsSubagents: true,
      rationale: "One worker is enough.",
      subtasks: [
        {
          id: "inspect",
          title: "Inspect",
          role: "Inspector",
          prompt: "inspect",
          objective: "Inspect",
          successCriteria: ["inspected"],
          expectedOutput: "notes",
          dependsOn: [],
        },
      ],
    };
    const { service } = await makeServiceFixture(new FakeRunner(), {}, {
      planner: {
        plan: async () => ({
          status: "available",
          plan,
          model: "planner-model",
          promptVersion: "planner-v1",
        }),
      } as OrchestratorParts["planner"],
      evaluator: {
        evaluate: async () => ({
          status: "available",
          model: "evaluator-model",
          promptVersion: "evaluator-v1",
          evaluation: {
            sufficient: true,
            subtaskEvaluations: [],
            missingInformation: [],
          },
        }),
      } as OrchestratorParts["evaluator"],
      replanner: {
        replan: async () => {
          throw new Error("should not replan");
        },
      } as OrchestratorParts["replanner"],
      synthesizer: {
        synthesize: async () => ({
          output: "done",
          model: "synth-model",
          promptVersion: "synthesizer-v1",
        }),
      } as OrchestratorParts["synthesizer"],
    });
    const leader = await service.createAgent({ name: "Lead", role: "leader" });
    const { run } = await service.sendMessage(leader.id, "coordinate", { mode: "ephemeral_research" });
    await expect.poll(() => service.getRun(run.id).status, { timeout: 5_000 }).toBe("completed");

    const { events } = await service.getRunEvents(run.id, 0);
    const latestBySpan = new Map(events.map((event) => [event.spanId, event]));
    const latestDelegating = latestBySpan.get("delegation-delegating-1");
    expect(latestDelegating?.status).toBe("ok");
    expect(latestDelegating?.endedAt).not.toBeNull();
    const dispatches = [...latestBySpan.values()].filter(
      (event) => event.kind === "delegation" && event.name === "dispatch_subagent",
    );
    expect(dispatches.map((event) => event.attributes.subtaskId)).toEqual(["inspect"]);
    expect(dispatches.every((event) => event.status === "ok")).toBe(true);
    expect(dispatches.every((event) => event.input.text?.includes("Inspector: Inspect")))
      .toBe(true);
  });

  it("gives each leader model call the iteration it belongs to", async () => {
    const seen: { label: string; iteration: number | undefined }[] = [];
    const parts = soloParts("no split needed", seen);
    const { service } = await makeServiceFixture(soloRunner(), {}, parts);
    const leader = await service.createAgent({ name: "Lead", role: "leader" });
    const { run } = await service.sendMessage(leader.id, "coordinate", { mode: "new_project", projectName: "iteration-project" });
    await expect.poll(() => service.getRun(run.id).status, { timeout: 5_000 }).toBe("completed");

    expect(seen).toEqual([{ label: "planner", iteration: 0 }]);
  });

  it("falls back to synthesis instead of treating evaluator failure as sufficient", async () => {
    const plan: LeaderPlan = {
      needsSubagents: true,
      rationale: "Needs a worker.",
      subtasks: [
        {
          id: "inspect",
          title: "Inspect",
          role: "Inspector",
          prompt: "inspect",
          objective: "Inspect",
          successCriteria: ["inspected"],
          expectedOutput: "notes",
          dependsOn: [],
        },
      ],
    };
    const parts: OrchestratorParts = {
      planner: {
        plan: async () => ({
          status: "available",
          plan,
          model: "planner-model",
          promptVersion: "planner-v1",
        }),
      } as OrchestratorParts["planner"],
      evaluator: {
        evaluate: async () => ({
          status: "unavailable",
          reason: "evaluator_failed",
          error: "bad json",
          promptVersion: "evaluator-v1",
        }),
      } as OrchestratorParts["evaluator"],
      replanner: {
        replan: async () => {
          throw new Error("should not replan");
        },
      } as OrchestratorParts["replanner"],
      synthesizer: {
        synthesize: async (_task, _plans, evaluations, results) => ({
          output:
            "fallback synthesis saw " +
            evaluations[0]?.result.status +
            " and " +
            results.length +
            " result",
          promptVersion: "synthesizer-v1",
        }),
      } as OrchestratorParts["synthesizer"],
    };
    const service = await makeService(new FakeRunner(), parts);
    const leader = await service.createAgent({ name: "Lead", role: "leader" });
    const { run } = await service.sendMessage(leader.id, "coordinate", { mode: "ephemeral_research" });

    await expect.poll(() => service.getRun(run.id).status, { timeout: 5_000 }).toBe("completed");

    const completed = service.getRun(run.id);
    expect(completed.output).toBe("fallback synthesis saw unavailable and 1 result");
    expect(completed.orchestration?.evaluationRecords[0]?.result).toMatchObject({
      status: "unavailable",
      reason: "evaluator_failed",
    });
  });

  it("surfaces planner unavailable details in canonical event fields", async () => {
    const parts: OrchestratorParts = {
      planner: {
        plan: async () => ({
          status: "unavailable",
          reason: "planner_failed",
          error: "raw planner output preview: nope",
          promptVersion: "planner-v1",
        }),
      } as OrchestratorParts["planner"],
      evaluator: {
        evaluate: async () => {
          throw new Error("should not evaluate");
        },
      } as OrchestratorParts["evaluator"],
      replanner: {
        replan: async () => {
          throw new Error("should not replan");
        },
      } as OrchestratorParts["replanner"],
      synthesizer: {
        synthesize: async () => {
          throw new Error("should not synthesize");
        },
      } as OrchestratorParts["synthesizer"],
    };
    const service = await makeService(new FakeRunner(), parts);
    const leader = await service.createAgent({ name: "Lead", role: "leader" });
    const { run } = await service.sendMessage(leader.id, "coordinate", { mode: "new_project", projectName: "planner-event-project" });

    await expect.poll(() => service.getRun(run.id).status, { timeout: 5_000 }).toBe("completed");

    const events = await service.getRunEvents(run.id, 0);
    const unavailable = events.events.find(
      (event) => event.name === "planning_unavailable",
    );
    expect(unavailable?.output.text).toContain("reason: planner_failed");
    expect(unavailable?.output.text).toContain("raw planner output preview");
    expect(unavailable?.error?.message).toContain("reason: planner_failed");
    expect(unavailable?.attributes).toMatchObject({
      reason: "planner_failed",
      error: "raw planner output preview: nope",
    });
  });

  it("synthesizes partial evidence instead of replanning after timeout-heavy workers", async () => {
    const plan: LeaderPlan = {
      needsSubagents: true,
      rationale: "Needs parallel checks.",
      subtasks: [
        {
          id: "slow-a",
          title: "Slow A",
          role: "Inspector",
          prompt: "slow a",
          objective: "Inspect A",
          successCriteria: ["A checked"],
          expectedOutput: "notes",
          dependsOn: [],
        },
        {
          id: "slow-b",
          title: "Slow B",
          role: "Inspector",
          prompt: "slow b",
          objective: "Inspect B",
          successCriteria: ["B checked"],
          expectedOutput: "notes",
          dependsOn: [],
        },
      ],
    };
    let replanned = false;
    const parts: OrchestratorParts = {
      policy: {
        ...defaultExecutionPolicy,
        maxParallel: 2,
        maxSubtasks: 2,
        maxIterations: 2,
        maxTotalWorkerRuns: 4,
        workerTimeoutMs: 60_000,
        workerSessionPolicy: "fresh",
        workerWorkspacePolicy: "fresh_task_scoped",
      },
      planner: {
        plan: async () => ({
          status: "available",
          plan,
          model: "planner-model",
          promptVersion: "planner-v1",
        }),
      } as OrchestratorParts["planner"],
      evaluator: {
        evaluate: async () => ({
          status: "available",
          evaluation: {
            sufficient: false,
            subtaskEvaluations: [],
            missingInformation: ["timed out checks"],
          },
          model: "evaluator-model",
          promptVersion: "evaluator-v1",
        }),
      } as OrchestratorParts["evaluator"],
      replanner: {
        replan: async () => {
          replanned = true;
          throw new Error("should not replan after timeout-heavy iteration");
        },
      } as OrchestratorParts["replanner"],
      synthesizer: {
        synthesize: async () => ({
          output: "partial synthesis",
          promptVersion: "synthesizer-v1",
        }),
      } as OrchestratorParts["synthesizer"],
    };
    const service = await makeService(
      {
        run: async () => {
          throw new Error("Worker timed out after 60000 ms");
        },
        cancel: async () => true,
        isAvailable: async () => true,
      },
      parts,
    );
    const leader = await service.createAgent({ name: "Lead", role: "leader" });
    const { run } = await service.sendMessage(leader.id, "coordinate", { mode: "new_project", projectName: "timeout-project" });

    await expect.poll(() => service.getRun(run.id).status, { timeout: 5_000 }).toBe("completed");

    expect(replanned).toBe(false);
    const completed = service.getRun(run.id);
    expect(completed.orchestration?.workerResults.map((result) => result.status))
      .toEqual(["timed_out", "timed_out"]);
    const events = await service.getRunEvents(run.id, 0);
    const timeoutEvent = events.events.find(
      (event) => event.name === "timeout_limited_synthesis",
    );
    expect(timeoutEvent?.status).toBe("warning");
    expect(timeoutEvent?.attributes).toMatchObject({ timedOut: 2, total: 2 });
  });

  it("serves a file the Agent produced, and refuses one outside its workspace", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Producer" });
    await writeFile(path.join(agent.workspacePath, "report.txt"), "the answer", "utf8");

    const file = service.readWorkspaceFile(agent.id, "report.txt");
    expect(file.bytes.toString("utf8")).toBe("the answer");
    expect(file.contentType).toBe("text/plain");

    // The path arrives from a browser and from model output, so climbing out of
    // the workspace has to fail rather than read whatever is up there.
    expect(() => service.readWorkspaceFile(agent.id, "../../../etc/hosts")).toThrow(
      /escapes the workspace/,
    );
    expect(() => service.readWorkspaceFile(agent.id, "missing.txt")).toThrow(/No such file/);
  });

  it("reads a container-absolute path as a workspace path", async () => {
    // The Agent reports files as `/workspace/report.txt`; that is this
    // workspace, not the host's root.
    const service = await makeService();
    const agent = await service.createAgent({ name: "Producer" });
    await writeFile(path.join(agent.workspacePath, "report.txt"), "ok", "utf8");

    expect(service.readWorkspaceFile(agent.id, "/workspace/report.txt")).toBeTruthy();
  });

  it("puts an upload where the Agent can read it, under a name it chose", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Reader" });

    const written = await service.writeWorkspaceUpload(
      agent.id,
      "../../my notes.txt",
      Buffer.from("hello from the operator").toString("base64"),
    );

    // Only the basename survives, and only inside the uploads directory.
    expect(written.path).toBe("uploads/my-notes.txt");
    expect(service.readWorkspaceFile(agent.id, written.path).bytes.toString("utf8")).toBe(
      "hello from the operator",
    );
  });

  it("refuses an upload past the size limit before writing anything", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Reader" });
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 7).toString("base64");

    await expect(
      service.writeWorkspaceUpload(agent.id, "big.bin", oversized),
    ).rejects.toThrow(/size limit/);
  });

});

describe("legacy chat migration", () => {
  it("classifies project, temporary, ambiguous, and unverifiable chats idempotently", async () => {
    const git = new GitClient(5_000);
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "launchpad-migrate-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspaces");
    await mkdir(allowedRoot, { recursive: true });
    const origin = path.join(allowedRoot, "origin.git");
    const root = path.join(allowedRoot, "root");
    const clone = path.join(allowedRoot, "clone");
    await git.run(allowedRoot, ["init", "-b", "main", "--bare", "--", origin]);
    await git.run(allowedRoot, ["clone", origin, root]);
    await writeFile(path.join(root, "README.md"), "initial\n", "utf8");
    await git.run(root, ["add", "--", "README.md"]);
    await git.run(root, ["commit", "-m", "initial"]);
    await git.run(root, ["push", "-u", "origin", "HEAD:main"]);
    await git.run(allowedRoot, ["clone", origin, clone]);

    const store = new JsonStore(path.join(fixtureRoot, "db.json"));
    await store.initialize();
    const registry = new ProjectRegistry(
      store,
      new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git),
      git,
    );

    const projectAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ephemeralAgentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const ambiguousAgentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const unverifiableAgentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const projectRunId = "11111111-1111-4111-8111-111111111111";
    const ephemeralRunId = "22222222-2222-4222-8222-222222222222";
    const ambiguousRunA = "33333333-3333-4333-8333-333333333333";
    const ambiguousRunB = "44444444-4444-4444-8444-444444444444";
    const unverifiableRunId = "55555555-5555-4555-8555-555555555555";
    const seededAgents = [
      legacyAgent(projectAgentId, "Project Chat"),
      legacyAgent(ephemeralAgentId, "Ephemeral Chat"),
      legacyAgent(ambiguousAgentId, "Ambiguous Chat"),
      legacyAgent(unverifiableAgentId, "Unverifiable Chat"),
    ];
    const seededRuns = [
      legacyRun(projectRunId, projectAgentId, {
        mode: "existing_repository",
        repositoryPath: root,
        revision: "HEAD",
      }),
      legacyRun(ephemeralRunId, ephemeralAgentId, { mode: "ephemeral_research" }),
      legacyRun(ambiguousRunA, ambiguousAgentId, {
        mode: "existing_repository",
        repositoryPath: root,
        revision: "HEAD",
      }),
      legacyRun(ambiguousRunB, ambiguousAgentId, {
        mode: "existing_repository",
        repositoryPath: clone,
        revision: "HEAD",
      }),
      legacyRun(unverifiableRunId, unverifiableAgentId, {
        mode: "existing_repository",
        repositoryPath: path.join(allowedRoot, "missing"),
        revision: "HEAD",
      }),
    ];
    const seededMessages = [
      {
        id: "66666666-6666-4666-8666-666666666666",
        agentId: projectAgentId,
        runId: projectRunId,
        role: "user" as const,
        content: "historical evidence",
        createdAt: "2026-08-28T00:00:00.000Z",
      },
    ];
    await store.mutate((database) => {
      database.agents.push(...structuredClone(seededAgents));
      database.runs.push(...structuredClone(seededRuns));
      database.messages.push(...structuredClone(seededMessages));
    });

    const updateSpy = vi.spyOn(git, "updateBranchIfAt");
    const createSpy = vi.spyOn(git, "createBranchIfMissingAt");
    const removeSpy = vi.spyOn(git, "worktreeRemove");
    const resetSpy = vi.spyOn(git, "resetHard");

    await migrateLegacyChats(store, registry);
    const firstSnapshot = store.snapshot();
    await migrateLegacyChats(store, registry);
    const secondSnapshot = store.snapshot();

    const projectAgent = firstSnapshot.agents.find((agent) => agent.id === projectAgentId)!;
    const ephemeralAgent = firstSnapshot.agents.find((agent) => agent.id === ephemeralAgentId)!;
    const ambiguousAgent = firstSnapshot.agents.find((agent) => agent.id === ambiguousAgentId)!;
    const unverifiableAgent = firstSnapshot.agents.find((agent) => agent.id === unverifiableAgentId)!;
    const [project] = firstSnapshot.projects;
    expect(firstSnapshot.projects).toHaveLength(1);
    expect(projectAgent.projectId).toBe(project.id);
    expect(projectAgent.unassignedPlacement).toBeNull();
    expect(ephemeralAgent.projectId).toBeNull();
    expect(ephemeralAgent.unassignedPlacement).toBe("temporary");
    expect(ambiguousAgent.projectId).toBeNull();
    expect(ambiguousAgent.unassignedPlacement).toBe("previous");
    expect(unverifiableAgent.projectId).toBeNull();
    expect(unverifiableAgent.unassignedPlacement).toBe("previous");
    expect(firstSnapshot.runs).toEqual(seededRuns);
    expect(firstSnapshot.messages).toEqual(seededMessages);
    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(updateSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it("migrates legacy chats during initialize after baseline recovery", async () => {
    const git = new GitClient(5_000);
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "launchpad-migrate-init-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspaces");
    await mkdir(allowedRoot, { recursive: true });
    const repository = path.join(allowedRoot, "solo");
    await git.run(allowedRoot, ["init", "-b", "main", "--", repository]);
    await writeFile(path.join(repository, "README.md"), "solo\n", "utf8");
    await git.run(repository, ["add", "--", "README.md"]);
    await git.run(repository, ["commit", "-m", "initial"]);

    const store = new JsonStore(path.join(fixtureRoot, "data", "db.json"));
    await store.initialize();
    await store.mutate((database) => {
      database.agents.push(legacyAgent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Init Chat"));
      database.runs.push(legacyRun("11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
        mode: "existing_repository",
        repositoryPath: repository,
        revision: "HEAD",
      }));
    });

    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(fixtureRoot, "data"),
      AGENT_WORKSPACE_ROOT: workspaceRoot,
      WORKSPACE_SOURCE_ROOTS: allowedRoot,
      CODEX_HOME: path.join(fixtureRoot, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      CODEX_RUNTIME_MODE: "exec",
    });
    const events = new EventLog(path.join(fixtureRoot, "data", "events"), {
      secrets: [config.arkApiKey],
    });
    const registry = new ProjectRegistry(
      store,
      new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git),
      git,
    );
    const recoverSpy = vi.spyOn(registry, "recoverBaselineTransitions");
    const service = new AgentService(
      config,
      store,
      new WorkspaceManager(workspaceRoot),
      new FakeRunner(),
      events,
      undefined,
      undefined,
      undefined,
      new ProjectRunManager(path.join(workspaceRoot, "project-runs"), [allowedRoot], git),
      {},
      registry,
      git,
    );
    await service.initialize();

    expect(recoverSpy).toHaveBeenCalled();
    const agent = service.listAgents()[0]!;
    expect(agent.projectId).not.toBeNull();
    expect(agent.unassignedPlacement).toBeNull();
    expect(store.snapshot().projects).toHaveLength(1);
  });

  it("does not move a new temporary chat with no runs to previous", async () => {
    const git = new GitClient(5_000);
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "launchpad-migrate-temp-"));
    temporaryDirectories.push(fixtureRoot);
    const store = new JsonStore(path.join(fixtureRoot, "db.json"));
    await store.initialize();
    const registry = new ProjectRegistry(
      store,
      new ProjectRepositoryManager(path.join(fixtureRoot, "workspaces"), [fixtureRoot], git),
      git,
    );
    const temporaryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await store.mutate((database) => {
      database.agents.push({
        ...legacyAgent(temporaryId, "Scratch"),
        unassignedPlacement: "temporary",
      });
    });

    await migrateLegacyChats(store, registry);

    const agent = store.snapshot().agents.find((item) => item.id === temporaryId)!;
    expect(agent.projectId).toBeNull();
    expect(agent.unassignedPlacement).toBe("temporary");
    expect(store.snapshot().projects).toHaveLength(0);
  });

  it("does not unassign attached chats when inspectExternal would fail", async () => {
    const git = new GitClient(5_000);
    const fixtureRoot = await mkdtemp(path.join(tmpdir(), "launchpad-migrate-live-"));
    temporaryDirectories.push(fixtureRoot);
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspaces");
    await mkdir(allowedRoot, { recursive: true });
    const repository = path.join(allowedRoot, "solo");
    await git.run(allowedRoot, ["init", "-b", "main", "--", repository]);
    await writeFile(path.join(repository, "README.md"), "solo\n", "utf8");
    await git.run(repository, ["add", "--", "README.md"]);
    await git.run(repository, ["commit", "-m", "initial"]);

    const store = new JsonStore(path.join(fixtureRoot, "db.json"));
    await store.initialize();
    const registry = new ProjectRegistry(
      store,
      new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git),
      git,
    );
    const attachedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const projectChatId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await store.mutate((database) => {
      database.agents.push(legacyAgent(attachedId, "Attached Chat"));
      database.runs.push(legacyRun("11111111-1111-4111-8111-111111111111", attachedId, {
        mode: "existing_repository",
        repositoryPath: repository,
        revision: "HEAD",
      }));
    });

    await migrateLegacyChats(store, registry);
    const projectId = store.snapshot().agents.find((agent) => agent.id === attachedId)!.projectId;
    expect(projectId).not.toBeNull();

    await store.mutate((database) => {
      database.agents.push({
        ...legacyAgent(projectChatId, "New Project Chat"),
        projectId,
        unassignedPlacement: null,
      });
    });
    await writeFile(path.join(repository, "dirty.txt"), "dirty\n", "utf8");

    await migrateLegacyChats(store, registry);

    const attached = store.snapshot().agents.find((agent) => agent.id === attachedId)!;
    const projectChat = store.snapshot().agents.find((agent) => agent.id === projectChatId)!;
    expect(attached.projectId).toBe(projectId);
    expect(attached.unassignedPlacement).toBeNull();
    expect(projectChat.projectId).toBe(projectId);
    expect(projectChat.unassignedPlacement).toBeNull();
  });

  it("preserves a historical todo-app Run with zero integrations and unknown outcome", async () => {
    const { service, store, root } = await makeServiceFixture();
    const git = new GitClient(5_000);
    const runId = "99999999-9999-4999-8999-999999999999";
    const manager = new ProjectRunManager(path.join(root, "project-runs"), [root], git);
    const historical = await manager.prepare(runId, {
      mode: "new_project",
      projectName: "todo-app",
    });
    await manager.acknowledgePrepared(runId, historical);
    const seedHead = historical.headCommit;
    historical.state = "completed";
    historical.attempts = [];
    historical.integrations = [];
    const agent = await service.createAgent({ name: "Historical Todo" });
    await store.mutate((database) => {
      const stored = database.agents.find((item) => item.id === agent.id);
      if (!stored) throw new Error("missing agent");
      stored.unassignedPlacement = "previous";
      database.runs.push({
        id: runId,
        agentId: agent.id,
        projectId: null,
        kind: "orchestration",
        parentRunId: null,
        orchestration: {
          phase: "completed",
          iteration: 1,
          iterationPlans: [],
          evaluationRecords: [],
          workerResults: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, workerRuns: 0 },
          policySnapshot: {
            maxParallel: 1,
            maxSubtasks: 1,
            maxIterations: 1,
            maxTotalWorkerRuns: 1,
            workerTimeoutMs: 1_000,
            workerSessionPolicy: "fresh",
            workerWorkspacePolicy: "fresh_task_scoped",
            workerIdentityPolicy: "per_subtask",
          },
          provenance: {
            harnessVersion: "historical",
            plannerPromptVersion: "v1",
            evaluatorPromptVersion: "v1",
            replannerPromptVersion: "v1",
            synthesizerPromptVersion: "v1",
          },
        },
        workspaceSource: { mode: "new_project", projectName: "todo-app" },
        project: historical,
        status: "completed",
        prompt: "build a todo app",
        output: "done",
        error: null,
        usage: null,
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:01.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
      });
    });

    await service.initialize();
    const recovered = service.getRun(runId);
    expect(recovered.status).toBe("completed");
    expect(recovered.project?.attempts).toEqual([]);
    expect(recovered.project?.integrations).toEqual([]);
    expect(recovered.project?.headCommit).toBe(seedHead);
    expect(recovered.orchestration?.outcome?.value ?? "unknown").toBe("unknown");
  });
});

describe("Project chat admission", () => {
  it("binds a project chat run to the persisted project source", async () => {
    const calls = { planner: 0, runner: 0, model: 0 };
    const { service } = await makeServiceFixture(
      {
        run: async () => {
          calls.runner += 1;
          throw new Error("runner must not be admitted");
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      {},
      {
        planner: {
          plan: async () => {
            calls.planner += 1;
            throw new Error("planner must not be admitted");
          },
        },
      } as OrchestratorParts,
    );
    const project = await service.createManagedProject({ displayName: "Todo Flow" });
    const projectChat = await service.createProjectChat(project.id, { name: "Build" });
    expect(projectChat.projectId).toBe(project.id);
    expect(projectChat.unassignedPlacement).toBeNull();
    expect(projectChat.role).toBe("leader");

    const { run } = await (service.sendMessage as (
      id: string,
      prompt: string,
      extra?: unknown,
    ) => ReturnType<AgentService["sendMessage"]>)(projectChat.id, "build", {
      mode: "ephemeral_research",
    });
    expect(run.projectId).toBe(project.id);
    expect(run.kind).toBe("orchestration");
    expect(run.workspaceSource).toEqual({
      mode: "existing_repository",
      repositoryPath: project.repositoryPath,
      revision: project.baselineCommit,
    });
    await service.stopAgent(projectChat.id);
  });

  it("continues a manually stopped project run from its interrupted head", async () => {
    const runnerRequests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        runnerRequests.push(request);
        return { output: "still working", threadId: request.threadId, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { root, service, store } = await makeServiceFixture(
      runner,
      {},
      soloParts("run solo"),
    );
    const project = await service.createManagedProject({ displayName: "Stopped Continue" });
    const projectChat = await service.createProjectChat(project.id, { name: "Stopped Continue" });
    const git = new GitClient(5_000);
    await git.run(project.repositoryPath, ["checkout", "-b", "interrupted-work"]);
    await writeFile(path.join(project.repositoryPath, "carried.txt"), "carried\n", "utf8");
    await git.run(project.repositoryPath, ["add", "--", "carried.txt"]);
    await git.run(project.repositoryPath, ["commit", "-m", "carried work"]);
    const interruptedHead = await git.head(project.repositoryPath);
    await git.run(project.repositoryPath, ["checkout", project.baselineBranch]);

    const previousRunId = "11111111-1111-4111-8111-111111111111";
    await store.mutate((database) => {
      database.runs.push({
        id: previousRunId,
        agentId: projectChat.id,
        projectId: project.id,
        kind: "orchestration",
        parentRunId: null,
        orchestration: null,
        workspaceSource: {
          mode: "existing_repository",
          repositoryPath: project.repositoryPath,
          revision: project.baselineCommit,
        },
        project: {
          source: {
            mode: "existing_repository",
            repositoryPath: project.repositoryPath,
            requestedRevision: project.baselineCommit,
            baseCommit: project.baselineCommit,
            sourceFingerprint: "interrupted",
          },
          runBranch: "launchpad/run/" + previousRunId,
          canonicalWorkspacePath: path.join(root, "old-canonical"),
          headCommit: interruptedHead,
          state: "cancelled",
          attempts: [],
          integrations: [],
        },
        status: "cancelled",
        prompt: "Add the carried feature",
        output: null,
        error: "Run was cancelled before an outcome could be established.",
        usage: null,
        startedAt: "2026-08-30T00:00:00.000Z",
        completedAt: "2026-08-30T00:01:00.000Z",
        createdAt: "2026-08-30T00:00:00.000Z",
      });
    });

    const { run } = await service.sendMessage(projectChat.id, "continue");
    await expect.poll(() => service.getRun(run.id).status, { timeout: 20_000 }).toBe("completed");

    expect(run.parentRunId).toBe(previousRunId);
    expect(run.workspaceSource).toEqual({
      mode: "existing_repository",
      repositoryPath: project.repositoryPath,
      revision: interruptedHead,
    });
    expect(run.prompt).toContain("Original user request:\nAdd the carried feature");
    expect(runnerRequests[0]?.parentRunId).toBe(previousRunId);
    expect(runnerRequests[0]?.prompt).toContain("Continue the previously stopped run.");
    await service.startAgent(projectChat.id);
  });

  it("routes a migrated standalone project chat through orchestration", async () => {
    const { service, store } = await makeServiceFixture();
    const project = await service.createManagedProject({ displayName: "Legacy App" });
    const standalone = await service.createAgent({ name: "Migrated Standalone" });
    await store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === standalone.id);
      if (!agent) throw new Error("missing agent");
      agent.role = "standalone";
      agent.projectId = project.id;
      agent.unassignedPlacement = null;
    });

    const { run } = await service.sendMessage(standalone.id, "build");
    expect(run.kind).toBe("orchestration");
    expect(run.projectId).toBe(project.id);
    expect(run.workspaceSource).toEqual({
      mode: "existing_repository",
      repositoryPath: project.repositoryPath,
      revision: project.baselineCommit,
    });
    await service.stopAgent(standalone.id);
  });

  it("derives ephemeral research for a temporary chat", async () => {
    const { service } = await makeServiceFixture();
    const agent = await service.createAgent({ name: "Scratch" });
    expect(agent.projectId).toBeNull();
    expect(agent.unassignedPlacement).toBe("temporary");
    const { run } = await service.sendMessage(agent.id, "research");
    expect(run.projectId).toBeNull();
    expect(run.workspaceSource).toEqual({ mode: "ephemeral_research" });
    await service.stopAgent(agent.id);
  });

  it("rejects worker chats before planner or runner admission", async () => {
    const calls = { planner: 0, runner: 0 };
    const { service } = await makeServiceFixture(
      {
        run: async () => {
          calls.runner += 1;
          throw new Error("runner must not be admitted");
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      {},
      {
        planner: {
          plan: async () => {
            calls.planner += 1;
            throw new Error("planner must not be admitted");
          },
        },
      } as OrchestratorParts,
    );
    const worker = await service.createAgent({
      name: "Hidden Worker",
      role: "worker",
      parentAgentId: null,
    });
    await expect(service.sendMessage(worker.id, "build")).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(calls).toEqual({ planner: 0, runner: 0 });
  });

  it("fails invalid project authority before planner or runner admission", async () => {
    const calls = { planner: 0, runner: 0 };
    const { service } = await makeServiceFixture(
      {
        run: async () => {
          calls.runner += 1;
          throw new Error("runner must not be admitted");
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      {},
      {
        planner: {
          plan: async () => {
            calls.planner += 1;
            throw new Error("planner must not be admitted");
          },
        },
      } as OrchestratorParts,
    );

    await expect(
      service.createProjectChat("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { name: "Missing" }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      service.openProject({
        displayName: "Outside",
        repositoryPath: "/etc",
        revision: "HEAD",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const managed = await service.createManagedProject({ displayName: "Gone" });
    await rm(managed.repositoryPath, { recursive: true, force: true });
    await service.initialize();
    await expect(service.createProjectChat(managed.id, { name: "Dead" })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(calls).toEqual({ planner: 0, runner: 0 });
  });

  it("does not advance a baseline on ordinary ephemeral completion", async () => {
    const { service, projectRegistry } = await makeServiceFixture();
    const spy = vi.spyOn(projectRegistry, "advanceBaseline");
    const agent = await service.createAgent({ name: "Scratch Complete" });
    const { run } = await service.sendMessage(agent.id, "hello");
    await expect.poll(() => service.getRun(run.id).status, { timeout: 10_000 }).toBe("completed");
    expect(spy).not.toHaveBeenCalled();
  });

  it("finalizes a leftover baseline transition on initialize without rerunning an agent", async () => {
    const { service, store, projectRegistry } = await makeServiceFixture();
    const project = await service.createManagedProject({ displayName: "Restart Baseline" });
    const git = new GitClient(5_000);
    const base = project.baselineCommit;
    await writeFile(path.join(project.repositoryPath, "next.txt"), "next\n", "utf8");
    await git.run(project.repositoryPath, ["add", "--", "next.txt"]);
    await git.run(project.repositoryPath, ["commit", "-m", "next"]);
    const next = await git.head(project.repositoryPath);
    await git.resetHard(project.repositoryPath, base);
    await git.updateBranchIfAt(project.repositoryPath, project.baselineBranch, base, next);
    await store.mutate((database) => {
      const record = database.projects.find((item) => item.id === project.id);
      if (!record) throw new Error("missing project");
      record.baselineTransition = {
        runId: "14141414-1414-4141-8141-141414141414",
        expectedCommit: base,
        nextCommit: next,
        state: "prepared",
      };
    });

    await service.initialize();
    expect(projectRegistry.get(project.id).baselineCommit).toBe(next);
    expect(store.snapshot().projects[0]?.baselineTransition).toBeUndefined();
  });

  it("rejects a replaced project repository at admission with typed unavailable", async () => {
    const calls = { planner: 0, runner: 0 };
    const { service, store } = await makeServiceFixture(
      {
        run: async () => {
          calls.runner += 1;
          throw new Error("runner must not be admitted");
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      {},
      {
        planner: {
          plan: async () => {
            calls.planner += 1;
            throw new Error("planner must not be admitted");
          },
        },
      } as OrchestratorParts,
    );
    const project = await service.createManagedProject({ displayName: "Swapped" });
    const git = new GitClient(5_000);
    await rm(project.repositoryPath, { recursive: true, force: true });
    await git.run(path.dirname(project.repositoryPath), ["init", "-b", "main", "--", project.repositoryPath]);
    await writeFile(path.join(project.repositoryPath, "README.md"), "replaced\n", "utf8");
    await git.run(project.repositoryPath, ["add", "--", "README.md"]);
    await git.run(project.repositoryPath, ["commit", "-m", "replaced"]);

    await expect(service.createProjectChat(project.id, { name: "Swapped Chat" })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/identity/i),
    });
    expect(store.snapshot().projects[0]?.state).toBe("unavailable");
    expect(calls).toEqual({ planner: 0, runner: 0 });
  });

  it("admits a previously unavailable Project once identity and HEAD match again", async () => {
    const { service, store } = await makeServiceFixture();
    const project = await service.createManagedProject({ displayName: "Recoverable" });
    await store.mutate((database) => {
      const record = database.projects.find((item) => item.id === project.id);
      if (!record) throw new Error("missing project");
      record.state = "unavailable";
      record.lastError = "temporary outage";
    });

    const chat = await service.createProjectChat(project.id, { name: "Recovered Chat" });
    expect(chat.projectId).toBe(project.id);
    expect(chat.status).toBe("ready");
    expect(store.snapshot().projects[0]?.state).toBe("ready");
    expect(store.snapshot().projects[0]?.lastError).toBeNull();
  });
});

function legacyAgent(id: string, name: string): Agent {
  return {
    id,
    name,
    description: "",
    instructions: "",
    status: "ready",
    role: "standalone",
    parentAgentId: null,
    specialty: null,
    projectId: null,
    unassignedPlacement: "previous",
    workspacePath: "/tmp/workspace/" + id,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

function legacyRun(id: string, agentId: string, workspaceSource: AgentRun["workspaceSource"]): AgentRun {
  return {
    id,
    agentId,
    projectId: null,
    kind: "single",
    parentRunId: null,
    orchestration: null,
    workspaceSource,
    status: "completed",
    prompt: "hello",
    output: "ok",
    error: null,
    usage: null,
    startedAt: "2026-08-28T00:00:00.000Z",
    completedAt: "2026-08-28T00:00:01.000Z",
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

function soloRunner(): AgentRunner {
  return {
    run: async () => ({ output: "solo output", threadId: "thread-solo", usage: null }),
    cancel: async () => false,
    isAvailable: async () => true,
  };
}

function soloParts(
  rationale: string,
  seen: { label: string; iteration: number | undefined }[] = [],
): OrchestratorParts {
  return {
    planner: {
      plan: async (
        _task: unknown,
        _workers: unknown,
        _policy: unknown,
        recorder?: { iteration?: number },
      ) => {
        seen.push({ label: "planner", iteration: recorder?.iteration });
        return {
          status: "available",
          plan: { needsSubagents: false, rationale, subtasks: [] },
          model: "planner-model",
          promptVersion: "planner-v1",
        };
      },
    } as unknown as OrchestratorParts["planner"],
    evaluator: {} as OrchestratorParts["evaluator"],
    replanner: {} as OrchestratorParts["replanner"],
    synthesizer: {} as OrchestratorParts["synthesizer"],
  };
}

function singleWorkerParts(): OrchestratorParts {
  const plan: LeaderPlan = {
    needsSubagents: true,
    rationale: "one bounded worker",
    subtasks: [{
      id: "worker",
      title: "Worker",
      role: "Engineer",
      prompt: "make one commit",
      objective: "Make one commit",
      successCriteria: ["one commit"],
      expectedOutput: "commit",
      dependsOn: [],
    }],
  };
  return {
    planner: { plan: async () => ({ status: "available", plan, model: "planner", promptVersion: "v1" }) } as OrchestratorParts["planner"],
    evaluator: { evaluate: async () => ({ status: "available", model: "evaluator", promptVersion: "v1", evaluation: { sufficient: true, subtaskEvaluations: [], missingInformation: [] } }) } as OrchestratorParts["evaluator"],
    replanner: { replan: async () => { throw new Error("unexpected replan"); } } as OrchestratorParts["replanner"],
    synthesizer: { synthesize: async () => ({ output: "complete", model: "synth", promptVersion: "v1" }) } as OrchestratorParts["synthesizer"],
  };
}
