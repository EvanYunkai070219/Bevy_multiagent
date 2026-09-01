import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService, type AgentServiceHooks } from "../src/agent-service.js";
import { AttemptWorkspaceManager } from "../src/attempt-workspace-manager.js";
import { loadConfig } from "../src/config.js";
import { EventLog } from "../src/event-log.js";
import { GitClient } from "../src/git-client.js";
import type { OrchestratorParts } from "../src/orchestration/orchestrator.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { ProjectRunManager } from "../src/project-run-manager.js";
import { JsonStore } from "../src/store.js";
import type {
  AgentRun,
  AgentRunner,
  CandidateState,
  Database,
  HealingState,
  MutationCandidate,
  TaskNodeStatus,
} from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function candidate(id: string, tournamentId: string, state: CandidateState): MutationCandidate {
  return {
    id,
    tournamentId,
    checkpointId: "checkpoint-1",
    delta: {
      family: id.endsWith("control") ? "control" : id.endsWith("context") ? "context_patch" : "strategy_patch",
      targetSubtaskId: "repairing",
      diagnosisId: "diagnosis-1",
      addedEvidenceRefs: [],
      instructionPatch: "",
      toolRoute: [],
      expectedEffect: "repair",
      contentHash: createHash("sha256").update(id).digest("hex"),
    },
    state,
    attemptId: id === "tour-running-control" ? "candidate-clean" : id === "tour-running-context" ? "candidate-dirty" : null,
    verificationIds: [],
    modelCalls: state === "declared" ? 0 : 1,
    reservedTokens: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    elapsedMs: 0,
    terminalReason: null,
  };
}

function healingState(): HealingState {
  const activeStates: TaskNodeStatus[] = [
    "running",
    "verifying",
    "repairing",
    "integration_pending",
    "integrating",
  ];
  const nodes = activeStates.map((state) => ({
    subtaskId: state,
    revision: 1,
    state,
    blockedBy: [],
    attemptId: state === "repairing" ? "source-attempt" : null,
    faultId: state === "repairing" ? "fault-1" : null,
    diagnosisId: state === "repairing" ? "diagnosis-1" : null,
    tournamentId: state === "repairing" ? "tour-running" : null,
    verificationIds: [],
    integrationContributionId: null,
    updatedAt: "2026-08-29T00:00:00.000Z",
  }));
  return {
    contracts: [],
    nodes,
    faults: [{
      id: "fault-1",
      subtaskId: "repairing",
      revision: 1,
      class: "hard_failure",
      reasonCode: "fixture_failure",
      summary: "fixture failure",
      repairable: true,
      evidenceRefs: ["evidence-1"],
      affectedConsumers: [],
      detectedAt: "2026-08-29T00:00:00.000Z",
    }],
    snapshots: [],
    diagnoses: [{
      id: "diagnosis-1",
      faultId: "fault-1",
      status: "available",
      classification: "context",
      rationale: "fixture",
      allowedMutationFamilies: ["control", "context_patch", "strategy_patch"],
      createdAt: "2026-08-29T00:00:01.000Z",
    }],
    candidates: [
      candidate("tour-running-control", "tour-running", "running"),
      candidate("tour-running-context", "tour-running", "verifying"),
      candidate("tour-running-strategy", "tour-running", "declared"),
      candidate("tour-pending-control", "tour-pending", "verified"),
      candidate("tour-pending-context", "tour-pending", "promotion_pending"),
      candidate("tour-pending-strategy", "tour-pending", "rejected"),
    ],
    tournaments: [
      {
        id: "tour-running",
        subtaskId: "repairing",
        revision: 1,
        checkpointId: "checkpoint-1",
        candidateIds: ["tour-running-control", "tour-running-context", "tour-running-strategy"],
        status: "running",
        winnerCandidateId: null,
        failureReason: null,
        startedAt: "2026-08-29T00:00:02.000Z",
        completedAt: null,
      },
      {
        id: "tour-pending",
        subtaskId: "integration_pending",
        revision: 1,
        checkpointId: "checkpoint-1",
        candidateIds: ["tour-pending-control", "tour-pending-context", "tour-pending-strategy"],
        status: "promotion_pending",
        winnerCandidateId: "tour-pending-context",
        failureReason: null,
        startedAt: "2026-08-29T00:00:02.000Z",
        completedAt: null,
      },
    ],
    verifications: [{
      id: "verification-1",
      subjectType: "candidate",
      subjectId: "tour-pending-context",
      stage: "finalist",
      authorityManifestHash: "a".repeat(64),
      gates: [],
      failureKind: null,
      mandatoryPassed: true,
      hardProgress: 1,
      regressionCount: 0,
      modelCalls: 1,
      reservedTokens: 10,
      actualInputTokens: 5,
      actualOutputTokens: 3,
      elapsedMs: 10,
      verifiedAt: "2026-08-29T00:00:03.000Z",
    }],
    budget: null,
  };
}

