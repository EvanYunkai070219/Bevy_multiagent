/** Persists sanitised RunEvent streams as bounded, append-only JSONL logs. */
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRedactor } from "./redact.js";
import {
  createTrajectoryState,
  replayTrajectoryState,
  renderTrajectoryLines,
  type TrajectoryState,
} from "./trajectory-log.js";
import {
  sanitizeRunEventDraft,
  type RunEvent,
  type RunEventDraft,
  type RunEventSink,
} from "./run-events.js";

const DEFAULT_BUFFER_SIZE = 512;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_READ_LIMIT = 500;

/** Inspect and clipped trajectory reads are observational; they never authorize continuation. */

const TRAJECTORY_FILE = "trajectory.jsonl";
const TRAJECTORY_LOG = "trajectory.log";
const MANIFEST_FILE = "session.json";

/**
 * Where a run's log lives and who wrote it.
 *
 * Placing options let sibling agents of one leader session share a directory:
 * `sessionId` groups them, `member` names each one's sub-folder. Both default so
 * a standalone run (no options) becomes a one-agent session.
 */
export interface SinkPlacement {
  /** Groups agents into one session directory. Defaults to the run's own id. */
  sessionId?: string;
  /** This agent's sub-folder name, e.g. "leader" or "API Reviewer". */
  member?: string;
  /** Optional role recorded in the manifest for readability. */
  role?: string;
}

interface ManifestMember {
  member: string;
  runId: string;
  agentId: string;
  role: string | null;
  createdAt: string;
}

interface SessionState {
  sessionId: string;
  dir: string;
  members: Map<string, ManifestMember>;
  queue: Promise<void>;
}

interface RunLogState {
  runId: string;
  agentId: string;
  member: string;
  dir: string;
  session: SessionState;
  seq: number;
  bytes: number;
  truncated: boolean;
  closed: boolean;
  closeComplete: boolean;
  appendFailure: Error | null;
  buffer: RunEvent[];
  queue: Promise<void>;
  trajectory: TrajectoryState;
}

type EventLogOptions = {
  bufferSize?: number;
  maxBytes?: number;
  secrets?: string[];
  append?: typeof appendFile;
};

/**
 * Append-only run event store.
 *
 * One session directory per leader run, one sub-folder per agent, each holding
 * `trajectory.jsonl` (the record of truth) and a human-readable `trajectory.log`.
 * A `session.json` manifest maps each member folder back to its run and agent.
 *
 * The control plane owns this; Runtime providers only hand drafts to a sink and
 * never touch the filesystem. `emit` is best-effort and never throws
 * asynchronously. The explicit close barrier still fails closed when the
 * authoritative JSONL append did not land.
 */
