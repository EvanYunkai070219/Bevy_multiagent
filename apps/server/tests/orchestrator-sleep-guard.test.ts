import { describe, expect, it, vi } from "vitest";
import {
  guardLeaderSleepPolling,
  isLeaderPollSleep,
} from "../src/orchestration/orchestrator.js";
import { RunControl } from "../src/orchestration/run-control.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import type { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { RunEventDraft, RunEventSink } from "../src/run-events.js";

function commandDraft(
  command: string,
  status: RunEventDraft["status"],
): RunEventDraft {
  const started = status === "in_progress";
  return {
    spanId: "span-1",
    parentSpanId: "root",
    kind: "command",
    name: "bash",
    status,
    startedAt: "2026-08-28T12:00:00.000Z",
    endedAt: started ? null : "2026-08-28T12:00:45.000Z",
    durationMs: started ? null : 45_000,
    input: { command },
    output: {},
    error: null,
    attributes: {},
    usage: null,
  };
}

function fakeRuntime(): { runtime: AgentRuntime; wake: ReturnType<typeof vi.fn> } {
  const wake = vi.fn().mockResolvedValue({ state: "delivered", via: "steer" });
  const runtime = {
    start: vi.fn(),
    inject: vi.fn(),
    wake,
    waitForIdle: vi.fn(),
    snapshot: vi.fn(),
    capability: vi.fn(),
    close: vi.fn(),
    cancel: vi.fn(),
  } as unknown as AgentRuntime;
  return { runtime, wake };
}

describe("isLeaderPollSleep", () => {
  it("flags the observed poll patterns", () => {
    expect(isLeaderPollSleep("/usr/bin/bash -lc 'sleep 45; echo waited'")).toBe(true);
    expect(isLeaderPollSleep("sleep 90")).toBe(true);
    expect(isLeaderPollSleep("sleep 30; echo done")).toBe(true);
  });

  it("ignores non-waits and trivial sleeps", () => {
    expect(isLeaderPollSleep(undefined)).toBe(false);
    expect(isLeaderPollSleep("ls -la /common-workspace")).toBe(false);
    expect(isLeaderPollSleep("echo asleep")).toBe(false); // word boundary, not `sleep N`
    expect(isLeaderPollSleep("sleep")).toBe(false); // no duration
    expect(isLeaderPollSleep("sleep 1")).toBe(false); // below threshold
  });
});

describe("guardLeaderSleepPolling", () => {
  const opts = { runId: "run-1", leaderAgentId: "leader-1", cooldownMs: 0 };

  it("passes every event through to the underlying sink", () => {
    const emit = vi.fn();
    const sink: RunEventSink = { emit };
    const { runtime } = fakeRuntime();
    const guarded = guardLeaderSleepPolling(sink, () => runtime, opts);
    const draft = commandDraft("sleep 30", "in_progress");
    guarded.emit(draft);
    expect(emit).toHaveBeenCalledWith(draft);
  });

  it("steers the live turn when a poll-sleep command starts", () => {
    const sink: RunEventSink = { emit: vi.fn() };
    const { runtime, wake } = fakeRuntime();
    const guarded = guardLeaderSleepPolling(sink, () => runtime, opts);
    guarded.emit(commandDraft("sleep 45; echo waited", "in_progress"));
    expect(wake).toHaveBeenCalledTimes(1);
    const message = wake.mock.calls[0][0];
    expect(message.delivery).toBe("wakeup");
    expect(message.content).toContain("wait_for_workers");
    expect(message.content).toContain("wait_job only for background shell jobs");
    expect(message.toWorkerRunId).toBe("leader-1");
  });

  it("does not steer on the completed phase or for non-sleep commands", () => {
    const sink: RunEventSink = { emit: vi.fn() };
    const { runtime, wake } = fakeRuntime();
    const guarded = guardLeaderSleepPolling(sink, () => runtime, opts);
    guarded.emit(commandDraft("sleep 45", "ok")); // completed
    guarded.emit(commandDraft("rg --files", "in_progress")); // not a sleep
    expect(wake).not.toHaveBeenCalled();
  });

  it("caps interventions per run", () => {
    const sink: RunEventSink = { emit: vi.fn() };
    const { runtime, wake } = fakeRuntime();
    const guarded = guardLeaderSleepPolling(sink, () => runtime, {
      ...opts,
      maxInterventions: 2,
    });
    for (let i = 0; i < 5; i++) {
      guarded.emit(commandDraft("sleep 60", "in_progress"));
    }
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("honours the cooldown between steers", () => {
    const sink: RunEventSink = { emit: vi.fn() };
    const { runtime, wake } = fakeRuntime();
    const guarded = guardLeaderSleepPolling(sink, () => runtime, {
      ...opts,
      cooldownMs: 60_000,
    });
    guarded.emit(commandDraft("sleep 60", "in_progress"));
    guarded.emit(commandDraft("sleep 60", "in_progress"));
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("no-ops when the runtime is gone", () => {
    const sink: RunEventSink = { emit: vi.fn() };
    const guarded = guardLeaderSleepPolling(sink, () => null, opts);
    expect(() => guarded.emit(commandDraft("sleep 60", "in_progress"))).not.toThrow();
  });

  it("does not wake after the run is terminal", () => {
    const sink: RunEventSink = { emit: vi.fn() };
    const { runtime, wake } = fakeRuntime();
    const control = new RunControl(defaultExecutionPolicy);
    control.stop("root_deadline", "done");
    const guarded = guardLeaderSleepPolling(sink, () => runtime, { ...opts, control });
    guarded.emit(commandDraft("sleep 60", "in_progress"));
    expect(wake).not.toHaveBeenCalled();
    control.close();
  });

  it("limits healing-enabled sleep steering to one advisory intervention", () => {
    const sink: RunEventSink = { emit: vi.fn() };
    const { runtime, wake } = fakeRuntime();
    const guarded = guardLeaderSleepPolling(sink, () => runtime, {
      ...opts,
      healingEnabled: true,
    });
    guarded.emit(commandDraft("sleep 60", "in_progress"));
    guarded.emit(commandDraft("sleep 60", "in_progress"));
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("kills mutation: hide a repeated sleep operation inside normalized trajectory events", () => {
    const sink: RunEventSink = { emit: vi.fn() };
    const { runtime, wake } = fakeRuntime();
    const observe = vi.fn()
      .mockReturnValueOnce({ action: "continue" })
      .mockReturnValueOnce({ action: "warn" })
      .mockReturnValueOnce({ action: "stop", reason: "repeated_signature" });
    const guarded = guardLeaderSleepPolling(sink, () => runtime, {
      ...opts,
      healingEnabled: true,
      monitor: { observe },
    });
    guarded.emit(commandDraft("sleep 60", "in_progress"));
    guarded.emit(commandDraft("sleep 60", "in_progress"));
    guarded.emit(commandDraft("sleep 60", "in_progress"));
    expect(wake).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(3);
    expect(observe.mock.results[2]?.value).toMatchObject({
      action: "stop",
      reason: "repeated_signature",
    });
  });
});
