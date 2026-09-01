/**
 * The existing one-shot backend, behind the AgentRuntime seam.
 *
 * Deliberately gains no new powers here. A `codex exec` turn is over when it
 * returns: there is no session left to inject into and no turn left to steer, so
 * both delivery paths refuse rather than accept and drop. A message that is
 * accepted and never seen is worse than one that is visibly refused — the sender
 * believes it was told.
 */
import type { AgentRunner, RunnerRequest } from "../types.js";
import type { TeamMessageQueued } from "../coordination/messages.js";
import {
  undeliverable,
  type AgentRuntime,
  type CoordinationCapability,
  type DeliveryResult,
  type RuntimeSnapshot,
  type RuntimeState,
  type WorkerCheckpoint,
} from "./agent-runtime.js";

export class ExecRuntime implements AgentRuntime {
  private state: RuntimeState = "not_started";
  private threadId: string | null = null;
  private agentId: string | null = null;

  constructor(private readonly runner: AgentRunner) {}

  async start(request: RunnerRequest): Promise<WorkerCheckpoint> {
    this.agentId = request.agentId;
    this.state = "active";
    try {
      const result = await this.runner.run(request);
      this.threadId = result.threadId;
      return { threadId: result.threadId, output: result.output, usage: result.usage };
    } finally {
      // The turn is gone either way; leaving it "active" would invite the
      // coordination layer to address a worker that has already exited.
      this.state = "closed";
    }
  }

  async inject(_message: TeamMessageQueued): Promise<DeliveryResult> {
    return undeliverable("RUNTIME_CAPABILITY_UNAVAILABLE");
  }

  async wake(_message: TeamMessageQueued): Promise<DeliveryResult> {
    return undeliverable("RUNTIME_CAPABILITY_UNAVAILABLE");
  }

  async waitForIdle(): Promise<void> {
    // A one-shot turn is only ever running or finished; `start` already awaited it.
  }

  snapshot(): RuntimeSnapshot {
    return { state: this.state, threadId: this.threadId, activeTurnId: null };
  }

  capability(): CoordinationCapability {
    return "queued_follow_up";
  }

  async close(_reason: string): Promise<void> {
    this.state = "closed";
  }

  async quiesce(reason: string): Promise<void> {
    await this.close(reason);
  }

  async cancel(_reason: string): Promise<void> {
    if (this.agentId !== null) await this.runner.cancel(this.agentId);
    this.state = "closed";
  }
}
