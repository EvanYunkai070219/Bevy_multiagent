/** End-to-end acceptance: restart, concurrency, and historical migration. */
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService } from "../src/agent-service.js";
import { EventLog } from "../src/event-log.js";
import { GitClient } from "../src/git-client.js";
import type { ModelCredentialIssuer } from "../src/model-proxy.js";
import type { OrchestratorParts } from "../src/orchestration/orchestrator.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { baselineCandidate, ProjectRegistry } from "../src/project-registry.js";
import { ProjectRepositoryManager } from "../src/project-repository-manager.js";
import { ProjectRunManager } from "../src/project-run-manager.js";
import { AttemptWorkspaceManager } from "../src/attempt-workspace-manager.js";
import { loadConfig } from "../src/config.js";
import { JsonStore } from "../src/store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  LeaderPlan,
  OrchestrationState,
  ProjectRecord,
  RunnerRequest,
  RunnerResult,
} from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";

const roots: string[] = [];
const LIVE_PLAN: LeaderPlan = { needsSubagents: false, rationale: "live leader", subtasks: [] };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class AcceptanceGit extends GitClient {
  async fileExists(cwd: string, relativePath: string, treeish = "HEAD"): Promise<boolean> {
    try {
      await this.run(cwd, ["cat-file", "-e", treeish + ":" + relativePath]);
      return true;
    } catch {
      return false;
    }
  }
}

interface SourceSnapshot {
  branch: string;
  head: string;
  index: string;
  status: string;
  refs: string;
}

interface Fixture {
  root: string;
  source: string;
  git: AcceptanceGit;
  config: ReturnType<typeof loadConfig>;
  store: JsonStore;
  service: AgentService;
  registry: ProjectRegistry;
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

async function commitFile(
  git: GitClient,
  request: RunnerRequest,
  file: string,
  content: string,
): Promise<RunnerResult> {
  const absolute = path.join(request.workspacePath, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
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

function liveParts(root: string, overrides: Partial<OrchestratorParts> = {}): OrchestratorParts {
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
      workerIdentityPolicy: "per_subtask",
    },
    planner: {
      plan: async () => ({ status: "available", plan: LIVE_PLAN, model: "fixture-planner", promptVersion: "v1" }),
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
      synthesize: async () => { throw new Error("live leader must not synthesize"); },
    } as OrchestratorParts["synthesizer"],
    coordination: {
      dataDir: path.join(root, "data"),
      baseUrl: "http://127.0.0.1:9",
      register() {},
      unregister() {},
    },
    ...overrides,
  };
}

function executionCounts() {
  return { planner: 0, runner: 0, model: 0 };
}

function failFastPlanner(counts: { planner: number }): OrchestratorParts["planner"] {
  return {
    plan: async () => {
      counts.planner += 1;
      throw new Error("restart recovery must not plan");
    },
  } as OrchestratorParts["planner"];
}

function failFastRunner(counts: { runner: number }): AgentRunner {
  return {
    run: async () => {
      counts.runner += 1;
      throw new Error("restart recovery must not run");
    },
    cancel: async () => false,
    isAvailable: async () => true,
  };
}

function failFastModel(counts: { model: number }): ModelCredentialIssuer {
  return {
    issue() {
      counts.model += 1;
      throw new Error("restart recovery must not issue a model token");
    },
    revoke() {},
    terminalError() {
      return undefined;
    },
  };
}

async function makeFixture(
  runner: AgentRunner,
  orchestrationParts?: OrchestratorParts | ((root: string) => OrchestratorParts),
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-accept-"));
  roots.push(root);
  const source = path.join(root, "source");
  const git = new AcceptanceGit(5_000);
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
  const registry = new ProjectRegistry(
    store,
    new ProjectRepositoryManager(config.workspaceRoot, config.workspaceSourceRoots, git),
    git,
  );
  const resolvedParts = typeof orchestrationParts === "function"
    ? orchestrationParts(root)
    : orchestrationParts ?? liveParts(root);
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
    registry,
    git,
  );
  await service.initialize();
  return { root, source, git, config, store, service, registry };
}

