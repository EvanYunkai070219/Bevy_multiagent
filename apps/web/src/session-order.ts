/**
 * One order for events produced by several agents at once.
 *
 * Within a run, `seq` is authoritative and wall clock is not: a span's newest
 * event carries its completion time, and some events are stamped when they are
 * reported rather than when they ran. Across runs there is no `seq` to share --
 * it restarts at zero per run -- and concurrent workers have no causal order
 * anyway, so the clock is the only signal available.
 *
 * Switching rule per pair (seq inside a run, time across runs) is NOT a valid
 * comparator. With A1(t=10), A2(t=5) in one run and B1(t=7) in another it says
 * A1 < A2, A2 < B1 and B1 < A1 at once, and `Array.prototype.sort` given an
 * inconsistent comparator is implementation-defined.
 *
 * So each event gets ONE key: its own timestamp, clamped to never fall below
 * the previous key in its run. The key is non-decreasing in `seq` by
 * construction, so a single global sort preserves each run's sequence and still
 * interleaves runs by the clock.
 */
import type { RunEvent } from "./types";

export interface OrderedEvent {
  event: RunEvent;
  /** Timestamp clamped monotonic within its run. Display ordering only. */
  sortKey: string;
}

export function compareSessionEvents(left: OrderedEvent, right: OrderedEvent): number {
  if (left.sortKey !== right.sortKey) return left.sortKey < right.sortKey ? -1 : 1;
  if (left.event.runId !== right.event.runId) {
    return left.event.runId < right.event.runId ? -1 : 1;
  }
  return left.event.seq - right.event.seq;
}

export function orderSessionEvents(
  byRun: Record<string, RunEvent[]>,
): OrderedEvent[] {
  const rows: OrderedEvent[] = [];
  for (const events of Object.values(byRun)) {
    let previous = "";
    for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
      const sortKey = event.startedAt > previous ? event.startedAt : previous;
      previous = sortKey;
      rows.push({ event, sortKey });
    }
  }
  return rows.sort(compareSessionEvents);
}
