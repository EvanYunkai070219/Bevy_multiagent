/** Milestone 1 vertical-slice acceptance tests for Git-backed orchestration. */
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../src/agent-service.js";
import { EventLog } from "../src/event-log.js";
import { GitClient } from "../src/git-client.js";
import type { OrchestratorParts } from "../src/orchestration/orchestrator.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { ProjectRegistry } from "../src/project-registry.js";
import { ProjectRepositoryManager } from "../src/project-repository-manager.js";
import { ProjectRunManager } from "../src/project-run-manager.js";
import { loadConfig } from "../src/config.js";
import { JsonStore } from "../src/store.js";
import type {
  AgentRunner,
  LeaderPlan,
  RunnerRequest,
  RunnerResult,
} from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface SourceSnapshot {
  branch: string;
  head: string;
  index: string;
  status: string;
}

interface Fixture {
  root: string;
  source: string;
  git: GitClient;
  config: ReturnType<typeof loadConfig>;
  store: JsonStore;
  workspaces: WorkspaceManager;
  events: EventLog;
  service: AgentService;
}

function completedCommand(request: RunnerRequest, name: string): void {
  const timestamp = new Date().toISOString();
  request.sink?.emit({
    spanId: "fixture-" + name,
    parentSpanId: "run",
    kind: "command",
    name,
    status: "ok",
    startedAt: timestamp,
    endedAt: timestamp,
    durationMs: 0,
    input: {},
    output: { exitCode: 0 },
    error: null,
    attributes: {},
    usage: null,
  });
}

function taskId(request: RunnerRequest): string {
  const match = /^TASK:([a-z-]+)/.exec(request.prompt);
  if (!match) throw new Error("fixture task marker missing");
  return match[1]!;
}

async function commitFile(
  git: GitClient,
  request: RunnerRequest,
  file: string,
  content: string,
): Promise<RunnerResult> {
  await writeFile(path.join(request.workspacePath, file), content, "utf8");
  await git.run(request.workspacePath, ["add", "--", file]);
  await git.run(request.workspacePath, ["commit", "-m", "fixture " + file]);
  const head = await git.head(request.workspacePath);
  completedCommand(request, "git commit");
  return {
    output: "findings: fixture complete\nevidence: " + file + "\nunresolved gaps: none\nrecommended next checks: structural gate\nLAUNCHPAD_COMMIT=" + head,
    threadId: null,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function parts(plan: LeaderPlan, overrides: Partial<OrchestratorParts> = {}): OrchestratorParts {
  return {
    policy: {
      ...defaultExecutionPolicy,
      maxParallel: 3,
      maxSubtasks: 6,
      maxIterations: 1,
      maxTotalWorkerRuns: 6,
      workerTimeoutMs: 10_000,
      workerSessionPolicy: "fresh",
      workerWorkspacePolicy: "fresh_task_scoped",
    },
    planner: {
      plan: async () => ({ status: "available", plan, model: "fixture-planner", promptVersion: "v1" }),
    } as OrchestratorParts["planner"],
    evaluator: {
      evaluate: async () => ({
        status: "available",
        model: "fixture-evaluator",
        promptVersion: "v1",
        evaluation: { sufficient: true, subtaskEvaluations: [], missingInformation: [] },
      }),
    } as OrchestratorParts["evaluator"],
    replanner: {
      replan: async () => { throw new Error("fixture must not replan"); },
    } as OrchestratorParts["replanner"],
    synthesizer: {
      synthesize: async () => ({ output: "fixture complete", model: "fixture-synth", promptVersion: "v1" }),
    } as OrchestratorParts["synthesizer"],
    ...overrides,
  };
}

async function makeFixture(
  runner: AgentRunner,
  orchestrationParts: OrchestratorParts | ((root: string) => OrchestratorParts),
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-project-e2e-"));
  roots.push(root);
  const source = path.join(root, "source");
  const git = new GitClient(5_000);
  await git.run(root, ["init", "-b", "fixture-main", source]);
  await writeFile(path.join(source, "shared.txt"), "seed\n", "utf8");
  await git.run(source, ["add", "--", "shared.txt"]);
  await git.run(source, ["commit", "-m", "seed"]);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "agents"),
    CODEX_HOME: path.join(root, "codex"),
    CODEX_RUNTIME_MODE: "exec",
    ARK_API_KEY: "fixture-key",
    ARK_MODEL: "fixture-model",
    WORKSPACE_SOURCE_ROOTS: root,
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "agents"));
  const events = new EventLog(path.join(root, "data", "events"), { secrets: [config.arkApiKey] });
  const projectRegistry = new ProjectRegistry(
    store,
    new ProjectRepositoryManager(config.workspaceRoot, config.workspaceSourceRoots, git),
    git,
  );
  const resolvedParts = typeof orchestrationParts === "function"
    ? orchestrationParts(root)
    : orchestrationParts;
  const service = new AgentService(
    config,
    store,
    workspaces,
    runner,
    events,
    resolvedParts,
    undefined,
    undefined,
    new ProjectRunManager(path.join(root, "project-workspaces"), [root], git),
    {},
    projectRegistry,
    git,
  );
  await service.initialize();
  return { root, source, git, config, store, workspaces, events, service };
}

