import type { ApiCallRecorder, ArkClient } from "./ark-client.js";
import { apiCallContext } from "./ark-client.js";
import { SYNTHESIZER_PROMPT_VERSION } from "../policies.js";
import { parseJsonObject } from "./validation.js";
import type { EvaluationRecord, IterationPlan, WorkerResult } from "../../types.js";

export interface SynthesisResult {
  output: string;
  model?: string;
  promptVersion: string;
}

export class Synthesizer {
  constructor(private readonly ark: ArkClient) {}

  async synthesize(
    task: string,
    plans: IterationPlan[],
    evaluations: EvaluationRecord[],
    results: WorkerResult[],
    recorder?: ApiCallRecorder,
  ): Promise<SynthesisResult> {
    try {
      const completion = await this.ark.completeJson(
        [
        {
          role: "system",
          content:
            "You synthesize leader/worker execution into the final user-facing answer. " +
            "Use worker outputs and evaluations. Be honest about partial or failed work. " +
            "Return JSON only: { \"answer\": string }.",
        },
        {
          role: "user",
          content: JSON.stringify({ task, plans, evaluations, results }),
        },
        ],
        call(recorder, "synthesizer", 1),
      );
      const parsed = parseJsonObject(completion.text) as { answer?: unknown };
      if (typeof parsed.answer !== "string" || parsed.answer.trim().length === 0) {
        throw new Error("Synthesis response did not include an answer");
      }
      return {
        output: parsed.answer.trim(),
        model: completion.model,
        promptVersion: SYNTHESIZER_PROMPT_VERSION,
      };
    } catch {
      return {
        output: fallbackSynthesis(results),
        promptVersion: SYNTHESIZER_PROMPT_VERSION,
      };
    }
  }
}

function fallbackSynthesis(results: WorkerResult[]): string {
  if (results.length === 0) {
    return "No worker results were available to synthesize.";
  }
  return results
    .map((result) =>
      [
        "Subtask " +
          result.subtaskId +
          " (" +
          result.status +
          ", iteration " +
          result.iteration +
          ", attempt " +
          result.attempt +
          ")",
        result.output || result.error || "No output.",
      ].join("\n"),
    )
    .join("\n\n");
}


/** Names one leader model call so its span is unique within the Run. */
function call(
  recorder: ApiCallRecorder | undefined,
  label: string,
  attempt: number,
) {
  return apiCallContext(recorder, label, attempt);
}