export class EventLog {
  private readonly bufferSize: number;
  private readonly maxBytes: number;
  private readonly redact: (value: unknown) => unknown;
  private readonly appendFile: typeof appendFile;
  private readonly states = new Map<string, RunLogState>();
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly root: string,
    options: EventLogOptions = {},
  ) {
    this.bufferSize = options.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.redact = createRedactor(options.secrets ?? []);
    this.appendFile = options.append ?? appendFile;
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
    const sessionDirs = await readdir(this.root, { withFileTypes: true });
    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory() || sessionEntry.name === ".deleted") continue;
      const sessionPath = path.join(this.root, sessionEntry.name);
      let memberEntries;
      try {
        memberEntries = await readdir(sessionPath, { withFileTypes: true });
      } catch {
        continue;
      }
      const manifest = await this.readManifest(sessionEntry.name);
      const session: SessionState = {
        sessionId: manifest?.session ?? sessionEntry.name,
        dir: sessionEntry.name,
        members: new Map(),
        queue: Promise.resolve(),
      };
      let recovered = false;
      for (const memberEntry of memberEntries) {
        if (!memberEntry.isDirectory()) continue;
        let raw: string;
        try {
          raw = await readFile(
            path.join(sessionPath, memberEntry.name, TRAJECTORY_FILE),
            "utf8",
          );
        } catch {
          continue; // not an agent folder
        }
        const events = this.parseEvents(raw);
        const last = events.at(-1);
        if (!last) continue;
        recovered = true;
        session.members.set(memberEntry.name, {
          member: memberEntry.name,
          runId: last.runId,
          agentId: last.agentId,
          role: manifest?.members?.find((m) => m.member === memberEntry.name)?.role ?? null,
          createdAt:
            manifest?.members?.find((m) => m.member === memberEntry.name)?.createdAt ??
            events[0]?.startedAt ??
            new Date().toISOString(),
        });
        const closed = last.kind === "run" && last.status !== "in_progress";
        this.states.set(last.runId, {
          runId: last.runId,
          agentId: last.agentId,
          member: memberEntry.name,
          dir: path.join(sessionEntry.name, memberEntry.name),
          session,
          seq: Math.max(...events.map((event) => event.seq)),
          bytes: Buffer.byteLength(raw, "utf8"),
          truncated: events.some(
            (event) =>
              event.name === "log_truncated" || event.error?.code === "log_truncated",
          ),
          closed,
          closeComplete: closed,
          appendFailure: null,
          buffer: events.slice(-this.bufferSize),
          queue: Promise.resolve(),
          trajectory: replayTrajectoryState(events),
        });
      }
      if (recovered) this.sessions.set(session.sessionId, session);
    }
  }

  createSink(
    runId: string,
    agentId: string,
    placement?: SinkPlacement,
  ): RunEventSink {
    const state = this.stateFor(runId, agentId, placement);
    return {
      emit: (draft: RunEventDraft): void => {
        if (state.closed) return;
        try {
          this.append(state, draft);
        } catch {
          // Best-effort: never let the event channel break a run.
        }
      },
    };
  }

  /** Absolute path to the physical session bundle for a leader or standalone run. */
  sessionDirectory(sessionId: string): string {
    return path.join(this.root, this.sessionFor(sessionId).dir);
  }

  /** Absolute path to one agent/member folder inside a session bundle. */
  runDirectory(
    runId: string,
    agentId: string,
    placement?: SinkPlacement,
  ): string {
    const state = this.stateFor(runId, agentId, placement);
    return path.join(this.root, state.dir);
  }

  /**
   * Wait for every queued append of a Run to reach disk.
   *
   * Callers use this as a barrier before reading a finished Run, so a Run that
   * is already marked terminal cannot be missing its last few events. The
   * session queue is awaited too so the manifest is on disk.
   */
  async flush(runId: string): Promise<void> {
    const state = this.states.get(runId);
    if (!state) return;
    const barrier = this.barrierStates(state);
    await Promise.all(barrier.map((item) => item.queue));
    await state.session.queue;
    const failed = barrier.find((item) => item.appendFailure !== null)?.appendFailure;
    if (failed) throw failed;
  }

  /** Prevent further emits, then wait for the complete owned append queue. */
  async close(runId: string): Promise<void> {
    const state = this.states.get(runId);
    if (!state) return;
    const barrier = this.barrierStates(state);
    for (const item of barrier) {
      item.closed = true;
      item.closeComplete = false;
    }
    await Promise.all(barrier.map((item) => item.queue));
    await state.session.queue;
    const failed = barrier.find((item) => item.appendFailure !== null)?.appendFailure;
    if (failed) throw failed;
    for (const item of barrier) item.closeComplete = true;
  }

  private barrierStates(state: RunLogState): RunLogState[] {
    if (state.runId !== state.session.sessionId) return [state];
    return [...this.states.values()].filter((item) => item.session === state.session);
  }

  /** True only after the matching terminal event has crossed the close barrier. */
  hasClosedTerminal(runId: string, matches: (event: RunEvent) => boolean): boolean {
    const state = this.states.get(runId);
    if (!state?.closed || !state.closeComplete || state.appendFailure !== null) return false;
    const terminal = [...state.buffer].reverse().find(isTerminalRunEvent);
    return terminal !== undefined && matches(terminal);
  }

  /** Reads the complete durable log, avoiding API pagination during restart replay. */
  async lastTerminalEvent(runId: string): Promise<RunEvent | null> {
    await this.flush(runId);
    return (await this.readFile(runId)).reverse().find(isTerminalRunEvent) ?? null;
  }

  /**
   * A process restart may find a terminal event whose matching store mutation
   * never committed. Recovery is the only caller allowed to reopen that log so
   * it can append the authoritative restart terminal event.
   */
  reopenForRecovery(runId: string): void {
    const state = this.states.get(runId);
    if (state) {
      state.closed = false;
      state.closeComplete = false;
    }
  }

  async read(
    runId: string,
    after: number,
    limit = DEFAULT_READ_LIMIT,
  ): Promise<{ events: RunEvent[]; lastSeq: number }> {
    const state = this.states.get(runId);
    if (state) {
      const earliest = state.buffer[0]?.seq;
      if (earliest !== undefined && after >= earliest - 1) {
        const events = state.buffer
          .filter((event) => event.seq > after)
          .slice(0, limit);
        return { events, lastSeq: events.at(-1)?.seq ?? after };
      }
    }
    const events = (await this.readFile(runId))
      .filter((event) => event.seq > after)
      .slice(0, limit);
    return { events, lastSeq: events.at(-1)?.seq ?? after };
  }

  async readTail(
    runId: string,
    limit: number,
  ): Promise<{ events: RunEvent[]; lastSeq: number }> {
    await this.flush(runId);
    const events = await this.readFile(runId);
    const tail = events.slice(Math.max(0, events.length - Math.max(0, limit)));
    return { events: tail, lastSeq: tail.at(-1)?.seq ?? 0 };
  }

  async summarizeProgressTail(
    runId: string,
    limit: number,
    checkpoint: { checkpointId: string | null; state: string; snapshot?: unknown } | null,
  ): Promise<{
    observational: true;
    authorizesContinuation: false;
    recent: Array<{
      seq: number;
      kind: RunEvent["kind"];
      name: string;
      status: RunEvent["status"];
      durationMs: number | null;
      text: string;
    }>;
    checkpoint: { checkpointId: string | null; state: string; snapshot?: unknown } | null;
  }> {
    const { events } = await this.readTail(runId, limit);
    return {
      observational: true,
      authorizesContinuation: false,
      recent: events.map((event) => ({
        seq: event.seq,
        kind: event.kind,
        name: event.name,
        status: event.status,
        durationMs: event.durationMs,
        text: compactEventText(event),
      })),
      checkpoint,
    };
  }

  /**
   * Store a large block beside the Run's log and return its file name.
   *
   * Content addressed by digest, so a block repeated across calls is written
   * once and a changed one gets its own file rather than overwriting history.
   */
  writeSidecar(runId: string, label: string, digest: string, text: string): string {
    const state = this.states.get(runId);
    const dir = state?.dir ?? standaloneDir(runId);
    const name = label + "-" + digest.slice(0, 12) + ".txt";
    const target = path.join(this.root, dir, name);
    const write = mkdir(path.join(this.root, dir), { recursive: true })
      .then(() => writeFile(target, this.redact(text) as string, { encoding: "utf8", flag: "wx" }))
      .catch(() => undefined);
    if (state) state.queue = state.queue.then(() => write);
    return name;
  }

  /** Move a Run's agent folder aside rather than deleting it, so audit records survive. */
  async archive(runIds: string[]): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const runId of runIds) {
      await this.close(runId);
      const state = this.states.get(runId);
      const dir = await this.dirName(runId);
      this.states.delete(runId);
      if (state) state.session.members.delete(state.member);
      // Archive the smallest self-contained unit: the whole session directory
      // when this was its last agent, otherwise just this agent's folder.
      const moveDir = await this.archiveTarget(dir);
      try {
        await rename(
          path.join(this.root, moveDir),
          path.join(this.root, ".deleted", archiveName(moveDir, timestamp)),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async archiveTarget(dir: string): Promise<string> {
    const sessionDir = path.dirname(dir);
    if (!sessionDir || sessionDir === ".") return dir; // legacy flat layout
    try {
      const members = await readdir(path.join(this.root, sessionDir), {
        withFileTypes: true,
      });
      const agentFolders = members.filter((entry) => entry.isDirectory());
      return agentFolders.length <= 1 ? sessionDir : dir;
    } catch {
      return dir;
    }
  }

  private stateFor(
    runId: string,
    agentId: string,
    placement?: SinkPlacement,
  ): RunLogState {
    const existing = this.states.get(runId);
    if (existing) return existing;
    const sessionId = placement?.sessionId ?? runId;
    const session = this.sessionFor(sessionId);
    const requestedMember = safeFileName(placement?.member ?? "agent");
    const existingMember = [...session.members.values()].find(
      (item) => item.runId === runId,
    )?.member;
    const member = existingMember ?? uniqueMemberName(session, requestedMember);
    const dir = path.join(session.dir, member);
    if (!session.members.has(member)) {
      session.members.set(member, {
        member,
        runId,
        agentId,
        role: placement?.role ?? null,
        createdAt: new Date().toISOString(),
      });
      this.writeManifest(session);
    }
    const state: RunLogState = {
      runId,
      agentId,
      member,
      dir,
      session,
      seq: 0,
      bytes: 0,
      truncated: false,
      closed: false,
      closeComplete: false,
      appendFailure: null,
      buffer: [],
      queue: mkdir(path.join(this.root, dir), { recursive: true }).then(
        () => undefined,
        () => undefined,
      ),
      trajectory: createTrajectoryState(),
    };
    this.states.set(runId, state);
    return state;
  }

  private sessionFor(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session: SessionState = {
      sessionId,
      dir: sessionDirName(sessionId),
      members: new Map(),
      queue: Promise.resolve(),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private writeManifest(session: SessionState): void {
    const manifest = {
      session: session.sessionId,
      members: [...session.members.values()],
    };
    const file = path.join(this.root, session.dir, MANIFEST_FILE);
    session.queue = session.queue
      .then(() => mkdir(path.join(this.root, session.dir), { recursive: true }))
      .then(() => writeFile(file, JSON.stringify(manifest, null, 2) + "\n", "utf8"))
      .catch(() => undefined);
  }

  private async readManifest(
    sessionDir: string,
  ): Promise<{ session: string; members: ManifestMember[] } | null> {
    try {
      const raw = await readFile(path.join(this.root, sessionDir, MANIFEST_FILE), "utf8");
      return JSON.parse(raw) as { session: string; members: ManifestMember[] };
    } catch {
      return null;
    }
  }

  private append(state: RunLogState, draft: RunEventDraft): void {
    if (state.closed || state.truncated) return;

    const sanitized = sanitizeRunEventDraft(draft, this.redact);
    const event: RunEvent = {
      ...sanitized,
      seq: state.seq + 1,
      runId: state.runId,
      agentId: state.agentId,
    };
    // Throws on an unserialisable payload before any state is mutated, so the
    // sequence stays gap-free and the next event still records.
    const line = JSON.stringify(event) + "\n";
    const lineBytes = Buffer.byteLength(line, "utf8");

    if (state.bytes + lineBytes > this.maxBytes) {
      state.truncated = true;
      const marker: RunEvent = {
        ...event,
        kind: "error",
        name: "log_truncated",
        status: "error",
        input: {},
        output: {},
        error: {
          message: "Event log exceeded " + this.maxBytes + " bytes",
          code: "log_truncated",
        },
        attributes: {},
        usage: null,
      };
      this.write(state, marker, JSON.stringify(marker) + "\n");
      return;
    }

    this.write(state, event, line);
  }

  private write(state: RunLogState, event: RunEvent, line: string): void {
    state.seq = event.seq;
    state.bytes += Buffer.byteLength(line, "utf8");
    state.buffer.push(event);
    if (state.buffer.length > this.bufferSize) state.buffer.shift();
    state.queue = state.queue.then(async () => {
      try {
        await this.appendFile(path.join(this.root, state.dir, TRAJECTORY_FILE), line, "utf8");
      } catch (error) {
        state.appendFailure ??= error instanceof Error
          ? error
          : new Error("Event log append failed", { cause: error });
      }
    });
    this.writeTrajectory(state, event);
  }

  /**
   * The readable projection. Best-effort by design: it shares the JSONL's
   * ordering and content but not its guarantees, so a failure here is
   * swallowed and leaves the JSONL — the record of truth — untouched.
   */
  private writeTrajectory(state: RunLogState, event: RunEvent): void {
    let text: string;
    try {
      const lines = renderTrajectoryLines(event, state.trajectory);
      if (lines.length === 0) return;
      text = lines.join("\n") + "\n";
    } catch {
      return;
    }
    state.queue = state.queue
      .then(() => this.appendFile(path.join(this.root, state.dir, TRAJECTORY_LOG), text, "utf8"))
      .catch(() => undefined);
  }

  private async dirName(runId: string): Promise<string> {
    const state = this.states.get(runId);
    if (state) return state.dir;
    // Scan session manifests for the member that owns this run.
    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return standaloneDir(runId);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".deleted") continue;
      const manifest = await this.readManifest(entry.name);
      const member = manifest?.members?.find((m) => m.runId === runId);
      if (member) return path.join(entry.name, member.member);
      // Legacy: an old flat dir named "{ts}_{runId}" with events.jsonl at top.
      if (entry.name.endsWith("_" + runId)) return entry.name;
    }
    return standaloneDir(runId);
  }

  private async readFile(runId: string): Promise<RunEvent[]> {
    const dir = await this.dirName(runId);
    for (const name of [TRAJECTORY_FILE, "events.jsonl"]) {
      try {
        return this.parseEvents(await readFile(path.join(this.root, dir, name), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return [];
  }

  private parseEvents(raw: string): RunEvent[] {
    const events: RunEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as RunEvent);
      } catch {
        // Skip a partially written trailing line.
      }
    }
    return events;
  }
}

function isTerminalRunEvent(event: RunEvent): boolean {
  return event.kind === "run" && event.status !== "in_progress";
}

export function compactEventText(event: RunEvent): string {
  const paths = [...(event.input?.paths ?? []), ...(event.output?.changedFiles ?? [])].join(" ");
  const text =
    event.output?.text ??
    event.input?.text ??
    event.input?.command ??
    (paths.length > 0 ? paths : undefined) ??
    event.error?.message ??
    "";
  return String(text).replace(/\s+/g, " ").slice(0, 500);
}

function sessionDirName(sessionId: string): string {
  return safeTimestamp(new Date()) + "_" + sessionId;
}

/** A run with no placement is its own single-agent session. */
function standaloneDir(runId: string): string {
  return path.join(sessionDirName(runId), "agent");
}

function archiveName(dir: string, timestamp: string): string {
  return dir.replace(/[/\\]/g, "_") + "-archived-" + timestamp;
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeFileName(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "unknown"
  );
}

function uniqueMemberName(session: SessionState, requested: string): string {
  if (!session.members.has(requested)) return requested;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = "-" + index;
    const candidate = requested.slice(0, 120 - suffix.length) + suffix;
    if (!session.members.has(candidate)) return candidate;
  }
  return requested.slice(0, 111) + "-" + Date.now().toString(36);
}
