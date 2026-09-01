import { describe, expect, it } from "vitest";
import { canonicalHash } from "../src/orchestration/evolution/evolution-fingerprints.js";
import { EvolutionProjector, EvolutionProjectionError } from "../src/orchestration/evolution/evolution-projector.js";
import type {
  BranchReturnRecord,
  EvolutionPayload,
  FailureCapsule,
  LineageEdge,
  LineageNode,
  LineageObservation,
} from "../src/orchestration/evolution/evolution-types.js";

const hash = (value: string) => canonicalHash({ value });

function lineageNode(kind: LineageNode["kind"], id = kind): LineageNode {
  return {
    id: hash("node-" + id),
    projectId: "project-1",
    sourceFingerprint: hash("source"),
    runId: "run-1",
    subtaskId: "backend",
    kind,
    entityId: id,
    revision: 1,
    harnessVersionHash: hash("harness"),
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    faultId: null,
    fingerprints: null,
    verificationIds: kind === "integration" ? ["verification-post"] : [],
    evidenceRefs: [],
    changedPaths: [],
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

function edge(from: LineageNode, to: LineageNode, kind: LineageEdge["kind"]): LineageEdge {
  return {
    id: hash(`${from.id}:${kind}:${to.id}`),
    projectId: "project-1",
    fromNodeId: from.id,
    toNodeId: to.id,
    kind,
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

function observation(node: LineageNode, kind: LineageObservation["kind"], second: number): LineageObservation {
  return {
    id: hash(`${node.id}:${kind}`),
    projectId: "project-1",
    runId: "run-1",
    nodeId: node.id,
    kind,
    candidateState: kind === "pruned_duplicate" ? "pruned_duplicate" : kind === "executed" ? "running" : kind as LineageObservation["candidateState"],
    terminalReason: kind === "branch_pruned" ? "protected_rejection" : null,
    modelCalls: 0,
    reservedTokens: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    elapsedMs: 0,
    occurredAt: `2026-08-30T00:00:${String(second).padStart(2, "0")}.000Z`,
  };
}

describe("EvolutionProjector", () => {
  it("projects one authorized weak continuation return without changing its successful sibling", () => {
    const checkpoint = lineageNode("attempt", "checkpoint");
    const weak = lineageNode("candidate", "weak");
    const successful = lineageNode("candidate", "successful");
    const capsule: FailureCapsule = {
      id: hash("capsule"), projectId: "project-1", runId: "run-1", tournamentId: "tournament-1",
      candidateId: "weak", candidateFamily: "context_patch", mutationContentHash: hash("mutation"),
      repairGraphFenceHash: hash("fence"), returnCheckpointId: "checkpoint-1",
      stopReason: "protected_rejection", summary: "Protected verification rejected the continuation.",
      evidenceRefs: [hash("evidence")], createdAt: "2026-08-30T00:00:03.000Z",
    };
    const returned: BranchReturnRecord = {
      id: hash("return"), projectId: "project-1", runId: "run-1", candidateNodeId: weak.id,
      checkpointNodeId: checkpoint.id, capsuleId: capsule.id, createdAt: capsule.createdAt,
    };
    const records: EvolutionPayload[] = [
      { type: "node", value: checkpoint },
      { type: "node", value: weak },
      { type: "node", value: successful },
      { type: "edge", value: edge(checkpoint, weak, "repair_fork") },
      { type: "edge", value: edge(checkpoint, successful, "repair_fork") },
      { type: "observation", value: observation(weak, "declared", 1) },
      { type: "observation", value: observation(weak, "branch_pruned", 3) },
      { type: "observation", value: observation(successful, "declared", 1) },
      { type: "observation", value: observation(successful, "verified", 3) },
      { type: "capsule", value: capsule },
      { type: "branch_return", value: returned },
      { type: "edge", value: edge(weak, checkpoint, "returned_to") },
    ];

    const projected = new EvolutionProjector().project(records);
    expect(projected.capsules).toEqual([capsule]);
    expect(projected.branchReturns).toEqual([returned]);
    expect(projected.counts).toMatchObject({ branchPruned: 1, branchReturned: 1 });
    expect(projected.observations.filter((value) => value.kind === "branch_pruned")).toHaveLength(1);
    expect(projected.edges.filter((value) => value.kind === "returned_to")).toHaveLength(1);
    expect(projected.observations.filter((value) => value.nodeId === successful.id).map((value) => value.kind))
      .toEqual(["declared", "verified"]);
  });

  it("keeps declaration, admission, execution, verification, pruning, and promotion counts distinct", () => {
    const candidate = lineageNode("candidate");
    const pruned = lineageNode("candidate", "pruned");
    const records: EvolutionPayload[] = [
      { type: "node", value: candidate },
      { type: "node", value: pruned },
      { type: "observation", value: observation(candidate, "declared", 1) },
      { type: "observation", value: observation(candidate, "admitted", 2) },
      { type: "observation", value: observation(candidate, "executed", 3) },
      { type: "observation", value: observation(candidate, "verified", 4) },
      { type: "observation", value: observation(pruned, "declared", 1) },
      { type: "observation", value: observation(pruned, "pruned_duplicate", 2) },
    ];
    const projected = new EvolutionProjector().project(records);
    expect(projected.counts).toMatchObject({
      declared: 2,
      prunedDuplicate: 1,
      admitted: 1,
      executed: 1,
      verified: 1,
      promoted: 0,
    });
  });

  it("rejects unequal duplicate IDs, dangling edges, decreasing lifecycle, and cycles", () => {
    const candidate = lineageNode("candidate");
    const unequal = { ...candidate, entityId: "different" };
    expect(() => new EvolutionProjector().project([
      { type: "node", value: candidate },
      { type: "node", value: unequal },
    ])).toThrow(/duplicate/i);
    const missing = lineageNode("attempt", "missing");
    expect(() => new EvolutionProjector().project([
      { type: "node", value: candidate },
      { type: "edge", value: edge(candidate, missing, "repair_fork") },
    ])).toThrow(/dangling/i);
    expect(() => new EvolutionProjector().project([
      { type: "node", value: candidate },
      { type: "observation", value: observation(candidate, "verified", 1) },
      { type: "observation", value: observation(candidate, "admitted", 2) },
    ])).toThrow(/decreasing/i);
    const attempt = lineageNode("attempt");
    expect(() => new EvolutionProjector().project([
      { type: "node", value: candidate }, { type: "node", value: attempt },
      { type: "edge", value: edge(candidate, attempt, "repair_fork") },
      { type: "edge", value: edge(attempt, candidate, "repair_fork") },
    ])).toThrow(/cycle/i);
  });

  it("requires verified integration before promotion and rejects promotion after rollback", () => {
    const candidate = lineageNode("candidate");
    const integration = { ...lineageNode("integration"), verificationIds: [] };
    const promotion = lineageNode("promotion");
    const graph: EvolutionPayload[] = [
      { type: "node", value: candidate }, { type: "node", value: integration }, { type: "node", value: promotion },
      { type: "edge", value: edge(candidate, integration, "integrated_as") },
      { type: "edge", value: edge(integration, promotion, "promoted_as") },
      { type: "observation", value: observation(candidate, "declared", 1) },
      { type: "observation", value: observation(candidate, "verified", 2) },
      { type: "observation", value: observation(candidate, "promoted", 3) },
    ];
    expect(() => new EvolutionProjector().project(graph)).toThrow(/verified integration/i);
    const verifiedIntegration = { ...integration, verificationIds: ["verification-post"] };
    expect(() => new EvolutionProjector().project(graph
      .filter((record) => !(record.type === "observation" && record.value.kind === "verified"))
      .map((record) => record.type === "node" && record.value.kind === "integration"
        ? { type: "node" as const, value: verifiedIntegration }
        : record)))
      .toThrow(/verified candidate/i);
    expect(() => new EvolutionProjector().project([
      ...graph.map((record) => record.type === "node" && record.value.kind === "integration"
        ? { type: "node" as const, value: verifiedIntegration }
        : record),
      { type: "observation", value: observation(candidate, "rolled_back", 2) },
    ])).toThrow(/rollback.*promot/i);
  });
});
