import { canonicalSerialize } from "./evolution-fingerprints.js";
import {
  emptyEvolutionCounts,
  evolutionCountsFromObservations,
  type EvolutionCounts,
  type EvolutionPayload,
  type FailureCapsule,
  type BranchReturnRecord,
  type LineageEdge,
  type LineageNode,
  type LineageObservation,
} from "./evolution-types.js";

const LIFECYCLE_RANK: Partial<Record<LineageObservation["kind"], number>> = {
  declared: 0,
  admitted: 1,
  executed: 2,
  verifying: 3,
  verified: 4,
  promotion_pending: 5,
  promoted: 6,
  rolled_back: 6,
  pruned_duplicate: 1,
  branch_pruned: 5,
  rejected: 5,
  cancelled: 5,
  restart_cancelled: 5,
};

export class EvolutionProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionProjectionError";
  }
}

export class EvolutionProjector {
  referencedEvidenceHashes(records: readonly EvolutionPayload[]): string[] {
    const references = new Set<string>();
    for (const record of deduplicate(records)) {
      if (record.type === "node" || record.type === "cue" || record.type === "transfer" ||
        record.type === "capsule" ||
        record.type === "quarantine") {
        for (const hash of record.value.evidenceRefs) references.add(hash);
      }
    }
    return [...references].sort();
  }

  project(records: readonly EvolutionPayload[], runId?: string): {
    nodes: LineageNode[];
    edges: LineageEdge[];
    observations: LineageObservation[];
    capsules: FailureCapsule[];
    branchReturns: BranchReturnRecord[];
    counts: EvolutionCounts;
  } {
    const unique = deduplicate(records);
    const allNodes = unique.filter((record): record is Extract<EvolutionPayload, { type: "node" }> =>
      record.type === "node").map((record) => record.value);
    const allEdges = unique.filter((record): record is Extract<EvolutionPayload, { type: "edge" }> =>
      record.type === "edge").map((record) => record.value);
    const allObservations = unique.filter((record): record is Extract<EvolutionPayload, { type: "observation" }> =>
      record.type === "observation").map((record) => record.value);
    const allCapsules = unique.filter((record): record is Extract<EvolutionPayload, { type: "capsule" }> =>
      record.type === "capsule").map((record) => record.value);
    const allBranchReturns = unique.filter((record): record is Extract<EvolutionPayload, { type: "branch_return" }> =>
      record.type === "branch_return").map((record) => record.value);
    validateGraph(allNodes, allEdges, allObservations, allCapsules, allBranchReturns);

    const selectedNodes = runId === undefined ? allNodes : allNodes.filter((node) => node.runId === runId);
    const selectedIds = new Set(selectedNodes.map((node) => node.id));
    const edges = allEdges.filter((edge) => selectedIds.has(edge.fromNodeId) && selectedIds.has(edge.toNodeId));
    const observations = allObservations
      .filter((observation) => selectedIds.has(observation.nodeId))
      .sort(compareObservation);
    const nodes = topologicalOrder(selectedNodes, structuralEdges(edges));
    const capsules = allCapsules
      .filter((capsule) => runId === undefined || capsule.runId === runId)
      .sort(compareCapsule);
    const capsuleIds = new Set(capsules.map((capsule) => capsule.id));
    const branchReturns = allBranchReturns
      .filter((record) => capsuleIds.has(record.capsuleId) && selectedIds.has(record.candidateNodeId) &&
        selectedIds.has(record.checkpointNodeId))
      .sort(compareBranchReturn);
    return {
      nodes,
      edges: edges.slice().sort(compareEdge),
      observations,
      capsules,
      branchReturns,
      counts: observations.length === 0 && branchReturns.length === 0
        ? emptyEvolutionCounts()
        : evolutionCountsFromObservations(observations, 0, branchReturns.length),
    };
  }
}

function deduplicate(records: readonly EvolutionPayload[]): EvolutionPayload[] {
  const byId = new Map<string, { serialized: string; payload: EvolutionPayload }>();
  for (const payload of records) {
    const id = payload.value.id;
    const serialized = canonicalSerialize(payload);
    const existing = byId.get(id);
    if (existing !== undefined && existing.serialized !== serialized) {
      throw new EvolutionProjectionError(`Unequal duplicate evolution ID: ${id}`);
    }
    if (existing === undefined) byId.set(id, { serialized, payload });
  }
  return [...byId.values()].map((value) => value.payload);
}

