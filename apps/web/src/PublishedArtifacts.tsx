/**
 * Artifacts an agent published on purpose.
 *
 * `RunArtifacts` lists the files the trace says were written, which is what
 * the control plane could already serve. It says so in its own header, and it
 * excluded published artifacts because they lived in a shared directory with no
 * route -- a row that opens nothing is worse than no row.
 *
 * The route exists now, so this is the other half: what an agent chose to
 * publish as the mission's output, rather than everything it happened to touch.
 * Content is fetched only when a row is opened; a mission can publish a report
 * far larger than the rail, and nobody should pay for one they did not open.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import type { PublishedArtifact } from "./types";

const POLL_MS = 3000;

/**
 * What to call an artifact.
 *
 * The publisher's description first, then the file it came from. A row headed
 * `text/markdown` names the encoding of something the reader still cannot
 * identify; `syllabus-map.md` is the thing they are looking for. The MIME type
 * is the last resort, for text published with no source file at all.
 */
export function artifactName(artifact: PublishedArtifact): string {
  const described = artifact.description.trim();
  if (described !== "") return described;
  const file = (artifact.sourcePath ?? "").split("/").pop()?.trim() ?? "";
  return file !== "" ? file : artifact.type;
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function ArtifactRow({ runId, artifact }: { runId: string; artifact: PublishedArtifact }) {
  const [body, setBody] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  const open = async (): Promise<void> => {
    if (asked) return;
    setAsked(true);
    try {
      const result = await api.runArtifact(runId, artifact.id);
      setBody(result.text);
    } catch (reason) {
      // The publisher recorded it and the bytes are gone: that is a fact about
      // the run, and showing an empty body instead would claim it produced
      // nothing.
      setFailure(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <details
      className="artifact-published"
      onToggle={(event) => {
        if (event.currentTarget.open) void open();
      }}
    >
      <summary>
        <span className="artifact-published-name">
          {artifactName(artifact)}
        </span>
        <span className="artifact-published-size">{sizeOf(artifact.bytes)}</span>
      </summary>
      {artifact.sourcePath !== null && (
        <code className="artifact-published-source">{artifact.sourcePath}</code>
      )}
      {failure !== null && <p className="artifact-published-failure">{failure}</p>}
      {body !== null && <pre className="artifact-published-body">{body}</pre>}
    </details>
  );
}

export function PublishedArtifacts({
  runId,
  running,
  ownerRunId,
}: {
  runId: string;
  running: boolean;
  /**
   * Narrow the list to one member's own output.
   *
   * The route answers from the mission's shared directory -- one place every
   * member publishes into -- so without this every agent showed the same
   * undifferentiated list and a worker's report read as the leader's. A worker
   * answers "what did I produce"; the leader is the mission, so it answers
   * "what did the mission produce" and passes nothing.
   */
  ownerRunId?: string;
}) {
  const [artifacts, setArtifacts] = useState<PublishedArtifact[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = async (): Promise<void> => {
      try {
        const result = await api.runArtifacts(runId);
        if (cancelled) return;
        // A run with no shared directory answers with nothing to list; an
        // answer this page cannot read is the same outcome, not a broken rail.
        setArtifacts(Array.isArray(result.artifacts) ? result.artifacts : []);
      } catch {
        // A run with no shared directory published nothing. Not an error.
      }
      // Nothing can be published to a mission that has ended.
      if (!cancelled && running) timer = window.setTimeout(() => void tick(), POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runId, running]);

  // Ownership is read off the run each artifact records publishing it, never
  // guessed from what is on screen.
  const shown =
    ownerRunId === undefined
      ? artifacts
      : artifacts.filter((artifact) => artifact.ownerWorkerRunId === ownerRunId);
  if (shown.length === 0) return null;

  return (
    <section className="rail-card card--files">
      <div className="rail-card-title">
        {ownerRunId === undefined ? "Published" : "Published by this agent"}{" "}
        <span className="rail-card-count">{shown.length}</span>
      </div>
      <div className="artifact-published-list">
        {shown.map((artifact) => (
          <ArtifactRow key={artifact.id} runId={runId} artifact={artifact} />
        ))}
      </div>
    </section>
  );
}
