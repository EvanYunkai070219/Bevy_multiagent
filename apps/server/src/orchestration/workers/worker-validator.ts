/**
 * Deterministic protocol checks on a finished worker turn.
 *
 * A worker whose process exits cleanly is currently taken to have done its job.
 * That is not the same claim: a model can emit its tool-call template as prose,
 * have the runner parse none of it, and finish `completed` with no error having
 * touched nothing. The plan then silently loses that step, and every downstream
 * worker reads state the failed step was supposed to produce.
 *
 * Only mechanical breakage is judged here. Whether the work was semantically
 * right belongs to the evaluator, and producing no tool calls at all is perfectly
 * normal for a research, analysis or writing subtask — so "no tools" is never on
 * its own a failure.
 */
import type { WorkerValidation, WorkerValidatorInput } from "../../types.js";

/**
 * The full-width pipes are what DeepSeek emits; the ASCII form covers renderings
 * where they were normalised away. Matching the block opener alone is not
 * enough — prose legitimately mentions it — so an invoke/parameter structure
 * must appear as well.
 */
const TOOL_CALL_BLOCK = /<[｜|]\s*DSML\s*[｜|]\s*tool_calls\s*>/i;
const INVOKE_STRUCTURE = /<[^>]*\b(?:invoke|parameter)\s+name\s*=/i;

export function validateWorker(input: WorkerValidatorInput): WorkerValidation {
  if (input.output.trim().length === 0) {
    return {
      integrity: "invalid",
      anomalyCodes: ["EMPTY_OUTPUT"],
      summary: "Worker finished without producing any output.",
    };
  }

  const codes: string[] = [];
  if (input.openToolCallCount > 0) {
    codes.push("OPEN_TOOL_CALL");
  }

  const looksUnparsed =
    TOOL_CALL_BLOCK.test(input.output) &&
    INVOKE_STRUCTURE.test(input.output) &&
    input.toolEventCount === 0;
  // A subtask asking the worker to analyse the markup would otherwise be unable
  // to ever pass. Quoting the marker back is not evidence of a broken turn, so
  // that case degrades to unverified rather than failing outright.
  const promptCarriesMarker = TOOL_CALL_BLOCK.test(input.subtaskPrompt);

  if (looksUnparsed && !promptCarriesMarker) {
    codes.push("UNPARSED_TOOL_CALL");
  }

  if (codes.length > 0) {
    return {
      integrity: "invalid",
      anomalyCodes: codes,
      summary: "Deterministic protocol failure: " + codes.join(", ") + ".",
    };
  }

  if (looksUnparsed && promptCarriesMarker) {
    return {
      integrity: "unverified",
      anomalyCodes: ["TOOL_CALL_MARKER_IN_PROMPT"],
      summary:
        "Output echoes tool-call markup the subtask itself supplied; could not " +
        "tell analysis from an unexecuted call.",
    };
  }
  if (!input.evidenceAvailable) {
    return {
      integrity: "unverified",
      anomalyCodes: ["EVIDENCE_UNAVAILABLE"],
      summary: "Execution evidence could not be read for this turn.",
    };
  }

  return { integrity: "valid", anomalyCodes: [], summary: "No protocol anomalies." };
}
