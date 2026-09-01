/**
 * Milestone 2 acceptance: an ordinary contribution is verified by the outer
 * authority before import and again inside serialized canonical integration.
 * The authority is faked at the container boundary only — integrity is decided
 * from the real committed diff by the real profile registry.
 */
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../src/agent-service.js";
import { AttemptWorkspaceManager } from "../src/attempt-workspace-manager.js";
import { loadConfig } from "../src/config.js";
import { EventLog } from "../src/event-log.js";
import { GitClient } from "../src/git-client.js";
import type { OrchestratorParts } from "../src/orchestration/orchestrator.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
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
  OrchestrationState,
  RunnerRequest,
  RunnerResult,
  SubtaskContract,
  TaskNodeState,
  VerificationResult,
} from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";
import { demoProfileDocument, materializeAuthority } from "./verification-authority-fixtures.js";

const roots: string[] = [];

afterEach(async () => {
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

type VerifyOutcome = Partial<VerificationResult> & { gates: GateResult[] };
type VerifyPlan = (input: VerifyInput, index: number) => VerifyOutcome | Promise<VerifyOutcome>;

function gate(
  gateId: string,
  tier: GateResult["tier"],
  passed = true,
): GateResult {
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

const PRE_TIERS: GateResult["tier"][] = [
  "targeted",
  "contract",
  "consumer",
  "held_out",
  "mutation_quality",
  "regression",
];

function passingPreGates(): GateResult[] {
  return PRE_TIERS.map((tier) => gate(tier + "-gate", tier));
}

function passingPostGates(): GateResult[] {
  return [gate("post-integration-gate", "post_integration"), gate("regression-gate", "regression")];
}

/**
 * Stands in for the container-backed authority. Gate verdicts are scripted, but
 * the integrity verdict is computed from the candidate's real committed diff by
 * the real registry, so protected-path and existing-test rules are not faked.
 */
class ScriptedAuthority {
  readonly calls: VerifyInput[] = [];
  private readonly git = new GitClient(5_000);

  constructor(
    private readonly registry: VerificationProfileRegistry,
    private readonly plan: VerifyPlan,
  ) {}

  asRunner(): VerificationRunner {
    return this as unknown as VerificationRunner;
  }

  async verify(input: VerifyInput): Promise<VerificationResult> {
    input.control.assertActive();
    const index = this.calls.length;
    this.calls.push({ ...input });
    const integrity = await this.integrityGate(input);
    if (!integrity.passed) {
      return this.result(input, index, { gates: [integrity], mandatoryPassed: false });
    }
    const scripted = await this.plan(input, index);
    return this.result(input, index, {
      ...scripted,
      gates: [integrity, ...scripted.gates],
    });
  }

  private async integrityGate(input: VerifyInput): Promise<GateResult> {
    const diff = await this.git.run(input.workspacePath, [
      "diff",
      "--no-ext-diff",
      "--end-of-options",
      input.baseCommit,
      "HEAD",
    ]);
    try {
      await this.registry.assertCandidatePatch(diff, input.contract);
      return gate("integrity", "integrity");
    } catch {
      return gate("integrity", "integrity", false);
    }
  }

  private result(input: VerifyInput, index: number, outcome: VerifyOutcome): VerificationResult {
    const gates = outcome.gates;
    const mandatoryPassed = outcome.mandatoryPassed ?? gates.every((item) => item.passed);
    const base: VerificationResult = {
      id: "verification-" + input.stage + "-" + index,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      stage: input.stage,
      authorityManifestHash: this.registry.profile().contentHash,
      gates,
      failureKind: mandatoryPassed ? null : "deterministic_gate_failure",
      mandatoryPassed,
      hardProgress: gates.filter((item) => item.passed).length,
      regressionCount: gates.filter((item) => item.tier === "regression" && !item.passed).length,
      modelCalls: 0,
      reservedTokens: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      elapsedMs: 1,
      verifiedAt: new Date().toISOString(),
    };
    // Only keys the script actually set override the stamped result, so a test
    // can forge an id, stage, or subject without disturbing anything else.
    const forged = Object.fromEntries(
      Object.entries(outcome).filter(([, value]) => value !== undefined),
    );
    return { ...base, ...forged } as VerificationResult;
  }
}

function healingProfileDocument() {
  return {
    ...demoProfileDocument(),
    contracts: [
      {
        contractKey: "feature-producer",
        allowedInputs: ["shared.txt"],
        allowedOutputs: ["feature.txt"],
        allowedMutationPaths: ["feature.txt"],
        protectedPaths: [".launchpad", "package.json"],
        artifactSchemaIds: ["feature-schema"],
        targetedGateIds: ["targeted"],
        contractGateIds: ["contract"],
        consumerGateIds: ["consumer"],
        regressionGateIds: ["regression"],
        authorizedTools: ["read_file"],
      },
      {
        contractKey: "docs-producer",
        allowedInputs: ["shared.txt"],
        allowedOutputs: ["docs.txt"],
        allowedMutationPaths: ["docs.txt"],
        protectedPaths: [".launchpad", "package.json"],
        artifactSchemaIds: ["docs-schema"],
        targetedGateIds: ["targeted"],
        contractGateIds: ["contract"],
        consumerGateIds: ["consumer"],
        regressionGateIds: ["regression"],
        authorizedTools: ["read_file"],
      },
    ],
  };
}

const featurePlan: LeaderPlan = {
  needsSubagents: true,
  rationale: "One contract-bearing producer.",
  subtasks: [
    {
      id: "feature",
      title: "Feature",
      role: "Engineer",
      prompt: "TASK:feature",
      objective: "Add the feature file",
      successCriteria: ["feature file committed"],
      expectedOutput: "commit",
      dependsOn: [],
      contractKey: "feature-producer",
      outputs: ["feature.txt"],
      mutationPaths: ["feature.txt"],
    },
  ],
};

interface Fixture {
  root: string;
  source: string;
  git: GitClient;
  store: JsonStore;
  service: AgentService;
  registry: VerificationProfileRegistry;
}

function baseParts(plan: LeaderPlan, overrides: Partial<OrchestratorParts>): OrchestratorParts {
  return {
    policy: {
      ...defaultExecutionPolicy,
      maxParallel: 2,
      maxSubtasks: 4,
      maxIterations: 1,
      maxTotalWorkerRuns: 4,
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
  build: (registry: VerificationProfileRegistry) => Partial<OrchestratorParts>,
  plan: LeaderPlan = featurePlan,
): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-trusted-"));
  const authorityRoot = await mkdtemp(path.join(tmpdir(), "launchpad-trusted-authority-"));
  roots.push(root, authorityRoot);
  const source = path.join(root, "source");
  const git = new GitClient(5_000);
  await git.run(root, ["init", "-b", "fixture-main", source]);
  await writeFile(path.join(source, "shared.txt"), "seed\n", "utf8");
  await mkdir(path.join(source, "tests"), { recursive: true });
  await writeFile(path.join(source, "tests", "existing.test.js"), "assert(strict);\n", "utf8");
  await git.run(source, ["add", "--", "shared.txt", "tests/existing.test.js"]);
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
    profilePath: await materializeAuthority(authorityRoot, healingProfileDocument()),
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
  const service = new AgentService(
    config,
    store,
    workspaces,
    runner,
    events,
    baseParts(plan, build(registry)),
    undefined,
    undefined,
    new ProjectRunManager(path.join(root, "project-workspaces"), [root], git),
    {},
    projectRegistry,
    git,
  );
  await service.initialize();
  return { root, source, git, store, service, registry };
}

function healingParts(
  registry: VerificationProfileRegistry,
  authority: ScriptedAuthority | null,
): Partial<OrchestratorParts> {
  return {
    healingEnabled: true,
    contractCatalog: registry.catalog(),
    verificationRegistry: registry,
    ...(authority ? { verificationRunner: authority.asRunner() } : {}),
  };
}

/** Commits `files` as exactly one commit and reports the marker the collector needs. */
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

function workerCommitting(files: Record<string, string>): AgentRunner {
  return {
    run: async (request) => commitFiles(request, files),
    cancel: async () => false,
    isAvailable: async () => true,
  };
}

async function waitForTerminal(service: AgentService, runId: string): Promise<AgentRun> {
  await expect.poll(() => service.getRun(runId).status, { timeout: 25_000 })
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
  return waitForTerminal(fixture.service, sent.run.id);
}

const FEATURE_FILE = { "feature.txt": "feature\n" };

function liveOrchestration(service: AgentService): OrchestrationState {
  const live = (
    service as unknown as {
      orchestrator: { liveOrchestration: Map<string, OrchestrationState> };
    }
  ).orchestrator.liveOrchestration;
  const states = [...live.values()];
  const state = states[0];
  if (states.length !== 1 || !state) throw new Error("expected exactly one live orchestration");
  return state;
}

const twoSubtaskPlan: LeaderPlan = {
  needsSubagents: true,
  rationale: "Two independent producers sharing one canonical base.",
  subtasks: [
    { ...featurePlan.subtasks[0]! },
    {
      id: "docs",
      title: "Docs",
      role: "Engineer",
      prompt: "TASK:docs",
      objective: "Add the docs file",
      successCriteria: ["docs file committed"],
      expectedOutput: "commit",
      dependsOn: [],
      contractKey: "docs-producer",
      outputs: ["docs.txt"],
      mutationPaths: ["docs.txt"],
    },
  ],
};

describe("trusted contribution verification", () => {
  it("verifies before import and after integration, records both ids, and completes without diagnosis", async () => {
    let authority!: ScriptedAuthority;
    const fixture = await makeFixture(workerCommitting(FEATURE_FILE), (registry) => {
      authority = new ScriptedAuthority(registry, (input) =>
        input.stage === "post_integration"
          ? { gates: passingPostGates() }
          : { gates: passingPreGates() },
      );
      return healingParts(registry, authority);
    });

    const run = await startProjectRun(fixture, "trusted success");

    expect(run.status).toBe("completed");
    expect(authority.calls.map((call) => call.stage)).toEqual([
      "pre_integration",
      "post_integration",
    ]);
    const [pre, post] = authority.calls;
    expect(pre).toMatchObject({ subjectType: "contribution", stage: "pre_integration" });
    expect(pre?.contract.subtaskId).toBe("feature");
    expect(pre?.contract.contractKey).toBe("feature-producer");
    expect(pre?.contract.targetedGateIds).toEqual(["targeted"]);
    const attempt = run.project?.attempts.find((item) => item.subtaskId === "feature");
    expect(pre?.workspacePath).toBe(attempt?.workspacePath);
    expect(pre?.baseCommit).toBe(attempt?.baseCommit);
    expect(post?.workspacePath).toBe(run.project?.canonicalWorkspacePath);

    const verifications = run.orchestration?.healing.verifications ?? [];
    expect(verifications.map((item) => item.stage)).toEqual([
      "pre_integration",
      "post_integration",
    ]);
    expect(verifications.every((item) => item.mandatoryPassed)).toBe(true);
    const integration = run.project?.integrations[0];
    expect(integration).toMatchObject({ subtaskId: "feature", state: "integrated" });
    expect(integration?.verificationIds).toEqual(verifications.map((item) => item.id));

    const node = run.orchestration?.healing.nodes.find((item) => item.subtaskId === "feature");
    expect(node).toMatchObject({ state: "completed", attemptId: attempt?.attemptId });
    expect(node?.verificationIds).toEqual(verifications.map((item) => item.id));
    expect(node?.integrationContributionId).toBe(integration?.contributionId);
    expect(run.orchestration?.healing.faults).toEqual([]);
    expect(run.orchestration?.healing.diagnoses).toEqual([]);
    expect(run.orchestration?.healing.tournaments).toEqual([]);
    await expect(readFile(path.join(run.project!.canonicalWorkspacePath, "feature.txt"), "utf8"))
      .resolves.toBe("feature\n");
  }, 40_000);

  it("records false_completion and leaves canonical HEAD unchanged when a contract gate fails", async () => {
    let authority!: ScriptedAuthority;
    const fixture = await makeFixture(workerCommitting(FEATURE_FILE), (registry) => {
      authority = new ScriptedAuthority(registry, () => ({
        gates: [
          gate("targeted-gate", "targeted"),
          gate("contract-gate", "contract", false),
        ],
      }));
      return healingParts(registry, authority);
    });

    const run = await startProjectRun(fixture, "false completion");

    expect(run.status).toBe("failed");
    expect(authority.calls.map((call) => call.stage)).toEqual(["pre_integration"]);
    expect(run.project?.integrations).toEqual([]);
    expect(run.project?.headCommit).toBe(run.project?.source.baseCommit);
    await expect(access(path.join(run.project!.canonicalWorkspacePath, "feature.txt")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const verification = run.orchestration?.healing.verifications[0];
    expect(verification).toMatchObject({ stage: "pre_integration", mandatoryPassed: false });
    expect(verification?.gates.find((item) => item.gateId === "contract-gate"))
      .toMatchObject({ passed: false, tier: "contract" });
    expect(verification?.gates.find((item) => item.gateId === "contract-gate")?.evidenceRef)
      .toMatch(/^[0-9a-f]{64}$/);

    const fault = run.orchestration?.healing.faults.find((item) => item.subtaskId === "feature");
    expect(fault).toMatchObject({ class: "false_completion", repairable: true });
    const node = run.orchestration?.healing.nodes.find((item) => item.subtaskId === "feature");
    expect(node?.state).toBe("failed");
    expect(node?.verificationIds).toEqual([verification?.id]);
    expect(node?.integrationContributionId).toBeNull();
  }, 40_000);

  for (const tier of ["consumer", "held_out", "mutation_quality", "regression"] as const) {
    it("keeps a contribution that passes targeted gates but fails " + tier + " out of canonical integration", async () => {
      let authority!: ScriptedAuthority;
      const fixture = await makeFixture(workerCommitting(FEATURE_FILE), (registry) => {
        authority = new ScriptedAuthority(registry, () => ({
          gates: PRE_TIERS.map((item) => gate(item + "-gate", item, item !== tier)),
        }));
        return healingParts(registry, authority);
      });

      const run = await startProjectRun(fixture, "gate " + tier);

      expect(run.status).toBe("failed");
      expect(authority.calls.map((call) => call.stage)).toEqual(["pre_integration"]);
      expect(run.project?.integrations).toEqual([]);
      expect(run.project?.headCommit).toBe(run.project?.source.baseCommit);
      expect(run.orchestration?.healing.verifications[0]?.mandatoryPassed).toBe(false);
      expect(run.orchestration?.healing.nodes[0]?.state).toBe("failed");
    }, 40_000);
  }

  it("rolls back to the exact prior head and clean tree when only the post-integration gate fails", async () => {
    let authority!: ScriptedAuthority;
    let untracked = "";
    const fixture = await makeFixture(workerCommitting(FEATURE_FILE), (registry) => {
      authority = new ScriptedAuthority(registry, async (input) => {
        if (input.stage !== "post_integration") return { gates: passingPreGates() };
        untracked = path.join(input.workspacePath, "authority-scratch.txt");
        await writeFile(untracked, "left behind\n", "utf8");
        return { gates: [gate("post-integration-gate", "post_integration", false)] };
      });
      return healingParts(registry, authority);
    });

    const run = await startProjectRun(fixture, "post failure");

    expect(run.status).toBe("failed");
    expect(authority.calls.map((call) => call.stage)).toEqual([
      "pre_integration",
      "post_integration",
    ]);
    const canonical = run.project!.canonicalWorkspacePath;
    expect(run.project?.headCommit).toBe(run.project?.source.baseCommit);
    expect(await fixture.git.head(canonical)).toBe(run.project?.source.baseCommit);
    expect(await fixture.git.isClean(canonical)).toBe(true);
    await expect(access(untracked)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(canonical, "feature.txt")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const integration = run.project?.integrations[0];
    expect(integration).toMatchObject({
      subtaskId: "feature",
      state: "rolled_back",
      structuralDecision: "failed",
      canonicalHeadAfter: null,
    });
    expect(integration?.reason).toContain("post_integration_verification_failed");
    expect(integration?.verificationIds)
      .toEqual(run.orchestration?.healing.verifications.map((item) => item.id));
    const node = run.orchestration?.healing.nodes.find((item) => item.subtaskId === "feature");
    expect(node?.state).not.toBe("completed");
  }, 40_000);

  it("fails integrity when a worker weakens an existing test while adding a passing one", async () => {
    let authority!: ScriptedAuthority;
    const runner = workerCommitting({
      "feature.txt": "feature\n",
      "tests/existing.test.js": "assert(loose);\n",
      "tests/agent-added.test.js": "assert(true);\n",
    });
    const fixture = await makeFixture(runner, (registry) => {
      authority = new ScriptedAuthority(registry, () => ({ gates: passingPreGates() }));
      return healingParts(registry, authority);
    });

    const run = await startProjectRun(fixture, "weakened test");

    expect(run.status).toBe("failed");
    expect(authority.calls.map((call) => call.stage)).toEqual(["pre_integration"]);
    const verification = run.orchestration?.healing.verifications[0];
    expect(verification?.mandatoryPassed).toBe(false);
    expect(verification?.gates).toEqual([
      expect.objectContaining({ gateId: "integrity", tier: "integrity", passed: false }),
    ]);
    expect(run.project?.integrations).toEqual([]);
    expect(run.project?.headCommit).toBe(run.project?.source.baseCommit);
  }, 40_000);

  it("denies promotion when a new agent-authored test passes but mandatory authority gates fail", async () => {
    let authority!: ScriptedAuthority;
    const runner = workerCommitting({
      "feature.txt": "feature\n",
      "tests/agent-added.test.js": "assert(true);\n",
    });
    const fixture = await makeFixture(runner, (registry) => {
      authority = new ScriptedAuthority(registry, () => ({
        gates: [
          gate("agent-authored", "targeted"),
          gate("consumer-gate", "consumer", false),
        ],
      }));
      return healingParts(registry, authority);
    });

    const run = await startProjectRun(fixture, "agent test only");

    expect(run.status).toBe("failed");
    expect(run.orchestration?.healing.verifications[0]?.gates)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ gateId: "integrity", passed: true }),
        expect.objectContaining({ gateId: "agent-authored", passed: true }),
      ]));
    expect(run.orchestration?.healing.verifications[0]?.mandatoryPassed).toBe(false);
    expect(run.project?.integrations).toEqual([]);
    expect(run.project?.headCommit).toBe(run.project?.source.baseCommit);
  }, 40_000);

  it("decides on the frozen mandatory profile and still records a failed supplementary test", async () => {
    let authority!: ScriptedAuthority;
    const runner = workerCommitting({
      "feature.txt": "feature\n",
      "tests/agent-added.test.js": "assert(false);\n",
    });
    const fixture = await makeFixture(runner, (registry) => {
      authority = new ScriptedAuthority(registry, (input) =>
        input.stage === "post_integration"
          ? { gates: passingPostGates() }
          : {
              gates: [...passingPreGates(), gate("agent-supplementary", "targeted", false)],
              mandatoryPassed: true,
            },
      );
      return healingParts(registry, authority);
    });

    const run = await startProjectRun(fixture, "supplementary failure");

    expect(run.status).toBe("completed");
    expect(run.project?.integrations[0]?.state).toBe("integrated");
    const pre = run.orchestration?.healing.verifications[0];
    expect(pre?.mandatoryPassed).toBe(true);
    expect(pre?.gates.find((item) => item.gateId === "agent-supplementary"))
      .toMatchObject({ passed: false, failureFingerprint: expect.any(String) });
  }, 40_000);

  it("keeps structural-only integration and never calls the authority when healing is disabled", async () => {
    let authority!: ScriptedAuthority;
    const fixture = await makeFixture(workerCommitting(FEATURE_FILE), (registry) => {
      authority = new ScriptedAuthority(registry, () => ({ gates: passingPreGates() }));
      return { verificationRunner: authority.asRunner() };
    });

    const run = await startProjectRun(fixture, "healing off");

    expect(run.status).toBe("completed");
    expect(authority.calls).toEqual([]);
    expect(run.project?.integrations[0]).toMatchObject({
      state: "integrated",
      structuralDecision: "passed",
      verificationIds: [],
    });
    expect(run.orchestration?.healing.verifications).toEqual([]);
  }, 40_000);

  it("fails closed before any worker starts when healing is enabled without a verification authority", async () => {
    let workerStarts = 0;
    const runner: AgentRunner = {
      run: async (request) => {
        workerStarts += 1;
        return commitFiles(request, FEATURE_FILE);
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const fixture = await makeFixture(runner, (registry) => healingParts(registry, null));

    const run = await startProjectRun(fixture, "missing authority");

    expect(run.status).toBe("failed");
    expect(workerStarts).toBe(0);
    expect(run.error).toContain("verification_authority_unavailable");
    expect(run.project?.integrations).toEqual([]);
    expect(run.project?.headCommit).toBe(run.project?.source.baseCommit);
  }, 40_000);

  it("fails closed before any worker starts when a planner subtask declares no catalog contract", async () => {
    let workerStarts = 0;
    const runner: AgentRunner = {
      run: async (request) => {
        workerStarts += 1;
        return commitFiles(request, FEATURE_FILE);
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const unknownKeyPlan: LeaderPlan = {
      ...featurePlan,
      subtasks: [{ ...featurePlan.subtasks[0]!, contractKey: "not-in-catalog" }],
    };
    const fixture = await makeFixture(
      runner,
      (registry) => healingParts(registry, new ScriptedAuthority(registry, () => ({ gates: [] }))),
      unknownKeyPlan,
    );

    const run = await startProjectRun(fixture, "unknown contract");

    expect(run.status).toBe("failed");
    expect(workerStarts).toBe(0);
    expect(run.error).toContain("unknown contract key");
    expect(run.project?.integrations).toEqual([]);
  }, 40_000);

  it("never verifies ephemeral research even when healing is enabled", async () => {
    let authority!: ScriptedAuthority;
    const runner: AgentRunner = {
      run: async () => ({
        output: "findings: notes\nevidence: none\nunresolved gaps: none\nrecommended next checks: none",
        threadId: null,
        usage: null,
      }),
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const researchPlan: LeaderPlan = {
      needsSubagents: true,
      rationale: "One research worker.",
      subtasks: [{
        id: "research", title: "Research", role: "Researcher", prompt: "TASK:research",
        objective: "Research", successCriteria: ["notes"], expectedOutput: "notes", dependsOn: [],
        contractKey: "feature-producer",
      }],
    };
    const fixture = await makeFixture(runner, (registry) => {
      authority = new ScriptedAuthority(registry, () => ({ gates: passingPreGates() }));
      return healingParts(registry, authority);
    }, researchPlan);

    const leader = await fixture.service.createAgent({ name: "Research leader", role: "leader" });
    const { run } = await fixture.service.sendMessage(leader.id, "research");
    const finalRun = await waitForTerminal(fixture.service, run.id);

    expect(finalRun.status).toBe("completed");
    expect(authority.calls).toEqual([]);
    expect(finalRun.orchestration?.healing.verifications).toEqual([]);
    expect(finalRun.project?.integrations).toEqual([]);
  }, 40_000);

  for (const [label, forged] of [
    ["the wrong stage", { stage: "post_integration" as const }],
    ["a different subjectId", { subjectId: "other-contribution" }],
    ["an empty id", { id: "" }],
  ] as const) {
    it("denies pre-integration import when the authority result has " + label + " even if mandatoryPassed", async () => {
      let authority!: ScriptedAuthority;
      const fixture = await makeFixture(workerCommitting(FEATURE_FILE), (registry) => {
        authority = new ScriptedAuthority(registry, () => ({
          gates: passingPreGates(),
          mandatoryPassed: true,
          ...forged,
        }));
        return healingParts(registry, authority);
      });

      const run = await startProjectRun(fixture, "malformed " + label);

      expect(run.status).toBe("failed");
      expect(authority.calls.map((call) => call.stage)).toEqual(["pre_integration"]);
      expect(run.project?.integrations).toEqual([]);
      expect(run.project?.headCommit).toBe(run.project?.source.baseCommit);
      expect(run.orchestration?.healing.nodes.find((item) => item.subtaskId === "feature")?.state)
        .toBe("failed");
      const verification = run.orchestration?.healing.verifications[0];
      expect(verification?.mandatoryPassed).toBe(true);
      expect(run.orchestration?.workerResults.some((item) =>
        (item.error ?? "").includes("pre_integration_verification_malformed"),
      )).toBe(true);
    }, 40_000);
  }

  it("post-verifies the second contribution against the just-applied range, not the shared attempt base", async () => {
    let started = 0;
    let releaseStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const runner: AgentRunner = {
      run: async (request) => {
        started += 1;
        if (started >= 2) releaseStarted();
        await bothStarted;
        const files = request.prompt.includes("TASK:docs")
          ? { "docs.txt": "docs\n" }
          : FEATURE_FILE;
        return commitFiles(request, files);
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    let authority!: ScriptedAuthority;
    const fixture = await makeFixture(runner, (registry) => {
      authority = new ScriptedAuthority(registry, (input) =>
        input.stage === "post_integration"
          ? { gates: passingPostGates() }
          : { gates: passingPreGates() },
      );
      return {
        ...healingParts(registry, authority),
        policy: {
          ...defaultExecutionPolicy,
          maxParallel: 2,
          maxSubtasks: 4,
          maxIterations: 1,
          maxTotalWorkerRuns: 4,
          workerTimeoutMs: 10_000,
          workerSessionPolicy: "fresh",
          workerWorkspacePolicy: "fresh_task_scoped",
        },
      };
    }, twoSubtaskPlan);

    const run = await startProjectRun(fixture, "sequential two-subtask");

    expect(run.status).toBe("completed");
    const originalBase = run.project?.source.baseCommit;
    const featureAttempt = run.project?.attempts.find((item) => item.subtaskId === "feature");
    const docsAttempt = run.project?.attempts.find((item) => item.subtaskId === "docs");
    expect(featureAttempt?.baseCommit).toBe(originalBase);
    expect(docsAttempt?.baseCommit).toBe(originalBase);
    const integrated = (run.project?.integrations ?? []).filter((item) => item.state === "integrated");
    expect(integrated).toHaveLength(2);
    const later = integrated.find((item) => item.canonicalHeadBefore !== originalBase);
    expect(later).toBeDefined();
    const laterPost = authority.calls.find((call) =>
      call.stage === "post_integration" && call.contract.subtaskId === later?.subtaskId,
    );
    expect(laterPost?.baseCommit).toBe(later?.canonicalHeadBefore);
    expect(laterPost?.baseCommit).not.toBe(originalBase);
    await expect(readFile(path.join(run.project!.canonicalWorkspacePath, "feature.txt"), "utf8"))
      .resolves.toBe("feature\n");
    await expect(readFile(path.join(run.project!.canonicalWorkspacePath, "docs.txt"), "utf8"))
      .resolves.toBe("docs\n");
  }, 40_000);

  it("fails the node out of integration_pending when contribution import throws", async () => {
    const fixture = await makeFixture(workerCommitting(FEATURE_FILE), (registry) => {
      const authority = new ScriptedAuthority(registry, () => ({ gates: passingPreGates() }));
      return {
        ...healingParts(registry, authority),
        attemptWorkspaces: new class extends AttemptWorkspaceManager {
          override async importContribution(): Promise<void> {
            throw new Error("injected import identity failure");
          }
        }(new GitClient(5_000)),
      };
    });

    const run = await startProjectRun(fixture, "import failure");

    expect(run.status).toBe("failed");
    expect(run.orchestration?.workerResults.some((item) =>
      (item.error ?? "").includes("contribution_import_failed"),
    )).toBe(true);
    const node = run.orchestration?.healing.nodes.find((item) => item.subtaskId === "feature");
    expect(node?.state).toBe("failed");
    expect(node?.integrationContributionId).toBeNull();
    expect(run.project?.integrations[0]).toMatchObject({
      subtaskId: "feature",
      state: "rolled_back",
    });
    const { events } = await fixture.service.getRunEvents(run.id, 0);
    expect(events.some((event) =>
      event.name === "verification_failed" &&
      String(event.output?.text ?? event.error?.message ?? "").includes("contribution_import_failed"),
    )).toBe(true);
  }, 40_000);

  it("does not report completed when settleNode's compare-and-set refuses", async () => {
    let fixture!: Fixture;
    fixture = await makeFixture(workerCommitting(FEATURE_FILE), (registry) => {
      const authority = new ScriptedAuthority(registry, (input) =>
        input.stage === "post_integration"
          ? { gates: passingPostGates() }
          : { gates: passingPreGates() },
      );
      return {
        ...healingParts(registry, authority),
        afterCanonicalIntegrationForTest: async () => {
          const node = liveOrchestration(fixture.service).healing.nodes
            .find((item) => item.subtaskId === "feature");
          if (node) node.state = "repairing";
        },
      };
    });

    const run = await startProjectRun(fixture, "settle cas refused");

    expect(run.status).not.toBe("completed");
    const node = run.orchestration?.healing.nodes.find((item) => item.subtaskId === "feature");
    expect(node?.state).not.toBe("completed");
    expect(run.orchestration?.workerResults.find((item) => item.subtaskId === "feature")?.status)
      .not.toBe("completed");
    expect(run.error ?? "").toContain("integration_node_superseded");
    const { events } = await fixture.service.getRunEvents(run.id, 0);
    expect(events.some((event) => event.name === "rollback")).toBe(false);
  }, 40_000);

  it("refuses to pull a repairing node into verifying or re-pin its attempt", async () => {
    let fixture!: Fixture;
    fixture = await makeFixture(workerCommitting(FEATURE_FILE), (registry) => {
      const authority = new ScriptedAuthority(registry, () => ({ gates: passingPreGates() }));
      return {
        ...healingParts(registry, authority),
        beforeContributionReadyForTest: async () => {
          const node = liveOrchestration(fixture.service).healing.nodes
            .find((item) => item.subtaskId === "feature");
          if (!node) return;
          node.state = "repairing";
          node.attemptId = "stale-repair-attempt";
        },
      };
    });

    const run = await startProjectRun(fixture, "repairing not verifiable");

    expect(run.status).toBe("failed");
    expect(run.orchestration?.workerResults.some((item) =>
      (item.error ?? "").includes("verification_node_unavailable"),
    )).toBe(true);
    const node = run.orchestration?.healing.nodes.find((item) => item.subtaskId === "feature");
    expect(node).toMatchObject({ state: "repairing", attemptId: "stale-repair-attempt" });
    expect(run.project?.integrations).toEqual([]);
  }, 40_000);

  it("keeps a live-admitted node across a healing persist so an in-flight admit is not overwritten", async () => {
    let fixture!: Fixture;
    const sentinel: TaskNodeState = {
      subtaskId: "concurrent-admit",
      revision: 1,
      state: "ready",
      blockedBy: [],
      attemptId: null,
      faultId: null,
      diagnosisId: null,
      tournamentId: null,
      verificationIds: [],
      integrationContributionId: null,
      updatedAt: new Date().toISOString(),
    };
    fixture = await makeFixture(workerCommitting(FEATURE_FILE), (registry) => {
      const authority = new ScriptedAuthority(registry, (input) => {
        if (input.stage === "pre_integration") {
          liveOrchestration(fixture.service).healing.nodes.push(sentinel);
        }
        return input.stage === "post_integration"
          ? { gates: passingPostGates() }
          : { gates: passingPreGates() };
      });
      return healingParts(registry, authority);
    });

    const run = await startProjectRun(fixture, "healing lost-update");

    expect(run.status).toBe("completed");
    expect(run.orchestration?.healing.nodes.some((item) => item.subtaskId === "concurrent-admit"))
      .toBe(true);
  }, 40_000);
});
