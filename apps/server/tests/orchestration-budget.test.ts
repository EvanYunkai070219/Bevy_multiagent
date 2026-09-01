/** Advisory reservations, sticky warnings, and emergency-fuse arithmetic. */
import { describe, expect, it } from "vitest";
import {
  emitBudgetNotices,
  emitBudgetTerminal,
  persistHealingBudget,
  publishBudgetAdmission,
  publishBudgetReconciliation,
} from "../src/orchestration/workers/budget-events.js";
import { WORKER_ADVISORY_TOKENS } from "../src/orchestration/workers/budget.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import {
  RunControl,
  RunTerminalError,
  type RunClock,
} from "../src/orchestration/run-control.js";
import type { RunEventDraft, RunEventSink } from "../src/run-events.js";
import type { ExecutionPolicy } from "../src/types.js";
import { emptyHealingState } from "../src/types.js";

const SAFETY_TOKENS = 256;
const RESERVE_INPUT = 100;
const RESERVE_OUTPUT = 100;
const RESERVATION_COST = RESERVE_INPUT + SAFETY_TOKENS + RESERVE_OUTPUT;

function tinyPolicy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    ...defaultExecutionPolicy,
    budgetAdvisoryTokens: 500,
    budgetSevereTokens: 900,
    budgetAdvisoryModelCalls: 2,
    budgetSevereModelCalls: 4,
    emergencyTokenFuse: RESERVATION_COST * 3,
    emergencyModelCallFuse: 10,
    rootTimeoutMs: 60_000,
    ...overrides,
  };
}

function collectingSink(drafts: RunEventDraft[]): RunEventSink {
  return { emit: (draft) => { drafts.push(draft); } };
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

describe("budget reservation arithmetic", () => {
  it("reserves estimated input plus 256 safety tokens plus maximum output", () => {
    const control = new RunControl(tinyPolicy());
    const reservation = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    expect(reservation.reservedTokens).toBe(456);
    expect(control.snapshot().reservedTokens).toBe(456);
    expect(control.snapshot().usedModelCalls).toBe(1);
  });

  it("keeps the advisory warning after reconciliation drops current usage", () => {
    const control = new RunControl(tinyPolicy({ budgetAdvisoryTokens: 400 }));
    const reservation = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    expect(reservation.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: "advisory",
        metric: "tokens",
        observed: 456,
        threshold: 400,
      }),
    ]));
    expect(control.snapshot().warningLevel).toBe("advisory");

    control.budget.reconcile(reservation, { inputTokens: 10, outputTokens: 5 });
    expect(control.snapshot().reservedTokens).toBe(15);
    expect(control.snapshot().actualInputTokens).toBe(10);
    expect(control.snapshot().actualOutputTokens).toBe(5);
    expect(control.snapshot().warningLevel).toBe("advisory");
  });

  it("keeps the severe warning after usage falls below both token thresholds", () => {
    const control = new RunControl(tinyPolicy({
      budgetAdvisoryTokens: 200,
      budgetSevereTokens: 400,
    }));
    const reservation = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    expect(reservation.notices.some((notice) => notice.level === "severe")).toBe(true);
    expect(control.snapshot().warningLevel).toBe("severe");

    control.budget.reconcile(reservation, { inputTokens: 1, outputTokens: 1 });
    expect(control.snapshot().reservedTokens).toBe(2);
    expect(control.snapshot().warningLevel).toBe("severe");
  });

  it("admits a reservation that lands exactly on the emergency token fuse", () => {
    const control = new RunControl(tinyPolicy({ emergencyTokenFuse: RESERVATION_COST }));
    const reservation = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    expect(reservation.reservedTokens).toBe(456);
    expect(control.snapshot().reservedTokens).toBe(456);
    expect(control.snapshot().terminalReason).toBeNull();
  });

  it("denies the next call after exact emergency token-fuse equality", () => {
    const control = new RunControl(tinyPolicy({ emergencyTokenFuse: RESERVATION_COST }));
    control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    expect(() => control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT))
      .toThrow(RunTerminalError);
    try {
      control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    } catch (error) {
      expect(error).toMatchObject({ reason: "emergency_token_fuse" });
    }
    expect(control.snapshot().terminalReason).toBe("emergency_token_fuse");
    expect(control.snapshot().reservedTokens).toBe(456);
  });

  it("denies the next call after exact emergency model-call fuse equality", () => {
    const control = new RunControl(tinyPolicy({
      emergencyTokenFuse: 100_000,
      emergencyModelCallFuse: 3,
    }));
    control.budget.reserve("root", 1, 1);
    control.budget.reserve("root", 1, 1);
    control.budget.reserve("root", 1, 1);
    expect(control.snapshot().usedModelCalls).toBe(3);
    expect(() => control.budget.reserve("root", 1, 1)).toThrow(RunTerminalError);
    expect(control.snapshot().terminalReason).toBe("emergency_model_call_fuse");
    expect(control.snapshot().usedModelCalls).toBe(3);
  });
});

