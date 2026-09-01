/**
 * The shape of a message between workers of one leader run.
 *
 * Delivery modes must not silently become each other. `quiet` is information
 * the recipient should have the next time it works. `talk` steers an active
 * recipient but queues quietly if it is idle. `wakeup` asks it to work now.
 * Waking costs a model turn, so a system where every note wakes someone spends
 * its budget on acknowledgements.
 */
export type MessageDelivery = "quiet" | "talk" | "wakeup";

export interface TeamMessageQueued {
  id: string;
  parentRunId: string;
  fromWorkerRunId: string;
  toWorkerRunId: string;
  delivery: MessageDelivery;
  content: string;
  /** Paths under the common workspace this message refers to. */
  workspaceRefs: string[];
  createdAt: string;
}

/**
 * How a queued message ended up.
 *
 * `delivered` means the message reached the target's durable input — not that
 * the target understood or acted on it. Whether the request was actually met is
 * a question for the evidence, not for the transport.
 */
export interface TeamMessageReceipt {
  messageId: string;
  state: "delivered" | "undeliverable";
  deliveredVia?: "initial" | "pending_quiet" | "steer" | "follow_up" | "lead_projection";
  turnId?: string;
  recordedAt: string;
  reason?: string;
}
