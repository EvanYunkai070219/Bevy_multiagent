import type { JSX } from "react";
import type { AgentRun, EvolutionCounts, EvolutionProjection, LineageEdge, LineageNode } from "./types";
import { EvolutionBranchHistory } from "./EvolutionBranchHistory";

export interface EvolutionViewModel {
  status: EvolutionProjection["syncState"];
  counts: EvolutionCounts;
  primaryFault: EvolutionProjection["primaryFault"];
  warningLevel: EvolutionProjection["warningLevel"];
  branchLabel: string | null;
  commitLabel: string | null;
  terminalLabel: string | null;
  cueCount: number;
  transferCount: number;
  historyHealth: EvolutionProjection["historyHealth"];
  quarantineReasons: string[];
  treeRows: {
    id: string;
    depth: number;
    label: string;
    edgeLabel: string | null;
    state: string;
    historical: boolean;
  }[];
}

export function shouldLoadEvolution(run: AgentRun, panelExpanded: boolean): boolean {
  if (run.projectId === null || run.workspaceSource?.mode === "ephemeral_research") return false;
  return panelExpanded || run.orchestration !== null;
}

export function selectEvolutionViewModel(input: EvolutionProjection): EvolutionViewModel {
  const currentRunId = input.nodes.slice().sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0]?.runId ?? null;
  const observations = new Map<string, EvolutionProjection["observations"]>();
  for (const value of input.observations) {
    const entries = observations.get(value.nodeId) ?? [];
    entries.push(value);
    observations.set(value.nodeId, entries);
  }
  const rows = orderedTree(input.nodes, input.edges).map(({ node, depth, incoming }) => {
    const latest = (observations.get(node.id) ?? []).slice().sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id))[0];
    return {
      id: node.id,
      depth,
      label: nodeLabel(node),
      edgeLabel: incoming === null ? null : words(incoming.kind),
      state: words(latest?.candidateState ?? latest?.kind ?? (node.kind === "candidate" ? "not_started" : node.kind)),
      historical: currentRunId !== null && node.runId !== currentRunId,
    };
  });
  return {
    status: input.syncState,
    counts: input.counts,
    primaryFault: input.primaryFault,
    warningLevel: input.warningLevel,
    branchLabel: input.runBranch,
    commitLabel: input.baseCommit === null && input.headCommit === null
      ? null
      : `${shortCommit(input.baseCommit)} → ${shortCommit(input.headCommit)}`,
    terminalLabel: input.terminalReason === "server_restarted"
      ? "Restart cancelled"
      : input.terminalReason,
    cueCount: input.cues.length,
    transferCount: input.transfers.length,
    historyHealth: input.historyHealth,
    quarantineReasons: [...new Set(input.quarantines.map((record) => words(record.reason)))].sort(),
    treeRows: rows,
  };
}

