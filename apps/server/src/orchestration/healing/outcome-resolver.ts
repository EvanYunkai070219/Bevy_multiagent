/**
 * Resolves whether the user's task succeeded — a separate question from whether
 * the run finished.
 *
 * `AgentRun.status` says the orchestration loop reached its end. It says nothing
 * about whether the user got what they asked for, yet a `completed` run reads as
 * success everywhere it is shown. Keeping the two apart means a run can finish
 * cleanly and still report that nothing was established.
 *
 * The resolver never upgrades on the strength of a synthesised paragraph: text
 * asserting success is not evidence of it.
 */
import type { OutcomeInput, OutcomeRecord, TaskOutcome } from "../../types.js";

export function resolveOutcome(input: OutcomeInput): OutcomeRecord {
  const invalid = input.results.filter(
    (result) => result.validation?.integrity === "invalid",
  );
  const unverified = input.results.filter(
    (result) => result.validation?.integrity === "unverified",
  );
  const usable = input.results.filter(
    (result) =>
      (result.status === "completed" || result.status === "partial") &&
      result.validation?.integrity !== "invalid",
  );
  const unresolved = input.results.filter(
    (result) => result.status === "failed" || result.status === "blocked" ||
      result.status === "cancelled",
  );

  const evidence: string[] = [
    "workers=" + input.results.length,
    "usable=" + usable.length,
    ...(invalid.length > 0 ? ["invalid=" + invalid.length] : []),
    ...(unverified.length > 0 ? ["unverified=" + unverified.length] : []),
    ...(unresolved.length > 0 ? ["unresolved=" + unresolved.length] : []),
    "evaluator=" + (input.evaluatorAvailable ? "available" : "unavailable"),
  ];

  const record = (value: TaskOutcome, reason: string): OutcomeRecord => ({
    value,
    reason,
    evidence,
    resolvedAt: new Date().toISOString(),
  });

  if (unresolved.length > 0) {
    return record(
      usable.length > 0 ? "partial" : "failed",
      "Required worker results remain unresolved: " +
        unresolved.map((result) => result.status).join(", ") +
        (invalid.length > 0 ? "; protocol-invalid evidence is present." : "."),
    );
  }

  if (input.evaluatorAvailable && input.evaluationSufficient) {
    // The evaluator judges the answer it was shown; it has no way to vouch for a
    // turn that never executed, so a deterministic failure outranks it.
    if (invalid.length > 0) {
      return record(
        usable.length > 0 ? "partial" : "failed",
        "Evaluator was satisfied, but " +
          invalid.length +
          " worker(s) failed protocol validation, so the evidence behind that judgement is incomplete.",
      );
    }
    if (unverified.length > 0) {
      return record(
        "partial",
        "Evaluator was satisfied, but " +
          unverified.length +
          " worker turn(s) could not be verified from evidence.",
      );
    }
    return record("succeeded", "Evaluator confirmed the task's criteria against verified worker evidence.");
  }

  if (input.evaluatorAvailable) {
    return usable.length > 0
      ? record("partial", "Evaluator found the results insufficient; some usable work remains.")
      : record("failed", "Evaluator found the results insufficient and no usable result remains.");
  }

  // No evaluator: nothing establishes semantic correctness either way. Reporting
  // `unknown` is the honest answer; reporting success would be inventing one.
  if (invalid.length > 0) {
    return usable.length > 0
      ? record("partial", "Evaluator unavailable; some workers failed protocol validation.")
      : record("failed", "Evaluator unavailable and every worker failed protocol validation.");
  }
  return record(
    "unknown",
    "Evaluator unavailable; workers completed without protocol failures, but the task's correctness was not established.",
  );
}
