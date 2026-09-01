import type { ApiCallRecorder, ArkClient } from "./ark-client.js";
import { apiCallContext } from "./ark-client.js";
import { REPLANNER_PROMPT_VERSION } from "../policies.js";
import { parseLeaderPlan } from "./validation.js";
import type {
  ExecutionPolicy,
  LeaderEvaluation,
  LeaderPlan,
  ReplannerResult,
  WorkerResult,
} from "../../types.js";

export class Replanner {
  constructor(private readonly ark: ArkClient) {}

  async replan(
    task: string,
    previousPlan: LeaderPlan,
    evaluation: LeaderEvaluation,
    allResults: WorkerResult[],
    policy: ExecutionPolicy,
    recorder?: ApiCallRecorder,
  ): Promise<ReplannerResult> {
    try {
      const completion = await this.ark.completeJson(
        [
        {
          role: "system",
          content:
            "You are a leader-agent replanner. Create the complete next plan for the next iteration, not a patch. " +
            "Use only subtasks needed to address missing or wrong work. Return only JSON matching " +
            "{ needsSubagents:boolean, rationale:string, subtasks:[{ id?:string, agentName?:string, title:string, role:string, prompt:string, objective:string, successCriteria:string[], expectedOutput:string, dependsOn:string[], contractKey?:string, inputs?:string[], outputs?:string[], mutationPaths?:string[] }] }. " +
            "For every subtask, choose a concise, human-readable `agentName` that describes the worker's specialty; keep names distinct within the plan. " +
            // The old rule here was "dependsOn must be empty", written before
            // dependency scheduling existed. Left in place it silently disabled
            // the DAG from the second iteration onward.
            "Subtasks may declare dependencies: set `dependsOn` to the ids of subtasks whose completed output this one needs, give any referenced subtask an explicit `id`, and keep the graph acyclic. Keep genuinely independent subtasks dependency-free so they run in parallel. If workers are supposed to communicate live with `talk`, keep the talking participants dependency-free so they start concurrently; a `dependsOn` edge makes real-time talk impossible. " +
            "Each worker's own workspace is private; workers exchange files through the shared directory named by the COMMON_WORKSPACE environment variable. Express a finished-file handoff as a `dependsOn` dependency and instruct both workers in terms of $COMMON_WORKSPACE — never a bare /workspace or an invented absolute path. Respect the original user's communication constraints: if they require `talk` or forbid shared-workspace messages, do not replace the task with file polling, locks, turn files, or a shared conversation file. " +
            "For non-talk file workflows, subtasks run to completion once each and cannot wait on, poll for, or take turns with a sibling that is still running; design those workflows as completed-output handoffs. Persistent reusable Codex skills may be available through bootstrap_context.skills, tool_search, search_skills, read_skill, and install_skill; when a gap looks like an existing reusable workflow, plan a bounded discovery/install step before rebuilding it. For skill improvement tasks, include a bounded skill-wiki/proposal/impact-history read through bootstrap_context.skillWiki, bootstrap_context.skillProposals, search_skill_wiki, read_skill_wiki, or list_skill_proposals before patching, and stage/finalize candidate edits when proposal tools are available. " +
            "Optional bounded declarations: `contractKey`, `inputs`, `outputs`, and `mutationPaths` may only narrow catalog paths. never declare gate IDs, verifier commands, protected-path exceptions, permissions, timeout extensions, or budgets. " +
            "For skill-creation replans, cluster missingInformation and failed tester findings by root cause before assigning work. Prefer one patch wave by defect cluster, followed by one retest per previously failed gate/category. Do not spawn duplicate replacements or corroborating retests unless the prior worker is blocked, timed out, or produced contradictory evidence. Require compact status files under $COMMON_WORKSPACE/status/ and final reports under $COMMON_WORKSPACE/reports/.",
        },
        {
          role: "user",
          content: JSON.stringify({
            task,
            previousPlan,
            evaluation,
            allResults,
            remainingWorkerRuns: policy.maxTotalWorkerRuns - allResults.length,
          }),
        },
        ],
        call(recorder, "replanner", 1),
      );
      return {
        status: "available",
        plan: parseLeaderPlan(completion.text, policy),
        model: completion.model,
        promptVersion: REPLANNER_PROMPT_VERSION,
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason: "replanner_failed",
        error: error instanceof Error ? error.message : String(error),
        promptVersion: REPLANNER_PROMPT_VERSION,
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
