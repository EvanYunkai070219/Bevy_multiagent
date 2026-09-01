import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { EventLog } from "../src/event-log.js";
import { Orchestrator, type OrchestratorParts } from "../src/orchestration/orchestrator.js";
import { EvolutionStore } from "../src/orchestration/evolution/evolution-store.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { JsonStore } from "../src/store.js";
import type {
  Agent,
  AgentRunner,
  AgentRun,
  LeaderSubtask,
  OrchestrationState,
  ProjectRunRecord,
  RunnerRequest,
} from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";
import type {
  AgentRuntime,
  DeliveryResult,
  RuntimeSnapshot,
  WorkerCheckpoint,
} from "../src/runtime/agent-runtime.js";
import type { TeamMessageQueued } from "../src/coordination/messages.js";
import type { CoordinationIngress } from "../src/coordination/ingress.js";
import type { ModelCredentialIssuer } from "../src/model-proxy.js";
import type { AttemptWorkspaceManager } from "../src/attempt-workspace-manager.js";
import type { ContributionCollector } from "../src/contribution-collector.js";
import type { ContractCatalogEntry } from "../src/orchestration/healing/contract-compiler.js";

class ImmediateRuntime implements AgentRuntime {
  async start(request: RunnerRequest): Promise<WorkerCheckpoint> {
    return {
      threadId: request.threadId ?? "thread-" + request.runId,
      output: "done",
      usage: null,
    };
  }
  async inject(_message: TeamMessageQueued): Promise<DeliveryResult> {
    return { state: "delivered", via: "pending_quiet" };
  }
  async wake(_message: TeamMessageQueued): Promise<DeliveryResult> {
    return { state: "delivered", via: "follow_up" };
  }
  async waitForIdle(): Promise<void> {}
  snapshot(): RuntimeSnapshot {
    return { state: "idle", threadId: "thread", activeTurnId: null };
  }
  capability(): "live_steer" {
    return "live_steer";
  }
  async close(_reason: string): Promise<void> {}
  async cancel(_reason: string): Promise<void> {}
  async quiesce(_reason: string): Promise<void> {}
}

class DeferredRuntime implements AgentRuntime {
  release!: () => void;
  started = false;
  sink: RunnerRequest["sink"] = undefined;
  cancelled: string[] = [];
  quiesced: string[] = [];

  async start(request: RunnerRequest): Promise<WorkerCheckpoint> {
    this.started = true;
    this.sink = request.sink;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return {
      threadId: request.threadId ?? "thread-" + request.runId,
      output: "deferred done",
      usage: null,
    };
  }
  async inject(_message: TeamMessageQueued): Promise<DeliveryResult> {
    return { state: "delivered", via: "pending_quiet" };
  }
  async wake(_message: TeamMessageQueued): Promise<DeliveryResult> {
    return { state: "delivered", via: "follow_up" };
  }
  async waitForIdle(): Promise<void> {}
  snapshot(): RuntimeSnapshot {
    return { state: this.started ? "active" : "not_started", threadId: "thread", activeTurnId: null };
  }
  capability(): "live_steer" {
    return "live_steer";
  }
  async close(_reason: string): Promise<void> {
    this.release?.();
  }
  async cancel(_reason: string): Promise<void> {
    this.cancelled.push(_reason);
    this.release?.();
  }
  async quiesce(_reason: string): Promise<void> {
    this.quiesced.push(_reason);
  }
}

function emitFailedTest(runtime: DeferredRuntime, span: string, text = "FAIL  tests/demo.test.ts") {
  runtime.sink?.emit({
    spanId: span,
    parentSpanId: "run",
    kind: "command",
    name: "bash",
    status: "error",
    startedAt: "2026-08-29T00:00:00.000Z",
    endedAt: "2026-08-29T00:00:01.000Z",
    durationMs: 1_000,
    input: { command: "npm test" },
    output: { exitCode: 1, text },
    error: { message: text, code: "1" },
    attributes: {},
    usage: null,
  });
}

function emitProgress(runtime: DeferredRuntime, pathName: string) {
  runtime.sink?.emit({
    spanId: "file-" + pathName,
    parentSpanId: "run",
    kind: "file_change",
    name: "apply_patch",
    status: "ok",
    startedAt: "2026-08-29T00:00:00.000Z",
    endedAt: "2026-08-29T00:00:01.000Z",
    durationMs: 200,
    input: { paths: [pathName] },
    output: { changedFiles: [pathName] },
    error: null,
    attributes: {},
    usage: null,
  });
}

function emitCompletedTool(runtime: DeferredRuntime, span: string, filePath: string) {
  runtime.sink?.emit({
    spanId: span,
    parentSpanId: "run",
    kind: "mcp_tool",
    name: "launchpad.read_file",
    status: "ok",
    startedAt: "2026-08-29T00:00:00.000Z",
    endedAt: "2026-08-29T00:00:01.000Z",
    durationMs: 5,
    input: { tool: "launchpad.read_file", text: JSON.stringify({ path: filePath }) },
    output: { text: "ok " + filePath },
    error: null,
    attributes: {},
    usage: null,
  });
}

const HEALING_CATALOG: ContractCatalogEntry[] = [
  {
    contractKey: "backend-producer",
    allowedInputs: ["docs/api.md"],
    allowedOutputs: ["src/api.ts"],
    allowedMutationPaths: ["src/api.ts"],
    protectedPaths: [".launchpad"],
    artifactSchemaIds: ["backend-schema"],
    targetedGateIds: ["backend-targeted"],
    contractGateIds: ["backend-contract"],
    consumerGateIds: ["backend-consumer"],
    regressionGateIds: ["backend-regression"],
    authorizedTools: ["read_file"],
  },
  {
    contractKey: "integration-consumer",
    allowedInputs: ["src/api.ts"],
    allowedOutputs: ["tests/integration.test.ts"],
    allowedMutationPaths: ["tests/integration.test.ts"],
    protectedPaths: [".launchpad"],
    artifactSchemaIds: ["integration-schema"],
    targetedGateIds: ["integration-targeted"],
    contractGateIds: ["integration-contract"],
    consumerGateIds: ["integration-consumer-gate"],
    regressionGateIds: ["integration-regression"],
    authorizedTools: ["read_file"],
  },
];

