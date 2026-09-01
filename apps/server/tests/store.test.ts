/** Covers JsonStore mutation consistency when persistence succeeds or fails. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "../src/store.js";
import { emptyHealingState } from "../src/types.js";
import {
  exactRepeatKey,
  failureCueLookupKey,
} from "../src/orchestration/evolution/evolution-fingerprints.js";
import type {
  Agent,
  AgentRun,
  Database,
  HealingState,
  OrchestrationState,
  ProjectBaselineTransition,
} from "../src/types.js";
import type { EvolutionOutboxEntry } from "../src/orchestration/evolution/evolution-types.js";

const temporaryDirectories: string[] = [];
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";

let file: string;

function legacyAgent(): Agent {
  return {
    id: AGENT_ID,
    name: "Legacy Chat",
    description: "",
    instructions: "",
    status: "ready",
    role: "standalone",
    parentAgentId: null,
    specialty: null,
    workspacePath: "/tmp/workspace/agent-1",
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
  } as Agent;
}

function databaseWithProject(overrides: {
  baselineTransition?: ProjectBaselineTransition;
} = {}): Database {
  return {
    version: 1,
    projects: [
      {
        id: PROJECT_ID,
        displayName: "Test Project",
        sourceKind: "managed",
        repositoryPath: "/tmp/projects/test",
        repositoryRealPath: "/tmp/projects/test",
        gitCommonRealPath: "/tmp/projects/test/.git",
        gitCommonDev: 1,
        gitCommonIno: 2,
        baselineBranch: "launchpad/project/" + PROJECT_ID,
        baselineCommit: "c".repeat(40),
        state: "ready",
        lastError: null,
        ...(overrides.baselineTransition
          ? { baselineTransition: overrides.baselineTransition }
          : {}),
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
      },
    ],
    agents: [],
    messages: [],
    runs: [],
  };
}

async function writeFixture(data: Database): Promise<void> {
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
  temporaryDirectories.push(root);
  file = path.join(root, "db.json");
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = path.dirname(file);
    const originalPath = file;
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });

  it("normalizes legacy agents as unassigned chats", async () => {
    await writeFixture({ version: 1, agents: [legacyAgent()], messages: [], runs: [] });
    const store = new JsonStore(file);
    await store.initialize();
    expect(store.snapshot()).toMatchObject({
      projects: [],
      agents: [{ projectId: null, unassignedPlacement: "previous" }],
    });
  });

  it("preserves temporary placement for newly persisted non-project agents", async () => {
    await writeFixture({
      version: 1,
      agents: [
        {
          ...legacyAgent(),
          projectId: null,
          unassignedPlacement: "temporary",
        },
      ],
      messages: [],
      runs: [],
    });
    const store = new JsonStore(file);
    await store.initialize();
    expect(store.snapshot().agents[0]?.unassignedPlacement).toBe("temporary");
  });

  it("preserves an exact project baseline transition", async () => {
    await writeFixture(
      databaseWithProject({
        baselineTransition: {
          runId: RUN_ID,
          expectedCommit: "a".repeat(40),
          nextCommit: "b".repeat(40),
          state: "prepared",
        },
      }),
    );
    const store = new JsonStore(file);
    await store.initialize();
    expect(store.snapshot().projects[0]?.baselineTransition?.runId).toBe(RUN_ID);
  });

  it("normalizes a version-1 orchestration record lacking healing to an empty state", async () => {
    await writeFixture({
      version: 1,
      projects: [],
      agents: [legacyAgent()],
      messages: [],
      runs: [runWithoutHealing()],
    });
    const store = new JsonStore(file);
    await store.initialize();
    expect(store.snapshot().runs[0]?.orchestration?.healing).toEqual(emptyHealingState());
    expect(store.snapshot().runs[0]?.orchestration?.evolutionOutbox).toEqual([]);
  });

  it("round-trips a bounded internal evolution outbox entry", async () => {
    const run = runWithoutHealing();
    run.orchestration = {
      ...run.orchestration!,
      evolutionOutbox: [evolutionOutboxEntry()],
    };
    await writeFixture({
      version: 1,
      projects: [],
      agents: [legacyAgent()],
      messages: [],
      runs: [run],
    });
    const store = new JsonStore(file);
    await store.initialize();
    expect(store.snapshot().runs[0]?.orchestration?.evolutionOutbox).toEqual([
      evolutionOutboxEntry(),
    ]);
  });

  it("round-trips exact incomplete v2 fingerprints without enabling repeat or cue keys", async () => {
    const store = new JsonStore(file);
    await store.initialize();
    const run = runWithoutHealing();
    const entry = incompleteFingerprintOutboxEntry();
    run.orchestration = {
      ...run.orchestration!,
      evolutionOutbox: [entry],
    };
    await store.mutate((database) => {
      database.runs.push(run);
    });

    const reopened = new JsonStore(file);
    await reopened.initialize();
    const record = reopened.snapshot().runs[0]?.orchestration?.evolutionOutbox?.[0]
      ?.records[0];
    expect(record?.type).toBe("node");
    const fingerprints = record?.type === "node" ? record.value.fingerprints : null;
    expect(fingerprints).toEqual(
      (entry.records[0]?.type === "node" ? entry.records[0].value.fingerprints : null),
    );
    expect(fingerprints?.complete).toBe(false);
    expect(exactRepeatKey(fingerprints!)).toBeNull();
    expect(failureCueLookupKey(fingerprints!)).toBeNull();
  });

  it("rejects an outbox mutation beyond the bounded entry count", async () => {
    const store = new JsonStore(file);
    await store.initialize();
    await expect(store.mutate((database) => {
      const run = runWithoutHealing();
      run.orchestration = {
        ...run.orchestration!,
        evolutionOutbox: Array.from({ length: 1_001 }, evolutionOutboxEntry),
      };
      database.runs.push(run);
    })).rejects.toThrow(/outbox|array|200/i);
    expect(store.snapshot().runs).toEqual([]);
  });

  it("normalizes healing records missing snapshots to an empty array", async () => {
    const run = runWithoutHealing();
    run.orchestration = {
      ...run.orchestration!,
      healing: {
        contracts: [],
        nodes: [],
        faults: [],
        diagnoses: [],
        candidates: [],
        tournaments: [],
        verifications: [],
        budget: null,
      } as HealingState,
    };
    await writeFixture({
      version: 1,
      projects: [],
      agents: [legacyAgent()],
      messages: [],
      runs: [run],
    });
    const store = new JsonStore(file);
    await store.initialize();
    expect(store.snapshot().runs[0]?.orchestration?.healing.snapshots).toEqual([]);
    expect(store.snapshot().runs[0]?.orchestration?.healing.repairGraphFence).toBeNull();
  });

  it("round-trips a valid repair graph fence", async () => {
    const healing = populatedHealingState() as HealingState & { repairGraphFence: unknown };
    healing.repairGraphFence = {
      runId: RUN_ID,
      tournamentId: "tournament-1",
      graphRevision: 1,
      graphHash: "a".repeat(64),
      contractHashes: ["b".repeat(64)],
      admittedAt: "2026-08-31T00:00:00.000Z",
    };
    await writeFixture({
      version: 1,
      projects: [],
      agents: [legacyAgent()],
      messages: [],
      runs: [runWithHealing(healing)],
    });

    const store = new JsonStore(file);
    await store.initialize();

    expect(store.snapshot().runs[0]?.orchestration?.healing.repairGraphFence).toEqual(
      healing.repairGraphFence,
    );
  });

  it("fails closed when a persisted repair graph fence has a malformed hash", async () => {
    const healing = populatedHealingState() as HealingState & { repairGraphFence: unknown };
    healing.repairGraphFence = {
      runId: RUN_ID,
      tournamentId: "tournament-1",
      graphRevision: 1,
      graphHash: "not-a-hash",
      contractHashes: ["b".repeat(64)],
      admittedAt: "2026-08-31T00:00:00.000Z",
    };
    await writeFixture({
      version: 1,
      projects: [],
      agents: [legacyAgent()],
      messages: [],
      runs: [runWithHealing(healing)],
    });

    const store = new JsonStore(file);
    await expect(store.initialize()).rejects.toThrow(/repair graph fence/i);
  });

  it("normalizes historical attempts and contributions without a database-version bump", async () => {
    await writeFixture({
      version: 1,
      projects: [],
      agents: [legacyAgent()],
      messages: [],
      runs: [runWithoutHealing()],
    });
    const store = new JsonStore(file);
    await store.initialize();
    const snapshot = store.snapshot();
    expect(snapshot.version).toBe(1);
    expect(snapshot.runs[0]?.project?.attempts[0]).toMatchObject({
      kind: "task",
      checkpointId: null,
    });
    expect(snapshot.runs[0]?.project?.integrations[0]?.verificationIds).toEqual([]);
    expect(snapshot.runs[0]?.orchestration?.workerResults[0]?.contribution?.verificationIds).toEqual(
      [],
    );
  });

  it("round-trips populated healing node revision, fault evidence, candidate lifecycle, verification costs, and budget warning", async () => {
    const healing = populatedHealingState();
    await writeFixture({
      version: 1,
      projects: [],
      agents: [legacyAgent()],
      messages: [],
      runs: [runWithHealing(healing)],
    });
    const store = new JsonStore(file);
    await store.initialize();
    const persisted = store.snapshot().runs[0]?.orchestration?.healing;
    expect(persisted?.nodes[0]?.revision).toBe(3);
    expect(persisted?.faults[0]?.evidenceRefs).toEqual(["snap-1"]);
    expect(
      persisted?.faults[0]?.evidenceRefs.every((id) =>
        persisted.snapshots.some((snapshot) => snapshot.id === id),
      ),
    ).toBe(true);
    expect(persisted?.candidates[0]?.state).toBe("promotion_pending");
    expect(persisted?.verifications[0]).toMatchObject({
      modelCalls: 2,
      reservedTokens: 400,
      actualInputTokens: 120,
      actualOutputTokens: 80,
      elapsedMs: 1500,
    });
    expect(persisted?.budget?.warningLevel).toBe("advisory");
    expect(persisted).toEqual(healing);
  });

  it("round-trips a sticky severe warning and terminal reason even when current usage is below advisory", async () => {
    const healing = populatedHealingState();
    healing.budget = {
      ...healing.budget!,
      reservedTokens: 10,
      actualInputTokens: 4,
      actualOutputTokens: 2,
      usedModelCalls: 1,
      warningLevel: "severe",
      terminalReason: "emergency_token_fuse",
    };
    await writeFixture({
      version: 1,
      projects: [],
      agents: [legacyAgent()],
      messages: [],
      runs: [runWithHealing(healing)],
    });
    const store = new JsonStore(file);
    await store.initialize();
    expect(store.snapshot().runs[0]?.orchestration?.healing?.budget).toMatchObject({
      reservedTokens: 10,
      warningLevel: "severe",
      terminalReason: "emergency_token_fuse",
      deadlineAt: "2026-08-29T01:00:00.000Z",
    });
  });
});

function policySnapshot(): OrchestrationState["policySnapshot"] {
  return {
    maxParallel: 10,
    maxSubtasks: 10,
    maxIterations: 2,
    maxTotalWorkerRuns: 30,
    workerTimeoutMs: 900_000,
    workerSessionPolicy: "fresh",
    workerWorkspacePolicy: "fresh_task_scoped",
    workerIdentityPolicy: "per_subtask",
    quiescenceMs: 2_000,
    maxFollowUpTurnsPerWorker: 3,
  };
}

function evolutionOutboxEntry(): EvolutionOutboxEntry {
  return {
    id: "f".repeat(64),
    projectId: PROJECT_ID,
    runId: RUN_ID,
    records: [{
      type: "quarantine",
      value: {
        id: "e".repeat(64),
        projectId: PROJECT_ID,
        targetRecordId: "d".repeat(64),
        reason: "fingerprint_incomplete",
        evidenceRefs: ["c".repeat(64)],
        quarantinedAt: "2026-08-29T00:00:00.000Z",
      },
    }],
    state: "pending",
    createdAt: "2026-08-29T00:00:00.000Z",
    deliveredAt: null,
    lastErrorCode: null,
  };
}

function incompleteFingerprintOutboxEntry(): EvolutionOutboxEntry {
  return {
    id: "f".repeat(64),
    projectId: PROJECT_ID,
    runId: RUN_ID,
    records: [{
      type: "node",
      value: {
        id: "1".repeat(64),
        projectId: PROJECT_ID,
        sourceFingerprint: "2".repeat(64),
        runId: RUN_ID,
        subtaskId: "backend",
        kind: "candidate",
        entityId: "candidate-1",
        revision: 1,
        harnessVersionHash: "3".repeat(64),
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        faultId: "fault-1",
        fingerprints: {
          schemaVersion: 2,
          complete: false,
          repositoryBaseHash: "4".repeat(64),
          contractHash: "5".repeat(64),
          authorityManifestHash: "6".repeat(64),
          runtimeCapabilityHash: "7".repeat(64),
          faultEvidenceHash: "8".repeat(64),
          mutationContentHash: "9".repeat(64),
        },
        verificationIds: [],
        evidenceRefs: [],
        changedPaths: [],
        createdAt: "2026-08-29T00:00:00.000Z",
      },
    }],
    state: "pending",
    createdAt: "2026-08-29T00:00:00.000Z",
    deliveredAt: null,
    lastErrorCode: null,
  };
}

function runWithoutHealing(): AgentRun {
  return {
    id: RUN_ID,
    agentId: AGENT_ID,
    projectId: null,
    kind: "orchestration",
    parentRunId: null,
    orchestration: {
      phase: "executing",
      iteration: 1,
      iterationPlans: [],
      evaluationRecords: [],
      workerResults: [
        {
          subtaskId: "backend",
          workerId: null,
          workerRunId: null,
          iteration: 1,
          attempt: 1,
          status: "completed",
          output: "done",
          usage: null,
          durationMs: 1,
          artifacts: [],
          contribution: {
            contributionId: "c1",
            attemptId: "a1",
            attemptRevision: 1,
            ownerFingerprint: "f".repeat(64),
            subtaskId: "backend",
            baseCommit: "a".repeat(40),
            headCommit: "b".repeat(40),
            changedPaths: ["src/api.ts"],
            diffHash: "d".repeat(64),
            verificationLevel: "structural",
          },
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, workerRuns: 1 },
      policySnapshot: policySnapshot(),
      provenance: {
        harnessVersion: "orchestration-1",
        plannerPromptVersion: "planner-v1",
        evaluatorPromptVersion: "evaluator-v1",
        replannerPromptVersion: "replanner-v1",
        synthesizerPromptVersion: "synthesizer-v1",
      },
    },
    project: {
      source: {
        mode: "existing_repository",
        repositoryPath: "/tmp/repo",
        requestedRevision: "HEAD",
        baseCommit: "a".repeat(40),
        sourceFingerprint: "s".repeat(64),
      },
      runBranch: "launchpad/run/" + RUN_ID,
      canonicalWorkspacePath: "/tmp/run",
      headCommit: "b".repeat(40),
      state: "ready",
      attempts: [
        {
          attemptId: "a1",
          revision: 1,
          ownerToken: "legacy-owner-token",
          subtaskId: "backend",
          baseCommit: "a".repeat(40),
          workspacePath: "/tmp/attempt",
          state: "integrated",
          cleanup: "removed",
          headCommit: "b".repeat(40),
          reason: null,
        },
      ],
      integrations: [
        {
          contributionId: "c1",
          subtaskId: "backend",
          canonicalHeadBefore: "a".repeat(40),
          canonicalHeadAfter: "b".repeat(40),
          state: "integrated",
          structuralDecision: "passed",
          reason: null,
        },
      ],
    },
    status: "running",
    prompt: "build",
    output: null,
    error: null,
    usage: null,
    startedAt: "2026-08-28T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

function populatedHealingState(): HealingState {
  return {
    contracts: [
      {
        subtaskId: "backend",
        revision: 3,
        contractKey: "backend-producer",
        inputs: ["docs/api.md"],
        outputs: ["src/api.ts"],
        dependencyIds: [],
        downstreamConsumers: ["integration"],
        allowedMutationPaths: ["src/api.ts"],
        protectedPaths: [".launchpad"],
        artifactSchemaIds: ["backend-schema"],
        targetedGateIds: ["backend-targeted"],
        contractGateIds: ["backend-contract"],
        consumerGateIds: ["backend-consumer"],
        regressionGateIds: ["backend-regression"],
        authorizedTools: ["read_file"],
      },
    ],
    nodes: [
      {
        subtaskId: "backend",
        revision: 3,
        state: "completed",
        blockedBy: [],
        attemptId: "a1",
        faultId: "fault-1",
        diagnosisId: "diag-1",
        tournamentId: "tourney-1",
        verificationIds: ["ver-1"],
        integrationContributionId: "c1",
        updatedAt: "2026-08-29T00:00:00.000Z",
      },
    ],
    faults: [
      {
        id: "fault-1",
        subtaskId: "backend",
        revision: 3,
        class: "hard_failure",
        reasonCode: "gate_failed",
        summary: "targeted gate failed",
        repairable: true,
        evidenceRefs: ["snap-1"],
        affectedConsumers: ["integration"],
        detectedAt: "2026-08-29T00:00:00.000Z",
      },
    ],
    snapshots: [
      {
        id: "snap-1",
        attemptId: "a1",
        sequence: 1,
        source: "runtime",
        mandatoryFailures: 1,
        consumerPassed: true,
        regressionCount: 0,
        failureFingerprints: ["fail"],
        changedPaths: ["src/api.ts"],
        protectedViolations: [],
        diffRiskUnits: 0,
        modelCalls: 1,
        commands: 1,
        toolCalls: 0,
        elapsedMs: 10,
        stateFingerprint: "fp",
        contentHash: "c".repeat(64),
        createdAt: "2026-08-29T00:00:00.000Z",
      },
    ],
    diagnoses: [
      {
        id: "diag-1",
        faultId: "fault-1",
        status: "available",
        classification: "missing_export",
        rationale: "API export was omitted",
        allowedMutationFamilies: ["context_patch"],
        createdAt: "2026-08-29T00:00:01.000Z",
      },
    ],
    candidates: [
      {
        id: "cand-1",
        tournamentId: "tourney-1",
        checkpointId: "ckpt-1",
        delta: {
          family: "context_patch",
          targetSubtaskId: "backend",
          diagnosisId: "diag-1",
          addedEvidenceRefs: ["evidence/fault-1.json"],
          instructionPatch: "export the handler",
          toolRoute: ["read_file"],
          expectedEffect: "gate passes",
          contentHash: "h".repeat(64),
        },
        state: "promotion_pending",
        attemptId: "repair-1",
        verificationIds: ["ver-1"],
        modelCalls: 1,
        reservedTokens: 200,
        actualInputTokens: 50,
        actualOutputTokens: 20,
        elapsedMs: 800,
        terminalReason: null,
        historicalMatchRecordId: null,
        historicalVerificationId: null,
        evolutionFingerprints: null,
      },
    ],
    tournaments: [
      {
        id: "tourney-1",
        subtaskId: "backend",
        revision: 3,
        checkpointId: "ckpt-1",
        candidateIds: ["cand-1", "cand-2", "cand-3"],
        status: "promotion_pending",
        winnerCandidateId: "cand-1",
        failureReason: null,
        startedAt: "2026-08-29T00:00:02.000Z",
        completedAt: null,
      },
    ],
    verifications: [
      {
        id: "ver-1",
        subjectType: "candidate",
        subjectId: "cand-1",
        stage: "finalist",
        authorityManifestHash: "m".repeat(64),
        gates: [
          {
            gateId: "backend-targeted",
            tier: "targeted",
            passed: true,
            evidenceRef: "evidence/gate-1.json",
            failureFingerprint: null,
          },
        ],
        failureKind: null,
        mandatoryPassed: true,
        hardProgress: 1,
        regressionCount: 0,
        modelCalls: 2,
        reservedTokens: 400,
        actualInputTokens: 120,
        actualOutputTokens: 80,
        elapsedMs: 1500,
        verifiedAt: "2026-08-29T00:00:03.000Z",
      },
    ],
    repairGraphFence: null,
    budget: {
      advisoryTokens: 10_000,
      severeTokens: 50_000,
      advisoryModelCalls: 8,
      severeModelCalls: 20,
      emergencyTokenFuse: 100_000,
      emergencyModelCallFuse: 40,
      usedModelCalls: 4,
      reservedTokens: 400,
      actualInputTokens: 120,
      actualOutputTokens: 80,
      estimatedDollars: 0.02,
      warningLevel: "advisory",
      deadlineAt: "2026-08-29T01:00:00.000Z",
      terminalReason: null,
    },
  };
}

function runWithHealing(healing: HealingState): AgentRun {
  const run = runWithoutHealing();
  return {
    ...run,
    orchestration: {
      ...run.orchestration!,
      healing,
    },
    project: {
      ...run.project!,
      attempts: run.project!.attempts.map((attempt) => ({
        ...attempt,
        kind: "task" as const,
        checkpointId: null,
      })),
      integrations: run.project!.integrations.map((integration) => ({
        ...integration,
        verificationIds: ["ver-1"],
      })),
    },
  };
}
