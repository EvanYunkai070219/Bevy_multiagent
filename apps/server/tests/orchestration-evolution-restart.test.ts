import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalHash } from "../src/orchestration/evolution/evolution-fingerprints.js";
import { EvolutionProjector } from "../src/orchestration/evolution/evolution-projector.js";
import { EvolutionStore } from "../src/orchestration/evolution/evolution-store.js";
import {
  deterministicEvolutionId,
  type EvolutionOutboxEntry,
  type EvolutionPayload,
  type LineageNode,
} from "../src/orchestration/evolution/evolution-types.js";
import { EvidenceStore } from "../src/orchestration/verification/evidence-store.js";
import {
  assertEvolutionOutboxCapacity,
  LineageRecorder,
} from "../src/orchestration/evolution/lineage-recorder.js";
import { JsonStore } from "../src/store.js";
import type { AgentRun, OrchestrationState } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "evolution-restart-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  const evolutionStore = new EvolutionStore({ dataDirectory: root });
  await store.initialize();
  await evolutionStore.initialize();
  return { root, store, evolutionStore };
}

function node(name: string, evidenceRefs: string[] = []): EvolutionPayload {
  const value: LineageNode = {
    id: canonicalHash({ name }),
    projectId: "project-1",
    sourceFingerprint: canonicalHash({ source: 1 }),
    runId: "run-1",
    subtaskId: "task-1",
    kind: "attempt",
    entityId: name,
    revision: 1,
    harnessVersionHash: canonicalHash({ harness: 1 }),
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    faultId: null,
    fingerprints: null,
    verificationIds: [],
    evidenceRefs,
    changedPaths: [],
    createdAt: "2026-08-30T00:00:00.000Z",
  };
  return { type: "node", value };
}

function outbox(index: number): EvolutionOutboxEntry {
  const records = [node(`attempt-${index}`)];
  return {
    id: deterministicEvolutionId("restart-outbox", { index }),
    projectId: "project-1",
    runId: "run-1",
    records,
    state: "pending",
    createdAt: "2026-08-30T00:00:00.000Z",
    deliveredAt: null,
    lastErrorCode: null,
  };
}

function runWithOutbox(entries: EvolutionOutboxEntry[]): AgentRun {
  return {
    id: "run-1",
    agentId: "agent-1",
    projectId: "project-1",
    kind: "orchestration",
    parentRunId: null,
    status: "completed",
    prompt: "repair",
    output: "done",
    error: null,
    usage: null,
    startedAt: "2026-08-30T00:00:00.000Z",
    completedAt: "2026-08-30T00:00:01.000Z",
    createdAt: "2026-08-30T00:00:00.000Z",
    orchestration: {
      phase: "completed",
      iteration: 1,
      iterationPlans: [],
      evaluationRecords: [],
      workerResults: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, workerRuns: 0 },
      policySnapshot: {},
      provenance: {
        harnessVersion: "m3",
        plannerPromptVersion: "p",
        evaluatorPromptVersion: "e",
        replannerPromptVersion: "r",
        synthesizerPromptVersion: "s",
      },
      healing: {
        contracts: [], nodes: [], faults: [], snapshots: [], diagnoses: [], candidates: [],
        tournaments: [], verifications: [], budget: null,
      },
      evolutionOutbox: entries,
    } as unknown as OrchestrationState,
  };
}