describe("per-call output caps", () => {
  it("caps safeMaxOutputTokens to a per-call share instead of the entire remaining fuse", () => {
    const control = new RunControl(tinyPolicy({ emergencyTokenFuse: 10_000_000 }));
    const cap = control.budget.safeMaxOutputTokens(100);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(WORKER_ADVISORY_TOKENS);
    expect(cap).toBeLessThan(10_000_000 - 100 - SAFETY_TOKENS);
  });

  it("admits two overlapping per-call reservations without tripping the emergency fuse", () => {
    const control = new RunControl(tinyPolicy({ emergencyTokenFuse: 10_000_000 }));
    const firstCap = control.budget.safeMaxOutputTokens(100);
    const first = control.budget.reserve("root", 100, firstCap);
    const secondCap = control.budget.safeMaxOutputTokens(100);
    expect(secondCap).toBeGreaterThan(0);
    const second = control.budget.reserve("root", 100, secondCap);
    expect(control.snapshot().terminalReason).toBeNull();
    expect(first.reservedTokens + second.reservedTokens).toBeLessThan(10_000_000);
    expect(control.snapshot().reservedTokens).toBe(first.reservedTokens + second.reservedTokens);
  });
});

describe("budget reservation races", () => {
  it("admits three of ten concurrent reservations against a three-call fuse twenty times", async () => {
    const policy = tinyPolicy();
    expect(policy.emergencyTokenFuse).toBe(1368);

    for (let round = 0; round < 20; round += 1) {
      const control = new RunControl(policy);
      const reservations = await Promise.allSettled(
        Array.from({ length: 10 }, () => Promise.resolve().then(() =>
          control.budget.reserve("root", 100, 100))),
      );
      expect(reservations.filter((item) => item.status === "fulfilled")).toHaveLength(3);
      expect(control.snapshot().reservedTokens).toBeLessThanOrEqual(policy.emergencyTokenFuse);
      expect(control.snapshot().terminalReason).toBe("emergency_token_fuse");
    }
  });
});

