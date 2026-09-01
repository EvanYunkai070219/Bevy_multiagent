/** Delivery semantics and when a team is actually finished. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TeamCoordinationRuntime } from "../src/coordination/team-runtime.js";
import { TeamJournal } from "../src/coordination/team-journal.js";
import type { AgentRuntime, DeliveryResult, RuntimeSnapshot } from "../src/runtime/agent-runtime.js";
import type { MessageDelivery, TeamMessageQueued } from "../src/coordination/messages.js";

let n = 0;
const msg = (
  from: string,
  to: string,
  delivery: MessageDelivery = "quiet",
  content = "note",
): TeamMessageQueued => ({
  id: "m" + n++,
  parentRunId: "leader-1",
  fromWorkerRunId: from,
  toWorkerRunId: to,
  delivery,
  content,
  workspaceRefs: [],
  createdAt: "2026-08-27T00:00:00.000Z",
});

class FakeRuntime implements AgentRuntime {
  injected: TeamMessageQueued[] = [];
  woken: TeamMessageQueued[] = [];
  stranded: TeamMessageQueued[] = [];
  constructor(
    private state: RuntimeSnapshot["state"] = "idle",
    private activeTurnId: string | null = null,
  ) {}
  async start() {
    return { threadId: "t", output: "", usage: null };
  }
  async inject(m: TeamMessageQueued): Promise<DeliveryResult> {
    this.injected.push(m);
    this.stranded.push(m);
    return { state: "delivered", via: "pending_quiet" };
  }
  async wake(m: TeamMessageQueued): Promise<DeliveryResult> {
    this.woken.push(m);
    return { state: "delivered", via: "follow_up" };
  }
  undeliveredQuiet(): TeamMessageQueued[] {
    return this.stranded;
  }
  async waitForIdle() {}
  snapshot(): RuntimeSnapshot {
    return { state: this.state, threadId: "t", activeTurnId: this.activeTurnId };
  }
  capability() {
    return "live_steer" as const;
  }
  async close() {
    this.state = "closed";
  }
  async cancel() {
    this.state = "closed";
  }
}

const setup = async (options = {}) => {
  const journal = await TeamJournal.open(mkdtempSync(join(tmpdir(), "team-")), "leader-1");
  const team = new TeamCoordinationRuntime("leader-1", journal, {
    quiescenceMs: 0,
    ...options,
  });
  await team.register("w-a", "step1", 1);
  await team.register("w-b", "step2", 1);
  return { team, journal };
};

describe("team coordination delivery", () => {
  it("injects quiet and wakes wakeup", async () => {
    const { team } = await setup();
    const b = new FakeRuntime();
    await team.attach("w-b", b);

    await team.queue(msg("w-a", "w-b", "quiet"));
    await team.queue(msg("w-a", "w-b", "wakeup"));

    expect(b.injected).toHaveLength(1);
    expect(b.woken).toHaveLength(1);
  });

  it("steers talk into an active turn without waking idle workers", async () => {
    const { team } = await setup();
    const active = new FakeRuntime("active", "turn-1");
    const idle = new FakeRuntime();
    await team.attach("w-a", active);
    await team.attach("w-b", idle);

    await team.queue(msg("w-b", "w-a", "talk", "quick active question"));
    await team.queue(msg("w-a", "w-b", "talk", "quick idle note"));

    expect(active.woken.map((message) => message.content)).toEqual([
      "quick active question",
    ]);
    expect(active.injected).toHaveLength(0);
    expect(idle.injected.map((message) => message.content)).toEqual(["quick idle note"]);
    expect(idle.woken).toHaveLength(0);
  });

  // The roster covers the whole plan, so a message to a member that has not
  // started is held rather than bounced — it rides in with their first turn.
  it("holds a message for a worker that has not started", async () => {
    const { team, journal } = await setup();
    await team.queue(msg("w-a", "w-b", "wakeup"));
    expect(journal.pendingMessages()).toHaveLength(1);
  });

  it("redelivers queued messages when the target runtime attaches", async () => {
    const { team, journal } = await setup();
    await team.queue(msg("w-a", "w-b", "talk", "queued before start"));
    expect(journal.pendingMessages()).toHaveLength(1);

    const b = new FakeRuntime("not_started");
    await team.attach("w-b", b);

    expect(b.injected.map((message) => message.content)).toEqual([
      "queued before start",
    ]);
    const entry = [...journal.projection().messages.values()][0];
    expect(entry?.state).toBe("delivered");
    expect(entry?.receipt?.deliveredVia).toBe("pending_quiet");
    expect(journal.projection().members.get("w-b")?.runtimeState).toBe("active");
  });

  it("stops waking a worker once its follow-up budget is spent", async () => {
    const { team, journal } = await setup({ maxFollowUpTurnsPerWorker: 2 });
    const b = new FakeRuntime();
    await team.attach("w-b", b);

    for (let i = 0; i < 4; i += 1) {
      await team.queue(msg("w-a", "w-b", "wakeup", "different " + i));
    }
    expect(b.woken).toHaveLength(2);
    const receipts = [...journal.projection().messages.values()];
    expect(receipts.some((r) => r.receipt?.reason === "FOLLOW_UP_LIMIT")).toBe(true);
  });

  // Tripped pairs keep talking; they just stop waking each other.
  it("downgrades a ping-ponging pair's wakeups to quiet", async () => {
    const { team, journal } = await setup({
      pingPongVolleys: 2,
      maxFollowUpTurnsPerWorker: 99,
    });
    const a = new FakeRuntime();
    const b = new FakeRuntime();
    await team.attach("w-a", a);
    await team.attach("w-b", b);

    await team.queue(msg("w-a", "w-b", "wakeup", "1"));
    await team.queue(msg("w-b", "w-a", "wakeup", "2"));
    await team.queue(msg("w-a", "w-b", "wakeup", "3"));

    expect(team.coordinationAnomalies()[0]?.code).toBe("COORDINATION_PING_PONG");
    expect(b.injected.length).toBeGreaterThan(0);
    const receipts = [...journal.projection().messages.values()];
    expect(receipts.some((r) => r.receipt?.reason === "downgraded_to_quiet")).toBe(true);
  });

  // The sender believes it passed the information on. Nobody read it. That is
  // the failure this channel makes easiest, so it has to be recorded.
  it("records quiet that never found a turn as NO_FURTHER_TURN", async () => {
    const { team, journal } = await setup();
    const b = new FakeRuntime();
    await team.attach("w-b", b);
    await team.queue(msg("w-a", "w-b", "quiet"));
    await team.settleUndeliveredQuiet();

    const receipts = [...journal.projection().messages.values()];
    expect(receipts.some((r) => r.receipt?.reason === "NO_FURTHER_TURN")).toBe(true);
  });

  // The bug this guards: the orchestrator registered the roster but never handed
  // the team the runtime, so every message sat queued forever while its sender
  // was told it had been sent. Nothing in the run reported a problem.
  it("leaves a message queued when the target has no runtime attached", async () => {
    const { team, journal } = await setup();
    await team.queue(msg("w-a", "w-b", "wakeup"));
    expect(journal.projection().messages.get([...journal.projection().messages.keys()][0]!)
      ?.state).toBe("queued");

    // Attaching is what makes the roster entry addressable.
    const b = new FakeRuntime();
    await team.attach("w-b", b);
    await team.queue(msg("w-a", "w-b", "wakeup"));
    expect(b.woken).toHaveLength(2);
  });

  it("is not quiescent while a message is still queued", async () => {
    const { team } = await setup();
    await team.queue(msg("w-a", "w-b", "wakeup"));
    expect(team.isQuiescent()).toBe(false);
  });

  it("recomputes what still needs delivering from the journal, not memory", async () => {
    const { team, journal } = await setup();
    await team.queue(msg("w-a", "w-b", "wakeup"));
    expect(team.pendingRedelivery().map((m) => m.id)).toEqual(
      journal.pendingMessages().map((m) => m.id),
    );
  });
});
