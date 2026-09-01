import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentRun, FaultRecord } from "../../types.js";
import { canonicalHash, canonicalSerialize } from "./evolution-fingerprints.js";
import type { EvolutionHead, EvolutionStoreHealth } from "./evolution-store.js";
import {
  emptyEvolutionCounts,
  evolutionCountsFromObservations,
  sanitizeEvolutionProjection,
  type EvolutionPayload,
  type EvolutionProjection,
  type FailureCapsule,
  type BranchReturnRecord,
  type FailureCue,
  type LineageEdge,
  type LineageNode,
  type LineageObservation,
  type QuarantineRecord,
  type TransferObservation,
} from "./evolution-types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_DEPTH = 8;

export interface EvolutionQueryInput {
  runId: string;
  after: string | null;
  limit: number;
  depth: number;
}

export interface EvolutionQueryStore {
  head(projectId: string): Promise<EvolutionHead>;
  read(input: {
    projectId: string;
    afterSequence: number;
    limit: number;
  }): Promise<{
    records: EvolutionPayload[];
    nextSequence: number | null;
    health: EvolutionStoreHealth;
  }>;
}

type EvolutionCursorCode =
  | "evolution_cursor_invalid"
  | "evolution_cursor_foreign"
  | "evolution_cursor_stale";

export class EvolutionQueryError extends Error {
  readonly statusCode = 400;

  constructor(readonly code: EvolutionCursorCode, message: string) {
    super(message);
    this.name = "EvolutionQueryError";
  }
}

interface CursorPayload {
  readonly version: 1;
  readonly projectId: string;
  readonly runId: string;
  readonly offset: number;
  readonly depth: number;
  readonly limit: number;
  readonly headSequence: number;
  readonly headHash: string | null;
  readonly overlayHash: string;
}

export class EvolutionQueryService {
  readonly #store: EvolutionQueryStore;
  readonly #runById: (runId: string) => AgentRun;
  readonly #cursorSecret: Buffer;

