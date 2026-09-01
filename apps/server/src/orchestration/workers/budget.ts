import { randomUUID } from "node:crypto";
import type { RootTerminalReason, RunTerminalError } from "../run-control.js";
import type { BudgetSnapshot, ExecutionPolicy, RunUsage } from "../../types.js";

const SAFETY_TOKENS = 256;
export const WORKER_ADVISORY_CALLS = 6;
export const WORKER_ADVISORY_TOKENS = 32_000;
/** Per-call output cap so one reservation cannot consume the emergency fuse. */
export const CALL_MAX_OUTPUT_TOKENS = WORKER_ADVISORY_TOKENS;

export interface BudgetHost {
  stop(reason: RootTerminalReason, message: string): RunTerminalError;
  assertActive(): void;
  deadlineAt(): string | null;
  terminalReason(): string | null;
}

export interface BudgetReservation {
  id: string;
  scopeId: string;
  reservedTokens: number;
  notices: BudgetNotice[];
}

export interface BudgetNotice {
  scopeId: string;
  level: "advisory" | "severe";
  metric: "tokens" | "calls";
  observed: number;
  threshold: number;
}

interface ScopeState {
  id: string;
  advisoryCalls: number | null;
  advisoryTokens: number | null;
  severeCalls: number | null;
  severeTokens: number | null;
  calls: number;
  committedTokens: number;
  outstandingTokens: number;
  inputTokens: number;
  outputTokens: number;
  emitted: Set<string>;
}

/**
 * Synchronous admission ledger for one root run. Ordinary thresholds are
 * sticky telemetry; only the emergency fuses deny the next call.
 */
export class BudgetLedger {
  private readonly root: ScopeState;
  private readonly scopes = new Map<string, ScopeState>();
  private readonly reservations = new Map<string, BudgetReservation>();
  private peakWarning: "advisory" | "severe" | null = null;

  constructor(
    private readonly host: BudgetHost,
    private readonly policy: ExecutionPolicy,
  ) {
    this.root = this.createScope(
      "root",
      policy.budgetAdvisoryModelCalls,
      policy.budgetAdvisoryTokens,
      policy.budgetSevereModelCalls,
      policy.budgetSevereTokens,
    );
    this.scopes.set(this.root.id, this.root);
  }

  openScope(scopeId: string, advisoryCalls: number, advisoryTokens: number): string {
    const existing = this.scopes.get(scopeId);
    if (existing) return existing.id;
    this.scopes.set(
      scopeId,
      this.createScope(scopeId, advisoryCalls, advisoryTokens, null, null),
    );
    return scopeId;
  }