function orchestration(healing: HealingState) {
  return {
    phase: "executing" as const,
    iteration: 1,
    iterationPlans: [],
    evaluationRecords: [],
    workerResults: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, workerRuns: 0 },
    policySnapshot: structuredClone(defaultExecutionPolicy),
    provenance: {
      harnessVersion: "orchestration-1",
      plannerPromptVersion: "planner-v1",
      evaluatorPromptVersion: "evaluator-v1",
      replannerPromptVersion: "replanner-v1",
      synthesizerPromptVersion: "synthesizer-v1",
    },
    healing,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "healing-restart-"));
  roots.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    WORKSPACE_SOURCE_ROOTS: root,
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    CODEX_RUNTIME_MODE: "exec",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  await store.initialize();
  const git = new GitClient(5_000);
  const runId = "healing-restart-run";
  const manager = new ProjectRunManager(path.join(root, "project-runs"), [root], git);
  const project = await manager.prepare(runId, { mode: "new_project", projectName: "restart" });
  await manager.acknowledgePrepared(runId, project);
  const attempts = new AttemptWorkspaceManager(git);
  const source = await attempts.create({
    runId,
    project,
    attemptId: "source-attempt",
    subtaskId: "repairing",
    baseCommit: project.headCommit!,
  });
  project.attempts.push({ ...source, state: "failed" });
  const sourceFingerprint = createHash("sha256").update(source.ownerToken).digest("hex");
  const clean = await attempts.create({
    runId,
    project,
    attemptId: "candidate-clean",
    revision: 1,
    subtaskId: "repairing",
    baseCommit: project.headCommit!,
    kind: "repair",
    checkpointId: "checkpoint-1",
    checkpointHash: project.headCommit!,
    sourceOwnerFingerprint: sourceFingerprint,
    sourceWorkspace: source.workspacePath,
    expectedHead: project.headCommit!,
  });
  project.attempts.push(clean);
  const dirty = await attempts.create({
    runId,
    project,
    attemptId: "candidate-dirty",
    revision: 1,
    subtaskId: "repairing",
    baseCommit: project.headCommit!,
    kind: "repair",
    checkpointId: "checkpoint-1",
    checkpointHash: project.headCommit!,
    sourceOwnerFingerprint: sourceFingerprint,
    sourceWorkspace: source.workspacePath,
    expectedHead: project.headCommit!,
  });
  await writeFile(path.join(dirty.workspacePath, "unfinished.txt"), "preserve\n", "utf8");
  project.attempts.push(dirty);
  const orphan = await attempts.create({
    runId,
    project,
    attemptId: "candidate-orphan",
    revision: 1,
    subtaskId: "repairing",
    baseCommit: project.headCommit!,
    kind: "repair",
    checkpointId: "checkpoint-1",
    checkpointHash: project.headCommit!,
    sourceOwnerFingerprint: sourceFingerprint,
    sourceWorkspace: source.workspacePath,
    expectedHead: project.headCommit!,
  });
  project.attempts.push(orphan);

  const agentId = "11111111-1111-4111-8111-111111111111";
  const createdAt = "2026-08-29T00:00:00.000Z";
  const rootRun: AgentRun = {
    id: runId,
    agentId,
    projectId: null,
    kind: "orchestration",
    parentRunId: null,
    orchestration: orchestration(healingState()),
    workspaceSource: { mode: "new_project", projectName: "restart" },
    project,
    status: "running",
    prompt: "interrupted healing",
    output: null,
    error: null,
    usage: null,
    startedAt: createdAt,
    completedAt: null,
    createdAt,
  };
  const child = (id: string): AgentRun => ({
    id,
    agentId,
    projectId: null,
    kind: "subtask",
    parentRunId: runId,
    orchestration: null,
    status: "running",
    prompt: "repair candidate",
    output: null,
    error: null,
    usage: null,
    startedAt: createdAt,
    completedAt: null,
    createdAt,
  });
  await store.mutate((database) => {
    database.agents.push({
      id: agentId,
      name: "Healing restart",
      description: "",
      instructions: "",
      status: "busy",
      role: "leader",
      parentAgentId: null,
      specialty: null,
      projectId: null,
      unassignedPlacement: "previous",
      workspacePath: path.join(root, "workspaces", agentId),
      codexThreadId: null,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
    });
    database.runs.push(rootRun, child("candidate-clean"), child("candidate-dirty"));
  });
  return { config, root, store, git, runId, agentId, clean, dirty, orphan };
}

