/** Root deadline, cancellation, and late-completion races at every wait. */
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { EventLog } from "../src/event-log.js";
import { Orchestrator, type OrchestratorParts } from "../src/orchestration/orchestrator.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import {
  RunControl,
  type RunClock,
} from "../src/orchestration/run-control.js";
import { JsonStore } from "../src/store.js";
import type {
  Agent,
  AgentRunner,
  AgentRun,
  LeaderSubtask,
  OrchestrationState,
  RunnerRequest,
  WorkerResult,
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

class HungRuntime implements AgentRuntime {
  started = false;
  cancels = 0;
  private releaseStart!: () => void;
  private readonly hang = new Promise<void>((resolve) => {
    this.releaseStart = resolve;
  });

  complete(output = "late success"): void {
    this.output = output;
    this.releaseStart();
  }

  private output = "late success";

  async start(request: RunnerRequest): Promise<WorkerCheckpoint> {
    this.started = true;
    await this.hang;
    return {
      threadId: request.threadId ?? "thread-" + request.runId,
      output: this.output,
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
    this.complete("closed");
  }
  async cancel(_reason: string): Promise<void> {
    this.cancels += 1;
  }
  async quiesce(_reason: string): Promise<void> {}
}

class CompletingRuntime implements AgentRuntime {
  started = false;
  cancels = 0;
  constructor(private readonly output = "done") {}
  async start(request: RunnerRequest): Promise<WorkerCheckpoint> {
    this.started = true;
    return {
      threadId: request.threadId ?? "thread-" + request.runId,
      output: this.output,
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
  async close(_reason: string): Promise<void> {}
  async cancel(_reason: string): Promise<void> {
    this.cancels += 1;
  }
  async quiesce(_reason: string): Promise<void> {}
}

class RejectingCancelRuntime extends HungRuntime {
  override async cancel(_reason: string): Promise<void> {
    this.cancels += 1;
    throw new Error("process group still alive");
  }
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

function createClock(start = 0): RunClock & { advance(ms: number): void } {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fireAt: now + Number(ms), fn: fn as () => void });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(id) {
      timers.delete(id as unknown as number);
    },
    advance(ms: number) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.fireAt <= now)
        .sort((left, right) => left[1].fireAt - right[1].fireAt);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

function leaderAgent(workspaces: WorkspaceManager, id = "leader-agent"): Agent {
  return {
    id,
    name: "Leader",
    description: "",
    instructions: "",
    status: "busy",
    role: "leader",
    parentAgentId: null,
    specialty: null,
    projectId: null,
    unassignedPlacement: "temporary",
    workspacePath: workspaces.workspacePath(id),
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
}

function leaderRunFor(leader: Agent, id: string): AgentRun {
  return {
    id,
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
}

const workerSubtask: LeaderSubtask = {
  id: "w1",
  title: "Work",
  role: "worker",
  prompt: "do the work",
  objective: "finish",
  successCriteria: ["done"],
  expectedOutput: "a result",
  dependsOn: [],
};

const plannerParts = {
  planner: {
    plan: async () => ({
      status: "available" as const,
      plan: {
        needsSubagents: true,
        rationale: "delegate",
        subtasks: [workerSubtask],
      },
      model: "m",
      promptVersion: "p1",
    }),
  },
  evaluator: { evaluate: async () => { throw new Error("evaluator must not run after deadline"); } },
  replanner: { replan: async () => { throw new Error("replanner must not run after deadline"); } },
  synthesizer: { synthesize: async () => { throw new Error("synthesizer must not run after deadline"); } },
};

async function setup(options: {
  coordination?: boolean;
  hung?: HungRuntime;
  policy?: Partial<typeof defaultExecutionPolicy>;
  clock?: RunClock;
  parts?: Partial<OrchestratorParts>;
}) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-terminal-"));
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
  const leader = leaderAgent(workspaces);
  const run = leaderRunFor(leader, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  await workspaces.create(leader);
  await workspaces.createCommon(run.id);
  await store.mutate((database) => {
    database.agents.push(leader);
    database.runs.push(run);
  });
  const hung = options.hung ?? new HungRuntime();
  const clock = options.clock ?? createClock();
  const orchestrator = new Orchestrator(
    store,
    workspaces,
    runner,
    events,
    {
      ...plannerParts,
      policy: {
        ...defaultExecutionPolicy,
        rootTimeoutMs: 25,
        workerTimeoutMs: 60_000,
        ...options.policy,
      },
      runtimeFactory: () => hung,
      clock,
      ...(options.coordination
        ? {
            coordination: {
              dataDir: config.dataDirectory,
              baseUrl: "http://127.0.0.1:1",
              register(_token: string, _ingress: CoordinationIngress) {},
              unregister(_token: string) {},
            },
          }
        : {}),
      ...options.parts,
    } as OrchestratorParts,
    () => false,
  );
  return { store, workspaces, events, leader, run, hung, clock, orchestrator, config };
}

function internals(orchestrator: Orchestrator) {
  return orchestrator as unknown as {
    activeRuntimes: Map<string, Map<string, AgentRuntime>>;
    activeRunKeys: Map<string, Set<string>>;
    backgroundDispatches: Map<string, Set<Promise<unknown>>>;
    controls: Map<string, RunControl>;
    openTeam(runId: string): Promise<void>;
    closeTeam(runId: string): void;
    initialState(): OrchestrationState;
    dispatchFromLeader(
      leader: Agent,
      leaderRun: AgentRun,
      state: OrchestrationState,
      request: { agentName?: string; prompt: string; wait?: boolean; id?: string },
      leaderSink: { emit(): void },
    ): Promise<{ status: string; workerRunId?: string }>;
    waitForBackgroundDispatches(runId: string): Promise<void>;
    drainBackgroundDispatches(runId: string): Promise<void>;
    extendWorkerTimeout(
      runId: string,
      request: { target: string; additionalSeconds: number; reason?: string },
      sink: { emit(): void },
    ): Promise<{ ok: boolean; error?: string; addedMs?: number }>;
    inspectWorkerProgress(
      runId: string,
      request: { target: string },
    ): Promise<{ ok: boolean }>;
  };
}

describe("root deadline at every unbounded wait", () => {
  it("fails a planned worker whose start never settles with root_deadline", async () => {
    const { store, leader, run, hung, clock, orchestrator } = await setup({});
    const pending = orchestrator.run(leader, run);
    await expect.poll(() => hung.started).toBe(true);
    clock.advance(25);
    await pending;
    const stored = store.snapshot().runs.find((item) => item.id === run.id)!;
    expect(stored.status).toBe("failed");
    expect(stored.output).toBeNull();
    expect(stored.error).toMatch(/root deadline/i);
    expect(hung.cancels).toBe(1);
    expect(internals(orchestrator).activeRuntimes.get(run.id)?.size ?? 0).toBe(0);
    expect(internals(orchestrator).backgroundDispatches.get(run.id)?.size ?? 0).toBe(0);
  });

  it("fails a live Codex leader whose start never settles with root_deadline", async () => {
    const { store, leader, run, hung, clock, orchestrator } = await setup({
      coordination: true,
    });
    const pending = orchestrator.run(leader, run);
    await expect.poll(() => hung.started).toBe(true);
    clock.advance(25);
    await pending;
    const stored = store.snapshot().runs.find((item) => item.id === run.id)!;
    expect(stored.status).toBe("failed");
    expect(stored.output).toBeNull();
    expect(stored.error).toMatch(/root deadline/i);
    expect(hung.cancels).toBe(1);
    expect(internals(orchestrator).activeRuntimes.get(run.id)?.size ?? 0).toBe(0);
  });

  it("fails a solo fallback whose start never settles with root_deadline", async () => {
    const hung = new HungRuntime();
    const { store, leader, run, clock, orchestrator } = await setup({
      hung,
      parts: {
        planner: {
          plan: async () => ({
            status: "available",
            plan: { needsSubagents: false, rationale: "solo", subtasks: [] },
            model: "m",
            promptVersion: "p1",
          }),
        },
      } as Partial<OrchestratorParts>,
    });
    const pending = orchestrator.run(leader, run);
    await expect.poll(() => hung.started).toBe(true);
    clock.advance(25);
    await pending;
    const stored = store.snapshot().runs.find((item) => item.id === run.id)!;
    expect(stored.status).toBe("failed");
    expect(stored.output).toBeNull();
    expect(stored.error).toMatch(/root deadline/i);
    expect(hung.cancels).toBe(1);
  });

  it("races wait=true live dispatch against the root deadline", async () => {
    const clock = createClock();
    const hung = new HungRuntime();
    const { leader, run, orchestrator } = await setup({
      coordination: true,
      hung,
      clock,
    });
    const api = internals(orchestrator);
    await api.openTeam(run.id);
    const state = api.initialState();
    const pending = api.dispatchFromLeader(
      leader,
      run,
      state,
      { id: "blocked-wait", prompt: "wait for me", wait: true },
      { emit() {} },
    );
    await expect.poll(() => hung.started).toBe(true);
    clock.advance(25);
    await expect(pending).rejects.toMatchObject({ reason: "root_deadline" });
    expect(hung.cancels).toBe(1);
    api.closeTeam(run.id);
  });

  it("drains asynchronous live-leader dispatch on deadline and cancels the worker once", async () => {
    const clock = createClock();
    const worker = new HungRuntime();
    const { store, leader, run, orchestrator } = await setup({
      coordination: true,
      hung: worker,
      clock,
    });
    const api = internals(orchestrator);
    await api.openTeam(run.id);
    const state = api.initialState();
    const dispatched = await api.dispatchFromLeader(
      leader,
      run,
      state,
      { agentName: "AsyncWorker", prompt: "run in the background" },
      { emit() {} },
    );
    expect(dispatched.status).toBe("running");
    await expect.poll(() => worker.started).toBe(true);
    clock.advance(25);
    await api.waitForBackgroundDispatches(run.id);
    expect(worker.cancels).toBe(1);
    expect(store.snapshot().runs.find((item) => item.id === run.id)?.output).toBeNull();
    expect(api.backgroundDispatches.get(run.id)?.size ?? 0).toBe(0);
    api.closeTeam(run.id);
  });

  it("does not publish a completed planned run until background dispatches drain", async () => {
    let orchestrator!: Orchestrator;
    let release!: () => void;
    const gated = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tracked: Promise<WorkerResult> = gated.then(() => ({
      subtaskId: "bg",
      workerId: "w",
      workerRunId: "bg-run",
      iteration: 1,
      attempt: 1,
      status: "completed",
      output: "bg",
      error: null,
      usage: null,
      durationMs: 1,
      artifacts: [],
    }));
    const passingParts = {
      evaluator: {
        evaluate: async () => ({
          status: "available" as const,
          model: "evaluator",
          promptVersion: "v1",
          evaluation: {
            sufficient: true,
            subtaskEvaluations: [],
            missingInformation: [],
          },
        }),
      },
      synthesizer: {
        synthesize: async () => {
          const dispatches = internals(orchestrator).backgroundDispatches.get(ctx.run.id)
            ?? new Set<Promise<WorkerResult>>();
          dispatches.add(tracked);
          internals(orchestrator).backgroundDispatches.set(ctx.run.id, dispatches);
          void tracked.finally(() => {
            const current = internals(orchestrator).backgroundDispatches.get(ctx.run.id);
            current?.delete(tracked);
            if (current?.size === 0) internals(orchestrator).backgroundDispatches.delete(ctx.run.id);
          });
          return { output: "synth-out", model: "m", promptVersion: "v1" };
        },
      },
    };
    const ctx = await setup({
      hung: new CompletingRuntime("worker-done"),
      policy: { rootTimeoutMs: 60_000, workerTimeoutMs: 60_000 },
      parts: passingParts as Partial<OrchestratorParts>,
    });
    orchestrator = ctx.orchestrator;
    const pending = ctx.orchestrator.run(ctx.leader, ctx.run);
    await expect.poll(
      () => internals(orchestrator).backgroundDispatches.get(ctx.run.id)?.size ?? 0,
    ).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(ctx.store.snapshot().runs.find((item) => item.id === ctx.run.id)?.status)
      .not.toBe("completed");
    release();
    await pending;
    expect(ctx.store.snapshot().runs.find((item) => item.id === ctx.run.id)?.status)
      .toBe("completed");
  });

  it("unblocks drain when the root deadline fires during a stalled background dispatch", async () => {
    let orchestrator!: Orchestrator;
    const stalled = new Promise<WorkerResult>(() => undefined);
    const clock = createClock();
    const ctx = await setup({
      hung: new CompletingRuntime("worker-done"),
      clock,
      policy: { rootTimeoutMs: 25, workerTimeoutMs: 60_000 },
      parts: {
        evaluator: {
          evaluate: async () => ({
            status: "available",
            model: "evaluator",
            promptVersion: "v1",
            evaluation: {
              sufficient: true,
              subtaskEvaluations: [],
              missingInformation: [],
            },
          }),
        },
        synthesizer: {
          synthesize: async () => {
            internals(orchestrator).backgroundDispatches.set(
              ctx.run.id,
              new Set([stalled]),
            );
            return { output: "synth-out", model: "m", promptVersion: "v1" };
          },
        },
      } as Partial<OrchestratorParts>,
    });
    orchestrator = ctx.orchestrator;
    const pending = ctx.orchestrator.run(ctx.leader, ctx.run);
    await expect.poll(
      () => internals(orchestrator).backgroundDispatches.get(ctx.run.id)?.size ?? 0,
    ).toBeGreaterThan(0);
    clock.advance(25);
    await pending;
    const stored = ctx.store.snapshot().runs.find((item) => item.id === ctx.run.id)!;
    expect(stored.status).not.toBe("running");
    expect(stored.status).not.toBe("completed");
  });

  it("keeps a runtime in the cancellation map when cancel fails to prove absence", async () => {
    const hung = new RejectingCancelRuntime();
    const { orchestrator, leader, run, clock } = await setup({ hung });
    const pending = orchestrator.run(leader, run);
    await expect.poll(() => hung.started).toBe(true);
    clock.advance(25);
    await pending;
    expect(hung.cancels).toBe(1);
    expect(internals(orchestrator).activeRuntimes.get(run.id)?.size ?? 0).toBe(1);
  });

  it("releases the live leader runtime after a successful run", async () => {
    const runtime = new CompletingRuntime("leader-done");
    const { store, leader, run, orchestrator } = await setup({
      coordination: true,
      hung: runtime,
      policy: { rootTimeoutMs: 60_000, workerTimeoutMs: 60_000 },
    });
    await orchestrator.run(leader, run);
    expect(store.snapshot().runs.find((item) => item.id === run.id)?.status).toBe("completed");
    expect(internals(orchestrator).activeRuntimes.get(run.id)?.size ?? 0).toBe(0);
  });

  it("releases the solo fallback runtime after a successful run", async () => {
    const runtime = new CompletingRuntime("solo-done");
    const { store, leader, run, orchestrator } = await setup({
      hung: runtime,
      policy: { rootTimeoutMs: 60_000 },
      parts: {
        planner: {
          plan: async () => ({
            status: "available",
            plan: { needsSubagents: false, rationale: "solo", subtasks: [] },
            model: "m",
            promptVersion: "p1",
          }),
        },
      } as Partial<OrchestratorParts>,
    });
    await orchestrator.run(leader, run);
    expect(store.snapshot().runs.find((item) => item.id === run.id)?.status).toBe("completed");
    expect(internals(orchestrator).activeRuntimes.get(run.id)?.size ?? 0).toBe(0);
  });
});

describe("late completion cannot mutate a terminal run", () => {
  it("ignores a late async worker success after the live leader has already failed", async () => {
    const worker = new HungRuntime();
    const { leader, run, orchestrator } = await setup({
      coordination: true,
      parts: {
        runtimeFactory: () => worker,
        policy: { ...defaultExecutionPolicy, rootTimeoutMs: 60_000, workerTimeoutMs: 60_000 },
      } as Partial<OrchestratorParts>,
    });
    const api = internals(orchestrator);
    await api.openTeam(run.id);
    const state = api.initialState();
    state.healing.nodes.push({
      subtaskId: "late",
      revision: 1,
      state: "running",
      blockedBy: [],
      attemptId: null,
      faultId: null,
      diagnosisId: null,
      tournamentId: null,
      verificationIds: [],
      integrationContributionId: null,
      updatedAt: "2026-08-29T00:00:00.000Z",
    });
    const dispatched = await api.dispatchFromLeader(
      leader,
      run,
      state,
      { id: "late", agentName: "LateWorker", prompt: "finish after the leader dies" },
      { emit() {} },
    );
    expect(dispatched.status).toBe("running");
    await expect.poll(() => worker.started).toBe(true);
    const control = api.controls.get(run.id);
    expect(control).toBeDefined();
    control!.stop("root_deadline", "leader failed first");
    worker.complete("I finished anyway");
    await api.waitForBackgroundDispatches(run.id);
    expect(state.workerResults.some((item) => item.status === "completed")).toBe(false);
    expect(state.healing.nodes.find((node) => node.subtaskId === "late")?.revision).toBe(1);
    expect(state.healing.nodes.find((node) => node.subtaskId === "late")?.state).not.toBe(
      "completed",
    );
    api.closeTeam(run.id);
  });
});
