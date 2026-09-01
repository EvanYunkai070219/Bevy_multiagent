import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/event-log.js";
import {
  HealingCoordinator,
  leaderMayInterpretResults,
  type HealingAdmission,
  type HealingCoordinatorDeps,
} from "../src/orchestration/healing/healing-coordinator.js";
import { Orchestrator, type OrchestratorParts } from "../src/orchestration/orchestrator.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { RunControl } from "../src/orchestration/run-control.js";
import { JsonStore } from "../src/store.js";
import type { RunEventDraft, RunEventSink } from "../src/run-events.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  DiagnosisRecord,
  FaultClass,
  FaultRecord,
  HealingState,
  SubtaskContract,
  TaskNodeState,
  WorkerResult,
} from "../src/types.js";
import { emptyHealingState } from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";

function contract(overrides: Partial<SubtaskContract> = {}): SubtaskContract {
  return {
    subtaskId: "worker-1",
    revision: 1,
    contractKey: "demo",
    inputs: [],
    outputs: ["src/app.ts"],
    dependencyIds: [],
    downstreamConsumers: ["tester"],
    allowedMutationPaths: ["src/"],
    protectedPaths: ["package-lock.json"],
    artifactSchemaIds: [],
    targetedGateIds: ["targeted"],
    contractGateIds: ["contract"],
    consumerGateIds: ["consumer"],
    regressionGateIds: ["regression"],
    authorizedTools: ["bash"],
    ...overrides,
  };
}

