/**
 * The seam between "what the orchestration wants a worker to do" and "how a
 * worker actually runs".
 *
 * Today there are two answers. A one-shot `codex exec` turn ends when it
 * returns, so nothing can be said to it afterwards. An app-server session stays
 * addressable between turns, so a sibling can hand it work without the leader
 * planning another round. The orchestrator should not have to know which it got,
 * beyond reporting the difference honestly — hence `capability()`.
 */
import type { RunUsage, RunnerRequest } from "../types.js";
import type { TeamMessageQueued } from "../coordination/messages.js";

export interface WorkerCheckpoint {
  threadId: string | null;
  output: string;
  usage: RunUsage | null;
}

export interface DeliveryResult {
  state: "delivered" | "undeliverable";
  via?: "initial" | "pending_quiet" | "steer" | "follow_up";
  turnId?: string;
  output?: string;
  usage?: RunUsage | null;
  reason?: string;
}

export type RuntimeState = "not_started" | "active" | "idle" | "closed";

export interface RuntimeSnapshot {
  state: RuntimeState;
  threadId: string | null;
  activeTurnId: string | null;
}

/**
 * `live_steer` — the worker can be interrupted mid-turn and woken while idle.
 * `queued_follow_up` — messages only reach it the next time the leader starts a
 * turn, which the UI must show as degraded rather than let it pass for the same
 * thing.
 */
export type CoordinationCapability = "live_steer" | "queued_follow_up";

export interface AgentRuntime {
  start(request: RunnerRequest): Promise<WorkerCheckpoint>;
  /** Deliver without costing a turn. */
  inject(message: TeamMessageQueued): Promise<DeliveryResult>;
  /** Deliver and ask the worker to act now. */
  wake(message: TeamMessageQueued): Promise<DeliveryResult>;
  waitForIdle(): Promise<void>;
  snapshot(): RuntimeSnapshot;
  capability(): CoordinationCapability;
  /** Public barrier: after this resolves no worker process can mutate its workspace. */
  quiesce(reason: string): Promise<void>;
  close(reason: string): Promise<void>;
  cancel(reason: string): Promise<void>;
}

/** Refused delivery, named so the reason survives into evidence. */
export function undeliverable(reason: string): DeliveryResult {
  return { state: "undeliverable", reason };
}
