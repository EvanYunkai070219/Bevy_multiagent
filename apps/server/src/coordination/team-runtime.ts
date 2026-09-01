/**
 * Coordination for one leader run: who is addressable, what was sent, and when
 * the team has actually stopped.
 *
 * Delivery is driven from the journal rather than from anything held here. A
 * signal lost to a crash must not lose a message, so what still needs sending is
 * always "queued minus terminal" recomputed from disk.
 */
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import { CoordinationAnomalyDetector, type CoordinationAnomaly } from "./anomaly-detector.js";
import type { TeamMessageQueued, TeamMessageReceipt } from "./messages.js";
import { Roster } from "./roster.js";
import type { TeamJournal } from "./team-journal.js";

export interface TeamRuntimeOptions {
  quiescenceMs?: number;
  maxFollowUpTurnsPerWorker?: number;
  pingPongVolleys?: number;
}

export class TeamCoordinationRuntime {
  readonly roster: Roster;
  private readonly detector: CoordinationAnomalyDetector;
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly followUps = new Map<string, number>();
  private readonly anomalies: CoordinationAnomaly[] = [];
  private readonly quiescenceMs: number;
  private readonly maxFollowUps: number;
  private lastActivityAt = Date.now();

  constructor(
    readonly parentRunId: string,
    private readonly journal: TeamJournal,
    options: TeamRuntimeOptions = {},
  ) {
    this.roster = new Roster(parentRunId);
    this.quiescenceMs = options.quiescenceMs ?? 2_000;
    this.maxFollowUps = options.maxFollowUpTurnsPerWorker ?? 3;
    this.detector = new CoordinationAnomalyDetector({
      ...(options.pingPongVolleys === undefined ? {} : { minVolleys: options.pingPongVolleys }),
    });
  }

  async attach(workerRunId: string, runtime: AgentRuntime): Promise<void> {
    this.runtimes.set(workerRunId, runtime);
    // `attach` happens immediately before the first turn is started. Marking
    // it active keeps list_teammates from telling siblings a worker is still
    // not_started while queued messages are already being prepared for it.
    this.roster.setState(workerRunId, "active");
    await this.journal.append({
      type: "team.member.runtime_changed",
      workerRunId,
      state: "active",
    });
    for (const message of this.journal.pendingMessages()) {
      if (message.toWorkerRunId === workerRunId) await this.deliver(message);
    }
  }

  detach(workerRunId: string, runtime: AgentRuntime): void {
    if (this.runtimes.get(workerRunId) !== runtime) return;
    this.runtimes.delete(workerRunId);
    this.roster.setState(workerRunId, "closed");
  }

  async register(
    workerRunId: string,
    subtaskId: string,
    iteration: number,
    displayName?: string,
  ): Promise<void> {
    const member = this.roster.register(workerRunId, subtaskId, iteration, displayName);
    await this.journal.append({
      type: "team.member.registered",
      workerRunId,
      subtaskId,
      displayName: member.displayName,
    });
  }

  /** Persist first: a message the sender was told about must survive a crash. */
  async queue(message: TeamMessageQueued): Promise<void> {
    await this.journal.append({ type: "team.message.queued", message });
    this.lastActivityAt = Date.now();

    const anomaly = this.detector.observe(message);
    if (anomaly !== null) this.anomalies.push(anomaly);

    await this.deliver(message);
  }

  private async deliver(message: TeamMessageQueued): Promise<void> {
    const runtime = this.runtimes.get(message.toWorkerRunId);
    if (runtime === undefined) {
      // Not started yet is not a failure: the roster covers the whole plan, and
      // the message rides in with that worker's first turn.
      return;
    }

    // A tripped pair keeps talking, it just stops waking each other.
    const downgraded =
      message.delivery === "wakeup" &&
      this.detector.shouldDowngrade(message.fromWorkerRunId, message.toWorkerRunId);
    const spent = this.followUps.get(message.toWorkerRunId) ?? 0;
    const overBudget = message.delivery === "wakeup" && spent >= this.maxFollowUps;

    if (overBudget) {
      await this.receipt({
        messageId: message.id,
        state: "undeliverable",
        recordedAt: new Date().toISOString(),
        reason: "FOLLOW_UP_LIMIT",
      });
      return;
    }

    const snapshot = runtime.snapshot();
    if (snapshot.state === "not_started") {
      const result = await runtime.inject(message);
      await this.receipt({
        messageId: message.id,
        state: result.state,
        ...(result.via === undefined ? {} : { deliveredVia: result.via }),
        recordedAt: new Date().toISOString(),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
      return;
    }

    const shouldSteerTalk =
      message.delivery === "talk" && snapshot.activeTurnId !== null;
    const shouldQueueQuiet =
      message.delivery === "quiet" || downgraded ||
      (message.delivery === "talk" && !shouldSteerTalk);
    const result =
      shouldSteerTalk || !shouldQueueQuiet
        ? await runtime.wake(message)
        : await runtime.inject(message);

    if (result.state === "delivered" && message.delivery === "wakeup" && !downgraded) {
      this.followUps.set(message.toWorkerRunId, spent + 1);
    }
    await this.receipt({
      messageId: message.id,
      state: result.state,
      ...(result.via === undefined ? {} : { deliveredVia: result.via }),
      ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
      recordedAt: new Date().toISOString(),
      ...(result.reason === undefined
        ? downgraded
          ? { reason: "downgraded_to_quiet" }
          : {}
        : { reason: result.reason }),
    });
  }

  private async receipt(receipt: TeamMessageReceipt): Promise<void> {
    await this.journal.append(
      receipt.state === "delivered"
        ? { type: "team.message.delivered", receipt }
        : { type: "team.message.undeliverable", receipt },
    );
    this.lastActivityAt = Date.now();
  }

  /**
   * Anything still queued after a restart, recomputed from disk. The in-process
   * signal is a convenience; this is the guarantee.
   */
  pendingRedelivery(): TeamMessageQueued[] {
    return this.journal.pendingMessages();
  }

  /**
   * The team is quiet when nothing is running, nothing is waiting to be
   * delivered, and it has stayed that way. Any new message restarts the clock —
   * a window that ends mid-conversation would cut a worker off.
   */
  isQuiescent(now = Date.now()): boolean {
    const anyActive = [...this.runtimes.values()].some(
      (runtime) => runtime.snapshot().state === "active",
    );
    if (anyActive) return false;
    if (this.journal.pendingMessages().length > 0) return false;
    return now - this.lastActivityAt >= this.quiescenceMs;
  }

  /**
   * Quiet notes whose recipient never took another turn. The sender believes it
   * passed the information on; nobody read it. That has to be visible.
   */
  async settleUndeliveredQuiet(): Promise<void> {
    for (const [workerRunId, runtime] of this.runtimes) {
      const stranded = (runtime as { undeliveredQuiet?: () => TeamMessageQueued[] })
        .undeliveredQuiet?.();
      for (const message of stranded ?? []) {
        await this.receipt({
          messageId: message.id,
          state: "undeliverable",
          recordedAt: new Date().toISOString(),
          reason: "NO_FURTHER_TURN",
        });
        this.roster.setState(workerRunId, "closed");
      }
    }
  }

  coordinationAnomalies(): CoordinationAnomaly[] {
    return [...this.anomalies];
  }
}
