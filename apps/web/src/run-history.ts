/**
 * Reading a Run that is no longer the current one.
 *
 * Every Run's trace, usage and worker tree was already persisted and already
 * served -- `/api/agents/:id/runs` returns all of them -- but the app took
 * `runs[0]` and dropped the rest on the floor, so the only Run whose trajectory,
 * tokens and cost you could see was the newest. Older Runs survived as a flat
 * strip of user and assistant messages with no timestamp, no status and no
 * account of what happened in between.
 *
 * Nothing here is new machinery: the point is that one selected Run id drives
 * the same components the live Run already uses. These are the pure parts of
 * that -- which messages belong to the Run being read, how long it took, and
 * the counts that make up its metadata line.
 */
import type { AgentRun, Message, RunEvent } from "./types";

/** Kinds that represent an agent reaching for a tool, as opposed to talking or bookkeeping. */
const TOOL_KINDS = new Set<RunEvent["kind"]>([
  "command",
  "file_change",
  "mcp_tool",
  "web_search",
]);

export interface RunMessages {
  /** Everything said before this Run, in order. */
  history: Message[];
  /** What opened the Run. */
  prompt: Message | null;
  /** Anything the operator said while it was already running. */
  steers: Message[];
  answer: Message | null;
}

/**
 * Split the agent's message log around the Run being read.
 *
 * The transcript is chronological, so a Run opened halfway up the list must not
 * be shown underneath the Runs that came after it: reading Run 2 of 5 with Runs
 * 3 to 5 stacked above it puts the answer before the question. Newer Runs are
 * withheld instead, and the picker is what says there are more.
 *
 * `runs` arrives newest-first from the API, so position in that array is the
 * ordering. When it is empty -- the very first paint, before the list has
 * loaded -- every other Run counts as history, which is what the app did before
 * a Run could be chosen at all.
 */
export function partitionRunMessages({
  messages,
  runs,
  viewedRunId,
}: {
  messages: Message[];
  runs: AgentRun[];
  viewedRunId: string | null;
}): RunMessages {
  if (viewedRunId === null) {
    return { history: messages, prompt: null, steers: [], answer: null };
  }

  const rankOf = new Map(runs.map((run, index) => [run.id, index]));
  const viewedRank = rankOf.get(viewedRunId);
  const isOlder = (runId: string): boolean => {
    if (viewedRank === undefined) return true;
    // An unknown Run is treated as older rather than hidden: losing a message
    // is worse than showing it a position too early.
    return (rankOf.get(runId) ?? Number.POSITIVE_INFINITY) > viewedRank;
  };

  const mine = messages.filter((message) => message.runId === viewedRunId);
  const asked = mine.filter((message) => message.role === "user");
  return {
    history: messages.filter(
      (message) => message.runId !== viewedRunId && isOlder(message.runId),
    ),
    prompt: asked[0] ?? null,
    steers: asked.slice(1),
    answer: mine.find((message) => message.role === "assistant") ?? null,
  };
}

/**
 * How long the Run took, or null while it is still open.
 *
 * `startedAt` is when the runner picked the Run up; a Run that was cancelled in
 * the queue never got one, so creation is the honest fallback -- it is the only
 * other moment the operator saw.
 */
export function runDurationMs(run: AgentRun): number | null {
  if (!run.completedAt) return null;
  const from = Date.parse(run.startedAt ?? run.createdAt);
  const to = Date.parse(run.completedAt);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(to - from, 0);
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return seconds.toFixed(1) + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m " + Math.floor(seconds % 60) + "s";
  return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}

/**
 * Calls, not events. A tool span is reported at least twice -- opened, then
 * settled -- and counting rows would say a Run did double the work it did.
 */
export function countToolCalls(events: RunEvent[]): number {
  const spans = new Set<string>();
  for (const event of events) {
    if (TOOL_KINDS.has(event.kind)) spans.add(event.spanId);
  }
  return spans.size;
}

/** How many agents actually appear in the trace, leader included. */
export function countAgents(events: RunEvent[]): number {
  return new Set(events.map((event) => event.agentId)).size;
}


export interface TranscriptRunRow {
  kind: "run";
  run: AgentRun;
  /** Counting from the operator's first run, which is how they think of them. */
  position: number;
  total: number;
}

export interface TranscriptMessageRow {
  kind: "message";
  message: Message;
}

export type TranscriptRow = TranscriptRunRow | TranscriptMessageRow;

/**
 * The transcript as a sequence of runs, not a strip of messages.
 *
 * Earlier runs used to be rendered as bare question/answer pairs with no
 * boundary of any kind, and only the run being read got a header. Eight
 * messages in a row, one header near the bottom: nothing said where one run
 * ended and the next began, so the order looked wrong even when it was not,
 * and there was no way to tell which answer belonged to which question.
 *
 * Every run now opens with its own header. Nothing here decides an order of its
 * own -- runs come in the order they were created, messages in the order they
 * were sent -- which is the point: the sequence is read off the data instead of
 * being assembled by the view.
 *
 * The run being read contributes its header and its opening prompt only. Its
 * work, its steers and its answer are rendered below by the timeline and the
 * result, so they are handed back rather than placed.
 */
export function buildTranscript({
  messages,
  runs,
  viewedRunId,
}: {
  messages: Message[];
  runs: AgentRun[];
  viewedRunId: string | null;
}): { rows: TranscriptRow[]; steers: Message[]; answer: Message | null } {
  const mine = viewedRunId === null ? [] : messages.filter((m) => m.runId === viewedRunId);
  const asked = mine.filter((message) => message.role === "user");
  const steers = asked.slice(1);
  const answer = mine.find((message) => message.role === "assistant") ?? null;

  if (viewedRunId === null || runs.length === 0) {
    return {
      rows: messages.map((message) => ({ kind: "message" as const, message })),
      steers,
      answer,
    };
  }

  // `runs` arrives newest-first; the transcript reads the other way.
  const oldestFirst = [...runs].reverse();
  const viewedIndex = oldestFirst.findIndex((run) => run.id === viewedRunId);
  const shown = viewedIndex === -1 ? oldestFirst : oldestFirst.slice(0, viewedIndex + 1);
  const known = new Set(oldestFirst.map((run) => run.id));

  const byRun = new Map<string, Message[]>();
  const orphans: Message[] = [];
  for (const message of messages) {
    if (!known.has(message.runId)) {
      // A message whose run is no longer stored still happened. Losing it is
      // worse than showing it before everything that has a place.
      orphans.push(message);
      continue;
    }
    const bucket = byRun.get(message.runId);
    if (bucket === undefined) byRun.set(message.runId, [message]);
    else bucket.push(message);
  }

  const rows: TranscriptRow[] = orphans.map((message) => ({ kind: "message", message }));
  for (const run of shown) {
    rows.push({
      kind: "run",
      run,
      position: oldestFirst.indexOf(run) + 1,
      total: oldestFirst.length,
    });
    const said = [...(byRun.get(run.id) ?? [])].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    if (run.id === viewedRunId) {
      const prompt = said.find((message) => message.role === "user");
      if (prompt !== undefined) rows.push({ kind: "message", message: prompt });
      continue;
    }
    for (const message of said) rows.push({ kind: "message", message });
  }
  return { rows, steers, answer };
}