async function restart(
  setup: Awaited<ReturnType<typeof fixture>>,
  calls: string[],
  hooks: AgentServiceHooks = {},
  restartStore = new JsonStore(path.join(setup.root, "data", "db.json")),
) {
  const forbidden = (name: string) => async () => {
    calls.push(name);
    throw new Error(name + " must not run during restart");
  };
  const runner: AgentRunner = {
    run: forbidden("runner"),
    cancel: async () => {
      calls.push("runner.cancel");
      return false;
    },
    isAvailable: async () => true,
  };
  const parts = {
    planner: { plan: forbidden("planner") },
    evaluator: { evaluate: forbidden("evaluator") },
    replanner: { replan: forbidden("replanner") },
    synthesizer: { synthesize: forbidden("synthesizer") },
    diagnoser: { diagnose: forbidden("diagnoser") },
    verificationRunner: { verify: forbidden("verifier") },
    contributionIntegrator: { integrate: forbidden("integrator"), restore: forbidden("integrator.restore") },
    attemptWorkspaces: new AttemptWorkspaceManager(new GitClient(5_000)),
  } as unknown as OrchestratorParts;
  const service = new AgentService(
    setup.config,
    restartStore,
    new WorkspaceManager(path.join(setup.root, "workspaces")),
    runner,
    new EventLog(path.join(setup.root, "data", "events")),
    parts,
    {
      issue: () => {
        calls.push("model");
        throw new Error("model must not run during restart");
      },
      revoke: () => calls.push("model.revoke"),
    },
    undefined,
    undefined,
    hooks,
    undefined,
    new GitClient(5_000),
  );
  await service.initialize();
  return service;
}

describe("healing restart recovery", () => {
  it("cancels every active healing state without resuming external work and cleans only exact clean candidates", async () => {
    const setup = await fixture();
    const calls: string[] = [];
    const service = await restart(setup, calls);

    const recovered = service.getRun(setup.runId);
    expect(calls).toEqual([]);
    expect(recovered.status).toBe("cancelled");
    expect(recovered.orchestration?.healing.nodes.map((node) => node.state)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(recovered.orchestration?.healing.tournaments.map((item) => item.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(recovered.orchestration?.healing.candidates.map((item) => item.state)).toEqual([
      "cancelled",
      "cancelled",
      "not_started",
      "verified",
      "cancelled",
      "rejected",
    ]);
    expect(recovered.orchestration?.healing.verifications).toHaveLength(1);
    expect(service.getChildRuns(setup.runId).map((run) => run.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(recovered.project?.attempts.find((item) => item.attemptId === "candidate-clean"))
      .toMatchObject({ state: "cancelled", cleanup: "removed", reason: "server_restarted" });
    expect(recovered.project?.attempts.find((item) => item.attemptId === "candidate-dirty"))
      .toMatchObject({ state: "cancelled", cleanup: "preserved", reason: "changed" });
    expect(recovered.project?.attempts.find((item) => item.attemptId === "candidate-orphan"))
      .toMatchObject({ state: "cancelled", cleanup: "preserved", reason: "unverifiable" });
    await expect(readFile(path.join(setup.dirty.workspacePath, "unfinished.txt"), "utf8"))
      .resolves.toBe("preserve\n");
    await expect(readFile(path.join(setup.orphan.workspacePath, "README.md"), "utf8"))
      .resolves.toBeDefined();
    const events = await service.getRunEvents(setup.runId, 0);
    expect(events.events.at(-1)).toMatchObject({
      name: "restart_cancelled",
      error: { code: "server_restarted" },
    });

    const first = structuredClone(recovered);
    const restartedAgain = await restart(setup, calls);
    expect(restartedAgain.getRun(setup.runId)).toEqual(first);
    expect(calls).toEqual([]);
  }, 30_000);

  it("preserves a newer child-run owner and performs zero cleanup when the restart snapshot is stale", async () => {
    const setup = await fixture();
    const calls: string[] = [];
    const restartStore = new JsonStore(path.join(setup.root, "data", "db.json"));
    const service = await restart(setup, calls, {
      afterRestartEventBarrierForTest: async (runId) => {
        if (runId !== setup.runId) return;
        await restartStore.mutate((database: Database) => {
          const child = database.runs.find((run) => run.id === "candidate-clean")!;
          child.status = "completed";
          child.output = "newer candidate completion";
          child.completedAt = "2026-08-29T00:00:10.000Z";
        });
      },
    }, restartStore);

    expect(service.getRun(setup.runId).status).toBe("running");
    expect(service.getRun("candidate-clean")).toMatchObject({
      status: "completed",
      output: "newer candidate completion",
    });
    expect(service.getRun(setup.runId).project?.attempts.find(
      (attempt) => attempt.attemptId === "candidate-clean",
    )).toMatchObject({ cleanup: "active", state: "running" });
    await expect(readFile(path.join(setup.clean.workspacePath, "README.md"), "utf8"))
      .resolves.toBeDefined();
    const childEvents = await service.getRunEvents("candidate-clean", 0);
    expect(childEvents.events.filter((event) => event.name === "restart_cancelled")).toEqual([]);
    expect(calls).toEqual([]);
  }, 30_000);
});
