/**
 * The leader's events and every worker's, as one attributed stream.
 *
 * Worker activity previously had nowhere to appear: `WorkerTrajectories` polled
 * for it and nothing rendered that component. The polling shape is kept -- one
 * cursor per run, so each request asks only for what it has not seen -- and the
 * result is merged rather than nested, because a multi-agent run reads as
 * characters taking turns, not as parallel logs.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { assignCreatures, creatureOf, type Creature } from "./creatures";
import { orderSessionEvents, type OrderedEvent } from "./session-order";
import type { Agent, AgentRun, RunEvent } from "./types";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 900;
const RETRY_MS = 1500;
/**
 * How many times a request is retried against a mission that has already
 * finished. A blip deserves another go; a run the API will never serve does
 * not, and the error path used to reschedule regardless of whether there was
 * anything left to wait for. One worker run recorded before run ids were UUIDs
 * -- which `/api/runs/:id/events` now correctly rejects as malformed -- kept a
 * settled mission polling every 1.5 seconds for as long as the tab was open.
 */
const SETTLED_RETRIES = 3;

export interface Actor {
  agentId: string;
  runId: string;
  name: string;
  specialty: string | null;
  creature: Creature;
  isLeader: boolean;
}

export interface SessionEvents {
  /** Worker runs under this leader run, in the order the server returned them. */
  runs: AgentRun[];
  byRun: Record<string, RunEvent[]>;
  ordered: OrderedEvent[];
  actors: Record<string, Actor>;
}

/**
 * A run whose agent has not loaded yet still has to be attributable, or its
 * events would silently lose their place in the transcript.
 */
export function buildActors(
  agents: Agent[],
  workerRuns: AgentRun[],
  leaderRunId: string,
  leaderAgentId: string,
): Record<string, Actor> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  // Cast from the whole roster, so a leader and its workers get four different
  // creatures in the transcript rather than the same one twice.
  const cast = assignCreatures(agents);
  const actors: Record<string, Actor> = {};

  const add = (runId: string, agentId: string, isLeader: boolean): void => {
    const agent = byId.get(agentId);
    actors[runId] = {
      agentId,
      runId,
      name: agent?.name ?? (isLeader ? "Leader" : "Worker"),
      specialty: agent?.specialty ?? null,
      creature: creatureOf({ id: agentId, specialty: agent?.specialty ?? null }, cast),
      isLeader,
    };
  };

  add(leaderRunId, leaderAgentId, true);
  for (const run of workerRuns) add(run.id, run.agentId, false);
  return actors;
}

/**
 * The leader's events are passed in, not fetched: the caller already polls them
 * with its own cursor and visibility bookkeeping, and a second poller would
 * double the requests and give the same run two slightly different histories.
 * This hook owns exactly what nothing else was fetching -- the workers.
 */
/**
 * Fold the leader's stream in, keyed by the run each event says it belongs to.
 *
 * Not by a run id handed in from outside: the caller can be between runs -- a
 * send that failed clears its active run without clearing the events it already
 * showed -- and trusting that id would drop a transcript the reader is still
 * looking at.
 */
export function mergeLeaderEvents(
  workerEvents: Record<string, RunEvent[]>,
  leaderEvents: RunEvent[],
): Record<string, RunEvent[]> {
  if (leaderEvents.length === 0) return workerEvents;
  const merged: Record<string, RunEvent[]> = { ...workerEvents };
  for (const event of leaderEvents) {
    const existing = merged[event.runId];
    if (existing === undefined) merged[event.runId] = [event];
    else if (existing !== workerEvents[event.runId]) existing.push(event);
    else merged[event.runId] = [...existing, event];
  }
  return merged;
}

export function useSessionEvents({
  leaderRunId,
  leaderAgentId,
  leaderEvents,
  agents,
  leaderRunning,
}: {
  leaderRunId: string | null;
  leaderAgentId: string | null;
  leaderEvents: RunEvent[];
  agents: Agent[];
  leaderRunning: boolean;
}): SessionEvents {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [byRun, setByRun] = useState<Record<string, RunEvent[]>>({});
  const cursors = useRef<Record<string, number>>({});

  useEffect(() => {
    // Cleared BEFORE the early return, not after it. Leaving a run clears the
    // leader run id, and returning first stranded the previous session's worker
    // runs and events in state -- they then rendered under whatever chat was
    // opened next, which is a transcript from a different mission entirely.
    cursors.current = {};
    setRuns([]);
    setByRun({});

    /**
     * One flag per effect run, captured by that run's closure.
     *
     * This used to be a ref shared by every run of the effect, which cannot
     * cancel anything: the cleanup set it to false and the next run's first
     * statement set it straight back to true. A `tick` suspended in `await`
     * when the switch happened woke up, read `true`, and carried on polling a
     * mission nobody was looking at -- rescheduling into its own `timer`, which
     * the new cleanup had no way to reach.
     *
     * Every trip in and out of a running leader leaked one more loop, and each
     * survivor kept writing its own run's children and events into the state
     * the current run owns. Two loops disagreeing about `runs` roughly once a
     * second is what made the transcript alternate between two versions of
     * itself, tearing down and rebuilding every group on each tick.
     */
    let cancelled = false;
    let timer: number | undefined;
    if (leaderRunId === null) {
      return () => {
        cancelled = true;
      };
    }

    const absorb = (runId: string, events: RunEvent[], lastSeq: number): void => {
      if (events.length === 0) return;
      cursors.current[runId] = lastSeq;
      setByRun((current) => {
        const merged = new Map<number, RunEvent>();
        for (const event of current[runId] ?? []) merged.set(event.seq, event);
        for (const event of events) merged.set(event.seq, event);
        return {
          ...current,
          [runId]: [...merged.values()].sort((left, right) => left.seq - right.seq),
        };
      });
    };

    // Spent, not consumed for good: any successful tick restores it, so a
    // mission whose workers are still open survives scattered failures.
    let retriesLeft = SETTLED_RETRIES;

    const tick = async (): Promise<void> => {
      try {
        const { runs: children } = await api.children(leaderRunId);
        if (cancelled) return;
        setRuns(children);
        for (const child of children) {
          const page = await api.runEvents(child.id, cursors.current[child.id] ?? 0);
          if (cancelled) return;
          absorb(child.id, page.events, page.lastSeq);
        }

        retriesLeft = SETTLED_RETRIES;
        const busy = leaderRunning || children.some((child) => !TERMINAL.has(child.status));
        if (busy && !cancelled) timer = window.setTimeout(() => void tick(), POLL_MS);
      } catch {
        if (cancelled) return;
        // A live mission is always worth another attempt: it is still producing
        // events, so giving up would freeze the transcript mid-run.
        if (!leaderRunning && retriesLeft <= 0) return;
        retriesLeft -= 1;
        timer = window.setTimeout(() => void tick(), RETRY_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [leaderRunId, leaderRunning]);

  // The leader is one more stream in the merge, not a special case: its events
  // interleave with its workers' by the same rule everything else does.
  const combined = useMemo(
    () => mergeLeaderEvents(byRun, leaderEvents),
    [byRun, leaderEvents],
  );
  const ordered = useMemo(() => orderSessionEvents(combined), [combined]);
  const actors = useMemo(
    () =>
      leaderRunId === null || leaderAgentId === null
        ? {}
        : buildActors(agents, runs, leaderRunId, leaderAgentId),
    [agents, runs, leaderRunId, leaderAgentId],
  );

  return { runs, byRun: combined, ordered, actors };
}