function validateGraph(
  nodes: readonly LineageNode[],
  edges: readonly LineageEdge[],
  observations: readonly LineageObservation[],
  capsules: readonly FailureCapsule[],
  branchReturns: readonly BranchReturnRecord[],
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new EvolutionProjectionError("Duplicate lineage node ID");
  for (const edge of edges) {
    if (!byId.has(edge.fromNodeId) || !byId.has(edge.toNodeId)) {
      throw new EvolutionProjectionError(`Dangling lineage edge: ${edge.id}`);
    }
    if (byId.get(edge.fromNodeId)!.projectId !== edge.projectId ||
      byId.get(edge.toNodeId)!.projectId !== edge.projectId) {
      throw new EvolutionProjectionError(`Cross-Project lineage edge: ${edge.id}`);
    }
  }
  topologicalOrder(nodes, structuralEdges(edges));

  const observationsByNode = new Map<string, LineageObservation[]>();
  for (const observation of observations) {
    if (!byId.has(observation.nodeId)) {
      throw new EvolutionProjectionError(`Observation targets a missing node: ${observation.id}`);
    }
    if (byId.get(observation.nodeId)!.projectId !== observation.projectId) {
      throw new EvolutionProjectionError(`Observation Project mismatch: ${observation.id}`);
    }
    const values = observationsByNode.get(observation.nodeId) ?? [];
    values.push(observation);
    observationsByNode.set(observation.nodeId, values);
  }

  const capsuleById = new Map(capsules.map((capsule) => [capsule.id, capsule]));
  for (const returned of branchReturns) {
    const capsule = capsuleById.get(returned.capsuleId);
    const candidate = byId.get(returned.candidateNodeId);
    const checkpoint = byId.get(returned.checkpointNodeId);
    if (capsule === undefined || candidate?.kind !== "candidate" || checkpoint?.kind !== "attempt" ||
      capsule.projectId !== returned.projectId || capsule.runId !== returned.runId ||
      candidate.projectId !== returned.projectId || checkpoint.projectId !== returned.projectId ||
      candidate.runId !== returned.runId || checkpoint.runId !== returned.runId) {
      throw new EvolutionProjectionError(`Branch return ownership mismatch: ${returned.id}`);
    }
    const matchingEdges = edges.filter((edge) => edge.kind === "returned_to" &&
      edge.projectId === returned.projectId && edge.fromNodeId === returned.candidateNodeId &&
      edge.toNodeId === returned.checkpointNodeId);
    const matchingObservations = observations.filter((observation) =>
      observation.kind === "branch_pruned" && observation.projectId === returned.projectId &&
      observation.runId === returned.runId && observation.nodeId === returned.candidateNodeId &&
      observation.terminalReason === capsule.stopReason);
    if (matchingEdges.length !== 1 || matchingObservations.length !== 1) {
      throw new EvolutionProjectionError(`Branch return proof is incomplete: ${returned.id}`);
    }
  }
  for (const edge of edges.filter((value) => value.kind === "returned_to")) {
    if (!branchReturns.some((record) => record.projectId === edge.projectId &&
      record.candidateNodeId === edge.fromNodeId && record.checkpointNodeId === edge.toNodeId)) {
      throw new EvolutionProjectionError(`Returned-to edge lacks a branch return record: ${edge.id}`);
    }
  }
  for (const [nodeId, values] of observationsByNode) {
    const node = byId.get(nodeId)!;
    if (node.kind !== "candidate") continue;
    validateLifecycle(values.slice().sort(compareObservation));
  }

  for (const promotion of nodes.filter((node) => node.kind === "promotion")) {
    const incoming = edges.find((edge) => edge.toNodeId === promotion.id && edge.kind === "promoted_as");
    const integration = incoming === undefined ? undefined : byId.get(incoming.fromNodeId);
    if (!integration || integration.kind !== "integration" || integration.verificationIds.length === 0) {
      throw new EvolutionProjectionError("Promotion requires verified integration");
    }
    const candidateEdge = edges.find((edge) => edge.toNodeId === integration.id && edge.kind === "integrated_as");
    const candidateObservations = candidateEdge === undefined
      ? []
      : observationsByNode.get(candidateEdge.fromNodeId) ?? [];
    if (!candidateObservations.some((observation) => observation.kind === "verified") ||
      !candidateObservations.some((observation) => observation.kind === "promoted")) {
      throw new EvolutionProjectionError("Promotion requires verified candidate integration state");
    }
  }
}

function validateLifecycle(observations: readonly LineageObservation[]): void {
  let rank = -1;
  let rolledBack = false;
  let promoted = false;
  for (const observation of observations) {
    const next = LIFECYCLE_RANK[observation.kind];
    if (next === undefined) continue;
    if (next < rank) throw new EvolutionProjectionError("Candidate lifecycle is decreasing");
    if (observation.kind === "rolled_back") rolledBack = true;
    if (observation.kind === "promoted") promoted = true;
    if (rolledBack && promoted) {
      throw new EvolutionProjectionError("Candidate rollback cannot be followed by promotion");
    }
    rank = next;
  }
}

function topologicalOrder(nodes: readonly LineageNode[], edges: readonly LineageEdge[]): LineageNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!byId.has(edge.fromNodeId) || !byId.has(edge.toNodeId)) continue;
    incoming.set(edge.toNodeId, (incoming.get(edge.toNodeId) ?? 0) + 1);
    outgoing.get(edge.fromNodeId)!.push(edge.toNodeId);
  }
  const ready = nodes.filter((node) => incoming.get(node.id) === 0).sort(compareNode);
  const ordered: LineageNode[] = [];
  while (ready.length > 0) {
    const node = ready.shift()!;
    ordered.push(node);
    for (const target of outgoing.get(node.id) ?? []) {
      const remaining = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, remaining);
      if (remaining === 0) {
        ready.push(byId.get(target)!);
        ready.sort(compareNode);
      }
    }
  }
  if (ordered.length !== nodes.length) throw new EvolutionProjectionError("Lineage graph contains a cycle");
  return ordered;
}

function structuralEdges(edges: readonly LineageEdge[]): LineageEdge[] {
  return edges.filter((edge) => edge.kind !== "returned_to");
}

function compareNode(left: LineageNode, right: LineageNode): number {
  return left.createdAt.localeCompare(right.createdAt) ||
    left.revision - right.revision ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id);
}

function compareEdge(left: LineageEdge, right: LineageEdge): number {
  return left.createdAt.localeCompare(right.createdAt) ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id);
}

function compareObservation(left: LineageObservation, right: LineageObservation): number {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

function compareCapsule(left: FailureCapsule, right: FailureCapsule): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareBranchReturn(left: BranchReturnRecord, right: BranchReturnRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