  reserve(
    scopeId: string,
    estimatedInputTokens: number,
    maxOutputTokens: number,
  ): BudgetReservation {
    this.host.assertActive();
    const child = this.scopes.get(scopeId)
      ?? this.scopes.get(this.openScope(scopeId, WORKER_ADVISORY_CALLS, WORKER_ADVISORY_TOKENS))!;
    const requested = Math.max(0, estimatedInputTokens) + SAFETY_TOKENS + Math.max(0, maxOutputTokens);

    if (
      this.policy.emergencyModelCallFuse !== null &&
      this.root.calls >= this.policy.emergencyModelCallFuse
    ) {
      throw this.host.stop(
        "emergency_model_call_fuse",
        "Emergency model-call fuse reached",
      );
    }
    if (
      this.policy.emergencyTokenFuse !== null &&
      this.root.committedTokens + this.root.outstandingTokens + requested >
      this.policy.emergencyTokenFuse
    ) {
      throw this.host.stop("emergency_token_fuse", "Emergency token fuse reached");
    }

    this.root.calls += 1;
    this.root.outstandingTokens += requested;
    if (child !== this.root) {
      child.calls += 1;
      child.outstandingTokens += requested;
    }

    const reservation: BudgetReservation = {
      id: randomUUID(),
      scopeId: child.id,
      reservedTokens: requested,
      notices: [
        ...this.collectNotices(this.root),
        ...(child === this.root ? [] : this.collectNotices(child)),
      ],
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  reconcile(reservation: BudgetReservation, usage: RunUsage | null): BudgetNotice[] {
    if (!this.reservations.delete(reservation.id)) return [];
    const input = usage?.inputTokens ?? 0;
    const output = usage?.outputTokens ?? 0;
    const notices = this.commit(this.root, reservation.reservedTokens, input, output);
    const child = this.scopes.get(reservation.scopeId);
    if (child && child !== this.root) {
      notices.push(...this.commit(child, reservation.reservedTokens, input, output));
    }
    return notices;
  }

  release(reservation: BudgetReservation): void {
    if (!this.reservations.delete(reservation.id)) return;
    this.root.outstandingTokens = Math.max(
      0,
      this.root.outstandingTokens - reservation.reservedTokens,
    );
    const child = this.scopes.get(reservation.scopeId);
    if (child && child !== this.root) {
      child.outstandingTokens = Math.max(
        0,
        child.outstandingTokens - reservation.reservedTokens,
      );
    }
  }

  snapshot(): BudgetSnapshot {
    return {
      advisoryTokens: this.policy.budgetAdvisoryTokens,
      severeTokens: this.policy.budgetSevereTokens,
      advisoryModelCalls: this.policy.budgetAdvisoryModelCalls,
      severeModelCalls: this.policy.budgetSevereModelCalls,
      emergencyTokenFuse: this.policy.emergencyTokenFuse,
      emergencyModelCallFuse: this.policy.emergencyModelCallFuse,
      usedModelCalls: this.root.calls,
      reservedTokens: this.root.committedTokens + this.root.outstandingTokens,
      actualInputTokens: this.root.inputTokens,
      actualOutputTokens: this.root.outputTokens,
      estimatedDollars: null,
      warningLevel: this.peakWarning,
      deadlineAt: this.host.deadlineAt(),
      terminalReason: this.host.terminalReason(),
    };
  }

  usageOf(scopeId: string): {
    modelCalls: number;
    reservedTokens: number;
    actualInputTokens: number;
    actualOutputTokens: number;
  } | undefined {
    const scope = this.scopes.get(scopeId);
    if (!scope) return undefined;
    return {
      modelCalls: scope.calls,
      reservedTokens: scope.committedTokens + scope.outstandingTokens,
      actualInputTokens: scope.inputTokens,
      actualOutputTokens: scope.outputTokens,
    };
  }

  safeMaxOutputTokens(estimatedInputTokens: number): number {
    if (this.policy.emergencyTokenFuse === null) return CALL_MAX_OUTPUT_TOKENS;
    const floor = Math.max(0, estimatedInputTokens) + SAFETY_TOKENS;
    const remaining = this.policy.emergencyTokenFuse
      - this.root.committedTokens
      - this.root.outstandingTokens
      - floor;
    return Math.max(0, Math.min(CALL_MAX_OUTPUT_TOKENS, remaining));
  }

  private createScope(
    id: string,
    advisoryCalls: number | null,
    advisoryTokens: number | null,
    severeCalls: number | null,
    severeTokens: number | null,
  ): ScopeState {
    return {
      id,
      advisoryCalls,
      advisoryTokens,
      severeCalls,
      severeTokens,
      calls: 0,
      committedTokens: 0,
      outstandingTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      emitted: new Set(),
    };
  }

  private collectNotices(state: ScopeState): BudgetNotice[] {
    const notices: BudgetNotice[] = [];
    const observedTokens = state.committedTokens + state.outstandingTokens;
    const levels: { level: "advisory" | "severe"; calls: number | null; tokens: number | null }[] = [
      { level: "advisory", calls: state.advisoryCalls, tokens: state.advisoryTokens },
      { level: "severe", calls: state.severeCalls, tokens: state.severeTokens },
    ];
    for (const { level, calls, tokens } of levels) {
      if (tokens !== null) {
        const notice = this.maybeNotice(state, level, "tokens", observedTokens, tokens);
        if (notice) notices.push(notice);
      }
      if (calls !== null) {
        const notice = this.maybeNotice(state, level, "calls", state.calls, calls);
        if (notice) notices.push(notice);
      }
    }
    return notices;
  }

  private maybeNotice(
    state: ScopeState,
    level: "advisory" | "severe",
    metric: "tokens" | "calls",
    observed: number,
    threshold: number,
  ): BudgetNotice | null {
    const key = level + ":" + metric;
    if (observed < threshold) return null;
    if (state === this.root) this.stickWarning(level);
    if (state.emitted.has(key)) return null;
    state.emitted.add(key);
    return { scopeId: state.id, level, metric, observed, threshold };
  }

  private stickWarning(level: "advisory" | "severe"): void {
    if (level === "severe" || this.peakWarning === null) this.peakWarning = level;
  }

  private commit(
    state: ScopeState,
    reserved: number,
    input: number,
    output: number,
  ): BudgetNotice[] {
    state.outstandingTokens = Math.max(0, state.outstandingTokens - reserved);
    state.committedTokens += input + output;
    state.inputTokens += input;
    state.outputTokens += output;
    return this.collectNotices(state);
  }
}