  constructor(options: {
    store: EvolutionQueryStore;
    runById: (runId: string) => AgentRun;
    cursorSecret: string | Buffer;
  }) {
    this.#store = options.store;
    this.#runById = options.runById;
    this.#cursorSecret = Buffer.isBuffer(options.cursorSecret)
      ? Buffer.from(options.cursorSecret)
      : Buffer.from(options.cursorSecret, "utf8");
    if (this.#cursorSecret.length === 0) throw new Error("Evolution cursor secret must not be empty");
  }

  async get(input: EvolutionQueryInput): Promise<EvolutionProjection> {
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new RangeError(`Evolution query limit must be between 1 and ${MAX_LIMIT}`);
    }
    if (!Number.isSafeInteger(input.depth) || input.depth < 1 || input.depth > MAX_DEPTH) {
      throw new RangeError(`Evolution query depth must be between 1 and ${MAX_DEPTH}`);
    }
    const run = this.#runById(input.runId);
    const projectId = run.projectId;
    if (projectId === null || run.project === undefined || run.project.source.mode === "ephemeral_research") {
      return unavailableProjection(run);
    }
    const overlay = uniquePayloads(pendingRunRecords(run));
    const overlayHash = canonicalHash(overlay);

    let cursor: CursorPayload | null = null;
    let head: EvolutionHead;
    try {
      head = await this.#store.head(projectId);
      if (input.after !== null) {
        cursor = this.#decodeCursor(input.after);
        if (
          cursor.projectId !== projectId ||
          cursor.runId !== input.runId ||
          cursor.depth !== input.depth ||
          cursor.limit !== limit ||
          cursor.overlayHash !== overlayHash
        ) {
          throw new EvolutionQueryError("evolution_cursor_foreign", "Evolution cursor does not belong to this query");
        }
        if (cursor.headSequence !== head.sequence || cursor.headHash !== head.segmentHash) {
          throw new EvolutionQueryError("evolution_cursor_stale", "Evolution history changed after this cursor was issued");
        }
      }
    } catch (error) {
      if (error instanceof EvolutionQueryError) throw error;
      return unavailableProjection(run);
    }

    try {
      const history = await this.#readSnapshot(projectId, head);
      const currentOverlayHash = canonicalHash(uniquePayloads(pendingRunRecords(this.#runById(input.runId))));
      if (currentOverlayHash !== overlayHash) {
        throw new EvolutionQueryError("evolution_cursor_stale", "Evolution run overlay changed during this query");
      }
      const projection = projectRunRecords(uniquePayloads([...overlay, ...history]), run, input.depth);
      const projectedRecords = projectionPayloads(projection);
      const offset = cursor?.offset ?? 0;
      if (offset > projectedRecords.length) {
        throw new EvolutionQueryError("evolution_cursor_stale", "Evolution projection changed after this cursor was issued");
      }
      const pageRecords = projectedRecords.slice(offset, offset + limit);
      const pageProjection = projectionPage(projection, pageRecords);
      const publicPageProjection = {
        ...pageProjection,
        capsules: pageProjection.capsules.map((capsule) => {
          const { mutationContentHash: _mutationContentHash, repairGraphFenceHash: _fenceHash, ...sanitized } = capsule;
          return sanitized;
        }),
      };
      const nextOffset = offset + pageRecords.length;
      const nextCursor = nextOffset >= projectedRecords.length
        ? null
        : this.#encodeCursor({
            version: 1,
            projectId,
            runId: input.runId,
            offset: nextOffset,
            depth: input.depth,
            limit,
            headSequence: head.sequence,
            headHash: head.segmentHash,
            overlayHash,
          });
      return sanitizeEvolutionProjection({
        ...publicPageProjection,
        syncState: run.orchestration?.evolutionHistory?.state === "unavailable"
          ? "unavailable"
          : run.orchestration?.evolutionOutbox.some((entry) => entry.state === "pending")
          ? "pending"
          : projection.quarantines.length > 0
            ? "quarantined"
            : "synced",
        historyHealth: publicHistoryHealth(run),
        primaryFault: primaryFault(run.orchestration?.healing.faults ?? []),
        warningLevel: run.orchestration?.healing.budget?.warningLevel ?? null,
        terminalReason: run.orchestration?.healing.budget?.terminalReason ?? run.error,
        runBranch: run.project.runBranch,
        baseCommit: run.project.source.baseCommit,
        headCommit: run.project.headCommit,
        nextCursor,
      });
    } catch (error) {
      if (error instanceof EvolutionQueryError) throw error;
      return unavailableProjection(run);
    }
  }

  async #readSnapshot(projectId: string, expectedHead: EvolutionHead): Promise<EvolutionPayload[]> {
    const records: EvolutionPayload[] = [];
    let afterSequence = 0;
    while (afterSequence < expectedHead.sequence) {
      const page = await this.#store.read({
        projectId,
        afterSequence,
        limit: MAX_LIMIT,
      });
      if (page.health.state !== "ready") throw new Error("Evolution history is unavailable");
      this.#assertSnapshotHead(expectedHead, {
        sequence: page.health.validThroughSequence,
        segmentHash: page.health.headSegmentHash,
      });
      records.push(...page.records);
      if (page.nextSequence === null) break;
      if (page.nextSequence <= afterSequence || page.nextSequence > expectedHead.sequence) {
        throw new Error("Evolution history pagination did not advance within the snapshot");
      }
      afterSequence = page.nextSequence;
    }
    if (records.length !== expectedHead.sequence) {
      throw new Error("Evolution history snapshot is incomplete");
    }
    const readHead = await this.#store.head(projectId);
    this.#assertSnapshotHead(expectedHead, readHead);
    return records;
  }

  #assertSnapshotHead(
    expected: Pick<EvolutionHead, "sequence" | "segmentHash">,
    actual: Pick<EvolutionHead, "sequence" | "segmentHash">,
  ): void {
    if (actual.sequence !== expected.sequence || actual.segmentHash !== expected.segmentHash) {
      throw new EvolutionQueryError("evolution_cursor_stale", "Evolution history changed during this query");
    }
  }

  #encodeCursor(value: CursorPayload): string {
    const payload = Buffer.from(canonicalSerialize(value), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#cursorSecret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  #decodeCursor(value: string): CursorPayload {
    const parts = value.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new EvolutionQueryError("evolution_cursor_invalid", "Evolution cursor is malformed");
    }
    const expected = createHmac("sha256", this.#cursorSecret).update(parts[0]).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(parts[1], "base64url");
    } catch {
      throw new EvolutionQueryError("evolution_cursor_invalid", "Evolution cursor signature is malformed");
    }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new EvolutionQueryError("evolution_cursor_invalid", "Evolution cursor signature is invalid");
    }
    try {
      const parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Partial<CursorPayload>;
      if (
        parsed.version !== 1 ||
        typeof parsed.projectId !== "string" ||
        typeof parsed.runId !== "string" ||
        !Number.isSafeInteger(parsed.offset) ||
        (parsed.offset ?? -1) < 0 ||
        !Number.isSafeInteger(parsed.depth) ||
        !Number.isSafeInteger(parsed.limit) ||
        !Number.isSafeInteger(parsed.headSequence) ||
        (parsed.headSequence ?? -1) < 0 ||
        !(parsed.headHash === null || typeof parsed.headHash === "string") ||
        typeof parsed.overlayHash !== "string"
      ) throw new Error("invalid cursor shape");
      return parsed as CursorPayload;
    } catch {
      throw new EvolutionQueryError("evolution_cursor_invalid", "Evolution cursor payload is invalid");
    }
  }
}