async function restartService(
  fixture: Pick<Fixture, "root" | "config" | "git">,
  counts: { planner: number; runner: number; model: number },
): Promise<{ service: AgentService; store: JsonStore; registry: ProjectRegistry }> {
  const store = new JsonStore(path.join(fixture.root, "data", "db.json"));
  const registry = new ProjectRegistry(
    store,
    new ProjectRepositoryManager(fixture.config.workspaceRoot, fixture.config.workspaceSourceRoots, fixture.git),
    fixture.git,
  );
  const service = new AgentService(
    fixture.config,
    store,
    new WorkspaceManager(path.join(fixture.root, "agents")),
    failFastRunner(counts),
    new EventLog(path.join(fixture.root, "data", "events"), { secrets: [fixture.config.arkApiKey] }),
    liveParts(fixture.root, { planner: failFastPlanner(counts) }),
    failFastModel(counts),
    undefined,
    new ProjectRunManager(path.join(fixture.root, "project-workspaces"), [fixture.root], fixture.git),
    {},
    registry,
    fixture.git,
  );
  await service.initialize();
  return { service, store, registry };
}

async function sourceSnapshot(git: GitClient, source: string): Promise<SourceSnapshot> {
  return {
    branch: await git.run(source, ["symbolic-ref", "--short", "HEAD"]),
    head: await git.head(source),
    index: await git.run(source, ["write-tree"]),
    status: await git.run(source, ["status", "--porcelain=v1", "--untracked-files=all"]),
    refs: await git.run(source, ["for-each-ref", "--format=%(refname) %(objectname)"]),
  };
}

