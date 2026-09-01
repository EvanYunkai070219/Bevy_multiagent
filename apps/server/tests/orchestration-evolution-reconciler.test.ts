import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvolutionReconciler, evolutionRunGroupFingerprint } from "../src/orchestration/evolution/evolution-reconciler.js";
import { EvolutionStore } from "../src/orchestration/evolution/evolution-store.js";
import {
  deterministicEvolutionId,
  type EvolutionPayload,
  type LineageNode,
  type QuarantineRecord,
} from "../src/orchestration/evolution/evolution-types.js";
import type { HistoricalEvidenceAuditor } from "../src/orchestration/evolution/historical-evidence-auditor.js";
import type { ExactRepeatIndex } from "../src/orchestration/evolution/exact-repeat-index.js";
import type { FailureCueService } from "../src/orchestration/evolution/failure-cues.js";
import { LineageRecorder } from "../src/orchestration/evolution/lineage-recorder.js";
import { JsonStore } from "../src/store.js";
import type { AgentRun, ProjectRecord } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function stores() {
  const root = await mkdtemp(path.join(tmpdir(), "evolution-reconcile-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  const evolutionStore = new EvolutionStore({ dataDirectory: root });
  await store.initialize();
  await evolutionStore.initialize();
  return { root, store, evolutionStore, recorder: new LineageRecorder({ store, evolutionStore }) };
}

function run(id: string, parentRunId: string | null): AgentRun {
  return {
    id, agentId: "agent-" + id, projectId: "project-1", kind: parentRunId ? "subtask" : "orchestration",
    parentRunId, orchestration: null, status: "completed", prompt: "p", output: "ok", error: null, usage: null,
    startedAt: "2026-08-30T00:00:00.000Z", completedAt: "2026-08-30T00:00:01.000Z",
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

function project(): ProjectRecord {
  return {
    id: "project-1", displayName: "Project", sourceKind: "managed", repositoryPath: "/repo",
    repositoryRealPath: "/repo", gitCommonRealPath: "/repo/.git", gitCommonDev: 1, gitCommonIno: 2,
    baselineBranch: "main", baselineCommit: "a".repeat(40), state: "ready", lastError: null,
    createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function legacyCompletedGroup(suffix = ""): AgentRun[] {
  const rootId = "root" + suffix;
  const childId = "candidate-child" + suffix;
  const tournamentId = "tournament-1" + suffix;
  const candidateId = "candidate-rejected" + suffix;
  const timestamp = "2026-08-30T00:00:00.000Z";
  const candidate = {
    id: candidateId, tournamentId, checkpointId: "checkpoint-1" + suffix,
    delta: { family: "control", targetSubtaskId: "backend", diagnosisId: "diagnosis-1", addedEvidenceRefs: [],
      instructionPatch: "retry", toolRoute: [], expectedEffect: "repair", contentHash: "b".repeat(64) },
    state: "rejected", attemptId: childId, verificationIds: [], modelCalls: 1, reservedTokens: 1,
    actualInputTokens: 1, actualOutputTokens: 1, elapsedMs: 1, terminalReason: "mandatory_gate_failed",
    historicalMatchRecordId: null, historicalVerificationId: null,
    evolutionFingerprints: {
      schemaVersion: 2, complete: true, repositoryBaseHash: "1".repeat(64),
      contractHash: "2".repeat(64), authorityManifestHash: "3".repeat(64),
      runtimeCapabilityHash: "4".repeat(64), faultEvidenceHash: "5".repeat(64),
      mutationContentHash: "b".repeat(64),
    },
  } as const;
  const declared = { ...candidate, id: "candidate-declared" + suffix, state: "declared" as const, attemptId: null };
  const root = {
    ...run(rootId, null),
    project: {
      source: { mode: "existing_repository", repositoryPath: "/repo", requestedRevision: "main",
        baseCommit: "a".repeat(40), sourceFingerprint: "c".repeat(64) },
      runBranch: "launchpad/run/" + rootId, canonicalWorkspacePath: "/repo", headCommit: "a".repeat(40),
      state: "completed", attempts: [], integrations: [],
    },
    orchestration: {
      phase: "completed", iteration: 1, iterationPlans: [], evaluationRecords: [], workerResults: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, workerRuns: 0 }, policySnapshot: {},
      provenance: { harnessVersion: "m2", plannerPromptVersion: "p", evaluatorPromptVersion: "e",
        replannerPromptVersion: "r", synthesizerPromptVersion: "s" },
      healing: {
        contracts: [],
        nodes: [{ subtaskId: "backend", revision: 1, state: "failed", blockedBy: [], attemptId: "original",
          faultId: "fault-1" + suffix, diagnosisId: "diagnosis-1" + suffix, tournamentId, verificationIds: [],
          integrationContributionId: null, updatedAt: timestamp }],
        faults: [{ id: "fault-1" + suffix, subtaskId: "backend", revision: 1, class: "hard_failure",
          reasonCode: "targeted_gate_failed", summary: "failed", repairable: true, evidenceRefs: [],
          affectedConsumers: [], detectedAt: timestamp }],
        snapshots: [], diagnoses: [], candidates: [candidate, declared],
        tournaments: [{ id: tournamentId, subtaskId: "backend", revision: 1, checkpointId: "checkpoint-1" + suffix,
          candidateIds: [candidateId, "candidate-declared" + suffix, "candidate-unused" + suffix], status: "failed",
          winnerCandidateId: null, failureReason: "mandatory_gate_failed", startedAt: timestamp, completedAt: timestamp }],
        verifications: [], budget: null,
      },
      evolutionOutbox: [],
    },
  } as unknown as AgentRun;
  return [root, { ...run(childId, rootId), usage: { inputTokens: 1, outputTokens: 1 } }];
}

describe("EvolutionReconciler", () => {
  it("fingerprints the exact root plus every candidate/background child", () => {
    const root = run("root", null);
    const children = [run("candidate", "root"), run("background", "root")];
    const fingerprint = evolutionRunGroupFingerprint(root, [root, ...children]);
    expect(evolutionRunGroupFingerprint(root, [root, children[0]!])).not.toBe(fingerprint);
    expect(evolutionRunGroupFingerprint(root, [root, children[1]!, children[0]!])).toBe(fingerprint);
  });

  it("rechecks the snapshotted group under store serialization and skips stale backfill", async () => {
    const { store, evolutionStore, recorder } = await stores();
    await store.mutate((database) => { database.runs.push(...legacyCompletedGroup()); });
    const reconciler = new EvolutionReconciler({
      store, evolutionStore, lineageRecorder: recorder,
      afterSnapshot: async () => store.mutate((database) => { database.runs[1]!.output = "newer child state"; }),
    });
    await expect(reconciler.reconcile()).resolves.toEqual({
      deliveredOutboxIds: [], backfilledRunIds: [], quarantineIds: [], unavailableProjectIds: [],
    });
    expect(store.snapshot().runs[1]!.output).toBe("newer child state");
  });

  it("backfills completed Milestone 2 execution once and never promotes a declaration to execution", async () => {
    const { store, evolutionStore, recorder } = await stores();
    await store.mutate((database) => { database.runs.push(...legacyCompletedGroup()); });
    const reconciler = new EvolutionReconciler({ store, evolutionStore, lineageRecorder: recorder });
    const first = await reconciler.reconcile();
    const firstBytes = JSON.stringify(store.snapshot().runs[0]!.orchestration!.evolutionOutbox);
    const second = await reconciler.reconcile();
    const records = (await evolutionStore.read({ projectId: "project-1", afterSequence: 0, limit: 200 })).records;
    const observations = records.filter((record) => record.type === "observation").map((record) => record.value);
    expect(first.backfilledRunIds).toEqual(["root"]);
    expect(first.deliveredOutboxIds).toHaveLength(1);
    expect(second.backfilledRunIds).toEqual([]);
    expect(JSON.stringify(store.snapshot().runs[0]!.orchestration!.evolutionOutbox)).toBe(firstBytes);
    expect(observations.map((value) => value.kind)).toEqual(["rejected"]);
    expect(records.some((record) => record.type === "node" && record.value.entityId === "candidate-declared")).toBe(false);
  });

  it("processes at most 100 startup groups and leaves the remainder untouched", async () => {
    const { store, evolutionStore, recorder } = await stores();
    const groups = Array.from({ length: 101 }, (_, index) => legacyCompletedGroup("-" + index)).flat();
    await store.mutate((database) => { database.runs.push(...groups); });
    const reconciler = new EvolutionReconciler({
      store, evolutionStore, lineageRecorder: recorder,
      now: () => 0,
    } as ConstructorParameters<typeof EvolutionReconciler>[0]);
    const result = await reconciler.reconcile();
    expect(result.backfilledRunIds).toHaveLength(100);
    expect(store.snapshot().runs.find((value) => value.id === "root-100")?.orchestration?.evolutionOutbox).toEqual([]);
    const second = await reconciler.reconcile();
    expect(second.backfilledRunIds).toEqual(["root-100"]);
    expect(store.snapshot().runs.find((value) => value.id === "root-100")?.orchestration?.evolutionOutbox[0]?.state)
      .toBe("delivered");
  }, 30_000);

  it("rechecks the five-second budget between pages of one large Project", async () => {
    const { store, recorder } = await stores();
    await store.mutate((database) => { database.projects.push(project()); });
    let reads = 0;
    const pagedStore = {
      head: async () => ({
        schemaVersion: 1 as const, projectId: "project-1", sequence: 200,
        segmentHash: "a".repeat(64), updatedAt: "2026-08-30T00:00:00.000Z",
      }),
      read: async () => {
        reads += 1;
        if (reads > 1) throw new Error("second page crossed startup deadline");
        return {
          records: [],
          nextSequence: 200,
          health: { state: "ready", validThroughSequence: 200, headSegmentHash: null,
            quarantinableSegmentHashes: [] },
        };
      },
    } as unknown as EvolutionStore;
    const ticks = [0, 0, 0, 5_001];
    const reconciler = new EvolutionReconciler({
      store,
      evolutionStore: pagedStore,
      lineageRecorder: recorder,
      now: () => ticks.shift() ?? 5_001,
    });
    await expect(reconciler.reconcile()).resolves.toMatchObject({ unavailableProjectIds: [] });
    expect(reads).toBe(1);
  });

  it("stages partial audit decisions without publishing pruning or cue authority", async () => {
    const { store, evolutionStore, recorder } = await stores();
    await store.mutate((database) => { database.projects.push(project()); });
    const records: EvolutionPayload[] = Array.from({ length: 150 }, (_, index) => ({
      type: "node" as const,
      value: {
        id: deterministicEvolutionId("large-audit-node", { index }),
        projectId: "project-1",
        sourceFingerprint: "c".repeat(64),
        runId: "run-1",
        subtaskId: "task-1",
        kind: "candidate" as const,
        entityId: `candidate-${index}-control`,
        revision: 1,
        harnessVersionHash: "d".repeat(64),
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
        faultId: `fault-${index}`,
        fingerprints: {
          schemaVersion: 2, complete: true, repositoryBaseHash: "1".repeat(64),
          contractHash: "2".repeat(64), authorityManifestHash: "3".repeat(64),
          runtimeCapabilityHash: "4".repeat(64), faultEvidenceHash: "5".repeat(64),
          mutationContentHash: "6".repeat(64),
        },
        verificationIds: [`verification-${index}`],
        evidenceRefs: [],
        changedPaths: [],
        createdAt: "2026-08-30T00:00:00.000Z",
      } satisfies LineageNode,
    }));
    await evolutionStore.appendBatch({ projectId: "project-1", expectedHeadHash: null, records });
    const rebuildSizes: number[] = [];
    let unavailableCalls = 0;
    const index = {
      rebuild(values: readonly EvolutionPayload[]) { rebuildSizes.push(values.length); },
      markUnavailable() { unavailableCalls += 1; },
    } as unknown as ExactRepeatIndex;
    const cueRebuildSizes: number[] = [];
    let cueUnavailableCalls = 0;
    const cues = {
      rebuild(_values: readonly unknown[], decisions: readonly unknown[]) {
        cueRebuildSizes.push(decisions.length);
      },
      markUnavailable() { cueUnavailableCalls += 1; },
    } as unknown as FailureCueService;
    const auditor = ({
      audit: async ({ record }: { record: LineageNode }) => ({
        recordId: record.id, trustedForPruning: true, trustedForCue: true, quarantine: null,
      }),
    } as unknown) as HistoricalEvidenceAuditor;

    await new EvolutionReconciler({
      store, evolutionStore, lineageRecorder: recorder, auditor, exactRepeatIndex: index,
      failureCueService: cues, now: () => 0,
    }).reconcile();
    expect(rebuildSizes).toEqual([]);
    expect(cueRebuildSizes).toEqual([]);
    expect(unavailableCalls).toBe(1);
    expect(cueUnavailableCalls).toBe(1);
    const firstCheckpoint = (store.snapshot() as unknown as {
      evolutionReconciliation?: Record<string, { nextSequence: number; complete: boolean }>;
    }).evolutionReconciliation?.["project-1"];
    expect(firstCheckpoint).toMatchObject({ nextSequence: 99, complete: false });

    const restarted = new EvolutionReconciler({
      store, evolutionStore, lineageRecorder: recorder, auditor, exactRepeatIndex: index,
      failureCueService: cues, now: () => 0,
    });
    await restarted.reconcile();
    expect(rebuildSizes).toEqual([]);
    expect(cueRebuildSizes).toEqual([]);
    await restarted.reconcile();
    expect(rebuildSizes).toEqual([]);
    expect(cueRebuildSizes).toEqual([]);
    const partialCheckpoint = (store.snapshot() as unknown as {
      evolutionReconciliation?: Record<string, { auditDecisions: readonly unknown[]; complete: boolean }>;
    }).evolutionReconciliation?.["project-1"];
    expect(partialCheckpoint).toMatchObject({ complete: false });
    expect(partialCheckpoint?.auditDecisions).toHaveLength(99);
    await restarted.reconcile();
    expect(rebuildSizes).toEqual([150]);
    expect(cueRebuildSizes).toEqual([150]);
    expect((store.snapshot() as unknown as {
      evolutionReconciliation?: Record<string, { nextSequence: number; complete: boolean }>;
    }).evolutionReconciliation?.["project-1"]).toMatchObject({ nextSequence: 150, complete: true });
  });

  it("isolates an unexpected group failure as unavailable history", async () => {
    const { evolutionStore, recorder } = await stores();
    const malformedGroup = legacyCompletedGroup();
    const malformedStore = {
      snapshot: () => ({ version: 1, projects: [], agents: [], messages: [], runs: malformedGroup }),
      mutate: async () => { throw new Error("malformed persisted group"); },
    } as unknown as JsonStore;
    const reconciler = new EvolutionReconciler({ store: malformedStore, evolutionStore, lineageRecorder: recorder });
    await expect(reconciler.reconcile()).resolves.toMatchObject({ unavailableProjectIds: ["project-1"] });
  });

  it("exposes only the valid prefix, bounds corrupt-suffix identities, and preserves bytes", async () => {
    const { root, store, evolutionStore, recorder } = await stores();
    await store.mutate((database) => { database.projects.push(project()); });
    const quarantine: QuarantineRecord = {
      id: deterministicEvolutionId("seed", { value: 1 }), projectId: "project-1",
      targetRecordId: deterministicEvolutionId("target", { value: 1 }), reason: "schema_invalid",
      evidenceRefs: [], quarantinedAt: "2026-08-30T00:00:00.000Z",
    };
    await evolutionStore.appendBatch({ projectId: "project-1", expectedHeadHash: null, records: [{ type: "quarantine", value: quarantine }] });
    const directory = path.join(root, "evolution", "projects", "project-1", "segments");
    const segment = (await readdir(directory)).find((name) => name.endsWith(".json"))!;
    const segmentPath = path.join(directory, segment);
    const corrupted = Buffer.concat([await readFile(segmentPath), Buffer.from("corrupt")]);
    await writeFile(segmentPath, corrupted);
    const before = await readFile(segmentPath);
    const result = await new EvolutionReconciler({ store, evolutionStore, lineageRecorder: recorder }).reconcile();
    const read = await evolutionStore.read({ projectId: "project-1", afterSequence: 0, limit: 200 });
    expect(read.records).toEqual([]);
    expect(read.health.state).toBe("corrupt_suffix");
    expect(result.quarantineIds).toHaveLength(1);
    expect(await readFile(segmentPath)).toEqual(before);
  });
});
