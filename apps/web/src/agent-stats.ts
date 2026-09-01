/**
 * What an agent actually did, counted from its own event stream.
 *
 * Every field here is a count of something that happened. There is no score and
 * no level: a number the interface cannot explain has no business on screen.
 *
 * Errors are counted, not "errors recovered". The stream can show a failure
 * turning into a fix; a counter could only claim it did.
 */
import { moveFor, type Move } from "./moves";
import type { PlanItem, RunEvent } from "./types";

export interface MoveTally {
  move: Move;
  count: number;
}

export interface AgentStats {
  toolsUsed: number;
  filesChanged: number;
  tasksDone: number;
  errors: number;
  moves: MoveTally[];
  current: RunEvent | null;
  /**
   * The newest move that has finished, and only while nothing is in flight.
   * An agent waiting on the model -- or just back from `wait_for_workers` --
   * has no open span, and reporting only `current` made its move vanish at
   * exactly those moments. This says what it did; it never stands in for what
   * it is doing, which is why it is null the moment `current` is not.
   */
  last: RunEvent | null;
}

/**
 * One row per span, carrying that span's newest event.
 *
 * A span reports at least twice -- started, then completed -- so counting raw
 * events would double every tool call.
 */
function bySpan(events: RunEvent[]): RunEvent[] {
  const latest = new Map<string, RunEvent>();
  for (const event of events) {
    const current = latest.get(event.spanId);
    if (current === undefined || event.seq > current.seq) latest.set(event.spanId, event);
  }
  return [...latest.values()];
}

function newestTodos(events: RunEvent[]): PlanItem[] {
  let newest: RunEvent | null = null;
  for (const event of events) {
    if (event.kind !== "todo" || event.output.todos === undefined) continue;
    if (newest === null || event.seq > newest.seq) newest = event;
  }
  return newest?.output.todos ?? [];
}

export function agentStatsOf(events: RunEvent[]): AgentStats {
  const spans = bySpan(events);

  const files = new Set<string>();
  const tallies = new Map<string, MoveTally>();
  let toolsUsed = 0;
  let errors = 0;
  let current: RunEvent | null = null;
  let last: RunEvent | null = null;

  for (const span of spans) {
    for (const path of span.output.changedFiles ?? []) {
      const trimmed = path.trim();
      if (trimmed.length > 0) files.add(trimmed);
    }
    if (span.status === "error") errors += 1;
    if (span.status === "in_progress" && (current === null || span.seq > current.seq)) {
      current = span;
    }
    const move = moveFor(span);
    if (move === null) continue;
    if (span.status !== "in_progress" && (last === null || span.seq > last.seq)) {
      last = span;
    }
    toolsUsed += 1;
    const tally = tallies.get(move.id);
    if (tally === undefined) tallies.set(move.id, { move, count: 1 });
    else tally.count += 1;
  }

  return {
    toolsUsed,
    filesChanged: files.size,
    tasksDone: newestTodos(events).filter((todo) => todo.done).length,
    errors,
    moves: [...tallies.values()].sort((left, right) => right.count - left.count),
    current,
    last: current === null ? last : null,
  };
}
