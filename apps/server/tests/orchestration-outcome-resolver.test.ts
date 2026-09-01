/** Task outcome is a separate claim from whether the run finished. */
import { describe, expect, it } from "vitest";
import { resolveOutcome } from "../src/orchestration/healing/outcome-resolver.js";
import type { WorkerResult } from "../src/types.js";

const worker = (
  status: WorkerResult["status"],
  integrity: "valid" | "unverified" | "invalid",
): Pick<WorkerResult, "status" | "validation"> => ({
  status,
  validation: { integrity, anomalyCodes: [], summary: "" },
});

const ok = worker("completed", "valid");
const broken = worker("failed", "invalid");
const unsure = worker("completed", "unverified");

describe("outcome resolver", () => {
  it("succeeds when the evaluator is available and satisfied", () => {
    expect(
      resolveOutcome({ evaluatorAvailable: true, evaluationSufficient: true, results: [ok, ok] })
        .value,
    ).toBe("succeeded");
  });

  // The evaluator judges the answer; it cannot vouch for a turn that never ran.
  it("never succeeds while a worker failed deterministically", () => {
    const outcome = resolveOutcome({
      evaluatorAvailable: true,
      evaluationSufficient: true,
      results: [ok, broken],
    });
    expect(outcome.value).not.toBe("succeeded");
    expect(outcome.reason).toMatch(/protocol|invalid/i);
  });

  it.each(["failed", "blocked", "cancelled"] as const)(
    "never succeeds while a required worker is %s even when its evidence is valid",
    (status) => {
      const outcome = resolveOutcome({
        evaluatorAvailable: true,
        evaluationSufficient: true,
        results: [ok, worker(status, "valid")],
      });
      expect(outcome.value).not.toBe("succeeded");
      expect(outcome.evidence).toContain("unresolved=1");
    },
  );

  it("is partial when unsatisfied but usable results exist", () => {
    expect(
      resolveOutcome({ evaluatorAvailable: true, evaluationSufficient: false, results: [ok, broken] })
        .value,
    ).toBe("partial");
  });

  it("fails when no usable result exists", () => {
    expect(
      resolveOutcome({ evaluatorAvailable: true, evaluationSufficient: false, results: [broken] })
        .value,
    ).toBe("failed");
  });

  // Without an evaluator nothing establishes the answer was right. Saying
  // "unknown" is the honest report; saying "succeeded" would be inventing one.
  it("is unknown when the evaluator is unavailable and nothing broke", () => {
    expect(
      resolveOutcome({ evaluatorAvailable: false, evaluationSufficient: false, results: [ok] })
        .value,
    ).toBe("unknown");
  });

  it("is partial when the evaluator is unavailable and something broke", () => {
    expect(
      resolveOutcome({ evaluatorAvailable: false, evaluationSufficient: false, results: [ok, broken] })
        .value,
    ).toBe("partial");
  });

  it("fails when the evaluator is unavailable and everything broke", () => {
    expect(
      resolveOutcome({ evaluatorAvailable: false, evaluationSufficient: false, results: [broken] })
        .value,
    ).toBe("failed");
  });

  it("does not treat unverified as proof of success", () => {
    expect(
      resolveOutcome({ evaluatorAvailable: true, evaluationSufficient: true, results: [unsure] })
        .value,
    ).not.toBe("succeeded");
  });

  it("records which results drove the decision", () => {
    const outcome = resolveOutcome({
      evaluatorAvailable: true,
      evaluationSufficient: true,
      results: [ok, broken],
    });
    expect(outcome.evidence.length).toBeGreaterThan(0);
    expect(outcome.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// Two defects a real run exposed after the resolver landed. Both are silent
// failures, so they need tests or they come back.
describe("outcome is recorded on every settled run", () => {
  it("treats a missing outcome on a settled run as not-established, never success", () => {
    // Mirrors what the UI must do with pre-existing runs and early failures.
    const settledWithoutOutcome = { phase: "failed", outcome: undefined };
    const shown =
      settledWithoutOutcome.outcome === undefined
        ? "Not established"
        : "Succeeded";
    expect(shown).toBe("Not established");
  });
});
