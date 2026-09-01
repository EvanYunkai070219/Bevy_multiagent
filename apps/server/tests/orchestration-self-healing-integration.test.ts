import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../src/agent-service.js";
import { loadConfig } from "../src/config.js";
import { CoordinationServer } from "../src/coordination/server.js";
import { EventLog } from "../src/event-log.js";
import { GitClient } from "../src/git-client.js";
import type { ModelCredentialIssuer } from "../src/model-proxy.js";
import type { TeamMessageQueued } from "../src/coordination/messages.js";
import type { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { Diagnoser } from "../src/orchestration/healing/diagnoser.js";
import {
  buildEvolutionFingerprints,
  exactRepeatKey,
  failureCueLookupKey,
} from "../src/orchestration/evolution/evolution-fingerprints.js";
import type { OrchestratorParts } from "../src/orchestration/orchestrator.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { LiveDagAdmission } from "../src/orchestration/live-dag-admission.js";
import { VerificationProfileRegistry } from "../src/orchestration/verification/verification-profile.js";
import type { VerificationRunner } from "../src/orchestration/verification/verifier.js";
import { ProjectRegistry } from "../src/project-registry.js";
import { ProjectRepositoryManager } from "../src/project-repository-manager.js";
import { ProjectRunManager } from "../src/project-run-manager.js";
import { JsonStore } from "../src/store.js";
import type {
  AgentRun,
  AgentRunner,
  GateResult,
  LeaderPlan,
  RunnerRequest,
  RunnerResult,
  SubtaskContract,
  VerificationResult,
  OrchestrationState,
} from "../src/types.js";
import { emptyHealingState } from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";
import { demoProfileDocument, materializeAuthority } from "./verification-authority-fixtures.js";

const roots: string[] = [];
const servers: CoordinationServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface VerifyInput {
  subjectType: VerificationResult["subjectType"];
  subjectId: string;
  stage: VerificationResult["stage"];
  workspacePath: string;
  baseCommit: string;
  contract: SubtaskContract;
  control: { assertActive(): void };
}

function gate(gateId: string, tier: GateResult["tier"], passed = true): GateResult {
  return {
    gateId,
    tier,
    passed,
    evidenceRef: createHash("sha256").update(gateId + ":" + String(passed)).digest("hex"),
    failureFingerprint: passed
      ? null
      : createHash("sha256").update("failed:" + gateId).digest("hex"),
  };
}

function resultOf(
  input: VerifyInput,
  index: number,
  mandatoryPassed: boolean,
  hardProgress: number,
  extras: Partial<VerificationResult> = {},
): VerificationResult {
  return {
    id: "verification-" + input.stage + "-" + index,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    stage: input.stage,
    authorityManifestHash: "authority",
    gates: [gate("integrity", "integrity", mandatoryPassed)],
    failureKind: mandatoryPassed ? null : "deterministic_gate_failure",
    mandatoryPassed,
    hardProgress,
    regressionCount: extras.regressionCount ?? 0,
    modelCalls: extras.modelCalls ?? 0,
    reservedTokens: extras.reservedTokens ?? 0,
    actualInputTokens: extras.actualInputTokens ?? 0,
    actualOutputTokens: extras.actualOutputTokens ?? 0,
    elapsedMs: extras.elapsedMs ?? 1,
    verifiedAt: new Date().toISOString(),
    ...extras,
  };
}

class ScriptedRunner {
  readonly calls: VerifyInput[] = [];
  constructor(
    private readonly plan: (input: VerifyInput, index: number) => VerificationResult | Promise<VerificationResult>,
  ) {}
  asRunner(): VerificationRunner {
    return this as unknown as VerificationRunner;
  }
  async verify(input: VerifyInput): Promise<VerificationResult> {
    input.control.assertActive();
    const index = this.calls.length;
    this.calls.push({ ...input });
    return this.plan(input, index);
  }
}

function healingProfile() {
  return {
    ...demoProfileDocument(),
    contracts: [
      {
        contractKey: "backend-producer",
        allowedInputs: ["shared.txt"],
        allowedOutputs: ["backend.txt"],
        allowedMutationPaths: ["backend.txt"],
        protectedPaths: [".launchpad", "package.json"],
        artifactSchemaIds: ["backend-schema"],
        targetedGateIds: ["targeted"],
        contractGateIds: ["contract"],
        consumerGateIds: ["consumer"],
        regressionGateIds: ["regression"],
        authorizedTools: ["read_file"],
      },
      {
        contractKey: "frontend-producer",
        allowedInputs: ["shared.txt"],
        allowedOutputs: ["frontend.txt"],
        allowedMutationPaths: ["frontend.txt"],
        protectedPaths: [".launchpad", "package.json"],
        artifactSchemaIds: ["frontend-schema"],
        targetedGateIds: ["targeted"],
        contractGateIds: ["contract"],
        consumerGateIds: ["consumer"],
        regressionGateIds: ["regression"],
        authorizedTools: ["read_file"],
      },
      {
        contractKey: "integration-consumer",
        allowedInputs: ["backend.txt", "frontend.txt"],
        allowedOutputs: ["integration.txt"],
        allowedMutationPaths: ["integration.txt"],
        protectedPaths: [".launchpad", "package.json"],
        artifactSchemaIds: ["integration-schema"],
        targetedGateIds: ["targeted"],
        contractGateIds: ["contract"],
        consumerGateIds: ["consumer"],
        regressionGateIds: ["regression"],
        authorizedTools: ["read_file"],
      },
    ],
  };
}

const threeNodePlan: LeaderPlan = {
  needsSubagents: true,
  rationale: "Producer, sibling, and consumer.",
  subtasks: [
    {
      id: "backend",
      title: "Backend",
      role: "Backend engineer",
      prompt: "TASK:backend",
      objective: "Create backend output",
      successCriteria: ["backend file"],
      expectedOutput: "commit",
      dependsOn: [],
      contractKey: "backend-producer",
      outputs: ["backend.txt"],
      mutationPaths: ["backend.txt"],
    },
    {
      id: "frontend",
      title: "Frontend",
      role: "Frontend engineer",
      prompt: "TASK:frontend",
      objective: "Create frontend output",
      successCriteria: ["frontend file"],
      expectedOutput: "commit",
      dependsOn: [],
      contractKey: "frontend-producer",
      outputs: ["frontend.txt"],
      mutationPaths: ["frontend.txt"],
    },
    {
      id: "integration",
      title: "Integration",
      role: "Integration engineer",
      prompt: "TASK:integration",
      objective: "Consume both outputs",
      successCriteria: ["integration file"],
      expectedOutput: "commit",
      dependsOn: ["backend", "frontend"],
      contractKey: "integration-consumer",
      outputs: ["integration.txt"],
      mutationPaths: ["integration.txt"],
    },
  ],
};

it("returns a typed rejection without mutating the live DAG while a repair fence is active", () => {
  const state = {
    healing: emptyHealingState(),
    iterationPlans: [],
  } as unknown as OrchestrationState;
  state.healing.repairGraphFence = {
    runId: "run-1",
    tournamentId: "tournament-1",
    graphRevision: 0,
    graphHash: "a".repeat(64),
    contractHashes: [],
    admittedAt: "2026-08-31T00:00:00.000Z",
  };
  const before = structuredClone(state.healing);
  const result = new LiveDagAdmission(healingProfile().contracts).tryAdmit(state, {
    id: "late-worker",
    prompt: "Do late work",
    role: "Backend engineer",
    objective: "Late objective",
    successCriteria: ["late output"],
    expectedOutput: "commit",
    dependsOn: [],
    contractKey: "backend-producer",
    outputs: ["backend.txt"],
    mutationPaths: ["backend.txt"],
  });

  expect(result).toEqual({ ok: false, error: "repair_graph_frozen" });
  expect(state.healing).toEqual(before);
});

function taskId(request: RunnerRequest): string {
  const match = /^TASK:([a-z-]+)/.exec(request.prompt);
  if (match) return match[1]!;
  if (request.coordinationEnv?.LAUNCHPAD_REPAIR_CANDIDATE === "1") {
    if (request.prompt.includes("Consult the frozen failure")) return "repair-context";
    if (request.prompt.includes("Inspect consumer")) return "repair-strategy";
    return "repair-control";
  }
  throw new Error("fixture task marker missing");
}

async function commitFiles(
  request: RunnerRequest,
  files: Record<string, string>,
): Promise<RunnerResult> {
  const git = new GitClient(5_000);
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(request.workspacePath, relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
  await git.run(request.workspacePath, ["add", "--", ...Object.keys(files)]);
  await git.run(request.workspacePath, ["commit", "-m", "fixture contribution"]);
  const head = await git.head(request.workspacePath);
  return {
    output: [
      "findings: fixture complete",
      "evidence: " + Object.keys(files).join(", "),
      "unresolved gaps: none",
      "recommended next checks: authority gates",
      "LAUNCHPAD_COMMIT=" + head,
    ].join("\n"),
    threadId: null,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function availableDiagnoser(): Diagnoser {
  return {
    diagnose: async (input: { fault: { id: string } }) => ({
      id: "diag-1",
      faultId: input.fault.id,
      status: "available",
      classification: "context",
      rationale: "Need frozen failure context.",
      allowedMutationFamilies: ["context_patch"],
      createdAt: new Date().toISOString(),
    }),
  } as Diagnoser;
}

interface Fixture {
  root: string;
  source: string;
  git: GitClient;
  store: JsonStore;
  service: AgentService;
  issuedBudgetScopes: string[];
}

function contextWinsPlan(input: VerifyInput, index: number): VerificationResult {
  if (input.subjectType === "candidate") {
    const context = input.subjectId.endsWith("context_patch");
    if (input.stage === "candidate") {
      return resultOf(input, index, context, context ? 2 : 0);
    }
    return resultOf(input, index, context, context ? 6 : 0, {
      regressionCount: 0,
      modelCalls: context ? 1 : 3,
      actualInputTokens: context ? 10 : 40,
      elapsedMs: context ? 5 : 50,
    });
  }
  return resultOf(input, index, true, 4);
}

function allFailPlan(input: VerifyInput, index: number): VerificationResult {
  if (input.subjectType === "candidate") return resultOf(input, index, false, 0);
  return resultOf(input, index, true, 4);
}

function expensiveTiePlan(input: VerifyInput, index: number): VerificationResult {
  if (input.subjectType === "candidate") {
    const mutant = !input.subjectId.endsWith("-control");
    if (input.stage === "candidate") return resultOf(input, index, mutant, mutant ? 2 : 0);
    return resultOf(input, index, mutant, mutant ? 6 : 0, {
      regressionCount: 0,
      modelCalls: 2,
      actualInputTokens: 20,
      actualOutputTokens: 20,
      elapsedMs: 10,
    });
  }
  return resultOf(input, index, true, 4);
}

function contextBreaksConsumerPlan(input: VerifyInput, index: number): VerificationResult {
  if (input.subjectType === "candidate") {
    const context = input.subjectId.endsWith("context_patch");
    if (input.stage === "candidate") return resultOf(input, index, context, context ? 4 : 0);
    return resultOf(input, index, false, context ? 6 : 0, { regressionCount: context ? 2 : 0 });
  }
  return resultOf(input, index, true, 4);
}

async function liveCoordination(): Promise<Partial<OrchestratorParts>> {
  const server = new CoordinationServer();
  await server.listen(0);
  servers.push(server);
  return {
    coordination: {
      dataDir: path.join(tmpdir(), "launchpad-heal-coord"),
      baseUrl: server.baseUrl("127.0.0.1"),
      register(token, ingress) {
        server.register(token, ingress);
      },
      unregister(token) {
        server.unregister(token);
      },
    },
  };
}

async function makeFixture(
  runner: AgentRunner,
  verify: (input: VerifyInput, index: number) => VerificationResult | Promise<VerificationResult>,
  extras: Partial<OrchestratorParts> = {},
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-heal-t9-"));
  const authorityRoot = await mkdtemp(path.join(tmpdir(), "launchpad-heal-t9-auth-"));
  roots.push(root, authorityRoot);
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
  const registry = new VerificationProfileRegistry({
    profilePath: await materializeAuthority(authorityRoot, healingProfile()),
    workspaceRoot: config.workspaceRoot,
    workspaceSourceRoots: config.workspaceSourceRoots,
    eventSessionRoot: path.join(config.dataDirectory, "event"),
  });
  await registry.load();
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "agents"));
  const events = new EventLog(path.join(root, "data", "events"), { secrets: [config.arkApiKey] });
  const projectRegistry = new ProjectRegistry(
    store,
    new ProjectRepositoryManager(config.workspaceRoot, config.workspaceSourceRoots, git),
    git,
  );
  const authority = new ScriptedRunner(verify);
  const issuedBudgetScopes: string[] = [];
  const modelProxy = {
    issue(_runId, _agentId, _control, budgetScopeId) {
      if (budgetScopeId) issuedBudgetScopes.push(budgetScopeId);
      return "fixture-model-token";
    },
    revoke() {},
    terminalError() {
      return undefined;
    },
  } satisfies ModelCredentialIssuer;
  const service = new AgentService(
    config,
    store,
    workspaces,
    runner,
    events,
    {
      policy: {
        ...defaultExecutionPolicy,
        maxParallel: 3,
        maxSubtasks: 6,
        maxIterations: 1,
        maxTotalWorkerRuns: 12,
        workerTimeoutMs: 15_000,
        workerSessionPolicy: "fresh",
        workerWorkspacePolicy: "fresh_task_scoped",
      },
      planner: {
        plan: async () => ({
          status: "available",
          plan: threeNodePlan,
          model: "fixture-planner",
          promptVersion: "v1",
        }),
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
        replan: async () => {
          throw new Error("fixture must not replan");
        },
      } as OrchestratorParts["replanner"],
      synthesizer: {
        synthesize: async () => ({
          output: "fixture complete",
          model: "fixture-synth",
          promptVersion: "v1",
        }),
      } as OrchestratorParts["synthesizer"],
      healingEnabled: true,
      contractCatalog: registry.catalog(),
      verificationRegistry: registry,
      verificationRunner: authority.asRunner(),
      diagnoser: availableDiagnoser(),
      git,
      ...extras,
    },
    modelProxy,
    undefined,
    new ProjectRunManager(path.join(root, "project-workspaces"), [root], git),
    {},
    projectRegistry,
    git,
  );
  await service.initialize();
  return { root, source, git, store, service, issuedBudgetScopes };
}

async function sourceSnapshot(git: GitClient, source: string) {
  return {
    branch: await git.run(source, ["symbolic-ref", "--short", "HEAD"]),
    head: await git.head(source),
    status: await git.run(source, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

async function waitForTerminal(service: AgentService, runId: string): Promise<AgentRun> {
  await expect.poll(() => service.getRun(runId).status, { timeout: 40_000 })
    .toMatch(/^(completed|failed|cancelled)$/);
  return service.getRun(runId);
}

async function startProjectRun(fixture: Fixture, name: string) {
  const project = await fixture.service.openProject({
    displayName: name,
    repositoryPath: fixture.source,
    revision: "HEAD",
  });
  const leader = await fixture.service.createProjectChat(project.id, { name });
  const sent = await fixture.service.sendMessage(leader.id, "build " + name);
  const run = await waitForTerminal(fixture.service, sent.run.id);
  return { project, run };
}

async function startProjectRunPending(fixture: Fixture, name: string) {
  const project = await fixture.service.openProject({
    displayName: name,
    repositoryPath: fixture.source,
    revision: "HEAD",
  });
  const leader = await fixture.service.createProjectChat(project.id, { name });
  const sent = await fixture.service.sendMessage(leader.id, "build " + name);
  return { project, leader, runId: sent.run.id };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function coordinationDispatch(
  request: RunnerRequest,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = request.coordinationEnv?.LAUNCHPAD_COORDINATION_URL;
  const token = request.coordinationEnv?.LAUNCHPAD_COORDINATION_TOKEN;
  if (!url || !token) throw new Error("live leader missing coordination ingress");
  const response = await fetch(url.replace(/\/+$/, "") + "/dispatch_subagent", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error("dispatch_subagent refused: " + text);
  return JSON.parse(text) as Record<string, unknown>;
}

function emitProtectedTestFailures(request: RunnerRequest): void {
  const attempts = ["first", "second", "third"] as const;
  for (const attempt of attempts) {
    const timestamp = new Date().toISOString();
    request.sink?.emit({
      spanId: "protected-test-" + attempt,
      parentSpanId: "run",
      kind: "command",
      name: "bash",
      status: "error",
      startedAt: timestamp,
      endedAt: timestamp,
      durationMs: 1,
      input: { command: "npm test -- tests/protected.test.ts --run " + attempt },
      output: { exitCode: 1, text: "FAIL tests/protected.test.ts " + attempt + " run" },
      error: { message: "protected test failed " + attempt, code: "1" },
      attributes: {},
      usage: null,
    });
  }
}

function liveLeaderPrompt(request: RunnerRequest): boolean {
  return Boolean(request.coordinationEnv?.LAUNCHPAD_COORDINATION_URL)
    && request.coordinationEnv?.LAUNCHPAD_REPAIR_CANDIDATE !== "1"
    && !/^TASK:/.test(request.prompt);
}

function healingRunner(options: {
  failBackend?: boolean;
  repairContext?: boolean;
  repairThrows?: boolean;
  malformedContextMarker?: boolean;
  contextTouchesShared?: boolean;
  liveDispatch?: boolean;
  admitConsumerAfterBackendTerminal?: boolean;
  started?: { backend?: number; frontend?: number };
  counts?: { frontend: number; backend: number; integration: number; repair: number };
  repairRuntimeImageIds?: Array<string | undefined>;
}): AgentRunner {
  const counts = options.counts ?? { frontend: 0, backend: 0, integration: 0, repair: 0 };
  return {
    run: async (request) => {
      if (options.liveDispatch && liveLeaderPrompt(request)) {
        const overlap = options.started ?? {};
        const backend = coordinationDispatch(request, {
          id: "backend",
          prompt: "TASK:backend",
          contractKey: "backend-producer",
          outputs: ["backend.txt"],
          mutationPaths: ["backend.txt"],
        });
        const frontend = coordinationDispatch(request, {
          id: "frontend",
          prompt: "TASK:frontend",
          contractKey: "frontend-producer",
          outputs: ["frontend.txt"],
          mutationPaths: ["frontend.txt"],
        });
        await expect.poll(() => (overlap.backend ?? 0) > 0 && (overlap.frontend ?? 0) > 0).toBe(true);
        if (options.admitConsumerAfterBackendTerminal) {
          const terminalBackend = await coordinationDispatch(request, {
            id: "backend",
            prompt: "TASK:backend",
            contractKey: "backend-producer",
            wait: true,
          });
          const terminalResult = terminalBackend.result as { status?: string } | undefined;
          expect(terminalResult?.status ?? terminalBackend.status).toBe("failed");
        }
        const queued = await coordinationDispatch(request, {
          id: "integration",
          prompt: "TASK:integration",
          contractKey: "integration-consumer",
          outputs: ["integration.txt"],
          mutationPaths: ["integration.txt"],
          dependsOn: ["backend", "frontend"],
        });
        const queuedResult = queued.result as { status?: string } | undefined;
        expect(queuedResult?.status ?? queued.status).toBe("blocked");
        const waited = await coordinationDispatch(request, {
          id: "integration",
          prompt: "TASK:integration",
          contractKey: "integration-consumer",
          wait: true,
        });
        await Promise.allSettled([backend, frontend]);
        const waitedResult = waited.result as { status?: string } | undefined;
        return {
          output: "live leader dispatched " + String(waitedResult?.status ?? waited.status ?? "unknown"),
          threadId: null,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      const id = taskId(request);
      if (request.coordinationEnv?.LAUNCHPAD_REPAIR_CANDIDATE === "1") {
        options.repairRuntimeImageIds?.push(request.runtimeImageId);
      }
      if (id === "backend") {
        counts.backend += 1;
        if (options.started) {
          options.started.backend = Date.now();
          await expect.poll(() => options.started?.frontend, { timeout: 2_000 }).toBeDefined();
        }
        if (options.failBackend !== false) {
          emitProtectedTestFailures(request);
          throw new Error("protected test failed three times");
        }
        return commitFiles(request, { "backend.txt": "backend\n" });
      }
      if (id === "frontend") {
        counts.frontend += 1;
        if (options.started) {
          options.started.frontend = Date.now();
          await expect.poll(() => options.started?.backend, { timeout: 2_000 }).toBeDefined();
        }
        return commitFiles(request, { "frontend.txt": "frontend\n" });
      }
      if (id === "integration") {
        counts.integration += 1;
        const backend = await readFile(path.join(request.workspacePath, "backend.txt"), "utf8");
        const frontend = await readFile(path.join(request.workspacePath, "frontend.txt"), "utf8");
        if (backend !== "backend\n" || frontend !== "frontend\n") {
          throw new Error("integration missing parent outputs");
        }
        return commitFiles(request, { "integration.txt": "integrated\n" });
      }
      counts.repair += 1;
      if (options.repairThrows) throw new Error("repair candidate failed");
      if (id === "repair-context" && options.repairContext !== false) {
        const files: Record<string, string> = { "backend.txt": "backend\n" };
        if (options.contextTouchesShared) files["shared.txt"] = "context-shared\n";
        const committed = await commitFiles(request, files);
        if (options.malformedContextMarker) {
          return {
            ...committed,
            output: committed.output.replace(/LAUNCHPAD_COMMIT=[0-9a-f]{40}/, "LAUNCHPAD_COMMIT=not-a-sha"),
          };
        }
        return committed;
      }
      return {
        output: "unchanged control",
        threadId: null,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    cancel: async () => true,
    isAvailable: async () => true,
  };
}

class RepairAbsenceUnprovenRuntime implements AgentRuntime {
  private repairCandidate = false;

  constructor(private readonly runner: AgentRunner) {}

  async start(request: RunnerRequest) {
    this.repairCandidate = request.coordinationEnv?.LAUNCHPAD_REPAIR_CANDIDATE === "1";
    return this.runner.run(request);
  }

  async inject(_message: TeamMessageQueued) {
    return { state: "undeliverable" as const, reason: "fixture" };
  }

  async wake(_message: TeamMessageQueued) {
    return { state: "undeliverable" as const, reason: "fixture" };
  }

  async waitForIdle() {}

  snapshot() {
    return { state: "idle" as const, threadId: null, activeTurnId: null };
  }

  capability() {
    return "queued_follow_up" as const;
  }

  async quiesce() {
    if (this.repairCandidate) throw new Error("repair runtime absence could not be proven");
  }

  async close() {}

  async cancel() {}
}

describe("self-healing tournament integration", () => {
  it("continues fault classification and healing when advisory evidence persistence rejects", async () => {
    const fixture = await makeFixture(
      healingRunner({ failBackend: true, repairContext: true }),
      contextWinsPlan,
      {
        faultEvidenceStore: {
          write: async () => {
            throw new Error("fixture evidence store unavailable");
          },
        },
      },
    );

    const { run } = await startProjectRun(fixture, "heal with unavailable evidence storage");

    expect(run.status).toBe("completed");
    expect(run.orchestration?.healing.faults.length).toBeGreaterThan(0);
    expect(run.orchestration?.healing.faults.every((fault) => fault.evidenceRefs.length === 0)).toBe(true);
    expect(run.orchestration?.healing.diagnoses.length).toBeGreaterThan(0);
    expect(run.orchestration?.healing.tournaments.some((tournament) => tournament.status === "promoted"))
      .toBe(true);
  });

  it("carries the policy image digest through to the actual repair runner request", async () => {
    const digest = "sha256:" + "d".repeat(64);
    const repairRuntimeImageIds: Array<string | undefined> = [];
    const fixture = await makeFixture(
      healingRunner({
        failBackend: true,
        repairContext: true,
        repairRuntimeImageIds,
      }),
      contextWinsPlan,
      {
        runtimeCapabilityEnvironment: {
          schemaVersion: 1,
          modelId: "fixture-model",
          runtimeMode: "container:exec",
          toolSchemas: [{
            name: "read_file",
            description: "Read one workspace file.",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          }],
          sandboxPolicyHash: "a".repeat(64),
          containerImageId: digest,
        },
      },
    );

    const { run } = await startProjectRun(fixture, "pin repair image");

    expect(run.status).toBe("completed");
    expect(repairRuntimeImageIds).toEqual([digest, digest, digest]);
  });

  it("runs repair without an image resolution but disables repeat and cue keys", async () => {
    const counts = { frontend: 0, backend: 0, integration: 0, repair: 0 };
    const repairRuntimeImageIds: Array<string | undefined> = [];
    const fixture = await makeFixture(
      healingRunner({
        failBackend: true,
        repairContext: true,
        counts,
        repairRuntimeImageIds,
      }),
      contextWinsPlan,
      {
        runtimeCapabilityEnvironment: {
          schemaVersion: 1,
          modelId: "fixture-model",
          runtimeMode: "container:exec",
          toolSchemas: [{
            name: "read_file",
            description: "Read one workspace file.",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          }],
          sandboxPolicyHash: "a".repeat(64),
          containerImageId: null,
        },
      },
    );

    const { run } = await startProjectRun(fixture, "repair without resolved image");

    expect(run.status).toBe("completed");
    expect(counts.repair).toBe(3);
    expect(repairRuntimeImageIds).toEqual([undefined, undefined, undefined]);
    const checkpointRoot = path.join(
      path.dirname(run.project!.canonicalWorkspacePath),
      "repair-checkpoints",
    );
    const checkpointFile = (await readdir(checkpointRoot)).find((entry) => entry.endsWith(".json"));
    expect(checkpointFile).toBeDefined();
    const checkpoint = JSON.parse(
      await readFile(path.join(checkpointRoot, checkpointFile!), "utf8"),
    ) as {
      fingerprintComplete: boolean;
      repositoryBaseHash: string;
      contractHash: string;
      authorityManifestHash: string;
      runtimeCapabilityHash: string;
      faultEvidenceHash: string;
    };
    expect(checkpoint.fingerprintComplete).toBe(false);
    const fingerprints = buildEvolutionFingerprints({
      ...checkpoint,
      mutationContentHash: run.orchestration!.healing.candidates[0]!.delta.contentHash,
      runtimeCapabilityComplete: checkpoint.fingerprintComplete,
    });
    expect(exactRepeatKey(fingerprints)).toBeNull();
    expect(failureCueLookupKey(fingerprints)).toBeNull();
  });

  it("runs one tournament, promotes context, resumes integration, and does not restart frontend", async () => {
    const counts = { frontend: 0, backend: 0, integration: 0, repair: 0 };
    const fixture = await makeFixture(
      healingRunner({ failBackend: true, repairContext: true, counts }),
      contextWinsPlan,
    );
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const { project, run } = await startProjectRun(fixture, "heal context");
    const after = await sourceSnapshot(fixture.git, fixture.source);

    expect(run.status).toBe("completed");
    expect(counts.frontend).toBe(1);
    expect(counts.backend).toBe(1);
    expect(counts.repair).toBe(3);
    await expect.poll(() => counts.integration, { timeout: 5_000 }).toBe(1);
    const healing = run.orchestration?.healing;
    const candidateScopes = fixture.issuedBudgetScopes.filter((scope) => scope.startsWith("repair:"));
    expect(candidateScopes).toHaveLength(3);
    expect(new Set(candidateScopes)).toEqual(
      new Set(healing?.candidates.map((candidate) => "repair:" + candidate.id)),
    );
    expect(healing?.tournaments).toHaveLength(1);
    expect(healing?.tournaments[0]?.status).toBe("promoted");
    expect(healing?.tournaments[0]?.winnerCandidateId).toMatch(/context_patch$/);
    expect(
      healing?.candidates.find((item) => item.delta.family === "context_patch")?.delta.addedEvidenceRefs.length,
    ).toBeGreaterThan(0);
    const checkpointRoot = path.join(
      path.dirname(run.project!.canonicalWorkspacePath),
      "repair-checkpoints",
    );
    const checkpointFile = (await readdir(checkpointRoot)).find((entry) => entry.endsWith(".json"));
    expect(checkpointFile).toBeDefined();
    const checkpoint = JSON.parse(
      await readFile(path.join(checkpointRoot, checkpointFile!), "utf8"),
    ) as {
      id: string;
      fingerprintSchemaVersion: number;
      fingerprintComplete: boolean;
      repositoryBaseHash: string;
      contractHash: string;
      authorityManifestHash: string;
      runtimeCapabilityHash: string;
      faultEvidenceHash: string;
      contextEvidenceRefs: string[];
      contextAuditEvidenceRefs: string[];
    };
    expect(checkpoint.fingerprintSchemaVersion).toBe(2);
    expect(checkpoint.fingerprintComplete).toBe(true);
    for (const field of [
      "repositoryBaseHash",
      "contractHash",
      "authorityManifestHash",
      "runtimeCapabilityHash",
      "faultEvidenceHash",
    ] as const) {
      expect(checkpoint[field], field).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(checkpoint.contextEvidenceRefs.length).toBeGreaterThan(0);
    expect(checkpoint.contextAuditEvidenceRefs.length).toBeGreaterThan(0);
    expect(checkpoint.contextEvidenceRefs).not.toEqual(checkpoint.contextAuditEvidenceRefs);
    const frozenEvidence = await Promise.all(checkpoint.contextEvidenceRefs.map(async (ref) => {
      const bytes = await readFile(path.join(checkpointRoot, checkpoint.id, "bundle", ref));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref);
      return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    }));
    expect(frozenEvidence).toHaveLength(1);
    expect(frozenEvidence[0]).toEqual(expect.objectContaining({
      schemaVersion: 1,
      fault: expect.objectContaining({ reasonCode: expect.any(String) }),
      snapshots: expect.arrayContaining([
        expect.objectContaining({ stateFingerprint: expect.any(String) }),
      ]),
      diagnosis: expect.objectContaining({ classification: expect.any(String) }),
    }));
    expect(JSON.stringify(frozenEvidence)).not.toContain("attemptId");
    expect(JSON.stringify(frozenEvidence)).not.toContain("createdAt");
    expect(JSON.stringify(frozenEvidence)).not.toContain("modelCalls");
    expect(healing?.nodes.find((node) => node.subtaskId === "backend")?.state).toBe("completed");
    expect(healing?.nodes.find((node) => node.subtaskId === "frontend")?.state).toBe("completed");
    expect(healing?.nodes.find((node) => node.subtaskId === "integration")?.state).toBe("completed");
    expect(run.project?.integrations.some((item) => item.subtaskId === "backend" && item.state === "integrated")).toBe(true);
    expect(await fixture.git.head(fixture.source)).toBe(before.head);
    expect(after).toEqual(before);
    expect(fixture.service.listProjects().find((item) => item.id === project.id)?.baselineCommit)
      .toBe(run.project?.headCommit);
  });

  it("keeps the canonical head exact when every candidate fails", async () => {
    const fixture = await makeFixture(
      healingRunner({ failBackend: true, repairContext: false, repairThrows: true }),
      allFailPlan,
    );
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const { project, run } = await startProjectRun(fixture, "heal fail-all");
    expect(run.status).toBe("failed");
    expect(run.orchestration?.healing.tournaments).toHaveLength(1);
    expect(run.orchestration?.healing.tournaments[0]?.status).toMatch(/failed|rolled_back/);
    expect(run.orchestration?.outcome?.value).toBe("failed");
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
    expect(fixture.service.listProjects().find((item) => item.id === project.id)?.baselineCommit)
      .toBe(before.head);
    const backendIntegrated = run.project?.integrations.some(
      (item) => item.subtaskId === "backend" && item.state === "integrated",
    );
    expect(backendIntegrated).toBe(false);
  });

  it("prohibits repair verification and promotion when runtime absence cannot be proven", async () => {
    let candidateVerificationCalls = 0;
    const fixture = await makeFixture(
      healingRunner({ failBackend: true, repairContext: true }),
      (input, index) => {
        if (input.subjectType === "candidate") candidateVerificationCalls += 1;
        return contextWinsPlan(input, index);
      },
      { runtimeFactory: (runner) => new RepairAbsenceUnprovenRuntime(runner) },
    );
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const { run } = await startProjectRun(fixture, "repair absence unproven");
    expect(run.status).toBe("failed");
    expect(candidateVerificationCalls).toBe(0);
    expect(run.orchestration?.healing.tournaments[0]?.status).toMatch(/failed|rolled_back/);
    expect(run.orchestration?.healing.candidates.every((item) => item.state === "rejected")).toBe(true);
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
  });

  it("does not promote an expensive mutant tie", async () => {
    const fixture = await makeFixture(
      healingRunner({ failBackend: true, repairContext: true }),
      expensiveTiePlan,
    );
    const { run } = await startProjectRun(fixture, "heal expensive-tie");
    expect(run.status).toBe("failed");
    expect(run.orchestration?.healing.tournaments[0]?.status).toMatch(/failed|rolled_back/);
    expect(run.orchestration?.healing.nodes.find((node) => node.subtaskId === "backend")?.state)
      .toBe("failed");
    expect(run.orchestration?.phase).toBe("failed");
  });

  it("fails closed when authority is unavailable and never synthesizes", async () => {
    let synthesized = 0;
    const fixture = await makeFixture(
      healingRunner({ failBackend: true, repairContext: true }),
      () => {
        throw new Error("authority unavailable");
      },
      {
        synthesizer: {
          synthesize: async () => {
            synthesized += 1;
            return { output: "should not", model: "x", promptVersion: "v1" };
          },
        } as OrchestratorParts["synthesizer"],
      },
    );
    const { run } = await startProjectRun(fixture, "heal authority-down");
    expect(run.status).toBe("failed");
    expect(synthesized).toBe(0);
    expect(run.orchestration?.healing.tournaments[0]?.status).toMatch(/failed|rolled_back/);
  });

  it("rolls back a post-integration failure and leaves the user branch unchanged", async () => {
    const fixture = await makeFixture(
      healingRunner({ failBackend: true, repairContext: true }),
      (input, index) => {
        if (input.stage === "post_integration" && input.subjectType === "contribution") {
          return resultOf(input, index, false, 0);
        }
        return contextWinsPlan(input, index);
      },
    );
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const { project, run } = await startProjectRun(fixture, "heal post-gate");
    expect(run.status).toBe("failed");
    expect(run.orchestration?.healing.candidates.some((item) => item.state === "rolled_back" || item.state === "rejected"))
      .toBe(true);
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
    expect(fixture.service.listProjects().find((item) => item.id === project.id)?.baselineCommit)
      .toBe(before.head);
  });

  it("does not promote context that improves local gates but breaks the consumer", async () => {
    const fixture = await makeFixture(
      healingRunner({ failBackend: true, repairContext: true }),
      contextBreaksConsumerPlan,
    );
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const { project, run } = await startProjectRun(fixture, "heal context-breaks-consumer");
    expect(run.status).toBe("failed");
    expect(run.orchestration?.healing.tournaments[0]?.status).toMatch(/failed|rolled_back/);
    expect(String(run.orchestration?.healing.tournaments[0]?.winnerCandidateId ?? "")).not.toMatch(
      /context_patch$/,
    );
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
    expect(fixture.service.listProjects().find((item) => item.id === project.id)?.baselineCommit)
      .toBe(before.head);
  });

  it("does not promote a candidate with a malformed commit marker", async () => {
    const fixture = await makeFixture(
      healingRunner({ failBackend: true, repairContext: true, malformedContextMarker: true }),
      contextWinsPlan,
    );
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const { project, run } = await startProjectRun(fixture, "heal malformed-marker");
    expect(run.status).toBe("failed");
    expect(run.orchestration?.healing.tournaments[0]?.status).toMatch(/failed|rolled_back/);
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
    expect(fixture.service.listProjects().find((item) => item.id === project.id)?.baselineCommit)
      .toBe(before.head);
  });

  it("rolls back a winner import conflict and leaves the user branch unchanged", async () => {
    let fixture: Fixture | undefined;
    let canonicalHeadBeforeConflict: string | undefined;
    let conflictingHead: string | undefined;
    fixture = await makeFixture(
      healingRunner({ failBackend: true, repairContext: true }),
      async (input, index) => {
        if (input.stage === "finalist" && input.subjectId.endsWith("context_patch") && fixture) {
          const project = fixture.store.snapshot().runs.find(
            (item) => item.status === "running" && item.orchestration && item.project,
          )?.project;
          if (project?.canonicalWorkspacePath && project.headCommit) {
            canonicalHeadBeforeConflict = project.headCommit;
            await writeFile(path.join(project.canonicalWorkspacePath, "backend.txt"), "other\n", "utf8");
            await fixture.git.run(project.canonicalWorkspacePath, ["add", "--", "backend.txt"]);
            await fixture.git.run(project.canonicalWorkspacePath, ["commit", "-m", "conflicting backend"]);
            const head = await fixture.git.head(project.canonicalWorkspacePath);
            conflictingHead = head;
            await fixture.store.mutate((database) => {
              const run = database.runs.find(
                (item) => item.status === "running" && item.orchestration &&
                  item.project?.canonicalWorkspacePath === project.canonicalWorkspacePath,
              );
              if (run?.project) run.project.headCommit = head;
            });
          }
        }
        return contextWinsPlan(input, index);
      },
    );
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const { project, run } = await startProjectRun(fixture, "heal import-conflict");
    expect(run.status).toBe("failed");
    expect(run.orchestration?.healing.candidates.some((item) => item.state === "rolled_back" || item.state === "rejected"))
      .toBe(true);
    expect(conflictingHead).toBeDefined();
    expect(canonicalHeadBeforeConflict).toBeDefined();
    expect(conflictingHead).not.toBe(canonicalHeadBeforeConflict);
    expect(run.orchestration?.healing.tournaments[0]?.failureReason).toMatch(
      /conflict|import|authority|canonical/i,
    );
    const backendConflict = run.project?.integrations.find((item) => item.subtaskId === "backend");
    const frontendIntegration = run.project?.integrations.find((item) => item.subtaskId === "frontend");
    expect(backendConflict).toMatchObject({
      canonicalHeadBefore: conflictingHead,
      canonicalHeadAfter: null,
      state: "conflicted",
      structuralDecision: "failed",
    });
    expect(frontendIntegration?.state).toBe("integrated");
    expect({
      persisted: run.project?.headCommit,
      physical: await fixture.git.head(run.project!.canonicalWorkspacePath),
    }).toEqual({
      persisted: frontendIntegration?.canonicalHeadAfter,
      physical: frontendIntegration?.canonicalHeadAfter,
    });
    expect(await fixture.git.isClean(run.project!.canonicalWorkspacePath)).toBe(true);
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
    expect(fixture.service.listProjects().find((item) => item.id === project.id)?.baselineCommit)
      .toBe(before.head);
  });

  it("fails closed on a stale canonical baseline during winner import", async () => {
    let fixture: Fixture | undefined;
    let persistedHeadBeforeStale: string | undefined;
    let staleHead: string | undefined;
    fixture = await makeFixture(
      healingRunner({ failBackend: true, repairContext: true }),
      async (input, index) => {
        if (input.stage === "finalist" && input.subjectId.endsWith("context_patch") && fixture) {
          const project = fixture.store.snapshot().runs.find(
            (item) => item.status === "running" && item.orchestration && item.project,
          )?.project;
          if (project?.canonicalWorkspacePath) {
            persistedHeadBeforeStale = project.headCommit;
            await writeFile(path.join(project.canonicalWorkspacePath, "stale.txt"), "stale\n", "utf8");
            await fixture.git.run(project.canonicalWorkspacePath, ["add", "--", "stale.txt"]);
            await fixture.git.run(project.canonicalWorkspacePath, ["commit", "-m", "stale baseline"]);
            staleHead = await fixture.git.head(project.canonicalWorkspacePath);
          }
        }
        return contextWinsPlan(input, index);
      },
    );
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const { project, run } = await startProjectRun(fixture, "heal stale-baseline");
    expect(run.status).toBe("failed");
    expect(run.orchestration?.healing.tournaments[0]?.status).toMatch(/failed|rolled_back|cancelled/);
    expect(persistedHeadBeforeStale).toBeDefined();
    expect(staleHead).toBeDefined();
    expect(run.project?.headCommit).toBe(persistedHeadBeforeStale);
    expect(await fixture.git.head(run.project!.canonicalWorkspacePath)).toBe(staleHead);
    expect(await fixture.git.isClean(run.project!.canonicalWorkspacePath)).toBe(true);
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
    expect(fixture.service.listProjects().find((item) => item.id === project.id)?.baselineCommit)
      .toBe(before.head);
  });

  it("dispatches a live-leader wave, overlaps siblings, heals backend, and does not restart frontend", async () => {
    const counts = { frontend: 0, backend: 0, integration: 0, repair: 0 };
    const started: { backend?: number; frontend?: number } = {};
    const fixture = await makeFixture(
      healingRunner({
        failBackend: true,
        repairContext: true,
        liveDispatch: true,
        counts,
        started,
      }),
      contextWinsPlan,
      await liveCoordination(),
    );
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const startedAt = Date.now();
    const { project, run } = await startProjectRun(fixture, "heal live-leader");
    expect(Date.now() - startedAt).toBeLessThan(35_000);
    expect(run.status).toBe("completed");
    expect(started.backend).toBeDefined();
    expect(started.frontend).toBeDefined();
    expect(counts.frontend).toBe(1);
    expect(counts.backend).toBe(1);
    expect(counts.repair).toBe(3);
    expect(counts.integration).toBe(1);
    const healing = run.orchestration?.healing;
    expect(healing?.tournaments).toHaveLength(1);
    expect(healing?.tournaments[0]?.status).toBe("promoted");
    expect(healing?.tournaments[0]?.winnerCandidateId).toMatch(/context_patch$/);
    expect(healing?.nodes.find((node) => node.subtaskId === "backend")?.state).toBe("completed");
    expect(healing?.nodes.find((node) => node.subtaskId === "frontend")?.state).toBe("completed");
    expect(healing?.nodes.find((node) => node.subtaskId === "integration")?.state).toBe("completed");
    expect(
      healing?.candidates.find((item) => item.delta.family === "context_patch")?.delta.addedEvidenceRefs.length,
    ).toBeGreaterThan(0);
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
    expect(fixture.service.listProjects().find((item) => item.id === project.id)?.baselineCommit)
      .toBe(run.project?.headCommit);
  });

  it("settles wait=true dependents as blocked when the producer tournament is not promoted", async () => {
    const counts = { frontend: 0, backend: 0, integration: 0, repair: 0 };
    const fixture = await makeFixture(
      healingRunner({
        failBackend: true,
        repairContext: false,
        repairThrows: true,
        liveDispatch: true,
        admitConsumerAfterBackendTerminal: true,
        counts,
        started: {},
      }),
      allFailPlan,
      await liveCoordination(),
    );
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const startedAt = Date.now();
    const { project, run } = await startProjectRun(fixture, "heal live-wait-fail");
    expect(Date.now() - startedAt).toBeLessThan(35_000);
    expect(run.status).toBe("failed");
    expect(counts.frontend).toBe(1);
    expect(counts.integration).toBe(0);
    expect(run.orchestration?.healing.nodes.map((node) => ({
      subtaskId: node.subtaskId,
      state: node.state,
    }))).toContainEqual({ subtaskId: "integration", state: "blocked" });
    const durable = fixture.store.snapshot().runs.find((item) => item.id === run.id)?.orchestration;
    expect(durable?.healing.nodes.map((node) => ({
      subtaskId: node.subtaskId,
      state: node.state,
    }))).toContainEqual({ subtaskId: "integration", state: "blocked" });
    expect(run.orchestration?.healing.tournaments[0]?.status).toMatch(/failed|rolled_back/);
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
    expect(fixture.service.listProjects().find((item) => item.id === project.id)?.baselineCommit)
      .toBe(before.head);
  });

  it("cancels the live repair path during finalist verification without publishing repair state", async () => {
    const entered = deferred();
    const release = deferred();
    const counts = { frontend: 0, backend: 0, integration: 0, repair: 0 };
    const fixture = await makeFixture(
      healingRunner({
        failBackend: true,
        repairContext: true,
        liveDispatch: true,
        counts,
        started: {},
      }),
      async (input, index) => {
        if (input.subjectType === "candidate" && input.stage === "finalist") {
          entered.resolve();
          await release.promise;
          input.control.assertActive();
        }
        return contextWinsPlan(input, index);
      },
      await liveCoordination(),
    );
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const { project, leader, runId } = await startProjectRunPending(fixture, "cancel live verification");
    await entered.promise;
    const canonicalBeforeCancellation = fixture.service.getRun(runId).project?.headCommit;
    expect(canonicalBeforeCancellation).toBeTruthy();

    const stopping = fixture.service.stopAgent(leader.id);
    release.resolve();
    await stopping;

    const run = await waitForTerminal(fixture.service, runId);
    expect(run.status).toBe("cancelled");
    expect(run.orchestration?.healing.tournaments[0]?.status).toBe("cancelled");
    expect(run.project?.headCommit).toBe(canonicalBeforeCancellation);
    expect(counts.integration).toBe(0);
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
    expect(fixture.service.listProjects().find((item) => item.id === project.id)?.baselineCommit)
      .toBe(before.head);
  });

  it("cancels the live repair path after canonical apply and restores the exact pre-apply head", async () => {
    const entered = deferred();
    const release = deferred();
    const counts = { frontend: 0, backend: 0, integration: 0, repair: 0 };
    let fixture!: Fixture;
    let canonicalHeadBefore: string | undefined;
    fixture = await makeFixture(
      healingRunner({
        failBackend: true,
        repairContext: true,
        liveDispatch: true,
        counts,
        started: {},
      }),
      contextWinsPlan,
      {
        ...(await liveCoordination()),
        afterCanonicalIntegrationForTest: async () => {
          const active = fixture.store.snapshot().runs.find((item) =>
            item.project?.integrations.some((record) =>
              record.subtaskId === "backend" && record.state === "integrating"
            )
          );
          const integrating = active?.project?.integrations.find((item) =>
            item.subtaskId === "backend" && item.state === "integrating"
          );
          if (!integrating) return;
          canonicalHeadBefore = integrating.canonicalHeadBefore;
          entered.resolve();
          await release.promise;
        },
      },
    );
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const { project, leader, runId } = await startProjectRunPending(fixture, "cancel live integration");
    await entered.promise;
    expect(canonicalHeadBefore).toBeTruthy();
    expect(fixture.service.getRun(runId).project?.headCommit).toBe(canonicalHeadBefore);

    const stopping = fixture.service.stopAgent(leader.id);
    release.resolve();
    await stopping;

    const run = await waitForTerminal(fixture.service, runId);
    const backendIntegration = run.project?.integrations.find((item) => item.subtaskId === "backend");
    expect(run.status).toBe("cancelled");
    expect(backendIntegration).toMatchObject({ state: "rolled_back", reason: "user_cancelled" });
    expect(run.project?.headCommit).toBe(canonicalHeadBefore);
    expect(counts.integration).toBe(0);
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
    expect(fixture.service.listProjects().find((item) => item.id === project.id)?.baselineCommit)
      .toBe(before.head);
  });

  it("compensates live cancellation after the integration decision but before node settlement", async () => {
    const entered = deferred();
    const release = deferred();
    const counts = { frontend: 0, backend: 0, integration: 0, repair: 0 };
    let fixture!: Fixture;
    let canonicalHeadBefore: string | undefined;
    fixture = await makeFixture(
      healingRunner({
        failBackend: true,
        repairContext: true,
        liveDispatch: true,
        counts,
        started: {},
      }),
      contextWinsPlan,
      {
        ...(await liveCoordination()),
        afterIntegrationDecisionForTest: async () => {
          const active = fixture.store.snapshot().runs.find((item) =>
            item.project?.integrations.some((record) =>
              record.subtaskId === "backend" && record.state === "integrated"
            )
          );
          const integrated = active?.project?.integrations.find((item) =>
            item.subtaskId === "backend" && item.state === "integrated"
          );
          if (!integrated) return;
          canonicalHeadBefore = integrated.canonicalHeadBefore;
          entered.resolve();
          await release.promise;
        },
      },
    );
    const before = await sourceSnapshot(fixture.git, fixture.source);
    const { project, leader, runId } = await startProjectRunPending(fixture, "cancel decided integration");
    await entered.promise;
    expect(canonicalHeadBefore).toBeTruthy();
    expect(fixture.service.getRun(runId).project?.headCommit).not.toBe(canonicalHeadBefore);

    const stopping = fixture.service.stopAgent(leader.id);
    release.resolve();
    await stopping;

    const run = await waitForTerminal(fixture.service, runId);
    const backendIntegration = run.project?.integrations.find((item) => item.subtaskId === "backend");
    expect(run.status).toBe("cancelled");
    expect(backendIntegration).toMatchObject({ state: "rolled_back", reason: "user_cancelled" });
    expect(run.project?.headCommit).toBe(canonicalHeadBefore);
    expect(run.orchestration?.healing.nodes.find((node) => node.subtaskId === "backend")?.state)
      .not.toBe("completed");
    expect(counts.integration).toBe(0);
    expect(await sourceSnapshot(fixture.git, fixture.source)).toEqual(before);
    expect(fixture.service.listProjects().find((item) => item.id === project.id)?.baselineCommit)
      .toBe(before.head);
  });
});
