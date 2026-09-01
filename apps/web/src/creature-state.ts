/**
 * What a creature is doing, derived from what its agent is doing.
 *
 * Ordered, first match wins, and deliberately free of timers so it can be
 * asserted directly. "Byte is hurt" is a proposition about an event stream, not
 * a visual effect. Recovery is not a state here: it is the hurt -> working
 * transition, which the component plays once on class change.
 */
import type { RunEvent, RunStatus } from "./types";

export type CreatureState =
  | "done"
  | "searching"
  | "working"
  | "thinking"
  | "hurt"
  | "waiting"
  | "idle";

const DIAGNOSTIC_CODE = "codex_diagnostic";

/** Statuses a run does not come back from. */
const SETTLED = new Set<RunStatus | undefined>(["completed", "failed", "cancelled"]);

/**
 * A plan update is not execution, and diagnostics repeat verbatim every turn.
 * Neither says anything about how the agent is doing, so neither may set the
 * state or hide a failure behind itself.
 */
function meaningful(event: RunEvent): boolean {
  return event.kind !== "todo" && event.error?.code !== DIAGNOSTIC_CODE;
}

function latest(events: RunEvent[], open: boolean): RunEvent | null {
  let found: RunEvent | null = null;
  for (const event of events) {
    if (!meaningful(event)) continue;
    if ((event.status === "in_progress") !== open) continue;
    if (found === null || event.seq > found.seq) found = event;
  }
  return found;
}

function isSearch(event: RunEvent): boolean {
  return (
    event.kind === "web_search" ||
    (event.kind === "mcp_tool" && /search|fetch_webpage|browser/i.test(event.name))
  );
}

/**
 * `done` comes first on purpose: a run that finished after recovering from a
 * failure is done, not hurt. `hurt` means the agent is sitting on a failure
 * right now -- the active-event rules above it mean that reasoning about a
 * failure reads as thinking, and retrying reads as working.
 */
export function creatureStateOf(
  events: RunEvent[],
  runStatus?: RunStatus,
): CreatureState {
  if (runStatus === "completed") return "done";

  // A run that has stopped has nothing in flight, whatever its last events say.
  // A span left open by a kill, a timeout or a crash never reports a completion,
  // so reading the stream alone left the agent working forever on a run the
  // server had already marked failed or cancelled.
  const active = SETTLED.has(runStatus) ? null : latest(events, true);
  if (active !== null) {
    if (isSearch(active)) return "searching";
    if (active.kind !== "reasoning") return "working";
    return "thinking";
  }

  if (latest(events, false)?.status === "error") return "hurt";
  if (runStatus !== undefined) return "waiting";
  return "idle";
}