describe("budget reconciliation", () => {
  it("replaces the reservation with provider-reported actual usage", () => {
    const control = new RunControl(tinyPolicy());
    const reservation = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    control.budget.reconcile(reservation, { inputTokens: 40, outputTokens: 20 });
    expect(control.snapshot()).toMatchObject({
      reservedTokens: 60,
      actualInputTokens: 40,
      actualOutputTokens: 20,
      usedModelCalls: 1,
    });
  });

  it("records a provider overrun as telemetry and denies only the next admission", () => {
    const control = new RunControl(tinyPolicy({ emergencyTokenFuse: 1_000 }));
    const reservation = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    control.budget.reconcile(reservation, { inputTokens: 2_000, outputTokens: 100 });
    expect(control.snapshot()).toMatchObject({
      reservedTokens: 2_100,
      actualInputTokens: 2_000,
      actualOutputTokens: 100,
      terminalReason: null,
    });
    expect(() => control.budget.reserve("root", 1, 1)).toThrow(RunTerminalError);
    expect(control.snapshot().terminalReason).toBe("emergency_token_fuse");
    expect(control.snapshot().actualInputTokens).toBe(2_000);
    expect(control.snapshot().actualOutputTokens).toBe(100);
  });

  it("surfaces advisory and severe notices when reconciliation first crosses those thresholds", () => {
    const drafts: RunEventDraft[] = [];
    const healing = emptyHealingState();
    const control = new RunControl(tinyPolicy({
      budgetAdvisoryTokens: 500,
      budgetSevereTokens: 900,
      emergencyTokenFuse: 100_000,
    }));
    const reservation = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    expect(reservation.notices.some((notice) => notice.metric === "tokens")).toBe(false);

    const notices = control.budget.reconcile(reservation, {
      inputTokens: 2_000,
      outputTokens: 100,
    });
    expect(notices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: "advisory",
        metric: "tokens",
        observed: 2_100,
        threshold: 500,
      }),
      expect.objectContaining({
        level: "severe",
        metric: "tokens",
        observed: 2_100,
        threshold: 900,
      }),
    ]));

    publishBudgetReconciliation({
      sink: collectingSink(drafts),
      healing,
      notices,
      snapshot: control.snapshot(),
    });
    expect(drafts.map((draft) => draft.name)).toEqual(["budget_advisory", "budget_severe"]);
    expect(healing.budget?.warningLevel).toBe("severe");
    expect(healing.budget?.reservedTokens).toBe(2_100);

    const followUp = control.budget.reserve("root", 1, 1);
    expect(followUp.notices.some((notice) => notice.metric === "tokens")).toBe(false);
  });

  it("releases outstanding tokens without rewriting committed usage", () => {
    const control = new RunControl(tinyPolicy());
    const kept = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    const dropped = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    control.budget.reconcile(kept, { inputTokens: 12, outputTokens: 8 });
    control.budget.release(dropped);
    expect(control.snapshot()).toMatchObject({
      reservedTokens: 20,
      actualInputTokens: 12,
      actualOutputTokens: 8,
      usedModelCalls: 2,
      terminalReason: null,
    });
  });

  it("ignores duplicate reconciliation of the same reservation", () => {
    const control = new RunControl(tinyPolicy());
    const reservation = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    control.budget.reconcile(reservation, { inputTokens: 30, outputTokens: 10 });
    control.budget.reconcile(reservation, { inputTokens: 99, outputTokens: 99 });
    expect(control.snapshot()).toMatchObject({
      reservedTokens: 40,
      actualInputTokens: 30,
      actualOutputTokens: 10,
    });
  });

  it("never lets estimated dollars deny admission or latch a terminal reason", () => {
    const control = new RunControl(tinyPolicy({ emergencyTokenFuse: 100_000 }));
    const healing = emptyHealingState();
    const first = control.budget.reserve("root", 1, 1);
    control.budget.reconcile(first, { inputTokens: 1, outputTokens: 1 });
    persistHealingBudget(healing, {
      ...control.snapshot(),
      estimatedDollars: 1_000_000,
    });
    expect(healing.budget?.estimatedDollars).toBe(1_000_000);
    expect(() => control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT)).not.toThrow();
    expect(control.snapshot().terminalReason).toBeNull();
    expect(control.snapshot().estimatedDollars).toBeNull();
  });
});

describe("scoped advisory notices", () => {
  it("reports calls, reservations, and actual tokens for one repair scope", () => {
    const control = new RunControl(tinyPolicy({ emergencyTokenFuse: 100_000 }));
    control.budget.openScope("repair:candidate-1", 6, 32_000);
    const reconciled = control.budget.reserve("repair:candidate-1", 100, 100);
    control.budget.reconcile(reconciled, { inputTokens: 10, outputTokens: 5 });
    const outstanding = control.budget.reserve("repair:candidate-1", 20, 30);

    expect(control.budget.usageOf("repair:candidate-1")).toEqual({
      modelCalls: 2,
      reservedTokens: 321,
      actualInputTokens: 10,
      actualOutputTokens: 5,
    });

    control.budget.release(outstanding);
    expect(control.budget.usageOf("repair:candidate-1")?.reservedTokens).toBe(15);
    expect(control.budget.usageOf("missing")).toBeUndefined();
  });

  it("emits a worker-scope advisory at six calls without denying", () => {
    const control = new RunControl(tinyPolicy({
      emergencyTokenFuse: 100_000,
      emergencyModelCallFuse: 1_000,
    }));
    expect(control.budget.openScope("worker-1", 6, 32_000)).toBe("worker-1");
    let notices: { level: string; metric: string; observed: number; threshold: number }[] = [];
    for (let index = 0; index < 6; index += 1) {
      const reservation = control.budget.reserve("worker-1", 10, 10);
      notices = reservation.notices;
      control.budget.reconcile(reservation, { inputTokens: 1, outputTokens: 1 });
    }
    expect(notices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: "advisory",
        metric: "calls",
        observed: 6,
        threshold: 6,
      }),
    ]));
    expect(control.snapshot().terminalReason).toBeNull();
    expect(() => control.budget.reserve("worker-1", 10, 10)).not.toThrow();
  });

  it("emits a repair-scope advisory at 32,000 reserved tokens without denying", () => {
    const control = new RunControl(tinyPolicy({
      budgetAdvisoryTokens: 1_000_000,
      budgetSevereTokens: 2_000_000,
      emergencyTokenFuse: 10_000_000,
    }));
    control.budget.openScope("repair-1", 6, 32_000);
    const reservation = control.budget.reserve("repair-1", 16_000, 16_000);
    expect(reservation.reservedTokens).toBe(32_256);
    expect(reservation.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: "advisory",
        metric: "tokens",
        observed: 32_256,
        threshold: 32_000,
      }),
    ]));
    expect(control.snapshot().warningLevel).toBeNull();
    expect(control.snapshot().terminalReason).toBeNull();
  });

  it("records root call advisories independently of worker notices", () => {
    const control = new RunControl(tinyPolicy({
      budgetAdvisoryModelCalls: 2,
      budgetSevereModelCalls: 4,
      emergencyModelCallFuse: 100,
      emergencyTokenFuse: 100_000,
    }));
    control.budget.reserve("root", 1, 1);
    const second = control.budget.reserve("root", 1, 1);
    expect(second.notices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: "advisory",
        metric: "calls",
        observed: 2,
        threshold: 2,
      }),
    ]));
  });
});

