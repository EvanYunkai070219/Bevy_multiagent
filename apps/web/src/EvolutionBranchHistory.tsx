import { useId, useState, type JSX } from "react";
import type {
  EvolutionProjection,
  LineageNode,
  LineageObservation,
} from "./types";

export interface EvolutionBranchHistoryRow {
  id: string;
  kind: LineageNode["kind"];
  label: string;
  state: string;
  historical: boolean;
  detail: {
    candidate: string | null;
    checkpoint: string | null;
    evidence: string[];
    outcome: string;
    returnReason: string | null;
    summary: string | null;
  };
}

export interface EvolutionBranchHistoryViewModel {
  rows: EvolutionBranchHistoryRow[];
  connectors: {
    id: string;
    kind: EvolutionProjection["edges"][number]["kind"];
    label: string;
    fromTrack: number;
    toTrack: number;
  }[];
}

/** Projects the server-sanitized records without changing their supplied order. */
export function selectEvolutionBranchHistory(
  input: EvolutionProjection,
): EvolutionBranchHistoryViewModel {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const trackByNodeId = new Map(input.nodes.map((node, index) => [node.id, index]));
  const observationsByNode = new Map<string, LineageObservation[]>();
  for (const observation of input.observations) {
    const values = observationsByNode.get(observation.nodeId) ?? [];
    observationsByNode.set(observation.nodeId, [...values, observation]);
  }
  const capsulesById = new Map(input.capsules.map((capsule) => [capsule.id, capsule]));
  const newestRunId = input.nodes.reduce<LineageNode | null>((newest, node) =>
    newest === null || node.createdAt > newest.createdAt ? node : newest, null)?.runId ?? null;

  const rows = input.nodes.map((node) => {
    const observations = observationsByNode.get(node.id) ?? [];
    const latest = observations.at(-1);
    const branchReturn = input.branchReturns.find((record) => record.candidateNodeId === node.id) ?? null;
    const capsule = branchReturn === null ? null : capsulesById.get(branchReturn.capsuleId) ?? null;
    const fork = input.edges.find((edge) => edge.kind === "repair_fork" && edge.toNodeId === node.id);
    const checkpoint = branchReturn === null
      ? (fork === undefined ? null : nodesById.get(fork.fromNodeId) ?? null)
      : nodesById.get(branchReturn.checkpointNodeId) ?? null;
    const evidence = unique([...node.evidenceRefs, ...(capsule?.evidenceRefs ?? [])]);
    return {
      id: node.id,
      kind: node.kind,
      label: nodeLabel(node),
      state: observationLabel(latest, node),
      historical: newestRunId !== null && node.runId !== newestRunId,
      detail: {
        candidate: node.kind !== "candidate"
          ? null
          : capsule === null ? node.entityId : words(capsule.candidateFamily),
        checkpoint: checkpoint === null ? null : nodeLabel(checkpoint),
        evidence,
        outcome: observationLabel(latest, node),
        returnReason: capsule === null ? null : words(capsule.stopReason),
        summary: capsule?.summary ?? null,
      },
    };
  });
  const connectors = input.edges.flatMap((edge) => {
    const fromTrack = trackByNodeId.get(edge.fromNodeId);
    const toTrack = trackByNodeId.get(edge.toNodeId);
    const target = nodesById.get(edge.toNodeId);
    if (fromTrack === undefined || toTrack === undefined || target === undefined) return [];
    return [{
      id: edge.id,
      kind: edge.kind,
      label: edge.kind === "returned_to"
        ? `returned to ${nodeLabel(target)}`
        : `${words(edge.kind)} ${nodeLabel(target)}`,
      fromTrack,
      toTrack,
    }];
  });
  return {
    rows,
    connectors,
  };
}

export function EvolutionBranchHistory({
  evolution,
  onShowMore,
  runId,
}: {
  evolution: EvolutionProjection;
  onShowMore?: () => void;
  runId?: string;
}): JSX.Element {
  const runIdentity = runId ?? evolution.runBranch ?? "unidentified-run";
  return <EvolutionBranchHistoryState key={runIdentity} evolution={evolution} onShowMore={onShowMore} />;
}