function nonLaunchpadRefs(refs: string): string {
  return refs
    .split("\n")
    .filter((line) => !/^refs\/heads\/launchpad\/(project|run)\//.test(line.split(" ")[0] ?? ""))
    .join("\n");
}

function addedRefs(before: string, after: string): string[] {
  const previous = new Set(before.split("\n").filter(Boolean));
  return after.split("\n").filter((line) => line.length > 0 && !previous.has(line));
}

function assertExternalPreserved(before: SourceSnapshot, after: SourceSnapshot): void {
  expect(after.branch).toBe(before.branch);
  expect(after.head).toBe(before.head);
  expect(after.index).toBe(before.index);
  expect(after.status).toBe(before.status);
  expect(nonLaunchpadRefs(after.refs)).toBe(nonLaunchpadRefs(before.refs));
  for (const line of addedRefs(before.refs, after.refs)) {
    expect(line).toMatch(/^refs\/heads\/launchpad\/(project|run)\//);
  }
}

async function waitForTerminal(service: AgentService, runId: string) {
  await expect.poll(() => service.getRun(runId).status, { timeout: 25_000 })
    .toMatch(/^(completed|failed|cancelled)$/);
  return service.getRun(runId);
}

function completedControlLoop(overrides: Partial<OrchestrationState> = {}): OrchestrationState {
  return {
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
    ...overrides,
  };
}

async function commitThenRestore(
  git: GitClient,
  repository: string,
  fileName: string,
  contents: string,
): Promise<string> {
  const base = await git.head(repository);
  await writeFile(path.join(repository, fileName), contents, "utf8");
  await git.run(repository, ["add", "--", fileName]);
  await git.run(repository, ["commit", "-m", fileName]);
  const next = await git.head(repository);
  await git.resetHard(repository, base);
  return next;
}

describe("projects and chats acceptance", () => {
  it("runs two chats against one real Git baseline and never mutates the user checkout", async () => {
    let chat2Started = false;
    let chat2RuntimeBase = "";
    let chat2AttemptPath = "";
    let git!: AcceptanceGit;
    const runner: AgentRunner = {
      run: async (request) => {
        if (!chat2Started) {
          expect(request.workspacePath).toContain("/.runs/");
          return commitFile(git, request, "src/value.ts", "value\n");
        }
        chat2AttemptPath = request.workspacePath;
        chat2RuntimeBase = await git.head(request.workspacePath);
        expect(await git.fileExists(chat2AttemptPath, "src/value.ts")).toBe(true);
        return commitFile(git, request, "src/next.ts", "next\n");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const fixture = await makeFixture(runner, (root) => liveParts(root));
    git = fixture.git;
    const before = await sourceSnapshot(git, fixture.source);
    const project = await fixture.service.openProject({
      displayName: "Two Chat Source",
      repositoryPath: fixture.source,
      revision: "HEAD",
    });
    const chat1 = await fixture.service.createProjectChat(project.id, { name: "Chat 1" });
    const sent1 = await fixture.service.sendMessage(chat1.id, "write value");
    const chat1Run = await waitForTerminal(fixture.service, sent1.run.id);
    const projectAfterChat1 = fixture.registry.get(project.id);

    expect(chat1Run.orchestration?.outcome?.value).toBe("succeeded");
    expect(projectAfterChat1.id).toBe(project.id);
    expect(projectAfterChat1.baselineCommit).toBe(chat1Run.project?.headCommit);

    chat2Started = true;
    const chat2 = await fixture.service.createProjectChat(project.id, { name: "Chat 2" });
    expect(chat2.projectId).toBe(project.id);
    const extraSource = { mode: "ephemeral_research" as const };
    const sent2 = await (fixture.service.sendMessage as (
      id: string,
      prompt: string,
      extra?: unknown,
    ) => ReturnType<AgentService["sendMessage"]>)(chat2.id, "write next", extraSource);
    expect(sent2.run.workspaceSource).toEqual({
      mode: "existing_repository",
      repositoryPath: project.repositoryPath,
      revision: projectAfterChat1.baselineCommit,
    });
    const chat2Run = await waitForTerminal(fixture.service, sent2.run.id);
    const projectAfterChat2 = fixture.registry.get(project.id);

    expect(chat2RuntimeBase).toBe(projectAfterChat1.baselineCommit);
    let chat2Tree = chat2AttemptPath;
    try {
      await access(chat2AttemptPath);
    } catch {
      chat2Tree = chat2Run.project!.canonicalWorkspacePath;
    }
    expect(await git.fileExists(chat2Tree, "src/value.ts")).toBe(true);
    expect(await git.fileExists(fixture.source, "src/value.ts", chat2RuntimeBase)).toBe(true);
    expect(chat2Run.orchestration?.outcome?.value).toBe("succeeded");
    expect(projectAfterChat2.baselineCommit).toBe(chat2Run.project?.headCommit);
    expect(projectAfterChat2.id).toBe(project.id);
    expect(await git.fileExists(chat2Run.project!.canonicalWorkspacePath, "src/next.ts")).toBe(true);
    assertExternalPreserved(before, await sourceSnapshot(git, fixture.source));
  }, 40_000);

  it("admits exactly one concurrent winner and records typed stale-baseline failure", async () => {
    let git!: AcceptanceGit;
    const synthesisCalls = { count: 0 };
    const runner: AgentRunner = {
      run: async (request) => {
        const file = request.prompt.includes("alpha") ? "src/alpha.ts" : "src/beta.ts";
        return commitFile(git, request, file, file + "\n");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const fixture = await makeFixture(runner, (root) => liveParts(root, {
      synthesizer: {
        synthesize: async () => {
          synthesisCalls.count += 1;
          return { output: "must not synthesize", model: "fixture-synth", promptVersion: "v1" };
        },
      } as OrchestratorParts["synthesizer"],
    }));
    git = fixture.git;
    const before = await sourceSnapshot(git, fixture.source);
    const project = await fixture.service.openProject({
      displayName: "Concurrent Source",
      repositoryPath: fixture.source,
      revision: "HEAD",
    });
    const seed = project.baselineCommit;
    const chatA = await fixture.service.createProjectChat(project.id, { name: "Chat Alpha" });
    const chatB = await fixture.service.createProjectChat(project.id, { name: "Chat Beta" });

    let casCalls = 0;
    let firstFinished!: () => void;
    const firstCasDone = new Promise<void>((resolve) => { firstFinished = resolve; });
    const original = fixture.registry.advanceBaseline.bind(fixture.registry);
    vi.spyOn(fixture.registry, "advanceBaseline").mockImplementation(async (input) => {
      const call = ++casCalls;
      if (call === 1) {
        try {
          return await original(input);
        } finally {
          firstFinished();
        }
      }
      await firstCasDone;
      return original(input);
    });

    // The prompts have to read as contribution requests, not as labels: a
    // leader is only given a Git worktree on the project when
    // `requiresProjectContributionRequest` recognises the ask. "alpha" and
    // "beta" were written before that rule existed, so both runs executed in a
    // plain agent workspace and never reached the baseline CAS this asserts.
    const [sentA, sentB] = await Promise.all([
      fixture.service.sendMessage(chatA.id, "write src/alpha.ts"),
      fixture.service.sendMessage(chatB.id, "write src/beta.ts"),
    ]);
    const [runA, runB] = await Promise.all([
      waitForTerminal(fixture.service, sentA.run.id),
      waitForTerminal(fixture.service, sentB.run.id),
    ]);
    const finalProject = fixture.registry.get(project.id);
    const runs = [runA, runB];
    const winners = runs.filter((run) =>
      run.status === "completed" &&
      run.orchestration?.outcome?.value === "succeeded" &&
      run.project?.headCommit === finalProject.baselineCommit,
    );
    const losers = runs.filter((run) => run.id !== winners[0]?.id);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const winner = winners[0]!;
    const loser = losers[0]!;
    expect(finalProject.baselineCommit).not.toBe(seed);
    expect(finalProject.baselineCommit).toBe(winner.project?.headCommit);
    expect(loser.status).toBe("failed");
    expect(loser.orchestration?.outcome?.value).toBe("failed");
    expect(loser.error).toMatch(/does not match the expected commit/i);
    expect(loser.error).not.toMatch(/already in progress/i);
    expect(loser.orchestration?.outcome?.reason).toMatch(/compare-and-swap|baseline/i);
    expect(loser.orchestration?.outcome?.evidence?.join(" ")).toMatch(/does not match the expected commit/i);
    expect(loser.project?.integrations.length).toBeGreaterThan(0);
    expect(loser.project?.integrations.every((record) =>
      record.state === "integrated" || record.state === "conflicted",
    )).toBe(true);
    expect(loser.project?.attempts.some((attempt) =>
      attempt.state === "integrated" || attempt.state === "contribution_ready" || attempt.headCommit,
    )).toBe(true);
    expect(loser.output).toBeNull();
    expect(loser.orchestration?.outcome?.value).not.toBe("succeeded");
    expect(synthesisCalls.count).toBe(0);
    expect(chatA.projectId).toBe(project.id);
    expect(chatB.projectId).toBe(project.id);
    assertExternalPreserved(before, await sourceSnapshot(git, fixture.source));
  }, 40_000);

  it("rejects a Git expected-OID CAS after the baseline ref is diverted", async () => {
    let git!: AcceptanceGit;
    const runner: AgentRunner = {
      run: async (request) => commitFile(git, request, "src/cas.ts", "cas\n"),
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const fixture = await makeFixture(runner, (root) => liveParts(root));
    git = fixture.git;
    const before = await sourceSnapshot(git, fixture.source);
    const project = await fixture.service.openProject({
      displayName: "Expected OID Source",
      repositoryPath: fixture.source,
      revision: "HEAD",
    });
    const seed = project.baselineCommit;
    const chat = await fixture.service.createProjectChat(project.id, { name: "OID Chat" });

    const originalUpdate = git.updateBranchIfAt.bind(git);
    let diverted = false;
    vi.spyOn(git, "updateBranchIfAt").mockImplementation(async (cwd, branch, expected, next) => {
      if (!diverted && branch === project.baselineBranch) {
        diverted = true;
        const stolen = await commitThenRestore(git, cwd, "stolen.txt", "stolen\n");
        await originalUpdate(cwd, branch, expected, stolen);
      }
      return originalUpdate(cwd, branch, expected, next);
    });

    // Same reason as above: "cas" names the scenario, it does not ask for a
    // contribution, so no worktree was created and the run failed at `git add`
    // long before any compare-and-swap.
    const sent = await fixture.service.sendMessage(chat.id, "write src/cas.ts");
    const completed = await waitForTerminal(fixture.service, sent.run.id);
    expect(completed.status).toBe("failed");
    expect(completed.orchestration?.outcome?.value).toBe("failed");
    expect(String(completed.error)).toMatch(/Git command failed|update-ref|compare-and-swap/i);
    expect(String(completed.error)).not.toMatch(/already in progress/i);
    expect(fixture.registry.get(project.id).baselineCommit).toBe(seed);
    expect(completed.project?.integrations.length).toBeGreaterThan(0);
    assertExternalPreserved(before, await sourceSnapshot(git, fixture.source));
  }, 40_000);

  it("denies baseline advancement for a succeeded project Run with zero integrations", async () => {
    const fixture = await makeFixture({
      run: async () => ({ output: "unused", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const project = await fixture.service.createManagedProject({ displayName: "Zero Integration" });
    const chat = await fixture.service.createProjectChat(project.id, { name: "Zero Chat" });
    const seed = project.baselineCommit;
    const next = await commitThenRestore(fixture.git, project.repositoryPath, "ghost.txt", "ghost\n");
    const runId = "88888888-8888-4888-8888-888888888888";
    const manager = new ProjectRunManager(
      path.join(fixture.root, "project-workspaces"),
      [fixture.root],
      fixture.git,
    );
    const runProject = await manager.prepare(runId, {
      mode: "existing_repository",
      repositoryPath: project.repositoryPath,
      revision: seed,
    });
    await manager.acknowledgePrepared(runId, runProject);
    runProject.headCommit = next;
    runProject.integrations = [];
    await fixture.store.mutate((database) => {
      database.runs.push({
        id: runId,
        agentId: chat.id,
        projectId: project.id,
        kind: "orchestration",
        parentRunId: null,
        orchestration: completedControlLoop({
          phase: "completed",
          outcome: {
            value: "succeeded",
            reason: "claimed success without an integrated contribution",
            evidence: ["integrations=0"],
            resolvedAt: "2026-08-29T00:00:00.000Z",
          },
        }),
        workspaceSource: {
          mode: "existing_repository",
          repositoryPath: project.repositoryPath,
          revision: seed,
        },
        project: runProject,
        status: "completed",
        prompt: "claim success",
        output: "done",
        error: null,
        usage: null,
        startedAt: "2026-08-29T00:00:00.000Z",
        completedAt: "2026-08-29T00:00:01.000Z",
        createdAt: "2026-08-29T00:00:00.000Z",
      });
    });
    const stored = fixture.store.snapshot().runs.find((item) => item.id === runId)!;
    expect(stored.project?.integrations).toEqual([]);
    expect(baselineCandidate(stored)).toBeNull();
    expect(fixture.registry.get(project.id).baselineCommit).toBe(seed);
    const counts = executionCounts();
    const restarted = await restartService(fixture, counts);
    expect(baselineCandidate(restarted.service.getRun(runId))).toBeNull();
    expect(restarted.registry.get(project.id).baselineCommit).toBe(seed);
    expect(counts).toEqual({ planner: 0, runner: 0, model: 0 });
  });

  it("recovers Project persisted before folder publication with zero execution calls", async () => {
    const fixture = await makeFixture(failFastRunner(executionCounts()), (root) =>
      liveParts(root, { planner: failFastPlanner(executionCounts()) }),
    );
    const unpublished = path.join(fixture.root, "agents", "projects", "unpublished-folder");
    const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await fixture.store.mutate((database) => {
      database.projects.push({
        id: projectId,
        displayName: "Unpublished",
        sourceKind: "managed",
        repositoryPath: unpublished,
        repositoryRealPath: unpublished,
        gitCommonRealPath: unpublished,
        gitCommonDev: 1,
        gitCommonIno: 1,
        baselineBranch: "launchpad/project/" + projectId,
        baselineCommit: "a".repeat(40),
        state: "ready",
        lastError: null,
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
      });
    });
    const counts = executionCounts();
    const restarted = await restartService(fixture, counts);
    const recovered = restarted.service.listProjects().find((item) => item.id === projectId);
    expect(recovered?.state).toBe("unavailable");
    expect(counts).toEqual({ planner: 0, runner: 0, model: 0 });
  });

  it("recovers baseline intent prepared before ref update with zero execution calls", async () => {
    const fixture = await makeFixture({
      run: async () => ({ output: "unused", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const project = await fixture.service.createManagedProject({ displayName: "Prepared Intent" });
    const next = await commitThenRestore(fixture.git, project.repositoryPath, "prepared.txt", "prepared\n");
    const seed = project.baselineCommit;
    await fixture.store.mutate((database) => {
      const record = database.projects.find((item) => item.id === project.id);
      if (!record) throw new Error("missing project");
      record.baselineTransition = {
        runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        expectedCommit: seed,
        nextCommit: next,
        state: "prepared",
      };
    });
    const counts = executionCounts();
    const restarted = await restartService(fixture, counts);
    expect(restarted.registry.get(project.id).baselineCommit).toBe(seed);
    expect(restarted.store.snapshot().projects.find((item) => item.id === project.id)?.baselineTransition)
      .toBeUndefined();
    expect(counts).toEqual({ planner: 0, runner: 0, model: 0 });
  });

  it("finalizes a ref-updated baseline before store finalization with zero execution calls", async () => {
    const fixture = await makeFixture({
      run: async () => ({ output: "unused", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const project = await fixture.service.createManagedProject({ displayName: "Ref Updated" });
    const seed = project.baselineCommit;
    const next = await commitThenRestore(fixture.git, project.repositoryPath, "finalized.txt", "finalized\n");
    await fixture.git.updateBranchIfAt(project.repositoryPath, project.baselineBranch, seed, next);
    await fixture.store.mutate((database) => {
      const record = database.projects.find((item) => item.id === project.id);
      if (!record) throw new Error("missing project");
      record.baselineTransition = {
        runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        expectedCommit: seed,
        nextCommit: next,
        state: "prepared",
      };
    });
    const counts = executionCounts();
    const restarted = await restartService(fixture, counts);
    expect(restarted.registry.get(project.id).baselineCommit).toBe(next);
    expect(restarted.store.snapshot().projects.find((item) => item.id === project.id)?.baselineTransition)
      .toBeUndefined();
    expect(counts).toEqual({ planner: 0, runner: 0, model: 0 });
  });

  it("cancels contribution_ready before integration with zero execution calls", async () => {
    const fixture = await makeFixture({
      run: async () => ({ output: "unused", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const project = await fixture.service.createManagedProject({ displayName: "Ready Before Integrate" });
    const chat = await fixture.service.createProjectChat(project.id, { name: "Ready Chat" });
    const runId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const manager = new ProjectRunManager(
      path.join(fixture.root, "project-workspaces"),
      [fixture.root],
      fixture.git,
    );
    const runProject = await manager.prepare(runId, {
      mode: "existing_repository",
      repositoryPath: project.repositoryPath,
      revision: project.baselineCommit,
    });
    await manager.acknowledgePrepared(runId, runProject);
    const attempts = new AttemptWorkspaceManager(fixture.git);
    const attempt = await attempts.create({
      runId,
      project: runProject,
      attemptId: "ready-attempt",
      subtaskId: "leader",
      baseCommit: runProject.headCommit!,
    });
    await writeFile(path.join(attempt.workspacePath, "candidate.txt"), "candidate\n", "utf8");
    await fixture.git.run(attempt.workspacePath, ["add", "--", "candidate.txt"]);
    await fixture.git.run(attempt.workspacePath, ["commit", "-m", "candidate"]);
    const head = await fixture.git.head(attempt.workspacePath);
    runProject.attempts.push({ ...attempt, state: "contribution_ready", headCommit: head });
    await fixture.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === chat.id);
      if (agent) agent.status = "busy";
      database.runs.push({
        id: runId,
        agentId: chat.id,
        projectId: project.id,
        kind: "orchestration",
        parentRunId: null,
        orchestration: completedControlLoop({ phase: "executing" }),
        workspaceSource: {
          mode: "existing_repository",
          repositoryPath: project.repositoryPath,
          revision: project.baselineCommit,
        },
        project: runProject,
        status: "running",
        prompt: "interrupted before integration",
        output: null,
        error: null,
        usage: null,
        startedAt: "2026-08-29T00:00:00.000Z",
        completedAt: null,
        createdAt: "2026-08-29T00:00:00.000Z",
      });
    });
    const counts = executionCounts();
    const restarted = await restartService(fixture, counts);
    const recovered = restarted.service.getRun(runId);
    expect(recovered.status).toBe("cancelled");
    expect(recovered.project?.integrations).toEqual([]);
    expect(recovered.project?.attempts[0]).toMatchObject({
      state: "cancelled",
      headCommit: head,
    });
    expect(restarted.registry.get(project.id).baselineCommit).toBe(project.baselineCommit);
    expect(counts).toEqual({ planner: 0, runner: 0, model: 0 });
  });

  it("does not advance baseline when integration completed before terminal outcome", async () => {
    const fixture = await makeFixture({
      run: async () => ({ output: "unused", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const project = await fixture.service.createManagedProject({ displayName: "Integrated Before Outcome" });
    const chat = await fixture.service.createProjectChat(project.id, { name: "Integrated Chat" });
    const runId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const manager = new ProjectRunManager(
      path.join(fixture.root, "project-workspaces"),
      [fixture.root],
      fixture.git,
    );
    const runProject = await manager.prepare(runId, {
      mode: "existing_repository",
      repositoryPath: project.repositoryPath,
      revision: project.baselineCommit,
    });
    await manager.acknowledgePrepared(runId, runProject);
    const next = await commitThenRestore(
      fixture.git,
      runProject.canonicalWorkspacePath,
      "landed.txt",
      "landed\n",
    );
    runProject.headCommit = next;
    runProject.integrations.push({
      contributionId: "integrated-before-outcome",
      subtaskId: "leader",
      canonicalHeadBefore: project.baselineCommit,
      canonicalHeadAfter: next,
      state: "integrated",
      structuralDecision: "passed",
      reason: null,
    });
    await fixture.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === chat.id);
      if (agent) agent.status = "busy";
      database.runs.push({
        id: runId,
        agentId: chat.id,
        projectId: project.id,
        kind: "orchestration",
        parentRunId: null,
        orchestration: completedControlLoop({ phase: "executing" }),
        workspaceSource: {
          mode: "existing_repository",
          repositoryPath: project.repositoryPath,
          revision: project.baselineCommit,
        },
        project: runProject,
        status: "running",
        prompt: "integrated but not terminal",
        output: null,
        error: null,
        usage: null,
        startedAt: "2026-08-29T00:00:00.000Z",
        completedAt: null,
        createdAt: "2026-08-29T00:00:00.000Z",
      });
    });
    const counts = executionCounts();
    const restarted = await restartService(fixture, counts);
    const recovered = restarted.service.getRun(runId);
    expect(recovered.status).toBe("cancelled");
    expect(recovered.orchestration?.outcome?.value ?? "unknown").toBe("unknown");
    expect(recovered.project?.integrations).toEqual([
      expect.objectContaining({
        state: "integrated",
        structuralDecision: "passed",
        canonicalHeadAfter: next,
      }),
    ]);
    expect(restarted.registry.get(project.id).baselineCommit).toBe(project.baselineCommit);
    expect(counts).toEqual({ planner: 0, runner: 0, model: 0 });
  });

  it("migrates a historical todo-app Run without rewriting evidence or inventing success", async () => {
    const fixture = await makeFixture({
      run: async () => ({ output: "unused", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const runId = "99999999-9999-4999-8999-999999999999";
    const manager = new ProjectRunManager(
      path.join(fixture.root, "project-workspaces"),
      [fixture.root],
      fixture.git,
    );
    const historical = await manager.prepare(runId, {
      mode: "new_project",
      projectName: "todo-app",
    });
    await manager.acknowledgePrepared(runId, historical);
    const seedHead = historical.headCommit;
    historical.state = "completed";
    historical.attempts = [];
    historical.integrations = [];
    const agent: Agent = {
      id: agentId,
      name: "Todo App",
      description: "",
      instructions: "",
      status: "ready",
      role: "standalone",
      parentAgentId: null,
      specialty: null,
      projectId: null,
      unassignedPlacement: "previous",
      workspacePath: path.join(fixture.root, "agents", agentId),
      codexThreadId: null,
      lastError: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const historicalRun: AgentRun = {
      id: runId,
      agentId,
      projectId: null,
      kind: "orchestration",
      parentRunId: null,
      orchestration: completedControlLoop(),
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
    };
    delete historicalRun.orchestration?.outcome;
    await fixture.store.mutate((database) => {
      database.agents.push(agent);
      database.runs.push(historicalRun);
    });
    const beforeRun = structuredClone(
      fixture.store.snapshot().runs.find((item) => item.id === runId)!,
    );
    const counts = executionCounts();
    const restarted = await restartService(fixture, counts);
    const recovered = restarted.service.getRun(runId);
    expect(recovered.status).toBe("completed");
    expect(recovered.project?.attempts).toEqual([]);
    expect(recovered.project?.integrations).toEqual([]);
    expect(recovered.project?.headCommit).toBe(seedHead);
    expect(recovered.project?.source.baseCommit).toBe(seedHead);
    expect(recovered.orchestration?.outcome?.value ?? "unknown").toBe("unknown");
    expect(recovered.project?.integrations).toEqual(beforeRun.project?.integrations);
    expect(recovered.output).toBe("done");
    expect(counts).toEqual({ planner: 0, runner: 0, model: 0 });
  });
});

describe("deleting a project", () => {
  const idleRunner: AgentRunner = {
    run: async () => ({ output: "done", threadId: null, usage: null }),
    cancel: async () => false,
    isAvailable: async () => true,
  };

  it("takes its chats with it and leaves the operator's repository alone", async () => {
    const fixture = await makeFixture(idleRunner, (root) => liveParts(root));
    const project = await fixture.service.openProject({
      displayName: "Doomed",
      repositoryPath: fixture.source,
      revision: "HEAD",
    });
    const chat = await fixture.service.createProjectChat(project.id, { name: "Doomed Chat" });

    const result = await fixture.service.deleteProject(project.id);

    expect(result).toEqual({ deletedChats: 1, removedRepository: false });
    expect(fixture.service.listProjects()).toHaveLength(0);
    // The chats resolve their workspace through the project, so a chat left
    // behind would name a projectId that no longer resolves.
    expect(fixture.service.listAgents().some((agent) => agent.id === chat.id)).toBe(false);
    expect(fixture.store.snapshot().messages.some((item) => item.agentId === chat.id)).toBe(false);
    // Opening somebody's checkout must never become a way to lose it.
    await access(path.join(fixture.source, "shared.txt"));
    await access(path.join(fixture.source, ".git"));
  });

  it("removes a managed repository, because that one is ours", async () => {
    const fixture = await makeFixture(idleRunner, (root) => liveParts(root));
    const project = await fixture.service.createManagedProject({ displayName: "Managed Doomed" });

    await access(project.repositoryPath);
    const result = await fixture.service.deleteProject(project.id);

    expect(result).toEqual({ deletedChats: 0, removedRepository: true });
    await expect(access(project.repositoryPath)).rejects.toThrow();
  });

  it("refuses while a chat in it is still running", async () => {
    const fixture = await makeFixture(idleRunner, (root) => liveParts(root));
    const project = await fixture.service.createManagedProject({ displayName: "Busy" });
    const chat = await fixture.service.createProjectChat(project.id, { name: "Busy Chat" });
    await fixture.store.mutate((database) => {
      const stored = database.agents.find((item) => item.id === chat.id);
      if (stored) stored.status = "busy";
    });

    // Deleting is not an emergency stop. Stop is.
    await expect(fixture.service.deleteProject(project.id)).rejects.toThrow(/still running/i);
    expect(fixture.service.listProjects()).toHaveLength(1);
    expect(fixture.service.listAgents().some((agent) => agent.id === chat.id)).toBe(true);
    await access(project.repositoryPath);
  });

  it("reports a project that is not there as a 404", async () => {
    const fixture = await makeFixture(idleRunner, (root) => liveParts(root));
    await expect(fixture.service.deleteProject("missing")).rejects.toMatchObject({ statusCode: 404 });
  });
});