describe("budget events and sticky healing persistence", () => {
  it("emits arithmetic-only advisory and severe notices for the crossing scope", () => {
    const drafts: RunEventDraft[] = [];
    const control = new RunControl(tinyPolicy({
      budgetAdvisoryTokens: 400,
      budgetSevereTokens: 450,
    }));
    const reservation = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    emitBudgetNotices(collectingSink(drafts), reservation);

    expect(drafts.map((draft) => draft.name)).toEqual(["budget_advisory", "budget_severe"]);
    expect(drafts[0]).toMatchObject({
      status: "warning",
      attributes: {
        scope: "root",
        metric: "tokens",
        observed: 456,
        threshold: 400,
      },
    });
    expect(drafts[1]).toMatchObject({
      status: "warning",
      attributes: {
        scope: "root",
        metric: "tokens",
        observed: 456,
        threshold: 450,
      },
    });
    expect(JSON.stringify(drafts)).not.toMatch(/dollar|price|prompt|model/i);
  });

  it("gives token and call advisories on the same scope distinct span ids", () => {
    const drafts: RunEventDraft[] = [];
    const control = new RunControl(tinyPolicy({
      budgetAdvisoryTokens: 400,
      budgetSevereTokens: 10_000,
      budgetAdvisoryModelCalls: 1,
      budgetSevereModelCalls: 8,
      emergencyTokenFuse: 100_000,
      emergencyModelCallFuse: 100,
    }));
    const reservation = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    emitBudgetNotices(collectingSink(drafts), reservation);
    const spanIds = drafts.map((draft) => draft.spanId);
    expect(spanIds).toEqual(expect.arrayContaining([
      "budget_advisory-root-tokens",
      "budget_advisory-root-calls",
    ]));
    expect(new Set(spanIds).size).toBe(spanIds.length);
  });

  it("emits a terminal error event with only scope, thresholds, observed arithmetic, and reason", () => {
    const drafts: RunEventDraft[] = [];
    const control = new RunControl(tinyPolicy({ emergencyTokenFuse: RESERVATION_COST }));
    control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    try {
      control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    } catch (error) {
      expect(error).toBeInstanceOf(RunTerminalError);
      emitBudgetTerminal(
        collectingSink(drafts),
        error as RunTerminalError,
        control.snapshot(),
      );
    }
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      status: "error",
      attributes: {
        scope: "root",
        reason: "emergency_token_fuse",
        observed: 456,
        threshold: 456,
      },
    });
    expect(Object.keys(drafts[0]!.attributes).sort()).toEqual([
      "observed",
      "reason",
      "scope",
      "threshold",
    ]);
  });

  it("emits unit-consistent observed and threshold arithmetic for every terminal reason", () => {
    const tokenDrafts: RunEventDraft[] = [];
    const tokenControl = new RunControl(tinyPolicy({ emergencyTokenFuse: RESERVATION_COST }));
    tokenControl.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    try {
      tokenControl.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    } catch (error) {
      emitBudgetTerminal(collectingSink(tokenDrafts), error as RunTerminalError, tokenControl.snapshot());
    }
    expect(tokenDrafts[0]?.attributes).toMatchObject({
      reason: "emergency_token_fuse",
      observed: 456,
      threshold: 456,
    });

    const callDrafts: RunEventDraft[] = [];
    const callControl = new RunControl(tinyPolicy({
      emergencyTokenFuse: 100_000,
      emergencyModelCallFuse: 1,
    }));
    try {
      callControl.budget.reserve("root", 1, 1);
      callControl.budget.reserve("root", 1, 1);
    } catch (error) {
      emitBudgetTerminal(collectingSink(callDrafts), error as RunTerminalError, callControl.snapshot());
    }
    expect(callDrafts[0]?.attributes).toMatchObject({
      reason: "emergency_model_call_fuse",
      observed: 1,
      threshold: 1,
    });

    const deadlineDrafts: RunEventDraft[] = [];
    const clock = createClock();
    const deadlineControl = new RunControl(tinyPolicy({ rootTimeoutMs: 1_000 }), clock);
    clock.advance(1_000);
    try {
      deadlineControl.assertActive();
    } catch (error) {
      emitBudgetTerminal(
        collectingSink(deadlineDrafts),
        error as RunTerminalError,
        deadlineControl.snapshot(),
        { elapsedMs: 1_000, rootTimeoutMs: 1_000 },
      );
    }
    expect(deadlineDrafts[0]?.attributes).toMatchObject({
      reason: "root_deadline",
      observed: 1_000,
      threshold: 1_000,
    });
    expect(Object.keys(deadlineDrafts[0]!.attributes).sort()).toEqual([
      "observed",
      "reason",
      "scope",
      "threshold",
    ]);

    for (const reason of ["provider_rate_limited", "user_cancelled"] as const) {
      const drafts: RunEventDraft[] = [];
      const control = new RunControl(tinyPolicy());
      const error = control.stop(reason, reason);
      emitBudgetTerminal(collectingSink(drafts), error, control.snapshot());
      expect(drafts[0]?.attributes).toEqual({ scope: "root", reason });
      expect(drafts[0]?.attributes).not.toHaveProperty("observed");
      expect(drafts[0]?.attributes).not.toHaveProperty("threshold");
    }
  });

  it("updates root healing.budget after admission and reconciliation", () => {
    const healing = emptyHealingState();
    const control = new RunControl(tinyPolicy({ budgetAdvisoryTokens: 400 }));
    const reservation = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    publishBudgetAdmission({
      healing,
      reservation,
      snapshot: control.snapshot(),
    });
    expect(healing.budget?.warningLevel).toBe("advisory");
    expect(healing.budget?.reservedTokens).toBe(456);

    control.budget.reconcile(reservation, { inputTokens: 8, outputTokens: 2 });
    persistHealingBudget(healing, control.snapshot());
    expect(healing.budget).toMatchObject({
      reservedTokens: 10,
      actualInputTokens: 8,
      actualOutputTokens: 2,
      warningLevel: "advisory",
      terminalReason: null,
    });
  });

  it("keeps ledger behavior when the event sink throws", () => {
    const healing = emptyHealingState();
    const control = new RunControl(tinyPolicy({ budgetAdvisoryTokens: 400 }));
    const reservation = control.budget.reserve("root", RESERVE_INPUT, RESERVE_OUTPUT);
    expect(() => publishBudgetAdmission({
      sink: { emit: () => { throw new Error("sink down"); } },
      healing,
      reservation,
      snapshot: control.snapshot(),
    })).not.toThrow();
    expect(healing.budget?.reservedTokens).toBe(456);
    expect(() => control.budget.reserve("root", 1, 1)).not.toThrow();
    expect(control.snapshot().usedModelCalls).toBe(2);
  });
});

describe("production policy defaults", () => {
  it("keeps collaboration ceilings while orchestration fuses default off", () => {
    expect(defaultExecutionPolicy).toMatchObject({
      maxParallel: 10,
      maxSubtasks: 10,
      maxIterations: 2,
      maxTotalWorkerRuns: 30,
      maxFollowUpTurnsPerWorker: 3,
      workerTimeoutMs: null,
      maxRepairTournaments: 1,
      maxRepairBranches: 3,
      repairBranchTimeoutMs: 240_000,
      budgetAdvisoryTokens: null,
      budgetSevereTokens: null,
      budgetAdvisoryModelCalls: null,
      budgetSevereModelCalls: null,
      emergencyTokenFuse: null,
      emergencyModelCallFuse: null,
      rootTimeoutMs: null,
      maxRuntimeSteps: null,
      repeatedSignatureLimit: null,
      trajectoryCheckpointMs: 60_000,
    });
  });
});