describe("evolution restart recovery", () => {
  it("removes only proven unpublished temp files and preserves ambiguous bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evolution-orphans-"));
    roots.push(root);
    const segments = path.join(root, "evolution", "projects", "project-1", "segments");
    await mkdir(segments, { recursive: true, mode: 0o700 });
    const orphan = path.join(segments,
      `.000000000001-000000000001-${"a".repeat(64)}.json.123.550e8400-e29b-41d4-a716-446655440000.tmp`);
    const ambiguous = path.join(segments, ".unknown-recovery-bytes");
    await writeFile(orphan, "unpublished", { mode: 0o600 });
    await writeFile(ambiguous, "preserve", { mode: 0o600 });
    const store = new EvolutionStore({ dataDirectory: root });
    await store.initialize();
    await expect(readFile(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(ambiguous, "utf8")).resolves.toBe("preserve");
    await store.close();
  });

  it("replays append-before-delivery exactly once and the second restart is idempotent", async () => {
    const { store, evolutionStore } = await fixture();
    await store.mutate((database) => { database.runs.push(runWithOutbox([outbox(1)])); });
    let interrupt = true;
    const interrupted = new LineageRecorder({
      store,
      evolutionStore,
      beforeMarkDelivered: () => {
        if (interrupt) {
          interrupt = false;
          throw new Error("restart after durable append");
        }
      },
    });
    await expect(interrupted.flush("run-1", { maxEntries: 100 })).rejects.toThrow(
      "restart after durable append",
    );
    expect((await evolutionStore.head("project-1")).sequence).toBe(1);
    expect(store.snapshot().runs[0]!.orchestration!.evolutionOutbox[0]!.state).toBe("pending");

    const restarted = new LineageRecorder({ store, evolutionStore });
    await expect(restarted.flush("run-1", { maxEntries: 100 })).resolves.toMatchObject({ delivered: 1 });
    await expect(restarted.flush("run-1", { maxEntries: 100 })).resolves.toMatchObject({ delivered: 0 });
    expect((await evolutionStore.head("project-1")).sequence).toBe(1);
    expect(store.snapshot().runs[0]!.orchestration!.evolutionOutbox[0]!.state).toBe("delivered");
  });

  it("stops at 100 pending deliveries and resumes without duplicate records", async () => {
    const { store, evolutionStore } = await fixture();
    await store.mutate((database) => {
      database.runs.push(runWithOutbox(Array.from({ length: 101 }, (_, index) => outbox(index))));
    });
    const recorder = new LineageRecorder({ store, evolutionStore });
    await expect(recorder.flush("run-1", { maxEntries: 100 })).resolves.toMatchObject({
      delivered: 100,
      remaining: 1,
    });
    expect(store.snapshot().runs[0]!.orchestration!.evolutionOutbox.filter((entry) =>
      entry.state === "pending")).toHaveLength(1);
    await expect(recorder.flush("run-1", { maxEntries: 100 })).resolves.toMatchObject({
      delivered: 1,
      remaining: 0,
    });
    expect((await evolutionStore.head("project-1")).sequence).toBe(101);
  });

  it("fails optional history closed at the pending-entry boundary and keeps a dropped count", () => {
    const state = runWithOutbox(Array.from({ length: 1_000 }, (_, index) => outbox(index)))
      .orchestration!;
    expect(() => assertEvolutionOutboxCapacity(state, outbox(1_001))).toThrow(
      "Evolution outbox entry limit reached",
    );
    expect(state.evolutionHistory).toEqual({
      state: "unavailable",
      droppedHistoryCount: 1,
      droppedReason: "outbox_entry_limit",
      reconciliationPending: true,
    });
  });

  it("projects every referenced evidence hash and temp cleanup never removes pinned objects", async () => {
    const { root } = await fixture();
    const evidence = new EvidenceStore({ dataDirectory: root });
    await evidence.initialize();
    const pinned = await evidence.write("verification", Buffer.from("trusted evidence"));
    const disposable = path.join(root, "evidence", "sha256", `${"f".repeat(64)}.tmp.orphan`);
    await writeFile(disposable, "temporary");
    const records = [node("with-evidence", [pinned.sha256])];
    expect(new EvolutionProjector().referencedEvidenceHashes(records)).toEqual([pinned.sha256]);
    await evidence.cleanupTemps({
      pinnedHashes: new Set([pinned.sha256]),
      minimumAgeMs: 0,
      now: Date.now() + 1_000,
    });
    expect((await evidence.verify(pinned)).exists).toBe(true);
    await expect(readFile(disposable)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
