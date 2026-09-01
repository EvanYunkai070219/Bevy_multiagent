/**
 * Which agent the app is showing, and how that survives a reload.
 *
 * Two separate failures lived in one line of `refreshAgents`: the fallback took
 * `agents[0]`, and `/api/agents` returns workers and top-level chats in one
 * array, so a reload could land on a dispatched worker instead of the leader
 * whose mission it belonged to. Nothing was remembered either, so even the
 * correct fallback was not the chat the operator had been reading.
 *
 * The rules are ordered and pure so they can be asserted directly:
 *
 * 1. Whatever is already selected stays selected. Re-picking under the reader
 *    while they are looking at something is worse than any fallback.
 * 2. Otherwise the remembered id, whatever its role -- if the operator was
 *    inspecting a worker when they reloaded, that worker IS the thing to
 *    restore, and restoring its leader instead would be a second wrong answer.
 * 3. Otherwise the first top-level chat. Never a worker: a worker is somewhere
 *    the operator navigated to, never somewhere they are dropped by default.
 */
import type { Agent } from "./types";

const STORAGE_KEY = "launchpad.selectedAgentId";

/** Storage throws in private modes and sandboxed frames; a lost seat is not an error. */
export function rememberSelection(agentId: string | null): void {
  try {
    if (agentId === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, agentId);
  } catch {
    /* No persistence available. The session still works, it just forgets. */
  }
}

export function recallSelection(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function pickSelection(
  agents: Agent[],
  current: string | null,
  remembered: string | null,
): string | null {
  const has = (id: string | null): boolean =>
    id !== null && agents.some((agent) => agent.id === id);

  if (has(current)) return current;
  if (has(remembered)) return remembered;
  return agents.find((agent) => agent.role !== "worker")?.id ?? null;
}


const RAIL_KEY = "launchpad.agentPanelHidden";

/**
 * Whether the agent panel is put away. A per-viewer preference, so it is
 * remembered the same forgiving way the selection is: storage that throws in a
 * private window costs the preference, never the session.
 */
export function recallPanelHidden(): boolean {
  try {
    return window.localStorage.getItem(RAIL_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberPanelHidden(hidden: boolean): void {
  try {
    if (hidden) window.localStorage.setItem(RAIL_KEY, "1");
    else window.localStorage.removeItem(RAIL_KEY);
  } catch {
    /* No persistence available. */
  }
}

const TRANSCRIPT_SCOPE_KEY = "launchpad.transcriptLeaderOnly";

/**
 * Whether a leader's transcript is narrowed to the leader's own run.
 *
 * The whole session is the default and stays the default: what happened is the
 * mission, not one participant's half of it. This is the reading aid for a
 * mission with enough workers that the leader's own decisions are hard to pick
 * out. Per-viewer, so it is remembered as forgivingly as everything else here.
 */
export function recallLeaderOnly(): boolean {
  try {
    return window.localStorage.getItem(TRANSCRIPT_SCOPE_KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberLeaderOnly(leaderOnly: boolean): void {
  try {
    if (leaderOnly) window.localStorage.setItem(TRANSCRIPT_SCOPE_KEY, "1");
    else window.localStorage.removeItem(TRANSCRIPT_SCOPE_KEY);
  } catch {
    /* No persistence available. */
  }
}