function pendingRunRecords(run: AgentRun): EvolutionPayload[] {
  return run.orchestration?.evolutionOutbox
    .filter((entry) => entry.state === "pending" && entry.projectId === run.projectId && entry.runId === run.id)
    .flatMap((entry) => entry.records) ?? [];
}

function uniquePayloads(records: readonly EvolutionPayload[]): EvolutionPayload[] {
  const byId = new Map<string, { serialized: string; payload: EvolutionPayload }>();
  for (const payload of records) {
    const id = payload.value.id;
    const serialized = canonicalSerialize(payload);
    const existing = byId.get(id);
    if (existing !== undefined && existing.serialized !== serialized) {
      throw new Error(`Unequal duplicate evolution ID: ${id}`);
    }
    if (existing === undefined) byId.set(id, { serialized, payload });
  }
  return [...byId.values()].map((value) => value.payload);
}

function projectRunRecords(
  input: readonly EvolutionPayload[],
  run: AgentRun,
  depth: number,
): ProjectedRunRecords {
  const quarantines = input
    .filter((payload): payload is Extract<EvolutionPayload, { type: "quarantine" }> => payload.type === "quarantine")
    .map((payload) => payload.value)
    .sort(compareQuarantine);
  const quarantinedIds = new Set(quarantines.map((record) => record.targetRecordId));
  const scopeNodes = input
    .filter((payload): payload is Extract<EvolutionPayload, { type: "node" }> => payload.type === "node")
    .map((payload) => payload.value)
    .filter((node) => terminalBarrierClosed(run) || node.kind !== "promotion");
  const scopeNodeById = new Map(scopeNodes.map((node) => [node.id, node]));
  const scopeEdges = input
    .filter((payload): payload is Extract<EvolutionPayload, { type: "edge" }> => payload.type === "edge")
    .map((payload) => payload.value)
    .filter((edge) => scopeNodeById.has(edge.fromNodeId) && scopeNodeById.has(edge.toNodeId));
  const scopeIds = traversedNodeIds(scopeNodes, scopeEdges, run.id, depth);
  const records = input.filter((payload) =>
    payload.type === "quarantine" || !quarantinedIds.has(payload.value.id));
  const allNodes = records
    .filter((payload): payload is Extract<EvolutionPayload, { type: "node" }> => payload.type === "node")
    .map((payload) => payload.value)
    .filter((node) => terminalBarrierClosed(run) || node.kind !== "promotion");
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const allEdges = records
    .filter((payload): payload is Extract<EvolutionPayload, { type: "edge" }> => payload.type === "edge")
    .map((payload) => payload.value)
    .filter((edge) => nodeById.has(edge.fromNodeId) && nodeById.has(edge.toNodeId));
  const selectedIds = traversedNodeIds(allNodes, allEdges, run.id, depth);
  const nodes = allNodes.filter((node) => selectedIds.has(node.id)).sort(compareNode);
  const edges = allEdges
    .filter((edge) => selectedIds.has(edge.fromNodeId) && selectedIds.has(edge.toNodeId))
    .sort(compareEdge);
  const observations = records
    .filter((payload): payload is Extract<EvolutionPayload, { type: "observation" }> =>
      payload.type === "observation")
    .map((payload) => payload.value)
    .filter((value) => selectedIds.has(value.nodeId) && (terminalBarrierClosed(run) || value.kind !== "promoted"))
    .sort(compareObservation);
  const selectedCandidateKeys = new Set(nodes.filter((node) => node.kind === "candidate")
    .map(logicalCandidateKey));
  const allNodeById = new Map(scopeNodes.map((node) => [node.id, node]));
  const countObservations = input
    .filter((payload): payload is Extract<EvolutionPayload, { type: "observation" }> =>
      payload.type === "observation")
    .map((payload) => payload.value)
    .filter((value) => {
      if (!terminalBarrierClosed(run) && value.kind === "promoted") return false;
      if (selectedIds.has(value.nodeId)) return true;
      const node = allNodeById.get(value.nodeId);
      return node?.kind === "candidate" && selectedCandidateKeys.has(logicalCandidateKey(node));
    });
  const cues = records
    .filter((payload): payload is Extract<EvolutionPayload, { type: "cue" }> => payload.type === "cue")
    .map((payload) => payload.value)
    .filter((cue) => selectedIds.has(cue.sourceCandidateNodeId))
    .sort(compareCue);
  const cueIds = new Set(cues.map((cue) => cue.id));
  const transfers = records
    .filter((payload): payload is Extract<EvolutionPayload, { type: "transfer" }> => payload.type === "transfer")
    .map((payload) => payload.value)
    .filter((transfer) => selectedIds.has(transfer.targetCandidateNodeId) || cueIds.has(transfer.cueId))
    .sort(compareTransfer);
  const capsules = records
    .filter((payload): payload is Extract<EvolutionPayload, { type: "capsule" }> => payload.type === "capsule")
    .map((payload) => payload.value)
    .filter((capsule) => capsule.runId === run.id)
    .sort(compareCapsule);
  const capsuleIds = new Set(capsules.map((capsule) => capsule.id));
  const branchReturns = records
    .filter((payload): payload is Extract<EvolutionPayload, { type: "branch_return" }> =>
      payload.type === "branch_return")
    .map((payload) => payload.value)
    .filter((record) => record.runId === run.id && capsuleIds.has(record.capsuleId) &&
      selectedIds.has(record.candidateNodeId) && selectedIds.has(record.checkpointNodeId))
    .sort(compareBranchReturn);
  const visibleQuarantines = quarantines.filter((record) =>
    scopeIds.has(record.targetRecordId) || cueIds.has(record.targetRecordId) || scopeIds.size === 0);
  const historicalEvidenceUsed = run.orchestration?.healing.candidates.filter((candidate) =>
    candidate.historicalVerificationId !== null).length ?? 0;
  return {
    counts: evolutionCountsFromObservations(countObservations, historicalEvidenceUsed, branchReturns.length),
    nodes,
    edges,
    observations,
    cues,
    transfers,
    capsules,
    branchReturns,
    quarantines: visibleQuarantines,
  };
}

