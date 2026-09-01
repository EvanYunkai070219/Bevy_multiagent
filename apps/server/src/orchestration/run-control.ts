import { BudgetLedger } from "./workers/budget.js";
import type { BudgetSnapshot, ExecutionPolicy } from "../types.js";

export type RootTerminalReason =
  | "root_deadline"
  | "emergency_token_fuse"
  | "emergency_model_call_fuse"
  | "provider_rate_limited"
  | "user_cancelled";

export interface RunClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}

export class RunTerminalError extends Error {
  constructor(
    readonly reason: RootTerminalReason,
    message: string,
  ) {
    super(message);
    this.name = "RunTerminalError";
  }
}

const TERMINAL_PRIORITY: Record<RootTerminalReason, number> = {
  root_deadline: 1,
  provider_rate_limited: 2,
  emergency_token_fuse: 3,
  emergency_model_call_fuse: 3,
  user_cancelled: 4,
};

const defaultClock: RunClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

/**
 * One run-wide terminal latch. Advisory budget crossings never stop a run;
 * only deadline, emergency fuses, provider 429, and user cancellation do.
 */
export class RunControl {
  readonly budget: BudgetLedger;
  private readonly clock: RunClock;
  private readonly deadlineMs: number | null;
  private readonly listeners = new Set<(error: RunTerminalError) => void>();
  private terminal: RunTerminalError | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(policy: ExecutionPolicy, clock: RunClock = defaultClock) {
    this.clock = clock;
    this.deadlineMs = policy.rootTimeoutMs === null ? null : clock.now() + policy.rootTimeoutMs;
    this.budget = new BudgetLedger({
      stop: (reason, message) => this.stop(reason, message),
      assertActive: () => this.assertActive(),
      deadlineAt: () => this.deadlineMs === null ? null : new Date(this.deadlineMs).toISOString(),
      terminalReason: () => this.terminal?.reason ?? null,
    }, policy);
  }

  assertActive(): void {
    this.latchDeadlineIfElapsed();
    if (this.terminal) throw this.terminal;
  }

  remainingMs(): number {
    if (this.deadlineMs === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.deadlineMs - this.clock.now());
  }

  onTerminal(listener: (error: RunTerminalError) => void): () => void {
    this.listeners.add(listener);
    if (this.terminal) this.notify(listener, this.terminal);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stop(reason: RootTerminalReason, message: string): RunTerminalError {
    const current = this.terminal;
    if (current && TERMINAL_PRIORITY[reason] <= TERMINAL_PRIORITY[current.reason]) {
      return current;
    }
    const error = new RunTerminalError(reason, message);
    this.terminal = error;
    this.clearDeadlineTimer();
    for (const listener of this.listeners) this.notify(listener, error);
    return error;
  }

  race<T>(
    operation: Promise<T>,
    cancel?: () => Promise<void> | void,
  ): Promise<T> {
    return this.raceOutcome(operation, cancel).then((outcome) => {
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    });
  }

  /** Always settles. Used at chokepoints that must not leak a detached rejection. */
  raceOutcome<T>(
    operation: Promise<T>,
    cancel?: () => Promise<void> | void,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    this.latchDeadlineIfElapsed();
    this.armDeadline();
    if (this.terminal) {
      return Promise.resolve(this.safeCancel(cancel)).then(() => ({
        ok: false as const,
        error: this.terminal,
      }));
    }

    let settled = false;
    let cancelled = false;
    return new Promise((resolve) => {
      const finish = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (error !== undefined) resolve({ ok: false, error });
        else resolve({ ok: true, value: value as T });
      };
      const unsubscribe = this.onTerminal((error) => {
        if (cancelled) {
          finish(error);
          return;
        }
        cancelled = true;
        void Promise.resolve(this.safeCancel(cancel)).then(
          () => finish(error),
          () => finish(error),
        );
      });
      void operation.then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
    });
  }

  snapshot(): BudgetSnapshot {
    return this.budget.snapshot();
  }

  close(): void {
    this.clearDeadlineTimer();
  }

  private armDeadline(): void {
    if (this.deadlineTimer !== undefined || this.terminal) return;
    if (this.deadlineMs === null) return;
    const remaining = this.remainingMs();
    if (remaining === 0) {
      this.stop("root_deadline", "Root deadline elapsed");
      return;
    }
    this.deadlineTimer = this.clock.setTimeout(() => {
      this.stop("root_deadline", "Root deadline elapsed");
    }, remaining);
  }

  private latchDeadlineIfElapsed(): void {
    if (this.terminal) return;
    if (this.deadlineMs === null) return;
    if (this.clock.now() >= this.deadlineMs) {
      this.stop("root_deadline", "Root deadline elapsed");
    }
  }

  private clearDeadlineTimer(): void {
    if (this.deadlineTimer === undefined) return;
    this.clock.clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
  }

  private notify(
    listener: (error: RunTerminalError) => void,
    error: RunTerminalError,
  ): void {
    try {
      const returned = listener(error) as unknown;
      if (returned && typeof (returned as Promise<unknown>).then === "function") {
        void (returned as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      // A listener failure must not weaken synchronous denial.
    }
  }

  private async safeCancel(cancel?: () => Promise<void> | void): Promise<void> {
    if (cancel === undefined) return;
    try {
      await cancel();
    } catch {
      // Cancellation is best-effort; the terminal error still wins.
    }
  }
}
