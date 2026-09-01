/**
 * Reading what an agent published, from the control plane.
 *
 * `publish_artifact` is the one durable output an agent can name for itself:
 * text, or a file lifted out of its workspace or the shared workspace, written
 * to a per-session directory that every worker on that mission can read. Until
 * now only the agents could read it. The UI had no route, so a published
 * artifact -- often the actual deliverable -- existed but could not be opened,
 * and the rail deliberately listed only files it could serve rather than
 * showing rows that did nothing.
 *
 * The layout is fixed by the MCP server: `<data>/shared/<sessionRunId>/
 * artifacts/<id>.json` beside `<id>.txt`, keyed by the run at the root of the
 * mission so a leader and its workers share one set.
 *
 * Both identifiers are validated as ids, not as paths. They arrive from a URL,
 * and the artifact directory sits next to the store's own files -- one accepted
 * `..` would turn a read of a run's outputs into a read of anything on disk.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { HttpError } from "./errors.js";

/** Ids on both sides of this route are UUIDs, minted by the runtime. */
const ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface PublishedArtifact {
  id: string;
  type: string;
  description: string;
  sourcePath: string | null;
  ownerWorkerId: string | null;
  ownerWorkerRunId: string | null;
  createdAt: string;
  /** Size of the stored content, so the UI can say what it is about to open. */
  bytes: number;
}

function checked(value: string, what: string): string {
  if (!ID.test(value)) throw new HttpError(400, "Not a valid " + what);
  return value;
}

function artifactsDir(dataDirectory: string, sessionRunId: string): string {
  return path.join(
    dataDirectory,
    "runs",
    "shared",
    checked(sessionRunId, "run id"),
    "artifacts",
  );
}

function legacyArtifactsDir(dataDirectory: string, sessionRunId: string): string {
  return path.join(
    dataDirectory,
    "shared",
    checked(sessionRunId, "run id"),
    "artifacts",
  );
}

function artifactDirs(dataDirectory: string, sessionRunId: string): string[] {
  return [
    artifactsDir(dataDirectory, sessionRunId),
    legacyArtifactsDir(dataDirectory, sessionRunId),
  ];
}

function describe(dir: string, id: string): PublishedArtifact | null {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(readFileSync(path.join(dir, id + ".json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    // A half-written or hand-edited artifact must not take the whole list with
    // it: the rest of the mission's outputs are still readable.
    return null;
  }
  const text = (key: string): string | null =>
    typeof record[key] === "string" ? (record[key] as string) : null;
  let bytes = 0;
  try {
    bytes = statSync(path.join(dir, id + ".txt")).size;
  } catch {
    bytes = 0;
  }
  return {
    id,
    type: text("type") ?? "text",
    description: text("description") ?? "",
    sourcePath: text("sourcePath"),
    ownerWorkerId: text("ownerWorkerId"),
    ownerWorkerRunId: text("ownerWorkerRunId"),
    createdAt: text("createdAt") ?? "",
    bytes,
  };
}

/**
 * Everything published under one mission, oldest first -- the order they were
 * produced in, which is the order the transcript above them reads in.
 */
export function listPublishedArtifacts(
  dataDirectory: string,
  sessionRunId: string,
): PublishedArtifact[] {
  const artifacts: PublishedArtifact[] = [];
  for (const dir of artifactDirs(dataDirectory, sessionRunId)) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      // No shared directory means no artifacts, not a broken run.
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      if (!ID.test(id) || artifacts.some((artifact) => artifact.id === id)) continue;
      const artifact = describe(dir, id);
      if (artifact !== null) artifacts.push(artifact);
    }
  }
  return artifacts.sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

export function readPublishedArtifact(
  dataDirectory: string,
  sessionRunId: string,
  artifactId: string,
): { artifact: PublishedArtifact; text: string } {
  const id = checked(artifactId, "artifact id");
  for (const dir of artifactDirs(dataDirectory, sessionRunId)) {
    const artifact = describe(dir, id);
    if (artifact === null) continue;
    try {
      return { artifact, text: readFileSync(path.join(dir, id + ".txt"), "utf8") };
    } catch {
      // Metadata without content is a publish that did not finish. Reporting it
      // as an empty artifact would claim the agent produced nothing.
      throw new HttpError(404, "Artifact content not found");
    }
  }
  throw new HttpError(404, "Artifact not found");
}

/**
 * Which run's shared directory a run's artifacts live in.
 *
 * The runtime keys the shared directory by `LAUNCHPAD_PARENT_RUN_ID` when there
 * is one, so a leader and every worker it dispatched publish into one place.
 * Asking a worker run for its artifacts has to arrive at the same directory, or
 * a worker's own deliverable would look missing when opened from the worker.
 */
export function sessionRootRunId(
  runs: readonly { id: string; parentRunId: string | null }[],
  runId: string,
): string {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const seen = new Set<string>();
  let current = byId.get(runId);
  while (current !== undefined && current.parentRunId !== null && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentRunId);
    // A parent the store no longer holds is still the key the runtime used.
    if (parent === undefined) return current.parentRunId;
    current = parent;
  }
  return current?.id ?? runId;
}
