import { z } from "zod";
import type { ApiCallRecorder, ArkClient } from "./ark-client.js";
import { apiCallContext } from "./ark-client.js";
import { EVALUATOR_PROMPT_VERSION } from "../policies.js";
import { parseJsonObject } from "./validation.js";
import type {
  EvaluationResult,
  LeaderPlan,
  WorkerResult,
} from "../../types.js";

const evaluationSchema = z.object({
  sufficient: z.boolean(),
  subtaskEvaluations: z.array(
    z.object({
      subtaskId: z.string().trim().min(1),
      status: z.enum(["satisfied", "partial", "unsatisfied"]),
      criteria: z.array(
        z.object({
          criterion: z.string().trim().min(1),
          satisfied: z.boolean(),
          evidence: z.string().optional(),
        }),
      ),
      issues: z.array(z.string()),
    }),
  ),
  missingInformation: z.array(z.string()),
});

/** Per-result output cap; matches the evidence projection's preview bound. */
const MAX_OUTPUT_CHARS = 8_000;
/** Total serialized budget for the results block. */
const MAX_RESULTS_BYTES = 256 * 1024;

/**
 * Bound what the evaluator is asked to read.
 *
 * Worker output is unbounded — a verbose worker or a long run can push this
 * payload past what the model can accept, and the failure arrives as a slow or
 * rejected call rather than anything naming the cause. Truncation is marked so
 * the evaluator can tell a short answer from a clipped one.
 *
 * When the whole block is still too large, failed and unverified results are
 * kept in preference to satisfied ones: those are the entries a judgement most
 * depends on, and dropping them silently would let a run look cleaner than it was.
 */
export function boundResults(results: WorkerResult[]): unknown[] {
  const shaped = results.map((result) => {
    const output = result.output ?? "";
    const clipped = output.length > MAX_OUTPUT_CHARS;
    return {
      ...result,
      output: clipped ? output.slice(0, MAX_OUTPUT_CHARS) + "…[truncated]" : output,
      ...(clipped ? { outputTruncated: true } : {}),
    };
  });

  const keepFirst = (entry: (typeof shaped)[number]): boolean =>
    entry.status !== "completed" || entry.validation?.integrity !== "valid";

  const ordered = [...shaped.filter(keepFirst), ...shaped.filter((e) => !keepFirst(e))];
  const kept: typeof shaped = [];
  let bytes = 0;
  for (const entry of ordered) {
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (bytes + size > MAX_RESULTS_BYTES && kept.length > 0) break;
    kept.push(entry);
    bytes += size;
  }
  // Restore plan order so subtask ids still line up with the plan above.
  const keptIds = new Set(kept.map((entry) => entry.subtaskId));
  return shaped.filter((entry) => keptIds.has(entry.subtaskId));
}

export class Evaluator {
  constructor(private readonly ark: ArkClient) {}

  async evaluate(
    task: string,
    plan: LeaderPlan,
    results: WorkerResult[],
    recorder?: ApiCallRecorder,
  ): Promise<EvaluationResult> {
    const messages = [
      {
        role: "system" as const,
        content:
          "You are an evaluator. Identify only what is satisfied, missing, or wrong. " +
          "Do not create new subtasks or plans. Return only JSON matching " +
          "{ sufficient:boolean, subtaskEvaluations:[{ subtaskId:string, status:'satisfied'|'partial'|'unsatisfied', criteria:[{ criterion:string, satisfied:boolean, evidence?:string }], issues:string[] }], missingInformation:string[] }. " +
          "Every array field must be a JSON array even when it holds one item or none; never return a bare string in an array position.",
      },
      {
        role: "user" as const,
        content: JSON.stringify({ task, plan, results: boundResults(results) }),
      },
    ];

    try {
      const completion = await this.ark.completeJson(
        messages,
        call(recorder, "evaluator", 1),
      );
      let evaluation;
      try {
        evaluation = evaluationSchema.parse(parseJsonObject(completion.text));
      } catch (schemaError) {
        // The planner gets a repair attempt; the evaluator did not, so one
        // near-miss field sank the whole judgement. Observed live: the model
        // returned `missingInformation` as a string instead of an array, the
        // evaluator went unavailable, and the run could only report `unknown`.
        const detail =
          schemaError instanceof Error ? schemaError.message : String(schemaError);
        const repair = await this.ark.completeJson(
          [
            ...messages,
            {
              role: "user" as const,
              content:
                "The JSON you returned does not match the required schema: " +
                detail +
                "\n\nReturn only the corrected JSON. Keep every judgement you already made; " +
                "fix only the shape. Array fields must be arrays even when empty.\n\nOriginal JSON:\n" +
                completion.text,
            },
          ],
          call(recorder, "evaluator_repair", 2),
        );
        evaluation = evaluationSchema.parse(parseJsonObject(repair.text));
      }
      return {
        status: "available",
        evaluation,
        model: completion.model,
        promptVersion: EVALUATOR_PROMPT_VERSION,
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason: "evaluator_failed",
        error: error instanceof Error ? error.message : String(error),
        promptVersion: EVALUATOR_PROMPT_VERSION,
      };
    }
  }
}


/** Names one leader model call so its span is unique within the Run. */
function call(
  recorder: ApiCallRecorder | undefined,
  label: string,
  attempt: number,
) {
  return apiCallContext(recorder, label, attempt);
}