function ephemeralProject(workspacePath: string): ProjectRunRecord {
  return {
    source: {
      mode: "ephemeral_research",
      repositoryPath: null,
      requestedRevision: null,
      baseCommit: null,
      sourceFingerprint: "ephemeral",
    },
    runBranch: null,
    canonicalWorkspacePath: workspacePath,
    headCommit: null,
    state: "ready",
    attempts: [],
    integrations: [],
  };
}

function managedGitProject(workspacePath: string): ProjectRunRecord {
  const head = "a".repeat(40);
  return {
    source: {
      mode: "existing_repository",
      repositoryPath: workspacePath,
      requestedRevision: head,
      baseCommit: head,
      sourceFingerprint: "fp-managed",
    },
    runBranch: "launchpad/run/test",
    canonicalWorkspacePath: workspacePath,
    headCommit: head,
    state: "ready",
    attempts: [],
    integrations: [],
  };
}

function stubProjectParts(workspacePath: string): Pick<OrchestratorParts, "attemptWorkspaces" | "contributionCollector"> {
  return {
    attemptWorkspaces: {
      create: async (input: {
        attemptId: string;
        revision: number;
        subtaskId: string;
        baseCommit: string;
      }) => ({
        attemptId: input.attemptId,
        revision: input.revision,
        ownerToken: "11111111-1111-4111-8111-111111111111",
        subtaskId: input.subtaskId,
        baseCommit: input.baseCommit,
        workspacePath,
        state: "running",
        cleanup: "active",
        headCommit: null,
        reason: null,
        kind: "task",
        checkpointId: null,
      }),
      compensateUnpersisted: async () => ({ action: "removed", attemptId: "none" }),
    } as unknown as AttemptWorkspaceManager,
    contributionCollector: {
      collect: async () => {
        throw new Error("collection should not run");
      },
    } as unknown as ContributionCollector,
  };
}

const runner: AgentRunner = {
  async run() {
    return { output: "unused", threadId: "unused", usage: null };
  },
  async cancel() {
    return true;
  },
  async isAvailable() {
    return true;
  },
};

class RecordingModelProxy implements ModelCredentialIssuer {
  issued: string[] = [];
  revoked: string[] = [];
  issue(runId: string): string {
    this.issued.push(runId);
    return "token-" + runId;
  }
  revoke(runId: string): void {
    this.revoked.push(runId);
  }
  terminalError(_runId: string) {
    return undefined;
  }
}

