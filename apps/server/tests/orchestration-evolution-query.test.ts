import { describe, expect, it } from "vitest";
import type { AgentRun } from "../src/types.js";
import { canonicalHash } from "../src/orchestration/evolution/evolution-fingerprints.js";
import type {
  BranchReturnRecord,
  EvolutionPayload,
  FailureCapsule,
  LineageEdge,
  LineageNode,
  LineageObservation,
} from "../src/orchestration/evolution/evolution-types.js";
import { deterministicEvolutionId } from "../src/orchestration/evolution/evolution-types.js";
import {
  EvolutionQueryError,
  EvolutionQueryService,
  type EvolutionQueryStore,
} from "../src/orchestration/evolution/evolution-query.js";

const hash = (value: string) => canonicalHash({ value });

function node(index: number, runId = "run-1"): LineageNode {
  return {
    id: hash(`node-${index}`),
    projectId: "project-1",
    sourceFingerprint: hash("source"),
    runId,
    subtaskId: `task-${index}`,
    kind: index % 2 === 0 ? "attempt" : "candidate",
    entityId: `entity-${index}`,
    revision: 1,
    harnessVersionHash: hash("harness"),
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    faultId: null,
    fingerprints: null,
    verificationIds: [],
    evidenceRefs: [],
    changedPaths: [],
    createdAt: `2026-08-30T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
  };
}

function edge(from: LineageNode, to: LineageNode): LineageEdge {
  return {
    id: hash(`${from.id}:${to.id}`),
    projectId: "project-1",
    fromNodeId: from.id,
    toNodeId: to.id,
    kind: "continuation",
    createdAt: to.createdAt,
  };
}

function observation(target: LineageNode, kind: LineageObservation["kind"]): LineageObservation {
  return {
    id: hash(`${target.id}:${kind}`),
    projectId: "project-1",
    runId: target.runId,
    nodeId: target.id,
    kind,
    candidateState: kind === "executed" ? "running" : kind === "promoted" ? "promoted" : null,
    terminalReason: null,
    modelCalls: kind === "executed" ? 1 : 0,
    reservedTokens: kind === "executed" ? 100 : 0,
    actualInputTokens: kind === "executed" ? 30 : 0,
    actualOutputTokens: kind === "executed" ? 20 : 0,
    elapsedMs: kind === "executed" ? 40 : 0,
    occurredAt: target.createdAt,
  };
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    agentId: "agent-1",
    projectId: "project-1",
    kind: "orchestration",
    parentRunId: null,
    status: "running",
    prompt: "repair",
    output: null,
    error: null,
    usage: null,
    startedAt: "2026-08-30T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    project: {
      source: {
        mode: "existing_repository",
        repositoryPath: "/repo",
        requestedRevision: "main",
        baseCommit: "a".repeat(40),
        sourceFingerprint: hash("source"),
      },
      runBranch: "launchpad/run/run-1",
      canonicalWorkspacePath: "/private/worktree",
      headCommit: "b".repeat(40),
      state: "ready",
      attempts: [],
      integrations: [],
    },
    orchestration: null,
    ...overrides,
  };
}

class MemoryQueryStore implements EvolutionQueryStore {
  headHash = hash("head");
  onRead: (() => void) | null = null;
  constructor(readonly records: EvolutionPayload[]) {}

  async head(projectId: string) {
    return {
      schemaVersion: 1 as const,
      projectId,
      sequence: this.records.length,
      segmentHash: this.headHash,
      updatedAt: "2026-08-30T00:00:00.000Z",
    };
  }

  async read(input: { projectId: string; afterSequence: number; limit: number }) {
    const records = this.records.slice(input.afterSequence, input.afterSequence + input.limit);
    const next = input.afterSequence + records.length;
    this.onRead?.();
    return {
      records,
      nextSequence: next < this.records.length ? next : null,
      health: {
        state: "ready" as const,
        validThroughSequence: this.records.length,
        headSegmentHash: this.headHash,
        quarantinableSegmentHashes: [],
      },
    };
  }
}

describe("EvolutionQueryService", () => {
  it("paginates deterministically at 100 by default and never returns more than 200 records", async () => {
    const records = Array.from({ length: 205 }, (_, index) => ({
      type: "node" as const,
      value: node(index),
    }));
    const store = new MemoryQueryStore(records);
    const query = new EvolutionQueryService({
      store,
      runById: () => run(),
      cursorSecret: "query-secret",
    });

    const first = await query.get({ runId: "run-1", after: null, limit: 100, depth: 4 });
    expect(first.nodes).toHaveLength(100);
    expect(new Set(first.nodes.map((value) => value.id)).size).toBe(100);
    expect(first.nextCursor).not.toBeNull();

    const second = await query.get({ runId: "run-1", after: first.nextCursor, limit: 100, depth: 4 });
    const third = await query.get({ runId: "run-1", after: second.nextCursor, limit: 100, depth: 4 });
    expect(second.nodes).toHaveLength(100);
    expect(third.nodes).toHaveLength(5);
    expect([...first.nodes, ...second.nodes, ...third.nodes].map((value) => value.id))
      .toEqual(records.map((value) => value.value.id));

    const maximum = await query.get({ runId: "run-1", after: null, limit: 200, depth: 4 });
    expect(maximum.nodes).toHaveLength(200);
    await expect(query.get({ runId: "run-1", after: null, limit: 201, depth: 4 }))
      .rejects.toBeInstanceOf(RangeError);
  });

  it("binds opaque cursors to the project, run, depth, and current history head", async () => {
    const store = new MemoryQueryStore(Array.from({ length: 3 }, (_, index) => ({
      type: "node" as const,
      value: node(index),
    })));
    const query = new EvolutionQueryService({ store, runById: () => run(), cursorSecret: "query-secret" });
    const first = await query.get({ runId: "run-1", after: null, limit: 1, depth: 2 });
    const cursor = first.nextCursor!;

    await expect(query.get({ runId: "run-1", after: cursor + "x", limit: 1, depth: 2 }))
      .rejects.toMatchObject({ code: "evolution_cursor_invalid" });
    await expect(query.get({ runId: "run-1", after: cursor, limit: 1, depth: 3 }))
      .rejects.toMatchObject({ code: "evolution_cursor_foreign" });

    store.headHash = hash("new-head");
    await expect(query.get({ runId: "run-1", after: cursor, limit: 1, depth: 2 }))
      .rejects.toMatchObject({ code: "evolution_cursor_stale" });
  });

  it("paginates the projected graph so cross-page edges and observations survive", async () => {
    const current = node(0, "run-1");
    const historical = node(1, "run-old");
    const records: EvolutionPayload[] = [
      { type: "node", value: current },
      { type: "edge", value: edge(current, historical) },
      { type: "node", value: historical },
      { type: "observation", value: observation(historical, "verified") },
    ];
    const query = new EvolutionQueryService({
      store: new MemoryQueryStore(records), runById: () => run(), cursorSecret: "query-secret",
    });

    const pages = [];
    let after: string | null = null;
    do {
      const page = await query.get({ runId: "run-1", after, limit: 1, depth: 1 });
      pages.push(page);
      after = page.nextCursor;
    } while (after !== null);

    expect(pages.flatMap((page) => page.nodes).map((value) => value.id)).toEqual([
      current.id,
      historical.id,
    ]);
    expect(pages.flatMap((page) => page.edges).map((value) => value.id)).toEqual([
      edge(current, historical).id,
    ]);
    expect(pages.flatMap((page) => page.observations).map((value) => value.id)).toEqual([
      observation(historical, "verified").id,
    ]);
  });

  it("rejects a page when history advances during its read", async () => {
    const store = new MemoryQueryStore(Array.from({ length: 3 }, (_, index) => ({
      type: "node" as const,
      value: node(index),
    })));
    const query = new EvolutionQueryService({ store, runById: () => run(), cursorSecret: "query-secret" });
    const first = await query.get({ runId: "run-1", after: null, limit: 1, depth: 2 });
    store.onRead = () => {
      store.headHash = hash("concurrent-head");
      store.onRead = null;
    };

    await expect(query.get({ runId: "run-1", after: first.nextCursor, limit: 1, depth: 2 }))
      .rejects.toMatchObject({ code: "evolution_cursor_stale" });
  });

  it("discloses quarantine for a suppressed in-scope node when another node remains", async () => {
    const suppressed = node(0);
    const visible = node(1);
    const quarantine = {
      id: hash("quarantine-suppressed"),
      projectId: "project-1",
      targetRecordId: suppressed.id,
      reason: "evidence_missing" as const,
      evidenceRefs: [],
      quarantinedAt: "2026-08-30T00:00:02.000Z",
    };
    const query = new EvolutionQueryService({
      store: new MemoryQueryStore([
        { type: "node", value: suppressed },
        { type: "node", value: visible },
        { type: "quarantine", value: quarantine },
      ]),
      runById: () => run(),
      cursorSecret: "query-secret",
    });

    const first = await query.get({ runId: "run-1", after: null, limit: 1, depth: 4 });
    const second = await query.get({ runId: "run-1", after: first.nextCursor, limit: 1, depth: 4 });
    expect([...first.nodes, ...second.nodes].map((value) => value.id)).toEqual([visible.id]);
    expect([...first.quarantines, ...second.quarantines]).toEqual([quarantine]);
  });

  it("centers traversal on the requested run, accepts depth one through eight, and removes duplicates", async () => {
    const nodes = Array.from({ length: 11 }, (_, index) => node(index, index === 5 ? "run-1" : `foreign-${index}`));
    const records: EvolutionPayload[] = [
      ...nodes.map((value) => ({ type: "node" as const, value })),
      ...nodes.slice(1).map((value, index) => ({ type: "edge" as const, value: edge(nodes[index]!, value) })),
      { type: "node", value: nodes[3]! },
    ];
    const query = new EvolutionQueryService({
      store: new MemoryQueryStore(records),
      runById: () => run(),
      cursorSecret: "query-secret",
    });
    const result = await query.get({ runId: "run-1", after: null, limit: 100, depth: 2 });

    expect(result.nodes.map((value) => value.id)).toEqual(nodes.slice(3, 8).map((value) => value.id));
    expect(new Set(result.nodes.map((value) => value.id)).size).toBe(result.nodes.length);
    await expect(query.get({ runId: "run-1", after: null, limit: 100, depth: 0 }))
      .rejects.toBeInstanceOf(RangeError);
    await expect(query.get({ runId: "run-1", after: null, limit: 100, depth: 8 })).resolves.toBeDefined();
    await expect(query.get({ runId: "run-1", after: null, limit: 100, depth: 9 }))
      .rejects.toBeInstanceOf(RangeError);
  });

  it("returns sanitized branch records without protected fence or mutation hashes", async () => {
    const checkpoint = node(0);
    const weak = node(1);
    const capsule: FailureCapsule = {
      id: hash("capsule"), projectId: "project-1", runId: "run-1", tournamentId: "tournament-1",
      candidateId: weak.entityId, candidateFamily: "context_patch", mutationContentHash: hash("mutation"),
      repairGraphFenceHash: hash("fence"), returnCheckpointId: "checkpoint-1",
      stopReason: "protected_rejection", summary: "Protected verification rejected the continuation.",
      evidenceRefs: [hash("evidence")], createdAt: weak.createdAt,
    };
    const returnFields = {
      projectId: "project-1", runId: "run-1", candidateNodeId: weak.id,
      checkpointNodeId: checkpoint.id, capsuleId: capsule.id, createdAt: weak.createdAt,
    };
    const returned: BranchReturnRecord = {
      id: deterministicEvolutionId("branch-return", { schemaVersion: 1, ...returnFields }),
      ...returnFields,
    };
    const query = new EvolutionQueryService({
      store: new MemoryQueryStore([
        { type: "node", value: checkpoint },
        { type: "node", value: weak },
        { type: "edge", value: { ...edge(checkpoint, weak), kind: "repair_fork" } },
        { type: "capsule", value: capsule },
        { type: "branch_return", value: returned },
        { type: "observation", value: observation(weak, "branch_pruned") },
        { type: "edge", value: { ...edge(weak, checkpoint), kind: "returned_to" } },
      ]),
      runById: () => run(),
      cursorSecret: "query-secret",
    });

    const result = await query.get({ runId: "run-1", after: null, limit: 100, depth: 1 });
    expect(result.capsules).toEqual([{
      id: capsule.id,
      projectId: capsule.projectId,
      runId: capsule.runId,
      tournamentId: capsule.tournamentId,
      candidateId: capsule.candidateId,
      candidateFamily: capsule.candidateFamily,
      returnCheckpointId: capsule.returnCheckpointId,
      stopReason: capsule.stopReason,
      summary: capsule.summary,
      evidenceRefs: capsule.evidenceRefs,
      createdAt: capsule.createdAt,
    }]);
    expect(result.branchReturns).toEqual([returned]);
    expect(result.counts).toMatchObject({ branchPruned: 1, branchReturned: 1 });
    expect(JSON.stringify(result)).not.toContain(capsule.repairGraphFenceHash);
    expect(JSON.stringify(result)).not.toContain(capsule.mutationContentHash);
    expect(JSON.stringify(result)).not.toContain("/private/worktree");
  });

  it("overlays pending run-local truth but withholds promotion before terminal barriers", async () => {
    const candidate = node(1);
    const pendingRecords: EvolutionPayload[] = [
      { type: "node", value: candidate },
      { type: "observation", value: observation(candidate, "declared") },
      { type: "observation", value: observation(candidate, "executed") },
      { type: "observation", value: observation(candidate, "promoted") },
    ];
    const active = run({
      orchestration: {
        phase: "executing",
        iteration: 1,
        iterationPlans: [],
        evaluationRecords: [],
        workerResults: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, workerRuns: 0 },
        policySnapshot: {} as never,
        provenance: {
          harnessVersion: "m3",
          plannerPromptVersion: "p",
          evaluatorPromptVersion: "e",
          replannerPromptVersion: "r",
          synthesizerPromptVersion: "s",
        },
        healing: {
          contracts: [], nodes: [], faults: [{
            id: "fault-1", subtaskId: "task-1", revision: 1, class: "hard_failure",
            reasonCode: "contract_failed", summary: "Backend contract gate failed",
            repairable: true, evidenceRefs: [hash("fault")], affectedConsumers: ["consumer"],
            detectedAt: "2026-08-30T00:00:00.000Z",
          }], snapshots: [], diagnoses: [], candidates: [], tournaments: [], verifications: [],
          budget: {
            advisoryTokens: 1, severeTokens: 2, advisoryModelCalls: 1, severeModelCalls: 2,
            emergencyTokenFuse: 3, emergencyModelCallFuse: 3, usedModelCalls: 1,
            reservedTokens: 1, actualInputTokens: 1, actualOutputTokens: 1,
            estimatedDollars: null, warningLevel: "severe",
            deadlineAt: "2026-08-31T00:00:00.000Z", terminalReason: null,
          },
        },
        evolutionOutbox: [{
          id: hash("outbox"), projectId: "project-1", runId: "run-1", records: pendingRecords,
          state: "pending", createdAt: "2026-08-30T00:00:00.000Z", deliveredAt: null,
          lastErrorCode: null,
        }],
      },
    });
    const query = new EvolutionQueryService({
      store: new MemoryQueryStore([]), runById: () => active, cursorSecret: "query-secret",
    });
    const result = await query.get({ runId: "run-1", after: null, limit: 100, depth: 4 });

    expect(result.syncState).toBe("pending");
    expect(result.primaryFault?.summary).toBe("Backend contract gate failed");
    expect(result.warningLevel).toBe("severe");
    expect(result.counts).toMatchObject({ declared: 1, executed: 1, promoted: 0 });
    expect(result.observations.some((value) => value.kind === "promoted")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("/private/worktree");
  });

  it("uses a typed 400-compatible error for invalid cursors", () => {
    const error = new EvolutionQueryError("evolution_cursor_invalid", "bad cursor");
    expect(error).toMatchObject({ statusCode: 400, code: "evolution_cursor_invalid" });
  });
});