interface ProjectedRunRecords {
  counts: EvolutionProjection["counts"];
  nodes: LineageNode[];
  edges: LineageEdge[];
  observations: LineageObservation[];
  cues: FailureCue[];
  transfers: TransferObservation[];
  capsules: FailureCapsule[];
  branchReturns: BranchReturnRecord[];
  quarantines: QuarantineRecord[];
}

function projectionPayloads(projection: ProjectedRunRecords): EvolutionPayload[] {
  return [
    ...projection.quarantines.map((value) => ({ type: "quarantine" as const, value })),
    ...projection.nodes.map((value) => ({ type: "node" as const, value })),
    ...projection.edges.map((value) => ({ type: "edge" as const, value })),
    ...projection.observations.map((value) => ({ type: "observation" as const, value })),
    ...projection.cues.map((value) => ({ type: "cue" as const, value })),
    ...projection.transfers.map((value) => ({ type: "transfer" as const, value })),
    ...projection.capsules.map((value) => ({ type: "capsule" as const, value })),
    ...projection.branchReturns.map((value) => ({ type: "branch_return" as const, value })),
  ];
}

function projectionPage(
  full: ProjectedRunRecords,
  records: readonly EvolutionPayload[],
): ProjectedRunRecords {
  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];
  const observations: LineageObservation[] = [];
  const cues: FailureCue[] = [];
  const transfers: TransferObservation[] = [];
  const capsules: FailureCapsule[] = [];
  const branchReturns: BranchReturnRecord[] = [];
  const quarantines: QuarantineRecord[] = [];
  for (const record of records) {
    switch (record.type) {
      case "node": nodes.push(record.value); break;
      case "edge": edges.push(record.value); break;
      case "observation": observations.push(record.value); break;
      case "cue": cues.push(record.value); break;
      case "transfer": transfers.push(record.value); break;
      case "capsule": capsules.push(record.value); break;
      case "branch_return": branchReturns.push(record.value); break;
      case "quarantine": quarantines.push(record.value); break;
    }
  }
  return {
    counts: full.counts,
    nodes,
    edges,
    observations,
    cues,
    transfers,
    capsules,
    branchReturns,
    quarantines,
  };
}

