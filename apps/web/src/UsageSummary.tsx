/** Shows what a turn consumed, and roughly what it cost. */
import { useMemo } from "react";
import type { ModelPricing, RunEvent } from "./types";

const PER_MILLION = 1_000_000;
const MIN_DISPLAYED_COST = 0.0001;

interface Totals {
  input: number;
  cached: number;
  output: number;
  total: number;
}

/**
 * Two sources report the same tokens, so exactly one of them may be counted.
 *
 * `turn` spans carry what Codex itself reported for a completed turn. The
 * app-server runtime does not produce them, and a leader's own planning calls
 * never had one, so `api_call` spans — anchored by the model proxy on every
 * request it brokers — are the fallback. Adding both would double-count every
 * exec-mode run, where the turn total is precisely the sum of those calls.
 *
 * An `api_call` span appears twice, in progress and settled, and only the
 * settled half carries usage; folding by `spanId` keeps a retried or partially
 * reported call from counting more than once.
 */
function foldUsage(events: RunEvent[], kind: RunEvent["kind"]): Totals | null {
  const bySpan = new Map<string, RunEvent>();
  for (const event of events) {
    if (event.kind !== kind || event.usage === null) continue;
    const current = bySpan.get(event.spanId);
    if (!current || event.seq > current.seq) bySpan.set(event.spanId, event);
  }
  if (bySpan.size === 0) return null;

  const totals: Totals = { input: 0, cached: 0, output: 0, total: 0 };
  for (const event of bySpan.values()) {
    if (event.usage === null) continue;
    totals.input += event.usage.inputTokens ?? 0;
    totals.cached += event.usage.cachedInputTokens ?? 0;
    totals.output += event.usage.outputTokens ?? 0;
  }
  totals.total = totals.input + totals.output;
  return totals;
}

function sumUsage(events: RunEvent[]): Totals {
  return (
    foldUsage(events, "turn") ??
    foldUsage(events, "api_call") ?? { input: 0, cached: 0, output: 0, total: 0 }
  );
}

/**
 * Cached input bills at a fraction of the prompt rate, so the uncached
 * remainder is what pays full price. Ignoring the split overstates spend
 * by an order of magnitude on a long conversation.
 *
 * This mirrors estimateCost in the server's pricing module. The two workspaces
 * share no package, and adding one for ten lines of arithmetic would be a
 * bigger change than the duplication it saves.
 */
function estimate(totals: Totals, pricing: ModelPricing) {
  const cached = Math.min(totals.cached, totals.input);
  const uncached = Math.max(totals.input - cached, 0);
  const inputCost =
    (uncached * pricing.inputPerMillion) / PER_MILLION +
    (cached * pricing.cachedInputPerMillion) / PER_MILLION;
  const outputCost = (totals.output * pricing.outputPerMillion) / PER_MILLION;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

/** A run costing $0.00003 must not render as "$0.0000", which reads as free. */
function formatCost(value: number): string {
  if (value > 0 && value < MIN_DISPLAYED_COST) return "<$0.0001";
  return "$" + value.toFixed(4);
}

export function UsageSummary({
  events,
  pricing,
}: {
  events: RunEvent[];
  pricing: ModelPricing | null;
}) {
  const totals = useMemo(() => sumUsage(events), [events]);
  if (totals.total === 0) return null;

  const cost = pricing === null ? null : estimate(totals, pricing);
  const rateSource =
    pricing?.source === "config" ? "configured rates" : "published rates";

  return (
    <div className="usage-summary">
      <span>
        {totals.input.toLocaleString()} in / {totals.output.toLocaleString()} out /{" "}
        {totals.total.toLocaleString()} total
      </span>
      {cost !== null && cost.totalCost > 0 && (
        <span
          title={
            "Estimated from " +
            rateSource +
            ". Excludes account discounts, promotions and provider-side billing rules."
          }
        >
          {formatCost(cost.inputCost)} in / {formatCost(cost.outputCost)} out /{" "}
          {formatCost(cost.totalCost)} total
        </span>
      )}
    </div>
  );
}

/**
 * The same totals, compact enough to sit in the transcript header.
 *
 * The full summary sits at the end of a long scroll, which is exactly where
 * nobody is looking while a Run is still burning tokens. This renders the
 * running figure where the Run's status already is.
 */
export function UsageBadge({
  events,
  pricing,
}: {
  events: RunEvent[];
  pricing: ModelPricing | null;
}) {
  const totals = useMemo(() => sumUsage(events), [events]);
  if (totals.total === 0) return null;

  const cost = pricing === null ? null : estimate(totals, pricing);
  return (
    <span
      className="usage-badge"
      title={
        totals.input.toLocaleString() +
        " in / " +
        totals.output.toLocaleString() +
        " out" +
        (totals.cached > 0 ? " (" + totals.cached.toLocaleString() + " cached)" : "") +
        (cost === null
          ? ""
          : ". Estimated from " +
            (pricing?.source === "config" ? "configured" : "published") +
            " rates; excludes discounts and provider billing rules.")
      }
    >
      <span>{totals.total.toLocaleString()} tokens</span>
      {cost !== null && cost.totalCost > 0 && <span>{formatCost(cost.totalCost)}</span>}
    </span>
  );
}