function EvolutionBranchHistoryState({
  evolution,
  onShowMore,
}: {
  evolution: EvolutionProjection;
  onShowMore?: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const contentId = useId();
  const view = selectEvolutionBranchHistory(evolution);
  const selected = view.rows.find((row) => row.id === selectedNodeId) ?? null;

  return (
    <section className="evolution-branch-history" aria-label="Evolution branch history">
      <button
        type="button"
        className="button button-ghost evolution-branch-history__toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
      >
        View branch history
        <span aria-hidden="true">{expanded ? "−" : "+"}</span>
      </button>

      {expanded && (
        <div id={contentId} className="evolution-branch-history__body" role="group" aria-label="Recorded branch history">
          <p className="evolution-branch-history__advisory">
            Recorded history only. This view does not select, rank, execute, or promote branches.
          </p>
          {view.rows.length === 0 ? (
            <p className="evolution-empty">No lineage records in this page.</p>
          ) : (
            <div className="evolution-branch-history__graph">
              <ol
                className="evolution-branch-history__lineage evolution-branch-history__tracks evolution-branch-history__lineage--vertical-narrow"
                style={{
                  gridTemplateColumns: `repeat(${view.rows.length}, minmax(140px, 1fr))`,
                  minWidth: `${view.rows.length * 148}px`,
                }}
              >
                {view.rows.map((row, track) => (
                  <li
                    key={row.id}
                    className={`evolution-branch-history__row evolution-branch-history__row--${row.kind}`}
                    data-lineage-track-id={row.id}
                    style={{ gridColumn: track + 1 }}
                  >
                    <button
                      type="button"
                      className="evolution-branch-history__node"
                      aria-pressed={selectedNodeId === row.id}
                      onClick={() => setSelectedNodeId(row.id)}
                    >
                      <span className="evolution-node-label">{row.label}</span>
                      <span className="evolution-node-state">{row.state}</span>
                      {row.historical && row.state === "verified" && (
                        <span className="evolution-historical">Historical verification</span>
                      )}
                    </button>
                  </li>
                ))}
              </ol>
              <ol
                className="evolution-branch-history__connectors"
                aria-label="Recorded lineage relationships"
                style={{
                  gridTemplateColumns: `repeat(${view.rows.length}, minmax(140px, 1fr))`,
                  minWidth: `${view.rows.length * 148}px`,
                }}
              >
                {view.connectors.map((connector) => {
                  const firstTrack = Math.min(connector.fromTrack, connector.toTrack);
                  const trackSpan = Math.abs(connector.toTrack - connector.fromTrack) + 1;
                  return (
                    <li
                      key={connector.id}
                      className="evolution-branch-history__connector"
                      data-lineage-edge-id={connector.id}
                      data-lineage-edge-kind={connector.kind}
                      data-lineage-from-track={connector.fromTrack}
                      data-lineage-to-track={connector.toTrack}
                      data-lineage-direction={connector.fromTrack <= connector.toTrack ? "forward" : "return"}
                      style={{ gridColumn: `${firstTrack + 1} / span ${trackSpan}` }}
                    >
                      <span className="evolution-branch-history__connector-line" aria-hidden="true" />
                      <span className="evolution-edge">{connector.label}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {selected && (
            <aside className="evolution-branch-history__selection" role="region" aria-label="Selected branch record">
              <h4>{selected.label}</h4>
              <dl>
                {selected.detail.candidate && <Detail label="Candidate" value={selected.detail.candidate} />}
                {selected.detail.checkpoint && <Detail label="Checkpoint" value={selected.detail.checkpoint} />}
                <Detail label="Outcome" value={selected.detail.outcome} />
                {selected.detail.returnReason && <Detail label="Return reason" value={selected.detail.returnReason} />}
              </dl>
              {selected.detail.summary && <p>{selected.detail.summary}</p>}
              {selected.detail.evidence.length > 0 && (
                <div className="evolution-branch-history__evidence">
                  <strong>Evidence</strong>
                  <ul>
                    {selected.detail.evidence.map((reference) => <li key={reference}><code>{reference}</code></li>)}
                  </ul>
                </div>
              )}
            </aside>
          )}

          {evolution.nextCursor && onShowMore && (
            <button type="button" className="button button-ghost evolution-more" onClick={onShowMore}>
              Show more
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function observationLabel(observation: LineageObservation | undefined, node: LineageNode): string {
  if (observation?.kind === "branch_pruned") return "branch pruned";
  return words(observation?.candidateState ?? observation?.kind ?? (node.kind === "candidate" ? "not_started" : node.kind));
}

function nodeLabel(node: LineageNode): string {
  const kind = node.kind.charAt(0).toUpperCase() + node.kind.slice(1);
  if (node.subtaskId && node.entityId !== node.subtaskId) {
    return `${kind} · ${node.subtaskId} · ${node.entityId}`;
  }
  const identity = node.subtaskId ?? node.entityId;
  return identity ? `${kind} · ${identity}` : kind;
}

function words(value: string): string {
  return value.replaceAll("_", " ");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