function logicalCandidateKey(node: LineageNode): string {
  return `${node.projectId}\0${node.runId}\0${node.entityId}`;
}

function traversedNodeIds(
  nodes: readonly LineageNode[],
  edges: readonly LineageEdge[],
  runId: string,
  maximumDepth: number,
): Set<string> {
  const selected = new Set(nodes.filter((node) => node.runId === runId).map((node) => node.id));
  const frontier = [...selected];
  const distance = new Map(frontier.map((id) => [id, 0]));
  while (frontier.length > 0) {
    const id = frontier.shift()!;
    const currentDepth = distance.get(id)!;
    if (currentDepth >= maximumDepth) continue;
    for (const edge of edges) {
      const next = edge.fromNodeId === id
        ? edge.toNodeId
        : edge.toNodeId === id
          ? edge.fromNodeId
          : null;
      if (next === null || distance.has(next)) continue;
      distance.set(next, currentDepth + 1);
      selected.add(next);
      frontier.push(next);
    }
  }
  return selected;
}

function terminalBarrierClosed(run: AgentRun): boolean {
  return run.status === "completed" && run.project?.state === "completed" &&
    (run.orchestration?.healing.verifications.some((verification) =>
      verification.stage === "post_integration" && verification.mandatoryPassed) ?? false);
}

function primaryFault(faults: readonly FaultRecord[]): EvolutionProjection["primaryFault"] {
  const first = faults.slice().sort((left, right) =>
    left.detectedAt.localeCompare(right.detectedAt) || left.id.localeCompare(right.id))[0];
  return first === undefined ? null : {
    class: first.class,
    summary: first.summary,
    evidenceRefs: [...new Set(first.evidenceRefs)]
      .filter((value) => /^[0-9a-f]{64}$/u.test(value))
      .sort(),
  };
}

function unavailableProjection(run: AgentRun): EvolutionProjection {
  return sanitizeEvolutionProjection({
    syncState: "unavailable",
    historyHealth: publicHistoryHealth(run),
    primaryFault: primaryFault(run.orchestration?.healing.faults ?? []),
    warningLevel: run.orchestration?.healing.budget?.warningLevel ?? null,
    terminalReason: run.orchestration?.healing.budget?.terminalReason ?? run.error,
    runBranch: run.project?.runBranch ?? null,
    baseCommit: run.project?.source.baseCommit ?? null,
    headCommit: run.project?.headCommit ?? null,
    counts: emptyEvolutionCounts(),
    nodes: [], edges: [], observations: [], cues: [], transfers: [], capsules: [], branchReturns: [], quarantines: [],
    nextCursor: null,
  });
}

function publicHistoryHealth(run: AgentRun): EvolutionProjection["historyHealth"] {
  const value = run.orchestration?.evolutionHistory;
  return {
    droppedHistoryCount: value?.droppedHistoryCount ?? 0,
    droppedReason: value?.droppedReason ?? null,
    reconciliationPending: value?.reconciliationPending ??
      (run.orchestration?.evolutionOutbox.some((entry) => entry.state === "pending") ?? false),
  };
}

function compareNode(left: LineageNode, right: LineageNode): number {
  return left.createdAt.localeCompare(right.createdAt) || left.revision - right.revision || left.id.localeCompare(right.id);
}
function compareEdge(left: LineageEdge, right: LineageEdge): number {
  return left.createdAt.localeCompare(right.createdAt) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}
function compareObservation(left: LineageObservation, right: LineageObservation): number {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}
function compareCue(left: FailureCue, right: FailureCue): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
function compareTransfer(left: TransferObservation, right: TransferObservation): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
function compareQuarantine(left: QuarantineRecord, right: QuarantineRecord): number {
  return left.quarantinedAt.localeCompare(right.quarantinedAt) || left.id.localeCompare(right.id);
}
function compareCapsule(left: FailureCapsule, right: FailureCapsule): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
function compareBranchReturn(left: BranchReturnRecord, right: BranchReturnRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