describe("orchestration runtime lifetime", () => {
  it("releases repeated evolution-store leases and tolerates double close", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-evolution-lifetime-"));
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const store = new EvolutionStore({ dataDirectory: root });
      await store.initialize();
      await store.close();
      await store.close();
    }
    const reopened = new EvolutionStore({ dataDirectory: root });
    await reopened.initialize();
    await expect(reopened.head("project-lifetime")).resolves.toMatchObject({ sequence: 0 });
    await reopened.close();
    await reopened.close();
  });

  it("dispatches live leader workers asynchronously by default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-async-dispatch-"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    const events = new EventLog(path.join(root, "data", "event"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();

    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "22222222-2222-4222-8222-222222222222",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push(leaderRun);
    });

    const runtime = new DeferredRuntime();
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: defaultExecutionPolicy,
        runtimeFactory: () => runtime,
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: config.dataDirectory,
      baseUrl: "http://127.0.0.1:1",
      register(_token: string, _ingress: CoordinationIngress) {},
      unregister(_token: string) {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(
      leaderRun.id,
    );

    const state = (orchestrator as unknown as { initialState(): unknown }).initialState();
    const dispatched = await (
      orchestrator as unknown as {
        dispatchFromLeader(
          leader: Agent,
          leaderRun: AgentRun,
          state: unknown,
          request: { agentName: string; prompt: string },
          leaderSink: { emit(): void },
        ): Promise<{ status: string; subtaskId: string; workerRunId: string }>;
      }
    ).dispatchFromLeader(
      leader,
      leaderRun,
      state,
      { agentName: "AsyncWorker", prompt: "do slow worker task" },
      { emit() {} },
    );

    expect(dispatched.status).toBe("running");
    expect(dispatched.workerRunId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await expect.poll(() => runtime.started).toBe(true);

    const commonWorkspace = workspaces.commonWorkspacePath(leaderRun.id);
    await mkdir(path.join(commonWorkspace, "status"), { recursive: true });
    await writeFile(path.join(commonWorkspace, "status", "AsyncWorker.json"), "{\"state\":\"running\"}");
    const waitResult = await (
      orchestrator as unknown as {
        waitForWorkers(
          runId: string,
          state: unknown,
          request: { targets: string[]; timeoutSeconds: number },
          commonWorkspacePath: string,
        ): Promise<{
          completed: boolean;
          pendingHandoffs: {
            subtaskId: string;
            displayName: string;
            statusPaths: string[];
            reportPaths: string[];
            statusExists: boolean;
            reportExists: boolean;
          }[];
          hint: string;
        }>;
      }
    ).waitForWorkers(
      leaderRun.id,
      state,
      { targets: ["AsyncWorker"], timeoutSeconds: 1 },
      commonWorkspace,
    );
    expect(waitResult.completed).toBe(false);
    expect(waitResult.pendingHandoffs).toEqual([
      expect.objectContaining({
        subtaskId: dispatched.subtaskId,
        displayName: "AsyncWorker",
        statusPaths: expect.arrayContaining([
          "$COMMON_WORKSPACE/status/" + dispatched.subtaskId + ".json",
          "$COMMON_WORKSPACE/status/AsyncWorker.json",
        ]),
        reportPaths: expect.arrayContaining([
          "$COMMON_WORKSPACE/reports/" + dispatched.subtaskId + ".md",
          "$COMMON_WORKSPACE/reports/AsyncWorker.md",
        ]),
        statusExists: true,
        reportExists: false,
      }),
    ]);
    expect(waitResult.hint).toContain("pendingHandoffs.suggestedAction");

    runtime.release();
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });

  it("queues live leader workers until their dependsOn subtasks finish", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-dependent-dispatch-"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    const events = new EventLog(path.join(root, "data", "event"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();

    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "44444444-4444-4444-8444-444444444444",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push(leaderRun);
    });

    const contractRuntime = new DeferredRuntime();
    const implRuntime = new DeferredRuntime();
    const runtimes = [contractRuntime, implRuntime];
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: defaultExecutionPolicy,
        runtimeFactory: () => runtimes.shift() ?? new ImmediateRuntime(),
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: config.dataDirectory,
      baseUrl: "http://127.0.0.1:1",
      register(_token: string, _ingress: CoordinationIngress) {},
      unregister(_token: string) {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(
      leaderRun.id,
    );
    const state = (orchestrator as unknown as { initialState(): unknown }).initialState();
    const api = orchestrator as unknown as {
      dispatchFromLeader(
        leader: Agent,
        leaderRun: AgentRun,
        state: unknown,
        request: { id?: string; agentName: string; prompt: string; dependsOn?: string[] },
        leaderSink: { emit(): void },
      ): Promise<{ status: string; workerRunId: string }>;
      waitForBackgroundDispatches(runId: string): Promise<void>;
      closeTeam(runId: string): void;
    };

    await api.dispatchFromLeader(
      leader,
      leaderRun,
      state,
      { id: "contract", agentName: "ContractWorker", prompt: "write contract" },
      { emit() {} },
    );
    await expect.poll(() => contractRuntime.started).toBe(true);

    await api.dispatchFromLeader(
      leader,
      leaderRun,
      state,
      {
        id: "impl",
        agentName: "ImplWorker",
        prompt: "implement only after contract",
        dependsOn: ["contract"],
      },
      { emit() {} },
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(implRuntime.started).toBe(false);

    contractRuntime.release();
    await expect.poll(() => implRuntime.started, { timeout: 2_000 }).toBe(true);
    implRuntime.release();
    await api.waitForBackgroundDispatches(leaderRun.id);
    expect((state as { workerResults: { subtaskId: string; status: string }[] }).workerResults)
      .toMatchObject([
        { subtaskId: "contract", status: "completed" },
        { subtaskId: "impl", status: "completed" },
      ]);
    api.closeTeam(leaderRun.id);
  });

  it("lets the leader inspect progress and extend an active worker timeout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-extend-worker-"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    const events = new EventLog(path.join(root, "data", "event"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();

    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "33333333-3333-4333-8333-333333333333",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push(leaderRun);
    });

    const runtime = new DeferredRuntime();
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: { ...defaultExecutionPolicy, workerTimeoutMs: 200 },
        runtimeFactory: () => runtime,
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: config.dataDirectory,
      baseUrl: "http://127.0.0.1:1",
      register(_token: string, _ingress: CoordinationIngress) {},
      unregister(_token: string) {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(
      leaderRun.id,
    );
    const state = (orchestrator as unknown as { initialState(): unknown }).initialState();
    const dispatched = await (
      orchestrator as unknown as {
        dispatchFromLeader(
          leader: Agent,
          leaderRun: AgentRun,
          state: unknown,
          request: { agentName: string; prompt: string },
          leaderSink: { emit(): void },
        ): Promise<{ status: string; workerRunId: string }>;
      }
    ).dispatchFromLeader(
      leader,
      leaderRun,
      state,
      { agentName: "SlowUsefulWorker", prompt: "do slow useful worker task" },
      { emit() {} },
    );

    await expect.poll(() => runtime.started).toBe(true);
    const inspected = await (
      orchestrator as unknown as {
        inspectWorkerProgress(runId: string, request: { target: string }): Promise<{
          ok: boolean;
          observational?: boolean;
          authorizesContinuation?: boolean;
          timeout: { remainingMs: number } | null;
        }>;
      }
    ).inspectWorkerProgress(leaderRun.id, { target: dispatched.workerRunId });
    expect(inspected).toMatchObject({ ok: true, observational: true, authorizesContinuation: false });
    expect(inspected.timeout?.remainingMs).toBeGreaterThan(0);

    const extended = await (
      orchestrator as unknown as {
        extendWorkerTimeout(
          runId: string,
          request: { target: string; additionalSeconds: number; reason: string },
          sink: { emit(): void },
        ): Promise<{ ok: boolean; addedMs: number }>;
      }
    ).extendWorkerTimeout(
      leaderRun.id,
      { target: dispatched.workerRunId, additionalSeconds: 1, reason: "still writing useful files" },
      { emit() {} },
    );
    expect(extended).toMatchObject({ ok: true, addedMs: 1000 });

    await new Promise((resolve) => setTimeout(resolve, 250));
    runtime.release();
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    expect((state as { workerResults: { status: string }[] }).workerResults[0]?.status).toBe(
      "completed",
    );
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });

  it("kills mutation: let timeout extension exceed root or accept a non-finite extension", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-timeout-extend-"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    const events = new EventLog(path.join(root, "data", "event"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();
    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      projectId: null,
      unassignedPlacement: "temporary",
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "44444444-4444-4444-8444-444444444444",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push(leaderRun);
    });
    const runtime = new DeferredRuntime();
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: { ...defaultExecutionPolicy, workerTimeoutMs: 200, rootTimeoutMs: 1_000 },
        runtimeFactory: () => runtime,
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: config.dataDirectory,
      baseUrl: "http://127.0.0.1:1",
      register(_token: string, _ingress: CoordinationIngress) {},
      unregister(_token: string) {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(
      leaderRun.id,
    );
    const state = (orchestrator as unknown as { initialState(): unknown }).initialState();
    const dispatched = await (
      orchestrator as unknown as {
        dispatchFromLeader(
          leader: Agent,
          leaderRun: AgentRun,
          state: unknown,
          request: { agentName: string; prompt: string },
          leaderSink: { emit(): void },
        ): Promise<{ status: string; workerRunId: string }>;
      }
    ).dispatchFromLeader(
      leader,
      leaderRun,
      state,
      { agentName: "BoundedWorker", prompt: "do bounded work" },
      { emit() {} },
    );
    await expect.poll(() => runtime.started).toBe(true);
    emitProgress(runtime, "src/bounded.ts");
    const extend = (
      orchestrator as unknown as {
        extendWorkerTimeout(
          runId: string,
          request: { target: string; additionalSeconds: number; reason: string },
          sink: { emit(): void },
        ): Promise<{ ok: boolean; error?: string; addedMs?: number }>;
      }
    ).extendWorkerTimeout.bind(orchestrator);
    const nan = await extend(
      leaderRun.id,
      { target: dispatched.workerRunId, additionalSeconds: Number.NaN, reason: "please" },
      { emit() {} },
    );
    expect(nan.ok).toBe(false);
    const beyondRoot = await extend(
      leaderRun.id,
      { target: dispatched.workerRunId, additionalSeconds: 30, reason: "still going" },
      { emit() {} },
    );
    expect(beyondRoot.ok).toBe(true);
    expect(beyondRoot.addedMs ?? 0).toBeLessThanOrEqual(1_000);
    const control = (
      orchestrator as unknown as { controls: Map<string, { stop(reason: string, message: string): void }> }
    ).controls.get(leaderRun.id);
    control?.stop("root_deadline", "done");
    const afterTerminal = await extend(
      leaderRun.id,
      { target: dispatched.workerRunId, additionalSeconds: 2, reason: "too late" },
      { emit() {} },
    );
    expect(afterTerminal.ok).toBe(false);
    runtime.release();
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });

  it("caps cumulative timeout extraMs to remaining root time", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-timeout-ceiling-"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    const events = new EventLog(path.join(root, "data", "event"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();
    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      projectId: null,
      unassignedPlacement: "temporary",
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "55555555-5555-4555-8555-555555555555",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push(leaderRun);
    });
    const runtime = new DeferredRuntime();
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: {
          ...defaultExecutionPolicy,
          workerTimeoutMs: 14.5 * 60 * 1000,
          rootTimeoutMs: 20 * 60 * 1000,
        },
        runtimeFactory: () => runtime,
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: config.dataDirectory,
      baseUrl: "http://127.0.0.1:1",
      register(_token: string, _ingress: CoordinationIngress) {},
      unregister(_token: string) {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(
      leaderRun.id,
    );
    const state = (orchestrator as unknown as { initialState(): unknown }).initialState();
    const dispatched = await (
      orchestrator as unknown as {
        dispatchFromLeader(
          leader: Agent,
          leaderRun: AgentRun,
          state: unknown,
          request: { agentName: string; prompt: string },
          leaderSink: { emit(): void },
        ): Promise<{ status: string; workerRunId: string }>;
      }
    ).dispatchFromLeader(
      leader,
      leaderRun,
      state,
      { agentName: "CeilingWorker", prompt: "stay under the root lease" },
      { emit() {} },
    );
    await expect.poll(() => runtime.started).toBe(true);
    emitProgress(runtime, "src/ceiling-1.ts");
    const extend = (
      orchestrator as unknown as {
        extendWorkerTimeout(
          runId: string,
          request: { target: string; additionalSeconds: number; reason: string },
          sink: { emit(): void },
        ): Promise<{ ok: boolean; error?: string; addedMs?: number; totalExtraMs?: number }>;
      }
    ).extendWorkerTimeout.bind(orchestrator);
    const first = await extend(
      leaderRun.id,
      { target: dispatched.workerRunId, additionalSeconds: 20, reason: "first" },
      { emit() {} },
    );
    emitProgress(runtime, "src/ceiling-2.ts");
    const second = await extend(
      leaderRun.id,
      { target: dispatched.workerRunId, additionalSeconds: 20, reason: "second" },
      { emit() {} },
    );
    emitProgress(runtime, "src/ceiling-3.ts");
    const third = await extend(
      leaderRun.id,
      { target: dispatched.workerRunId, additionalSeconds: 20, reason: "third" },
      { emit() {} },
    );
    expect(first).toMatchObject({ ok: true, addedMs: 20_000, totalExtraMs: 20_000 });
    expect(second).toMatchObject({ ok: true, addedMs: 20_000, totalExtraMs: 40_000 });
    expect(third).toMatchObject({ ok: true, addedMs: 20_000, totalExtraMs: 60_000 });
    runtime.release();
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });

  it("keeps worker model tokens valid until the team closes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-runtime-lifetime-"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
    });
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    const events = new EventLog(path.join(root, "data", "event"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();

    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "11111111-1111-4111-8111-111111111111",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push(leaderRun);
    });

    const modelProxy = new RecordingModelProxy();
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: defaultExecutionPolicy,
        runtimeFactory: () => new ImmediateRuntime(),
      } as OrchestratorParts,
      () => false,
      modelProxy,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: config.dataDirectory,
      baseUrl: "http://127.0.0.1:1",
      register(_token: string, _ingress: CoordinationIngress) {},
      unregister(_token: string) {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(
      leaderRun.id,
    );

    const subtask: LeaderSubtask = {
      id: "diagram",
      agentName: "Diagrammer",
      title: "Create diagram",
      role: "writer",
      prompt: "write diagram",
      objective: "diagram",
      successCriteria: ["done"],
      expectedOutput: "file",
      dependsOn: [],
    };
    await (
      orchestrator as unknown as {
        runSubtask(
          leader: Agent,
          leaderRun: AgentRun,
          subtask: LeaderSubtask,
          iteration: number,
          attempt: number,
          upstream: [],
          leaderSink: { emit(): void },
        ): Promise<unknown>;
      }
    ).runSubtask(leader, leaderRun, subtask, 1, 1, [], { emit() {} });

    const workerRunId = modelProxy.issued.find((runId) => runId !== leaderRun.id);
    expect(workerRunId).toBeDefined();
    expect(modelProxy.revoked).not.toContain(workerRunId);

    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
    expect(modelProxy.revoked).toContain(workerRunId);
  });

  it("fails closed when healing is enabled without a catalog", () => {
    expect(
      () =>
        new Orchestrator(
          {} as JsonStore,
          {} as WorkspaceManager,
          runner,
          {} as EventLog,
          { healingEnabled: true, policy: defaultExecutionPolicy } as OrchestratorParts,
          () => false,
        ),
    ).toThrow(/missing contract catalog/i);
  });

  it("keeps healing-disabled live dispatch on the compatibility path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-healing-off-"));
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    const events = new EventLog(path.join(root, "data", "event"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();
    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "44444444-4444-4444-8444-444444444444",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push(leaderRun);
    });
    const runtime = new DeferredRuntime();
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: defaultExecutionPolicy,
        runtimeFactory: () => runtime,
        healingEnabled: false,
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: root,
      baseUrl: "http://127.0.0.1:1",
      register() {},
      unregister() {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(
      leaderRun.id,
    );
    const state = (orchestrator as unknown as { initialState(): OrchestrationState }).initialState();
    const dispatched = await (
      orchestrator as unknown as {
        dispatchFromLeader(
          leader: Agent,
          leaderRun: AgentRun,
          state: unknown,
          request: { agentName: string; prompt: string },
          leaderSink: { emit(): void },
        ): Promise<{ status: string }>;
      }
    ).dispatchFromLeader(
      leader,
      leaderRun,
      state,
      { agentName: "CompatWorker", prompt: "do work" },
      { emit() {} },
    );
    expect(dispatched.status).toBe("running");
    await expect.poll(() => runtime.started).toBe(true);
    runtime.release();
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });

  it("admits a healing live dispatch only after compiling and queues unresolved consumers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-live-dag-"));
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    const events = new EventLog(path.join(root, "data", "event"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();
    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "55555555-5555-4555-8555-555555555555",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push(leaderRun);
    });
    const started: string[] = [];
    const runtime = new DeferredRuntime();
    let created = 0;
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: defaultExecutionPolicy,
        healingEnabled: true,
        contractCatalog: [
          {
            contractKey: "backend-producer",
            allowedInputs: ["docs/api.md"],
            allowedOutputs: ["src/api.ts"],
            allowedMutationPaths: ["src/api.ts"],
            protectedPaths: [".launchpad"],
            artifactSchemaIds: ["backend-schema"],
            targetedGateIds: ["backend-targeted"],
            contractGateIds: ["backend-contract"],
            consumerGateIds: ["backend-consumer"],
            regressionGateIds: ["backend-regression"],
            authorizedTools: ["read_file"],
          },
          {
            contractKey: "integration-consumer",
            allowedInputs: ["src/api.ts"],
            allowedOutputs: ["tests/integration.test.ts"],
            allowedMutationPaths: ["tests/integration.test.ts"],
            protectedPaths: [".launchpad"],
            artifactSchemaIds: ["integration-schema"],
            targetedGateIds: ["integration-targeted"],
            contractGateIds: ["integration-contract"],
            consumerGateIds: ["integration-consumer-gate"],
            regressionGateIds: ["integration-regression"],
            authorizedTools: ["read_file"],
          },
        ],
        runtimeFactory: () => {
          created += 1;
          if (created === 1) {
            started.push("start");
            return runtime;
          }
          return new ImmediateRuntime();
        },
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: root,
      baseUrl: "http://127.0.0.1:1",
      register() {},
      unregister() {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(
      leaderRun.id,
    );
    const state = (orchestrator as unknown as { initialState(): OrchestrationState }).initialState();
    const dispatch = (
      request: Record<string, unknown>,
    ) =>
      (
        orchestrator as unknown as {
          dispatchFromLeader(
            leader: Agent,
            leaderRun: AgentRun,
            state: unknown,
            request: unknown,
            leaderSink: { emit(): void },
          ): Promise<{ status: string; subtaskId?: string }>;
        }
      ).dispatchFromLeader(leader, leaderRun, state, request, { emit() {} });

    const backend = await dispatch({
      id: "backend",
      prompt: "write api",
      contractKey: "backend-producer",
      outputs: ["src/api.ts"],
    });
    expect(backend.status).toBe("running");
    expect(state.healing.contracts[0]).toMatchObject({
      subtaskId: "backend",
      targetedGateIds: ["backend-targeted"],
    });
    await expect.poll(() => runtime.started).toBe(true);
    expect(started).toHaveLength(1);

    const queued = await dispatch({
      id: "integration",
      prompt: "write tests",
      contractKey: "integration-consumer",
      dependsOn: ["backend"],
    });
    expect(queued.status).toBe("blocked");
    expect(started).toHaveLength(1);
    expect(state.healing.nodes.find((node) => node.subtaskId === "integration")?.state).toBe(
      "blocked",
    );
    const roster = (
      orchestrator as unknown as {
        teams: Map<string, { roster: { list(): { subtaskId: string }[] } }>;
      }
    ).teams.get(leaderRun.id)?.roster.list() ?? [];
    expect(roster.map((member) => member.subtaskId)).toEqual(["backend"]);
    expect(roster.map((member) => member.subtaskId)).not.toContain("integration");

    await expect(
      dispatch({
        id: "backend",
        prompt: "replace admitted backend",
        contractKey: "backend-producer",
      }),
    ).rejects.toThrow(/already admitted/i);

    runtime.release();
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });

  it("wait=true joins the existing admitted node promise without a duplicate attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-wait-join-"));
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    const events = new EventLog(path.join(root, "data", "event"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();
    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push({ ...leaderRun, project: managedGitProject(leader.workspacePath) });
    });
    const runtime = new DeferredRuntime();
    let factoryCalls = 0;
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: defaultExecutionPolicy,
        healingEnabled: true,
        contractCatalog: HEALING_CATALOG,
        runtimeFactory: () => {
          factoryCalls += 1;
          return runtime;
        },
        ...stubProjectParts(leader.workspacePath),
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: path.join(root, "data"),
      baseUrl: "http://127.0.0.1:1",
      register() {},
      unregister() {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(leaderRun.id);
    const state = (orchestrator as unknown as { initialState(): OrchestrationState }).initialState();
    const dispatch = (
      request: Record<string, unknown>,
    ) =>
      (
        orchestrator as unknown as {
          dispatchFromLeader(
            leader: Agent,
            leaderRun: AgentRun,
            state: unknown,
            request: unknown,
            leaderSink: { emit(): void },
          ): Promise<{ status: string; subtaskId?: string }>;
        }
      ).dispatchFromLeader(leader, leaderRun, state, request, { emit() {} });

    const running = await dispatch({
      id: "backend",
      prompt: "write api",
      contractKey: "backend-producer",
    });
    expect(running.status).toBe("running");
    await expect.poll(() => runtime.started).toBe(true);
    const waiting = dispatch({
      id: "backend",
      prompt: "write api again",
      contractKey: "backend-producer",
      wait: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(factoryCalls).toBe(1);
    runtime.release();
    const joined = await waiting;
    expect(joined.status).toBe("failed");
    expect(factoryCalls).toBe(1);
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });

  it("starts independent project workers asynchronously and overlaps them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-overlap-"));
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    const events = new EventLog(path.join(root, "data", "event"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();
    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "12121212-1212-4121-8121-121212121212",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-28T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-28T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push({ ...leaderRun, project: managedGitProject(leader.workspacePath) });
    });
    const runtimes: InstanceType<typeof DeferredRuntime>[] = [];
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: { ...defaultExecutionPolicy, maxParallel: 3 },
        healingEnabled: true,
        contractCatalog: HEALING_CATALOG,
        runtimeFactory: () => {
          const runtime = new DeferredRuntime();
          runtimes.push(runtime);
          return runtime;
        },
        ...stubProjectParts(leader.workspacePath),
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: path.join(root, "data"),
      baseUrl: "http://127.0.0.1:1",
      register() {},
      unregister() {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(leaderRun.id);
    const state = (orchestrator as unknown as { initialState(): OrchestrationState }).initialState();
    const dispatch = (request: Record<string, unknown>) =>
      (
        orchestrator as unknown as {
          dispatchFromLeader(
            leader: Agent,
            leaderRun: AgentRun,
            state: unknown,
            request: unknown,
            leaderSink: { emit(): void },
          ): Promise<{ status: string }>;
        }
      ).dispatchFromLeader(leader, leaderRun, state, request, { emit() {} });
    const backend = await dispatch({
      id: "backend",
      prompt: "write api",
      contractKey: "backend-producer",
    });
    const frontend = await dispatch({
      id: "frontend",
      prompt: "write ui",
      contractKey: "backend-producer",
    });
    expect(backend.status).toBe("running");
    expect(frontend.status).toBe("running");
    await expect.poll(() => runtimes.length).toBe(2);
    expect(runtimes.every((item) => item.started)).toBe(true);
    const queued = await dispatch({
      id: "integration",
      prompt: "write tests",
      contractKey: "integration-consumer",
      dependsOn: ["backend", "frontend"],
    });
    expect(queued.status).toBe("blocked");
    expect(runtimes).toHaveLength(2);
    for (const runtime of runtimes) runtime.release();
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });

  it("cancels a stalled worker before the deadline, records three checkpoints, and skips collection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-stall-stop-"));
    const events = new EventLog(path.join(root, "data", "event"));
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();
    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "66666666-6666-4666-8666-666666666666",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-29T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-29T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push({ ...leaderRun, project: ephemeralProject(leader.workspacePath) });
    });
    const runtime = new DeferredRuntime();
    const startedAt = Date.now();
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: { ...defaultExecutionPolicy, workerTimeoutMs: 15 * 60 * 1000 },
        runtimeFactory: () => runtime,
        healingEnabled: true,
        contractCatalog: HEALING_CATALOG,
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: path.join(root, "data"),
      baseUrl: "http://127.0.0.1:1",
      register() {},
      unregister() {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(leaderRun.id);
    const state = (orchestrator as unknown as { initialState(): OrchestrationState }).initialState();
    const dispatched = await (
      orchestrator as unknown as {
        dispatchFromLeader(
          leader: Agent,
          leaderRun: AgentRun,
          state: unknown,
          request: { agentName: string; prompt: string },
          leaderSink: { emit(): void },
        ): Promise<{ status: string; workerRunId: string }>;
      }
    ).dispatchFromLeader(
      leader,
      leaderRun,
      state,
      { agentName: "StuckTester", prompt: "keep failing tests", contractKey: "backend-producer" },
      { emit() {} },
    );
    await expect.poll(() => runtime.started).toBe(true);
    emitFailedTest(runtime, "t1");
    emitFailedTest(runtime, "t2");
    emitFailedTest(runtime, "t3");
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    expect(Date.now() - startedAt).toBeLessThan(15 * 60 * 1000);
    expect(runtime.cancelled.length).toBeGreaterThan(0);
    expect(runtime.quiesced.length).toBeGreaterThan(0);
    const worker = state.workerResults[0];
    expect(worker?.status).toBe("failed");
    expect(worker?.contribution).toBeUndefined();
    expect(state.healing.faults[0]).toMatchObject({ class: "stall", repairable: false });
    expect(state.healing.snapshots.length).toBeGreaterThan(0);
    expect(
      state.healing.faults[0]?.evidenceRefs.every((id) =>
        state.healing.snapshots.some((snapshot) => snapshot.id === id),
      ),
    ).toBe(true);
    const monitor = (
      orchestrator as unknown as { monitors: Map<string, { snapshots(): unknown[] }> }
    ).monitors.get(dispatched.workerRunId);
    expect(monitor?.snapshots()).toHaveLength(3);
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });

  it("stops a silent hang after three unchanged timer checkpoints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-timer-stall-"));
    const events = new EventLog(path.join(root, "data", "event"));
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();
    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "77777777-7777-4777-8777-777777777777",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-29T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-29T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push({ ...leaderRun, project: ephemeralProject(leader.workspacePath) });
    });
    let nowMs = 1_000;
    const timers: { due: number; fn: () => void }[] = [];
    const clock = {
      now: () => nowMs,
      setTimeout(fn: () => void, ms: number) {
        const handle = { due: nowMs + ms, fn };
        timers.push(handle);
        return handle as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout(id: ReturnType<typeof setTimeout>) {
        const index = timers.indexOf(id as unknown as { due: number; fn: () => void });
        if (index >= 0) timers.splice(index, 1);
      },
    };
    const runtime = new DeferredRuntime();
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: { ...defaultExecutionPolicy, workerTimeoutMs: 15 * 60 * 1000 },
        runtimeFactory: () => runtime,
        trajectoryClock: clock,
        trajectoryCheckpointMs: 60_000,
        healingEnabled: true,
        contractCatalog: HEALING_CATALOG,
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: path.join(root, "data"),
      baseUrl: "http://127.0.0.1:1",
      register() {},
      unregister() {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(leaderRun.id);
    const state = (orchestrator as unknown as { initialState(): OrchestrationState }).initialState();
    await (
      orchestrator as unknown as {
        dispatchFromLeader(
          leader: Agent,
          leaderRun: AgentRun,
          state: unknown,
          request: { agentName: string; prompt: string },
          leaderSink: { emit(): void },
        ): Promise<{ status: string; workerRunId: string }>;
      }
    ).dispatchFromLeader(
      leader,
      leaderRun,
      state,
      { agentName: "SilentJob", prompt: "hang", contractKey: "backend-producer" },
      { emit() {} },
    );
    await expect.poll(() => runtime.started).toBe(true);
    for (let step = 0; step < 3; step += 1) {
      nowMs += 60_000;
      for (const timer of [...timers]) {
        if (timer.due <= nowMs) timer.fn();
      }
    }
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    expect(runtime.cancelled.length).toBeGreaterThan(0);
    expect(state.healing.faults[0]?.class).toBe("stall");
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });

  it("does not cancel when failure counts and job output hashes keep changing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-progress-keep-"));
    const events = new EventLog(path.join(root, "data", "event"));
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();
    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "88888888-8888-4888-8888-888888888888",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-29T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-29T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push(leaderRun);
    });
    const runtime = new DeferredRuntime();
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: { ...defaultExecutionPolicy, workerTimeoutMs: 15 * 60 * 1000 },
        runtimeFactory: () => runtime,
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: path.join(root, "data"),
      baseUrl: "http://127.0.0.1:1",
      register() {},
      unregister() {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(leaderRun.id);
    const state = (orchestrator as unknown as { initialState(): OrchestrationState }).initialState();
    const dispatched = await (
      orchestrator as unknown as {
        dispatchFromLeader(
          leader: Agent,
          leaderRun: AgentRun,
          state: unknown,
          request: { agentName: string; prompt: string },
          leaderSink: { emit(): void },
        ): Promise<{ status: string; workerRunId: string }>;
      }
    ).dispatchFromLeader(
      leader,
      leaderRun,
      state,
      { agentName: "ImprovingTester", prompt: "fix tests" },
      { emit() {} },
    );
    await expect.poll(() => runtime.started).toBe(true);
    emitFailedTest(runtime, "a", "Tests: 5 failed, 0 passed");
    emitFailedTest(runtime, "b", "Tests: 3 failed, 2 passed");
    emitFailedTest(runtime, "c", "Tests: 1 failed, 4 passed");
    runtime.sink?.emit({
      spanId: "job-1",
      parentSpanId: "run",
      kind: "mcp_tool",
      name: "launchpad.read_job_output",
      status: "ok",
      startedAt: "2026-08-29T00:00:00.000Z",
      endedAt: "2026-08-29T00:00:01.000Z",
      durationMs: 10,
      input: { tool: "launchpad.read_job_output", text: '{"job_id":"aaa","stdout_offset":0}' },
      output: { text: "compiling pass-1" },
      error: null,
      attributes: {},
      usage: null,
    });
    runtime.sink?.emit({
      spanId: "job-2",
      parentSpanId: "run",
      kind: "mcp_tool",
      name: "launchpad.read_job_output",
      status: "ok",
      startedAt: "2026-08-29T00:00:00.000Z",
      endedAt: "2026-08-29T00:00:01.000Z",
      durationMs: 10,
      input: { tool: "launchpad.read_job_output", text: '{"job_id":"bbb","stdout_offset":80}' },
      output: { text: "compiling pass-2 with new objects" },
      error: null,
      attributes: {},
      usage: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.cancelled).toEqual([]);
    const inspected = await (
      orchestrator as unknown as {
        inspectWorkerProgress(
          runId: string,
          request: { target: string; maxEvents?: number },
        ): Promise<{
          ok: boolean;
          observational: boolean;
          authorizesContinuation: boolean;
          recent: { name: string }[];
        }>;
      }
    ).inspectWorkerProgress(leaderRun.id, { target: dispatched.workerRunId, maxEvents: 20 });
    expect(inspected).toMatchObject({ ok: true, observational: true, authorizesContinuation: false });
    runtime.release();
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });

  it("inspects the newest EventLog tail and checkpoint, not the first page", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-inspect-tail-"));
    const events = new EventLog(path.join(root, "data", "event"));
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();
    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "99999999-9999-4999-8999-999999999999",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-29T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-29T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push(leaderRun);
    });
    const runtime = new DeferredRuntime();
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      { policy: defaultExecutionPolicy, runtimeFactory: () => runtime } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: path.join(root, "data"),
      baseUrl: "http://127.0.0.1:1",
      register() {},
      unregister() {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(leaderRun.id);
    const state = (orchestrator as unknown as { initialState(): unknown }).initialState();
    const dispatched = await (
      orchestrator as unknown as {
        dispatchFromLeader(
          leader: Agent,
          leaderRun: AgentRun,
          state: unknown,
          request: { agentName: string; prompt: string },
          leaderSink: { emit(): void },
        ): Promise<{ status: string; workerRunId: string }>;
      }
    ).dispatchFromLeader(
      leader,
      leaderRun,
      state,
      { agentName: "BusyWriter", prompt: "write many files" },
      { emit() {} },
    );
    await expect.poll(() => runtime.started).toBe(true);
    for (let index = 0; index < 40; index += 1) {
      emitProgress(runtime, "src/file-" + index + ".ts");
    }
    await events.flush(dispatched.workerRunId);
    const inspected = await (
      orchestrator as unknown as {
        inspectWorkerProgress(
          runId: string,
          request: { target: string; maxEvents?: number },
        ): Promise<{
          ok: boolean;
          observational: boolean;
          authorizesContinuation: boolean;
          recent: { name: string; text?: string }[];
          checkpoint: { checkpointId: string } | null;
        }>;
      }
    ).inspectWorkerProgress(leaderRun.id, { target: dispatched.workerRunId, maxEvents: 12 });
    expect(inspected.observational).toBe(true);
    expect(inspected.authorizesContinuation).toBe(false);
    expect(inspected.recent.some((item) => item.text?.includes("src/file-39.ts"))).toBe(true);
    expect(inspected.recent.some((item) => item.text?.includes("src/file-0.ts"))).toBe(false);
    expect(inspected.observational).toBe(true);
    runtime.release();
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });

  it("lets a healing-off 50-event progressing worker survive the 20-step cap", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-heal-off-50-"));
    const events = new EventLog(path.join(root, "data", "event"));
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();
    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-29T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-29T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push(leaderRun);
    });
    const runtime = new DeferredRuntime();
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: { ...defaultExecutionPolicy, workerTimeoutMs: 15 * 60 * 1000 },
        runtimeFactory: () => runtime,
        healingEnabled: false,
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: path.join(root, "data"),
      baseUrl: "http://127.0.0.1:1",
      register() {},
      unregister() {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(leaderRun.id);
    const state = (orchestrator as unknown as { initialState(): OrchestrationState }).initialState();
    await (
      orchestrator as unknown as {
        dispatchFromLeader(
          leader: Agent,
          leaderRun: AgentRun,
          state: unknown,
          request: { agentName: string; prompt: string },
          leaderSink: { emit(): void },
        ): Promise<{ status: string }>;
      }
    ).dispatchFromLeader(leader, leaderRun, state, { agentName: "LongWorker", prompt: "keep going" }, { emit() {} });
    await expect.poll(() => runtime.started).toBe(true);
    for (let index = 0; index < 50; index += 1) {
      emitCompletedTool(runtime, "tool-" + index, "src/file-" + index + ".ts");
      emitProgress(runtime, "src/file-" + index + ".ts");
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.cancelled).toEqual([]);
    runtime.release();
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    expect((state as { workerResults: { status: string }[] }).workerResults[0]?.status).toBe("completed");
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });

  it("stops a healing-on Git project worker at 20 normalized runtime steps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-heal-on-20-"));
    const events = new EventLog(path.join(root, "data", "event"));
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();
    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-29T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-29T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    const project = managedGitProject(leader.workspacePath);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push({ ...leaderRun, project });
    });
    const runtime = new DeferredRuntime();
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: { ...defaultExecutionPolicy, workerTimeoutMs: 15 * 60 * 1000, maxRuntimeSteps: 20 },
        runtimeFactory: () => runtime,
        healingEnabled: true,
        contractCatalog: HEALING_CATALOG,
        ...stubProjectParts(leader.workspacePath),
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: path.join(root, "data"),
      baseUrl: "http://127.0.0.1:1",
      register() {},
      unregister() {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(leaderRun.id);
    const state = (orchestrator as unknown as { initialState(): OrchestrationState }).initialState();
    const dispatching = (
      orchestrator as unknown as {
        dispatchFromLeader(
          leader: Agent,
          leaderRun: AgentRun,
          state: unknown,
          request: { agentName: string; prompt: string; contractKey: string },
          leaderSink: { emit(): void },
        ): Promise<{ status: string }>;
      }
    ).dispatchFromLeader(
      leader,
      leaderRun,
      state,
      { agentName: "StepWorker", prompt: "many tools", contractKey: "backend-producer" },
      { emit() {} },
    );
    await expect.poll(() => runtime.started).toBe(true);
    for (let index = 0; index < 21; index += 1) {
      emitCompletedTool(runtime, "step-" + index, "src/api-" + index + ".ts");
    }
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    expect(runtime.cancelled.length).toBeGreaterThan(0);
    expect(state.healing.faults[0]).toMatchObject({ class: "stall", repairable: true });
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
    expect(
      (orchestrator as unknown as { monitors: Map<string, unknown> }).monitors.size,
    ).toBe(0);
    expect(
      (orchestrator as unknown as { liveOrchestration: Map<string, unknown> }).liveOrchestration.has(
        leaderRun.id,
      ),
    ).toBe(false);
  });

  it("kills mutation: accept leader timeout rationale without trusted progress", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-heal-lease-"));
    const events = new EventLog(path.join(root, "data", "event"));
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    await store.initialize();
    await workspaces.initialize();
    await events.initialize();
    const leader: Agent = {
      id: "leader-agent",
      name: "Leader",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      workspacePath: workspaces.workspacePath("leader-agent"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
    };
    const leaderRun: AgentRun = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      agentId: leader.id,
      kind: "orchestration",
      parentRunId: null,
      orchestration: null,
      status: "running",
      prompt: "lead",
      output: null,
      error: null,
      usage: null,
      startedAt: "2026-08-29T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-29T00:00:00.000Z",
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push({ ...leaderRun, project: managedGitProject(leader.workspacePath) });
    });
    const runtime = new DeferredRuntime();
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: { ...defaultExecutionPolicy, workerTimeoutMs: 5_000 },
        runtimeFactory: () => runtime,
        healingEnabled: true,
        contractCatalog: HEALING_CATALOG,
        ...stubProjectParts(leader.workspacePath),
      } as OrchestratorParts,
      () => false,
    );
    (orchestrator as unknown as { coordination: unknown }).coordination = {
      dataDir: path.join(root, "data"),
      baseUrl: "http://127.0.0.1:1",
      register() {},
      unregister() {},
    };
    await (orchestrator as unknown as { openTeam(runId: string): Promise<void> }).openTeam(leaderRun.id);
    const state = (orchestrator as unknown as { initialState(): OrchestrationState }).initialState();
    const dispatching = (
      orchestrator as unknown as {
        dispatchFromLeader(
          leader: Agent,
          leaderRun: AgentRun,
          state: unknown,
          request: { agentName: string; prompt: string; contractKey: string },
          sink: { emit(): void },
        ): Promise<unknown>;
      }
    ).dispatchFromLeader(
      leader,
      leaderRun,
      state,
      { agentName: "LeaseWorker", prompt: "work", contractKey: "backend-producer" },
      { emit() {} },
    );
    await expect.poll(() => runtime.started).toBe(true);
    const denied = await (
      orchestrator as unknown as {
        extendWorkerTimeout(
          runId: string,
          request: { target: string; additionalSeconds: number; reason: string },
          sink: { emit(): void },
        ): Promise<{ ok: boolean; error?: string }>;
      }
    ).extendWorkerTimeout(
      leaderRun.id,
      { target: "LeaseWorker", additionalSeconds: 1, reason: "please" },
      { emit() {} },
    );
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/NO_FRESH_PROGRESS|progress/i);
    runtime.release();
    await (
      orchestrator as unknown as { waitForBackgroundDispatches(runId: string): Promise<void> }
    ).waitForBackgroundDispatches(leaderRun.id);
    (orchestrator as unknown as { closeTeam(runId: string): void }).closeTeam(leaderRun.id);
  });
});
