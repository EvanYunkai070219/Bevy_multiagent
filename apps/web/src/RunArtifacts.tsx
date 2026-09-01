/**
 * What the run left behind.
 *
 * The rail said what the agents were doing and never what they had produced, so
 * the one thing an operator is usually waiting for -- the file -- was reachable
 * only by reading the transcript for a path and knowing to trust it.
 *
 * These are read off the trace, not off a manifest: every `file_change` event
 * already names the paths its agent wrote, and the workspace file endpoint can
 * already serve them. That is a different question from what an agent chose to
 * publish as the mission's output, which `PublishedArtifacts` answers from the
 * shared directory -- everything touched, versus everything meant.
 */
import { WorkspaceDownload } from "./WorkspaceFile";
import type { RunEvent } from "./types";

export interface Artifact {
  path: string;
  /** Whose workspace holds it. A worker's file is not in its leader's. */
  agentId: string;
}

/**
 * One row per path, attributed to whoever wrote it first.
 *
 * A file rewritten four times is one artifact, and the run is more legible if
 * the list stays in the order things first appeared rather than reshuffling
 * every time a build touches something again.
 */
export function collectArtifacts(events: RunEvent[]): Artifact[] {
  const byPath = new Map<string, Artifact>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.kind !== "file_change") continue;
    for (const raw of event.output.changedFiles ?? event.input.paths ?? []) {
      const path = raw.trim();
      if (path.length === 0 || byPath.has(path)) continue;
      byPath.set(path, { path, agentId: event.agentId });
    }
  }
  return [...byPath.values()];
}

export function RunArtifacts({ events }: { events: RunEvent[] }) {
  const artifacts = collectArtifacts(events);
  if (artifacts.length === 0) return null;

  return (
    <section className="rail-card card--files">
      <div className="rail-card-title">
        Artifacts <span className="rail-card-count">{artifacts.length}</span>
      </div>
      <ul className="artifact-list">
        {artifacts.map((artifact) => (
          <li key={artifact.path}>
            <WorkspaceDownload
              agentId={artifact.agentId}
              path={artifact.path}
              label={artifact.path}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
