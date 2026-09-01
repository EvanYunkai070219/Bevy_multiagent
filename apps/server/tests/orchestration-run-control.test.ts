/** Root deadline, cancellation, and terminal-priority races. */
import { afterEach, describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import {
  RunControl,
  RunTerminalError,
  type RootTerminalReason,
  type RunClock,
} from "../src/orchestration/run-control.js";
import type { ExecutionPolicy } from "../src/types.js";

function tinyPolicy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    ...defaultExecutionPolicy,
    budgetAdvisoryTokens: 500,
    budgetSevereTokens: 900,
    budgetAdvisoryModelCalls: 2,
    budgetSevereModelCalls: 4,
    emergencyTokenFuse: 10_000,
    emergencyModelCallFuse: 100,
    rootTimeoutMs: 1_000,
    ...overrides,
  };
}

function createClock(start = 0): RunClock & { advance(ms: number): void } {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fireAt: now + Number(ms), fn: fn as () => void });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(id) {
      timers.delete(id as unknown as number);
    },
    advance(ms: number) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.fireAt <= now)
        .sort((left, right) => left[1].fireAt - right[1].fireAt);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

const openControls: RunControl[] = [];

function control(policy?: ExecutionPolicy, clock?: RunClock): RunControl {
  const created = new RunControl(policy ?? tinyPolicy(), clock);
  openControls.push(created);
  return created;
}

afterEach(() => {
  while (openControls.length > 0) openControls.pop()?.close();
});

describe("RunControl.race", () => {
  it("rejects a never-resolving promise at the root deadline and cancels once", async () => {
    const clock = createClock();
    const run = control(tinyPolicy({ rootTimeoutMs: 25 }), clock);
    let cancels = 0;
    const pending = run.race(new Promise<string>(() => undefined), () => {
      cancels += 1;
    });
    clock.advance(25);
    await expect(pending).rejects.toMatchObject({ reason: "root_deadline" });
    expect(cancels).toBe(1);
    expect(run.snapshot().terminalReason).toBe("root_deadline");
  });

  it("wakes every terminal listener exactly once when the deadline fires", async () => {
    const clock = createClock();
    const run = control(tinyPolicy({ rootTimeoutMs: 10 }), clock);
    const reasons: RootTerminalReason[] = [];
    run.onTerminal((error) => reasons.push(error.reason));
    run.onTerminal((error) => reasons.push(error.reason));
    const pending = run.race(new Promise<void>(() => undefined));
    clock.advance(10);
    await expect(pending).rejects.toBeInstanceOf(RunTerminalError);
    expect(reasons).toEqual(["root_deadline", "root_deadline"]);
  });

  it("denies later admission after the deadline", async () => {
    const clock = createClock();
    const run = control(tinyPolicy({ rootTimeoutMs: 5 }), clock);
    const pending = run.race(new Promise<void>(() => undefined));
    clock.advance(5);
    await expect(pending).rejects.toMatchObject({ reason: "root_deadline" });
    expect(() => run.assertActive()).toThrow(RunTerminalError);
    expect(() => run.budget.reserve("root", 1, 1)).toThrow(RunTerminalError);
    expect(run.remainingMs()).toBe(0);
  });

  it("invokes a race cancellation callback only once across repeated stop", async () => {
    const run = control();
    let cancels = 0;
    const pending = run.race(new Promise<void>(() => undefined), () => {
      cancels += 1;
    });
    run.stop("user_cancelled", "first");
    run.stop("user_cancelled", "again");
    await expect(pending).rejects.toMatchObject({ reason: "user_cancelled" });
    expect(cancels).toBe(1);
  });
});

describe("terminal priority", () => {
  it("keeps an emergency fuse from being overwritten by a later deadline", async () => {
    const clock = createClock();
    const run = control(tinyPolicy({
      emergencyTokenFuse: 456,
      rootTimeoutMs: 50,
    }), clock);
    run.budget.reserve("root", 100, 100);
    try {
      run.budget.reserve("root", 100, 100);
    } catch (error) {
      expect(error).toMatchObject({ reason: "emergency_token_fuse" });
    }
    const pending = run.race(new Promise<void>(() => undefined));
    clock.advance(50);
    await expect(pending).rejects.toMatchObject({ reason: "emergency_token_fuse" });
    expect(run.snapshot().terminalReason).toBe("emergency_token_fuse");
  });

  it("lets user cancellation replace a deadline and an emergency fuse", () => {
    const run = control();
    expect(run.stop("root_deadline", "time").reason).toBe("root_deadline");
    expect(run.stop("emergency_token_fuse", "fuse").reason).toBe("emergency_token_fuse");
    expect(run.stop("root_deadline", "later").reason).toBe("emergency_token_fuse");
    expect(run.stop("provider_rate_limited", "429").reason).toBe("emergency_token_fuse");
    expect(run.stop("user_cancelled", "user").reason).toBe("user_cancelled");
    expect(run.stop("emergency_model_call_fuse", "calls").reason).toBe("user_cancelled");
    expect(run.snapshot().terminalReason).toBe("user_cancelled");
  });

  it("treats repeated stop as idempotent", () => {
    const run = control();
    const first = run.stop("user_cancelled", "stop");
    const second = run.stop("user_cancelled", "again");
    expect(second).toBe(first);
    expect(first.reason).toBe("user_cancelled");
  });

  it("never lets a throwing listener weaken synchronous denial", () => {
    const run = control();
    run.onTerminal(() => {
      throw new Error("listener failed");
    });
    expect(() => run.stop("user_cancelled", "stop")).not.toThrow();
    expect(() => run.assertActive()).toThrow(RunTerminalError);
    expect(() => run.budget.reserve("root", 1, 1)).toThrow(RunTerminalError);
    expect(run.snapshot().terminalReason).toBe("user_cancelled");
  });

  it("promotes provider_rate_limited over a deadline but not over an emergency fuse", () => {
    const run = control();
    run.stop("root_deadline", "time");
    expect(run.stop("provider_rate_limited", "429").reason).toBe("provider_rate_limited");
    expect(run.stop("emergency_model_call_fuse", "calls").reason).toBe("emergency_model_call_fuse");
    expect(run.stop("provider_rate_limited", "again").reason).toBe("emergency_model_call_fuse");
  });
});

describe("RunControl clock", () => {
  it("reports remaining time from the injected clock", () => {
    const clock = createClock(1_000);
    const run = control(tinyPolicy({ rootTimeoutMs: 500 }), clock);
    expect(run.remainingMs()).toBe(500);
    clock.advance(200);
    expect(run.remainingMs()).toBe(300);
  });

  it("latches the deadline from assertActive without waiting for race", () => {
    const clock = createClock();
    const run = control(tinyPolicy({ rootTimeoutMs: 10 }), clock);
    clock.advance(10);
    expect(() => run.assertActive()).toThrow(RunTerminalError);
    expect(run.snapshot().terminalReason).toBe("root_deadline");
  });
});