export function EvolutionPanel({
  evolution,
  onShowMore,
  runId,
}: {
  evolution: EvolutionProjection;
  onShowMore?: () => void;
  runId?: string;
}): JSX.Element {
  const view = selectEvolutionViewModel(evolution);
  return (
    <section className={`evolution-panel evolution-panel--${view.warningLevel ?? view.status}`} aria-label="Repair evolution">
      <div className="evolution-heading">
        <div>
          <span className="eyebrow">Evolution</span>
          <strong>{summary(view.counts)}</strong>
        </div>
        <span className="evolution-status">{statusLabel(view.status)}</span>
      </div>
      <div className="evolution-counts" aria-label="Evolution lifecycle counts">
        <span>{view.counts.declared} declared</span>
        <span>{view.counts.prunedDuplicate} pruned</span>
        <span>{view.counts.admitted} admitted</span>
        <span>{view.counts.executed} executed</span>
        <span>{view.counts.verified} verified</span>
        <span>{view.counts.promoted} promoted</span>
        <span>{view.counts.rolledBack} rolled back</span>
        <span>{view.counts.branchPruned} branch pruned</span>
        <span>{view.counts.branchReturned} returned</span>
        <span>{view.counts.historicalEvidenceUsed} historical evidence</span>
      </div>

      {view.primaryFault && (
        <p className="evolution-fault"><strong>Primary fault:</strong> {view.primaryFault.summary}</p>
      )}
      {view.warningLevel && (
        <p className={`evolution-warning evolution-warning--${view.warningLevel}`}>
          {view.warningLevel === "severe" ? "Severe budget warning" : "Budget warning"}
        </p>
      )}
      {view.status === "pending" && <p className="evolution-sync">History sync pending</p>}
      {view.status === "unavailable" && <p className="evolution-sync">Evolution history unavailable</p>}
      {view.historyHealth.droppedHistoryCount > 0 && (
        <p className="evolution-sync">
          {view.historyHealth.droppedHistoryCount} history records dropped · {words(view.historyHealth.droppedReason ?? "unknown")}
        </p>
      )}
      {view.historyHealth.reconciliationPending && (
        <p className="evolution-sync">History reconciliation pending</p>
      )}
      {view.terminalLabel && <p className="evolution-terminal">{view.terminalLabel}</p>}

      <div className="evolution-meta">
        {view.branchLabel && <code>{view.branchLabel}</code>}
        {view.commitLabel && <span>{view.commitLabel}</span>}
        <span>{view.cueCount} cues · {view.transferCount} transfers</span>
        {view.quarantineReasons.length > 0 && (
          <span>{evolution.quarantines.length} quarantined · {view.quarantineReasons.join(", ")}</span>
        )}
      </div>

      <EvolutionBranchHistory evolution={evolution} onShowMore={onShowMore} runId={runId} />
    </section>
  );
}

function orderedTree(
  nodes: readonly LineageNode[],
  edges: readonly LineageEdge[],
): { node: LineageNode; depth: number; incoming: LineageEdge | null }[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const validEdges = edges.filter((edge) => byId.has(edge.fromNodeId) && byId.has(edge.toNodeId));
  const incoming = new Map<string, LineageEdge[]>();
  const outgoing = new Map<string, LineageEdge[]>();
  for (const edge of validEdges) {
    incoming.set(edge.toNodeId, [...(incoming.get(edge.toNodeId) ?? []), edge]);
    outgoing.set(edge.fromNodeId, [...(outgoing.get(edge.fromNodeId) ?? []), edge]);
  }
  const compare = (left: LineageNode, right: LineageNode) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  const roots = nodes.filter((node) => !(incoming.get(node.id)?.length)).slice().sort(compare);
  const result: { node: LineageNode; depth: number; incoming: LineageEdge | null }[] = [];
  const seen = new Set<string>();
  const visit = (node: LineageNode, depth: number, via: LineageEdge | null) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    result.push({ node, depth, incoming: via });
    const children = (outgoing.get(node.id) ?? []).slice().sort((left, right) => {
      const leftNode = byId.get(left.toNodeId)!;
      const rightNode = byId.get(right.toNodeId)!;
      return compare(leftNode, rightNode) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
    });
    for (const edge of children) visit(byId.get(edge.toNodeId)!, Math.min(depth + 1, 4), edge);
  };
  for (const root of roots) visit(root, 0, null);
  for (const node of nodes.slice().sort(compare)) visit(node, 0, null);
  return result;
}

function nodeLabel(node: LineageNode): string {
  const kind = node.kind.charAt(0).toUpperCase() + node.kind.slice(1);
  return node.subtaskId ? `${kind} · ${node.subtaskId}` : kind;
}

function words(value: string): string {
  return value.replaceAll("_", " ");
}

function shortCommit(value: string | null): string {
  return value === null ? "pending" : value.slice(0, 7);
}

function summary(counts: EvolutionCounts): string {
  return `${counts.declared} declared · ${counts.prunedDuplicate} pruned · ${counts.executed} executed`;
}

function statusLabel(status: EvolutionProjection["syncState"]): string {
  if (status === "pending") return "sync pending";
  if (status === "unavailable") return "unavailable";
  if (status === "quarantined") return "quarantined";
  return "synced";
}