async function sourceSnapshot(git: GitClient, source: string): Promise<SourceSnapshot> {
  return {
    branch: await git.run(source, ["symbolic-ref", "--short", "HEAD"]),
    head: await git.head(source),
    index: await git.run(source, ["write-tree"]),
    status: await git.run(source, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

async function waitForTerminal(service: AgentService, runId: string) {
  await expect.poll(() => service.getRun(runId).status, { timeout: 25_000 })
    .toMatch(/^(completed|failed|cancelled)$/);
  return service.getRun(runId);
}

async function startExternalChat(fixture: Fixture, name: string, prompt: string) {
  const project = await fixture.service.openProject({
    displayName: name,
    repositoryPath: fixture.source,
    revision: "HEAD",
  });
  const leader = await fixture.service.createProjectChat(project.id, { name });
  const sent = await fixture.service.sendMessage(leader.id, prompt);
  return { project, leader, run: sent.run };
}

const threeNodePlan: LeaderPlan = {
  needsSubagents: true,
  rationale: "Two producers followed by their consumer.",
  subtasks: [
    {
      id: "frontend", title: "Frontend", role: "Frontend engineer", prompt: "TASK:frontend",
      objective: "Create frontend output", successCriteria: ["frontend file"], expectedOutput: "commit", dependsOn: [],
    },
    {
      id: "backend", title: "Backend", role: "Backend engineer", prompt: "TASK:backend",
      objective: "Create backend output", successCriteria: ["backend file"], expectedOutput: "commit", dependsOn: [],
    },
    {
      id: "integration", title: "Integration", role: "Integration engineer", prompt: "TASK:integration",
      objective: "Consume both outputs", successCriteria: ["integration file"], expectedOutput: "commit",
      dependsOn: ["frontend", "backend"],
    },
  ],
};

describe("Git-backed project orchestration", () => {
  it("integrates a three-node DAG in planner order and never mutates the user checkout", async () => {
    let backendReturned!: () => void;
    const backendDone = new Promise<void>((resolve) => { backendReturned = resolve; });
    const workerFinishOrder: string[] = [];
    let integrationSawParents = false;
    let synthesisCalls = 0;
    let git!: GitClient;
    const runner: AgentRunner = {
      run: async (request) => {
        const id = taskId(request);
        if (id === "backend") {
          const result = await commitFile(git, request, "backend.txt", "backend\n");
          workerFinishOrder.push(id);
          backendReturned();
          return result;
        }
        if (id === "frontend") {
          await backendDone;
          await new Promise<void>((resolve) => setImmediate(resolve));
          const result = await commitFile(git, request, "frontend.txt", "frontend\n");
          workerFinishOrder.push(id);
          return result;
        }
        integrationSawParents =
          (await readFile(path.join(request.workspacePath, "frontend.txt"), "utf8")) === "frontend\n" &&
          (await readFile(path.join(request.workspacePath, "backend.txt"), "utf8")) === "backend\n";
        workerFinishOrder.push(id);
        return commitFile(git, request, "integration.txt", "integrated\n");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const fixture = await makeFixture(runner, parts(threeNodePlan, {
      synthesizer: {
        synthesize: async () => {
          synthesisCalls += 1;
          return { output: "fixture complete", model: "fixture-synth", promptVersion: "v1" };
        },
      } as OrchestratorParts["synthesizer"],
    }));
    git = fixture.git;
    const before = await sourceSnapshot(git, fixture.source);
    const { run } = await startExternalChat(fixture, "E2E leader", "build fixture");
    const finalRun = await waitForTerminal(fixture.service, run.id);

    expect(finalRun.status).toBe("completed");
    expect(synthesisCalls).toBe(1);
    expect(workerFinishOrder.slice(0, 2)).toEqual(["backend", "frontend"]);
    expect(finalRun.project?.integrations.map((record) => record.subtaskId))
      .toEqual(["frontend", "backend", "integration"]);
    expect(finalRun.project?.integrations.every((record) => record.state === "integrated"))
      .toBe(true);
    expect(integrationSawParents).toBe(true);
    expect(finalRun.project?.runBranch).toBe("launchpad/run/" + finalRun.id);
    expect(finalRun.project?.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(finalRun.project?.headCommit)
      .toBe(finalRun.project?.integrations.at(-1)?.canonicalHeadAfter);
    expect(await git.head(finalRun.project!.canonicalWorkspacePath))
      .toBe(finalRun.project?.headCommit);
    expect(fixture.store.snapshot().runs.find((candidate) => candidate.id === run.id)?.project)
      .toMatchObject({
        runBranch: finalRun.project?.runBranch,
        headCommit: finalRun.project?.headCommit,
      });
    await expect(readFile(path.join(finalRun.project!.canonicalWorkspacePath, "frontend.txt"), "utf8"))
      .resolves.toBe("frontend\n");
    await expect(readFile(path.join(finalRun.project!.canonicalWorkspacePath, "backend.txt"), "utf8"))
      .resolves.toBe("backend\n");
    await expect(readFile(path.join(finalRun.project!.canonicalWorkspacePath, "integration.txt"), "utf8"))
      .resolves.toBe("integrated\n");
    expect(await sourceSnapshot(git, fixture.source)).toEqual(before);
  }, 40_000);

  it("rejects invalid sources before planner or worker admission", async () => {
    const calls = { planner: 0, worker: 0 };
    const plan: LeaderPlan = { needsSubagents: false, rationale: "unused", subtasks: [] };
    const runner: AgentRunner = {
      run: async () => { calls.worker += 1; throw new Error("not admitted"); },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const orchestrationParts = parts(plan, {
      planner: {
        plan: async () => { calls.planner += 1; throw new Error("not admitted"); },
      } as unknown as OrchestratorParts["planner"],
    });
    const fixture = await makeFixture(runner, orchestrationParts);
    await expect(fixture.service.openProject({
      displayName: "Preflight leader",
      repositoryPath: path.join(fixture.root, "missing"),
      revision: "HEAD",
    })).rejects.toMatchObject({ message: expect.stringMatching(/not found|does not exist|invalid|repository/i) });
    expect(calls).toEqual({ planner: 0, worker: 0 });

    await writeFile(path.join(fixture.source, "dirty.txt"), "uncommitted\n", "utf8");
    await expect(fixture.service.openProject({
      displayName: "Dirty source leader",
      repositoryPath: fixture.source,
      revision: "HEAD",
    })).rejects.toMatchObject({ message: expect.stringMatching(/clean/i) });
    expect(calls).toEqual({ planner: 0, worker: 0 });
  });

  it("fails a clean worker with no commit and blocks its dependent", async () => {
    const started: string[] = [];
    let synthesisCalls = 0;
    const plan: LeaderPlan = {
      needsSubagents: true,
      rationale: "A producer and dependent.",
      subtasks: [
        { id: "producer", title: "Producer", role: "Engineer", prompt: "TASK:producer", objective: "Produce", successCriteria: ["commit"], expectedOutput: "commit", dependsOn: [] },
        { id: "consumer", title: "Consumer", role: "Engineer", prompt: "TASK:consumer", objective: "Consume", successCriteria: ["output"], expectedOutput: "commit", dependsOn: ["producer"] },
      ],
    };
    const runner: AgentRunner = {
      run: async (request) => {
        started.push(taskId(request));
        completedCommand(request, "inspect");
        return { output: "findings: no changes\nevidence: clean tree\nunresolved gaps: commit absent\nrecommended next checks: stop", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const fixture = await makeFixture(runner, parts(plan, {
      synthesizer: {
        synthesize: async () => {
          synthesisCalls += 1;
          return { output: "must not synthesize", model: "fixture-synth", promptVersion: "v1" };
        },
      } as OrchestratorParts["synthesizer"],
    }));
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const { run } = await startExternalChat(fixture, "No commit leader", "no commit");
    const finalRun = await waitForTerminal(fixture.service, run.id);
    expect(finalRun.status).toBe("failed");
    expect(finalRun.output).toBeNull();
    expect(synthesisCalls).toBe(0);
    expect(started).toEqual(["producer"]);
    expect(finalRun.orchestration?.workerResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ subtaskId: "producer", status: "failed" }),
      expect.objectContaining({ subtaskId: "consumer", status: "blocked" }),
    ]));
    expect(finalRun.project?.attempts[0]).toMatchObject({ state: "failed", cleanup: "preserved" });
    expect(finalRun.project?.integrations).toEqual([]);
    expect((await fixture.service.getRunEvents(run.id, 0)).events.some((event) => event.name === "synthesis"))
      .toBe(false);
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
  });

  it("keeps the first planner-ordered commit and aborts a same-wave conflict", async () => {
    const started: string[] = [];
    let synthesisCalls = 0;
    let git!: GitClient;
    const plan: LeaderPlan = {
      needsSubagents: true,
      rationale: "Two conflicting producers and a dependent.",
      subtasks: [
        { id: "first", title: "First", role: "Engineer", prompt: "TASK:first", objective: "First edit", successCriteria: ["commit"], expectedOutput: "commit", dependsOn: [] },
        { id: "second", title: "Second", role: "Engineer", prompt: "TASK:second", objective: "Second edit", successCriteria: ["commit"], expectedOutput: "commit", dependsOn: [] },
        { id: "dependent", title: "Dependent", role: "Engineer", prompt: "TASK:dependent", objective: "Consume", successCriteria: ["commit"], expectedOutput: "commit", dependsOn: ["first", "second"] },
      ],
    };
    const runner: AgentRunner = {
      run: async (request) => {
        const id = taskId(request);
        started.push(id);
        return commitFile(git, request, "shared.txt", id + "\n");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const fixture = await makeFixture(runner, parts(plan, {
      synthesizer: {
        synthesize: async () => {
          synthesisCalls += 1;
          return { output: "must not synthesize", model: "fixture-synth", promptVersion: "v1" };
        },
      } as OrchestratorParts["synthesizer"],
    }));
    git = fixture.git;
    const before = await sourceSnapshot(git, fixture.source);
    const { run } = await startExternalChat(fixture, "Conflict leader", "conflict");
    const finalRun = await waitForTerminal(fixture.service, run.id);
    const project = finalRun.project!;
    expect(finalRun.status).toBe("failed");
    expect(finalRun.output).toBeNull();
    expect(synthesisCalls).toBe(0);
    expect(started).not.toContain("dependent");
    expect(project.integrations).toEqual([
      expect.objectContaining({ subtaskId: "first", state: "integrated", structuralDecision: "passed" }),
      expect.objectContaining({
        subtaskId: "second",
        state: "conflicted",
        structuralDecision: "failed",
        reason: expect.stringContaining("integration_conflict"),
      }),
    ]);
    await expect(readFile(path.join(project.canonicalWorkspacePath, "shared.txt"), "utf8"))
      .resolves.toBe("first\n");
    await expect(git.run(project.canonicalWorkspacePath, ["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"]))
      .rejects.toMatchObject({ code: "git_failed" });
    expect(project.attempts.find((attempt) => attempt.subtaskId === "second"))
      .toMatchObject({
        state: "failed",
        cleanup: "preserved",
        reason: expect.stringContaining("integration_conflict"),
      });
    expect((await fixture.service.getRunEvents(run.id, 0)).events.some((event) => event.name === "synthesis"))
      .toBe(false);
    expect(await sourceSnapshot(git, fixture.source)).toEqual(before);
  }, 20_000);

  it("cancels restart-interrupted work, preserves a dirty attempt, and performs no resume calls", async () => {
    let dirty!: () => void;
    const dirtyReached = new Promise<void>((resolve) => { dirty = resolve; });
    const never = new Promise<RunnerResult>(() => undefined);
    const plan: LeaderPlan = {
      needsSubagents: true,
      rationale: "One interrupted worker.",
      subtasks: [{ id: "dirty", title: "Dirty", role: "Engineer", prompt: "TASK:dirty", objective: "Edit", successCriteria: ["commit"], expectedOutput: "commit", dependsOn: [] }],
    };
    const runner: AgentRunner = {
      run: async (request) => {
        await writeFile(path.join(request.workspacePath, "unfinished.txt"), "preserve me\n", "utf8");
        dirty();
        return never;
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const fixture = await makeFixture(runner, parts(plan));
    const { run } = await startExternalChat(fixture, "Restart leader", "interrupt");
    await dirtyReached;
    const resumeCalls = { planner: 0, worker: 0 };
    const forbidden = async () => { resumeCalls.planner += 1; throw new Error("restart resumed planning"); };
    const restarted = new AgentService(
      fixture.config,
      new JsonStore(path.join(fixture.root, "data", "db.json")),
      new WorkspaceManager(path.join(fixture.root, "agents")),
      {
        run: async () => { resumeCalls.worker += 1; throw new Error("restart resumed worker"); },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      new EventLog(path.join(fixture.root, "data", "events"), { secrets: [fixture.config.arkApiKey] }),
      parts(plan, { planner: { plan: forbidden } as unknown as OrchestratorParts["planner"] }),
    );
    await restarted.initialize();
    const recovered = restarted.getRun(run.id);
    expect(recovered.status).toBe("cancelled");
    expect(recovered.project?.state).toBe("cancelled");
    expect(recovered.project?.attempts).toEqual([
      expect.objectContaining({ subtaskId: "dirty", state: "cancelled", cleanup: "preserved", reason: "changed" }),
    ]);
    await expect(readFile(path.join(recovered.project!.attempts[0]!.workspacePath, "unfinished.txt"), "utf8"))
      .resolves.toBe("preserve me\n");
    expect(resumeCalls).toEqual({ planner: 0, worker: 0 });
  }, 20_000);

  it("keeps ephemeral research compatible without Git contribution state", async () => {
    const plan: LeaderPlan = {
      needsSubagents: true,
      rationale: "One research worker.",
      subtasks: [{ id: "research", title: "Research", role: "Researcher", prompt: "TASK:research", objective: "Research", successCriteria: ["notes"], expectedOutput: "notes", dependsOn: [] }],
    };
    let workerCalls = 0;
    const runner: AgentRunner = {
      run: async (request) => {
        workerCalls += 1;
        completedCommand(request, "research");
        return { output: "findings: result\nevidence: fixture\nunresolved gaps: none\nrecommended next checks: none", threadId: null, usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const fixture = await makeFixture(runner, parts(plan));
    const leader = await fixture.service.createAgent({ name: "Research leader", role: "leader" });
    const { run } = await fixture.service.sendMessage(leader.id, "research");
    const finalRun = await waitForTerminal(fixture.service, run.id);
    expect(finalRun.status).toBe("completed");
    expect(workerCalls).toBe(1);
    expect(finalRun.project).toMatchObject({
      state: "ready",
      runBranch: null,
      headCommit: null,
      attempts: [],
      integrations: [],
      source: { mode: "ephemeral_research", baseCommit: null },
    });
    await expect(access(finalRun.project!.canonicalWorkspacePath)).resolves.toBeUndefined();
  });

  it("routes a live leader through an isolated contribution without mutating the user checkout", async () => {
    const runtimeRequests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        runtimeRequests.push(request);
        return commitFile(new GitClient(5_000), request, "todo.html", "<!doctype html>\n");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const fixture = await makeFixture(runner, (root) => parts(
      { needsSubagents: false, rationale: "live leader", subtasks: [] },
      {
        coordination: {
          dataDir: path.join(root, "data"),
          baseUrl: "http://127.0.0.1:9",
          register() {},
          unregister() {},
        },
      },
    ));
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const opened = await fixture.service.openProject({
      displayName: "Live leader source",
      repositoryPath: fixture.source,
      revision: "HEAD",
    });
    const leader = await fixture.service.createProjectChat(opened.id, { name: "Live leader chat" });
    const { run } = await fixture.service.sendMessage(leader.id, "build a todo app");
    const completed = await waitForTerminal(fixture.service, run.id);
    expect(runtimeRequests[0]?.workspacePath).toContain("/.runs/");
    expect(runtimeRequests[0]?.workspacePath).not.toBe(leader.workspacePath);
    expect(completed.project?.integrations).toHaveLength(1);
    expect(completed.orchestration?.outcome?.value).toBe("succeeded");
    expect(completed.project?.headCommit).not.toBe(completed.project?.source.baseCommit);
    expect(fixture.service.listProjects().find((item) => item.id === opened.id)?.baselineCommit)
      .toBe(completed.project?.headCommit);
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
  }, 25_000);
});