function node(overrides: Partial<TaskNodeState> = {}): TaskNodeState {
  return {
    subtaskId: "worker-1",
    revision: 1,
    state: "failed",
    blockedBy: [],
    attemptId: "attempt-1",
    faultId: null,
    diagnosisId: null,
    tournamentId: null,
    verificationIds: [],
    integrationContributionId: null,
    updatedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function fault(overrides: Partial<FaultRecord> = {}): FaultRecord {
  return {
    id: "fault-1",
    subtaskId: "worker-1",
    revision: 1,
    class: "hard_failure",
    reasonCode: "tests_failed",
    summary: "Tests failed.",
    repairable: true,
    evidenceRefs: ["snap-1"],
    affectedConsumers: ["tester"],
    detectedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function availableDiagnosis(overrides: Partial<DiagnosisRecord> = {}): DiagnosisRecord {
  return {
    id: "diag-1",
    faultId: "fault-1",
    status: "available",
    classification: "context",
    rationale: "Missing upstream context.",
    allowedMutationFamilies: ["context_patch"],
    createdAt: "2026-08-29T00:00:01.000Z",
    ...overrides,
  };
}

class RecordingDiagnoser {
  calls = 0;
  inputs: unknown[] = [];
  gate: Promise<void> = Promise.resolve();
  constructor(
    private readonly impl: (input: unknown) => Promise<DiagnosisRecord> | DiagnosisRecord = () =>
      availableDiagnosis(),
  ) {}
  async diagnose(input: unknown): Promise<DiagnosisRecord> {
    this.calls += 1;
    this.inputs.push(input);
    await this.gate;
    return this.impl(input);
  }
}

function memoryHealing(initial: HealingState) {
  let healing = initial;
  let tail = Promise.resolve();
  return {
    get: () => healing,
    mutateHealing: async <T>(mutate: (current: HealingState) => T): Promise<T> => {
      return mutate(healing);
    },
    withAuthorityLock: async <T>(operation: () => Promise<T>): Promise<T> => {
      const predecessor = tail;
      let release!: () => void;
      const turn = new Promise<void>((resolve) => {
        release = resolve;
      });
      tail = predecessor.catch(() => undefined).then(() => turn);
      await predecessor.catch(() => undefined);
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}

function coordinator(
  options: {
    diagnoser?: RecordingDiagnoser;
    healing?: HealingState;
    healingEnabled?: boolean;
    projectReady?: boolean;
    control?: RunControl;
    sink?: RunEventSink;
    events?: RunEventDraft[];
  } = {},
) {
  const events = options.events ?? [];
  const store = memoryHealing(
    options.healing ?? {
      ...emptyHealingState(),
      contracts: [contract()],
      nodes: [node()],
    },
  );
  const diagnoser = options.diagnoser ?? new RecordingDiagnoser();
  const runControl = options.control ?? new RunControl(defaultExecutionPolicy);
  const deps: HealingCoordinatorDeps = {
    mutateHealing: store.mutateHealing,
    withAuthorityLock: store.withAuthorityLock,
    diagnoser,
    control: runControl,
    sink: options.sink ?? {
      emit(draft) {
        events.push(draft);
      },
    },
    healingEnabled: options.healingEnabled ?? true,
    projectReady: options.projectReady ?? true,
    evidenceFor: () => [
      {
        id: "snap-1",
        source: "verification" as const,
        failureFingerprints: ["assert"],
        changedPaths: ["src/app.ts"],
        stateFingerprint: "abc",
      },
    ],
    budgetScopeId: "diagnosis:worker-1",
  };
  return {
    begin: (inputFault = fault(), inputNode = node(), inputContract = contract()) =>
      new HealingCoordinator(deps).begin(inputFault, inputNode, inputContract),
    diagnoser,
    store,
    events,
    control: runControl,
  };
}

function expectNoTournament(admission: HealingAdmission, events: RunEventDraft[]) {
  expect(events.some((item) => item.name === "repair_tournament_started")).toBe(false);
  if (admission.status === "admitted" || admission.status === "unavailable") {
    expect(admission.status === "admitted" ? admission.diagnosis : true).toBeTruthy();
  }
}

describe("HealingCoordinator classification denial", () => {
  const nonRepairable: Array<{ name: string; class: FaultClass; reasonCode: string }> = [
    { name: "provider rate limit", class: "provider_rate_limited", reasonCode: "provider_rate_limited" },
    { name: "container failure", class: "infrastructure_failure", reasonCode: "container_failure" },
    { name: "authority failure", class: "authority_failure", reasonCode: "authority_failure" },
    { name: "source/checkpoint failure", class: "infrastructure_failure", reasonCode: "git_metadata_tampered" },
    { name: "budget fuse", class: "budget_failure", reasonCode: "emergency_token_fuse" },
    { name: "deadline", class: "deadline_failure", reasonCode: "root_deadline" },
    { name: "cancellation", class: "cancelled", reasonCode: "user_cancelled" },
    { name: "integration conflict", class: "integration_conflict", reasonCode: "integration_conflict" },
  ];

  for (const item of nonRepairable) {
    it("does not diagnose " + item.name, async () => {
      const harness = coordinator();
      const admission = await harness.begin(
        fault({
          id: "fault-" + item.class,
          class: item.class,
          reasonCode: item.reasonCode,
          repairable: false,
        }),
      );
      expect(harness.diagnoser.calls).toBe(0);
      expect(admission.status).toBe("unavailable");
      expectNoTournament(admission, harness.events);
      const persisted = harness.store.get();
      expect(persisted.faults.some((entry) => entry.class === item.class)).toBe(true);
      expect(persisted.nodes[0]?.state).toBe("failed");
      expect(persisted.nodes[0]?.state).not.toBe("repairing");
      expect(persisted.tournaments).toEqual([]);
      expect(leaderMayInterpretResults([admission])).toBe(false);
    });
  }

  it("does not diagnose when healing is disabled", async () => {
    const harness = coordinator({ healingEnabled: false });
    const admission = await harness.begin();
    expect(harness.diagnoser.calls).toBe(0);
    expect(admission.status).toBe("unavailable");
    expectNoTournament(admission, harness.events);
  });

  it("does not diagnose when the project or authority is not ready", async () => {
    const harness = coordinator({ projectReady: false });
    const admission = await harness.begin();
    expect(harness.diagnoser.calls).toBe(0);
    expect(admission.status).toBe("unavailable");
    expectNoTournament(admission, harness.events);
  });

  it("does not diagnose an ephemeral non-repairable stall", async () => {
    const harness = coordinator();
    const admission = await harness.begin(
      fault({ class: "stall", reasonCode: "no_evidence_progress", repairable: false }),
    );
    expect(harness.diagnoser.calls).toBe(0);
    expect(admission.status).toBe("unavailable");
  });

  const repairable: FaultClass[] = [
    "hard_failure",
    "stall",
    "false_completion",
    "coordination_failure",
  ];

  for (const cls of repairable) {
    it("diagnoses a repairable " + cls + " once", async () => {
      const harness = coordinator();
      const admission = await harness.begin(
        fault({ id: "fault-" + cls, class: cls, repairable: true }),
      );
      expect(harness.diagnoser.calls).toBe(1);
      expect(admission.status).toBe("admitted");
      if (admission.status !== "admitted") return;
      expect(admission.diagnosis.allowedMutationFamilies).toContain("control");
      expect(admission.diagnosis.allowedMutationFamilies).toContain("context_patch");
      expect(harness.store.get().nodes[0]?.state).toBe("failed");
      expect(harness.store.get().nodes[0]?.state).not.toBe("repairing");
      expectNoTournament(admission, harness.events);
    });
  }
});

describe("HealingCoordinator structured-output persistence", () => {
  it("persists an unavailable diagnosis, leaves the node failed, and skips the tournament", async () => {
    const harness = coordinator({
      diagnoser: new RecordingDiagnoser(() => ({
        ...availableDiagnosis(),
        status: "unavailable",
        classification: "",
        rationale: "",
        allowedMutationFamilies: [],
      })),
    });
    const admission = await harness.begin();
    expect(admission.status).toBe("unavailable");
    expect(harness.diagnoser.calls).toBe(1);
    expect(harness.store.get().diagnoses[0]?.status).toBe("unavailable");
    expect(harness.store.get().nodes[0]?.state).toBe("failed");
    expect(harness.store.get().tournaments).toEqual([]);
    expectNoTournament(admission, harness.events);
  });

  it("adds unchanged control to a valid context/strategy diagnosis", async () => {
    const harness = coordinator({
      diagnoser: new RecordingDiagnoser(() =>
        availableDiagnosis({
          allowedMutationFamilies: ["strategy_patch"],
        }),
      ),
    });
    const admission = await harness.begin();
    expect(admission.status).toBe("admitted");
    if (admission.status !== "admitted") return;
    expect(admission.diagnosis.allowedMutationFamilies).toEqual([
      "control",
      "strategy_patch",
    ]);
    expect(harness.store.get().nodes[0]?.state).not.toBe("repairing");
    expectNoTournament(admission, harness.events);
  });
});

describe("HealingCoordinator duplicate and stale diagnosis", () => {
  it("calls the diagnoser only once for the same task revision", async () => {
    const harness = coordinator();
    const first = await harness.begin();
    const second = await harness.begin();
    expect(harness.diagnoser.calls).toBe(1);
    expect(first.status).toBe("admitted");
    expect(second.status === "admitted" || second.status === "unavailable").toBe(true);
    expect(harness.store.get().diagnoses).toHaveLength(1);
  });

  it("lets only one of two racing callers reserve the model call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const diagnoser = new RecordingDiagnoser();
    diagnoser.gate = gate;
    const harness = coordinator({ diagnoser });
    const first = harness.begin();
    const second = harness.begin(fault({ id: "fault-race" }));
    await expect.poll(() => diagnoser.calls).toBe(1);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(diagnoser.calls).toBe(1);
    const statuses = [left.status, right.status];
    expect(statuses.filter((status) => status === "admitted")).toHaveLength(1);
    expect(harness.store.get().diagnoses).toHaveLength(1);
  });

  it("does not attach a revision-1 diagnosis after the node moves to revision 2", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const diagnoser = new RecordingDiagnoser();
    diagnoser.gate = gate;
    const harness = coordinator({ diagnoser });
    const pending = harness.begin();
    await expect.poll(() => diagnoser.calls).toBe(1);
    await harness.store.mutateHealing((healing) => {
      const current = healing.nodes[0]!;
      current.revision = 2;
      current.diagnosisId = null;
      current.state = "failed";
    });
    release();
    const admission = await pending;
    expect(admission.status).toBe("unavailable");
    expect(harness.store.get().nodes[0]?.revision).toBe(2);
    expect(harness.store.get().nodes[0]?.diagnosisId).toBeNull();
    expect(
      harness.store.get().diagnoses.some((item) => item.faultId === "fault-1" && item.status === "available"),
    ).toBe(false);
  });

  it("does not attach a diagnosis after cancellation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const diagnoser = new RecordingDiagnoser();
    diagnoser.gate = gate;
    const runControl = new RunControl(defaultExecutionPolicy);
    const harness = coordinator({ diagnoser, control: runControl });
    const pending = harness.begin();
    await expect.poll(() => diagnoser.calls).toBe(1);
    runControl.stop("user_cancelled", "cancelled");
    await harness.store.mutateHealing((healing) => {
      healing.nodes[0]!.state = "cancelled";
    });
    release();
    const admission = await pending;
    expect(admission.status === "unavailable" || admission.status === "terminal").toBe(true);
    expect(harness.store.get().nodes[0]?.state).toBe("cancelled");
    expect(harness.store.get().tournaments).toEqual([]);
  });

  it("does not make a second diagnoser call when the event sink fails", async () => {
    const diagnoser = new RecordingDiagnoser();
    const harness = coordinator({
      diagnoser,
      sink: {
        emit() {
          throw new Error("event sink unavailable");
        },
      },
    });
    const admission = await harness.begin();
    expect(diagnoser.calls).toBe(0);
    expect(admission.status).toBe("unavailable");
    const retry = await harness.begin();
    expect(diagnoser.calls).toBe(0);
    expect(retry.status).toBe("unavailable");
    expect(harness.store.get().diagnoses[0]?.status).toBe("unavailable");
  });
});

describe("leader interpretation after a terminal task decision", () => {
  it("blocks evaluator/replanner/synthesizer after an unavailable diagnosis", () => {
    const admission: HealingAdmission = {
      status: "unavailable",
      fault: fault(),
      diagnosis: { ...availableDiagnosis(), status: "unavailable" },
      reason: "diagnosis_unavailable",
    };
    expect(leaderMayInterpretResults([admission])).toBe(false);
  });

  it("allows Milestone 1 interpretation when healing never ran", () => {
    expect(leaderMayInterpretResults([])).toBe(true);
  });
});

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

describe("Orchestrator does not replan after unavailable diagnosis", () => {
  it("fails a required project task before evaluator, replanner, or synthesizer run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-heal-admit-"));
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
      projectId: "project-1",
      unassignedPlacement: null,
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
      status: "queued",
      prompt: "build it",
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      project: {
        source: {
          mode: "existing_repository",
          repositoryPath: "/repo",
          requestedRevision: null,
          baseCommit: "a".repeat(40),
          sourceFingerprint: "fp",
        },
        runBranch: "run/test",
        canonicalWorkspacePath: "/repo",
        headCommit: "a".repeat(40),
        state: "ready",
        attempts: [],
        integrations: [],
      },
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push(leaderRun);
    });
    const failed: WorkerResult = {
      subtaskId: "feature",
      workerId: "w",
      workerRunId: "wr",
      iteration: 1,
      attempt: 1,
      status: "failed",
      output: "",
      error: "tests failed",
      usage: null,
      durationMs: 1,
      artifacts: [],
    };
    let evaluated = 0;
    let replanned = 0;
    let synthesized = 0;
    const diagnoser = new RecordingDiagnoser(() => ({
      ...availableDiagnosis({ faultId: "ignored" }),
      status: "unavailable",
      classification: "",
      rationale: "",
      allowedMutationFamilies: [],
    }));
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: { ...defaultExecutionPolicy, maxIterations: 2 },
        healingEnabled: true,
        contractCatalog: [
          {
            contractKey: "feature-producer",
            allowedInputs: [],
            allowedOutputs: ["feature.txt"],
            allowedMutationPaths: ["feature.txt"],
            protectedPaths: [".launchpad"],
            artifactSchemaIds: [],
            targetedGateIds: ["t"],
            contractGateIds: ["c"],
            consumerGateIds: ["n"],
            regressionGateIds: ["r"],
            authorizedTools: ["bash"],
          },
        ],
        verificationRunner: {
          verify: async () => {
            throw new Error("authority must not run in this fixture");
          },
        } as OrchestratorParts["verificationRunner"],
        diagnoser,
        scheduler: {
          execute: async () => [failed],
        } as OrchestratorParts["scheduler"],
        planner: {
          plan: async () => ({
            status: "available",
            plan: {
              needsSubagents: true,
              rationale: "one producer",
              subtasks: [
                {
                  id: "feature",
                  title: "Feature",
                  role: "worker",
                  prompt: "write it",
                  objective: "file",
                  successCriteria: ["done"],
                  expectedOutput: "feature.txt",
                  dependsOn: [],
                  contractKey: "feature-producer",
                  outputs: ["feature.txt"],
                },
              ],
            },
            model: "m",
            promptVersion: "p1",
          }),
        } as OrchestratorParts["planner"],
        evaluator: {
          evaluate: async () => {
            evaluated += 1;
            throw new Error("evaluator must not run after unavailable diagnosis");
          },
        } as OrchestratorParts["evaluator"],
        replanner: {
          replan: async () => {
            replanned += 1;
            throw new Error("replanner must not run after unavailable diagnosis");
          },
        } as OrchestratorParts["replanner"],
        synthesizer: {
          synthesize: async () => {
            synthesized += 1;
            throw new Error("synthesizer must not run after unavailable diagnosis");
          },
        } as OrchestratorParts["synthesizer"],
      } as OrchestratorParts,
      () => false,
    );

    await orchestrator.run(leader, leaderRun);

    expect(diagnoser.calls).toBe(1);
    expect(evaluated).toBe(0);
    expect(replanned).toBe(0);
    expect(synthesized).toBe(0);
    const persisted = store.snapshot().runs.find((item) => item.id === leaderRun.id);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.orchestration?.phase).toBe("failed");
    expect(persisted?.orchestration?.healing.diagnoses[0]?.status).toBe("unavailable");
    expect(persisted?.orchestration?.healing.nodes[0]?.state).toBe("failed");
    expect(persisted?.orchestration?.healing.nodes[0]?.state).not.toBe("repairing");
    expect(persisted?.orchestration?.healing.tournaments).toEqual([]);
  });

  it("does not diagnose inside the scheduler pump before settleWave", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-heal-pump-"));
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
      projectId: "project-1",
      unassignedPlacement: null,
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
      status: "queued",
      prompt: "build it",
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      project: {
        source: {
          mode: "existing_repository",
          repositoryPath: "/repo",
          requestedRevision: null,
          baseCommit: "a".repeat(40),
          sourceFingerprint: "fp",
        },
        runBranch: "run/test",
        canonicalWorkspacePath: "/repo",
        headCommit: "a".repeat(40),
        state: "ready",
        attempts: [],
        integrations: [],
      },
    };
    await workspaces.create(leader);
    await workspaces.createCommon(leaderRun.id);
    await store.mutate((database) => {
      database.agents.push(leader);
      database.runs.push(leaderRun);
    });
    const failed: WorkerResult = {
      subtaskId: "feature",
      workerId: "w",
      workerRunId: "wr",
      iteration: 1,
      attempt: 1,
      status: "failed",
      output: "",
      error: "tests failed",
      usage: null,
      durationMs: 1,
      artifacts: [],
    };
    const order: string[] = [];
    const diagnoser = new RecordingDiagnoser(() => {
      order.push("diagnose");
      return {
        ...availableDiagnosis({ faultId: "ignored" }),
        status: "unavailable",
        classification: "",
        rationale: "",
        allowedMutationFamilies: [],
      };
    });
    const orchestrator = new Orchestrator(
      store,
      workspaces,
      runner,
      events,
      {
        policy: { ...defaultExecutionPolicy, maxIterations: 1 },
        healingEnabled: true,
        contractCatalog: [
          {
            contractKey: "feature-producer",
            allowedInputs: [],
            allowedOutputs: ["feature.txt"],
            allowedMutationPaths: ["feature.txt"],
            protectedPaths: [".launchpad"],
            artifactSchemaIds: [],
            targetedGateIds: ["t"],
            contractGateIds: ["c"],
            consumerGateIds: ["n"],
            regressionGateIds: ["r"],
            authorizedTools: ["bash"],
          },
        ],
        verificationRunner: {
          verify: async () => {
            throw new Error("authority must not run in this fixture");
          },
        } as OrchestratorParts["verificationRunner"],
        diagnoser,
        scheduler: {
          execute: async (
            _subtasks: unknown,
            _policy: unknown,
            _already: unknown,
            _runOne: unknown,
            _iteration: unknown,
            _onOver: unknown,
            _settleWave?: (wave: WorkerResult[]) => Promise<WorkerResult[]>,
            _control?: unknown,
            onResult?: (result: WorkerResult) => Promise<WorkerResult>,
          ) => {
            if (onResult) await onResult(failed);
            order.push("pump-done");
            order.push("settled");
            return [failed];
          },
        } as OrchestratorParts["scheduler"],
        planner: {
          plan: async () => ({
            status: "available",
            plan: {
              needsSubagents: true,
              rationale: "one producer",
              subtasks: [
                {
                  id: "feature",
                  title: "Feature",
                  role: "worker",
                  prompt: "write it",
                  objective: "file",
                  successCriteria: ["done"],
                  expectedOutput: "feature.txt",
                  dependsOn: [],
                  contractKey: "feature-producer",
                  outputs: ["feature.txt"],
                },
              ],
            },
            model: "m",
            promptVersion: "p1",
          }),
        } as OrchestratorParts["planner"],
        evaluator: {
          evaluate: async () => {
            throw new Error("evaluator must not run after unavailable diagnosis");
          },
        } as OrchestratorParts["evaluator"],
        replanner: {
          replan: async () => {
            throw new Error("replanner must not run after unavailable diagnosis");
          },
        } as OrchestratorParts["replanner"],
        synthesizer: {
          synthesize: async () => {
            throw new Error("synthesizer must not run after unavailable diagnosis");
          },
        } as OrchestratorParts["synthesizer"],
      } as OrchestratorParts,
      () => false,
    );

    await orchestrator.run(leader, leaderRun);

    expect(diagnoser.calls).toBe(1);
    expect(order).toEqual(["pump-done", "settled", "diagnose"]);
  });
});
