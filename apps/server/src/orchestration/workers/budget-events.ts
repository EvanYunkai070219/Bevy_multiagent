import type { RunEventDraft, RunEventSink } from "../../run-events.js";
import type { BudgetSnapshot, HealingState } from "../../types.js";
import type { BudgetNotice, BudgetReservation } from "./budget.js";
import type { RunTerminalError } from "../run-control.js";

export function persistHealingBudget(
  healing: HealingState,
  snapshot: BudgetSnapshot,
): void {
  healing.budget = { ...snapshot };
}

export function emitBudgetNotices(
  sink: RunEventSink,
  source: BudgetReservation | BudgetNotice[],
): void {
  const notices = Array.isArray(source) ? source : source.notices;
  for (const notice of notices) {
    emitSafely(sink, eventDraft(
      notice.level === "severe" ? "budget_severe" : "budget_advisory",
      "warning",
      {
        scope: notice.scopeId,
        metric: notice.metric,
        observed: notice.observed,
        threshold: notice.threshold,
      },
      null,
    ));
  }
}

export function emitBudgetTerminal(
  sink: RunEventSink,
  error: RunTerminalError,
  snapshot: BudgetSnapshot,
  timing?: { elapsedMs: number; rootTimeoutMs: number | null },
): void {
  emitSafely(sink, eventDraft(
    terminalEventName(error.reason),
    "error",
    terminalAttributes(error, snapshot, timing),
    { message: error.message, code: error.reason },
  ));
}

export function publishBudgetAdmission(options: {
  sink?: RunEventSink;
  healing?: HealingState;
  reservation: BudgetReservation;
  snapshot: BudgetSnapshot;
}): void {
  if (options.healing) persistHealingBudget(options.healing, options.snapshot);
  if (options.sink) emitBudgetNotices(options.sink, options.reservation);
}

export function publishBudgetReconciliation(options: {
  sink?: RunEventSink;
  healing?: HealingState;
  notices: BudgetNotice[];
  snapshot: BudgetSnapshot;
}): void {
  if (options.healing) persistHealingBudget(options.healing, options.snapshot);
  if (options.sink) emitBudgetNotices(options.sink, options.notices);
}

function terminalAttributes(
  error: RunTerminalError,
  snapshot: BudgetSnapshot,
  timing?: { elapsedMs: number; rootTimeoutMs: number | null },
): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
    scope: "root",
    reason: error.reason,
  };
  if (error.reason === "emergency_token_fuse" && snapshot.emergencyTokenFuse !== null) {
    attributes.observed = snapshot.reservedTokens;
    attributes.threshold = snapshot.emergencyTokenFuse;
  } else if (
    error.reason === "emergency_model_call_fuse" &&
    snapshot.emergencyModelCallFuse !== null
  ) {
    attributes.observed = snapshot.usedModelCalls;
    attributes.threshold = snapshot.emergencyModelCallFuse;
  } else if (error.reason === "root_deadline" && timing && timing.rootTimeoutMs !== null) {
    attributes.observed = timing.elapsedMs;
    attributes.threshold = timing.rootTimeoutMs;
  }
  return attributes;
}

function terminalEventName(reason: RunTerminalError["reason"]): string {
  if (reason === "root_deadline") return "root_deadline_stop";
  if (reason === "user_cancelled") return "user_cancelled_stop";
  if (reason === "provider_rate_limited") return "provider_rate_limited_stop";
  return "budget_emergency_stop";
}

function eventDraft(
  name: string,
  status: RunEventDraft["status"],
  attributes: Record<string, string | number>,
  error: RunEventDraft["error"],
): RunEventDraft {
  const timestamp = new Date().toISOString();
  const metric = attributes.metric;
  return {
    spanId: metric === undefined
      ? name + "-" + String(attributes.scope)
      : name + "-" + String(attributes.scope) + "-" + String(metric),
    parentSpanId: "run",
    kind: status === "error" ? "error" : "delegation",
    name,
    status,
    startedAt: timestamp,
    endedAt: timestamp,
    durationMs: 0,
    input: {},
    output: {},
    error,
    attributes,
    usage: null,
  };
}

function emitSafely(sink: RunEventSink, draft: RunEventDraft): void {
  try {
    sink.emit(draft);
  } catch {
    // Observability is best-effort and cannot change ledger behavior.
  }
}
