import type { ApiCallRecorder, ArkClient } from "./ark-client.js";
import { apiCallContext } from "./ark-client.js";
import { PLANNER_PROMPT_VERSION } from "../policies.js";
import { isSkillCreationRequest } from "../skill-creation.js";
import { parseLeaderPlan } from "./validation.js";
import type { Agent, ExecutionPolicy, PlannerResult } from "../../types.js";

export class Planner {
  constructor(private readonly ark: ArkClient) {}

  async plan(
    task: string,
    existingWorkers: Agent[],
    policy: ExecutionPolicy,
    recorder?: ApiCallRecorder,
    selectedSkillContext = "",
  ): Promise<PlannerResult> {
    try {
      const messages = plannerMessages(task, existingWorkers, policy, selectedSkillContext);
      const completion = await this.ark.completeJson(
        messages,
        call(recorder, "planner", 1),
      );
      let plan = null;
      try {
        plan = parseLeaderPlan(completion.text, policy);
      } catch (error) {
        const validationError = error instanceof Error ? error.message : String(error);
        const repair = await this.ark.completeJson(
          [
          ...messages,
          {
            role: "user",
            content:
              "The JSON you returned is invalid for this harness version: " +
              validationError +
              "\n\nRepair it into a complete v1-compatible plan. " +
              "Ensure every dependsOn references an existing subtask id, referenced subtasks have explicit ids, and the dependency graph is acyclic. Keep genuinely independent subtasks dependency-free so they run in parallel. " +
              "Return only the corrected JSON.\n\nOriginal JSON:\n" +
              completion.text,
          },
          ],
          call(recorder, "planner_repair", 2),
        );
        try {
          plan = parseLeaderPlan(repair.text, policy);
        } catch (repairError) {
          throw new Error(
            "initial validation: " +
              validationError +
              "; repair validation: " +
              (repairError instanceof Error ? repairError.message : String(repairError)) +
              "; raw planner output preview: " +
              preview(completion.text) +
              "; raw repair output preview: " +
              preview(repair.text),
          );
        }
      }
      return {
        status: "available",
        plan,
        model: completion.model,
        promptVersion: PLANNER_PROMPT_VERSION,
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason: "planner_failed",
        error: error instanceof Error ? error.message : String(error),
        promptVersion: PLANNER_PROMPT_VERSION,
      };
    }
  }
}

function plannerMessages(
  task: string,
  existingWorkers: Agent[],
  policy: ExecutionPolicy,
  selectedSkillContext = "",
) {
  const skillGuidance = isSkillCreationRequest(task)
    ? " For skill-creation tasks, plan skill-shaped work with a small default cast: one contract/scaffold subtask for a real skill folder with SKILL.md and useful scripts/references/assets, at most two implementation subtasks for reusable resources, one integration/gate subtask, and independent validation or forward-test subtasks that use fresh-context natural prompts. Require each worker to write a compact status file under $COMMON_WORKSPACE/status/ and a final report under $COMMON_WORKSPACE/reports/ so the leader can read durable summaries instead of polling full traces. Do not plan duplicate replacement or corroborating retest workers up front; group defects by root cause and leave retests for the failed gates after a clustered fix wave. Do not plan only a one-off CLI, application, or script when the requested deliverable is a reusable skill."
    : "";
  return [
    {
      role: "system" as const,
      content:
        "You are a leader-agent planner. Return only JSON matching " +
        "{ needsSubagents:boolean, rationale:string, subtasks:[{ id?:string, agentName?:string, title:string, role:string, prompt:string, objective:string, successCriteria:string[], expectedOutput:string, dependsOn:string[], contractKey?:string, inputs?:string[], outputs?:string[], mutationPaths?:string[] }] }. " +
        "Workers are real Codex agents with workspace access, so do not refuse because repository or file details are not in this prompt. " +
        "For every subtask, choose a concise, human-readable `agentName` naming what that worker does -- \"Schema Auditor\", \"Retry Logic\", \"Docs Sweep\" -- and keep names distinct within the plan. Numbered placeholders like \"agent1\", \"worker 2\" or \"subagent-3\" are discarded and the subtask title is used instead, so they only lose you the chance to say something useful. " +
        "Keep `role` to a short job label of a few words, such as \"Backend engineer\" or \"Release reviewer\". It is slugged into the worker's identity, so an instruction sentence written there becomes an unreadable identifier. Put the instructions in `prompt`. " +
        "Subtasks may declare dependencies: set `dependsOn` to the ids of subtasks whose completed output this one needs. Dependent subtasks run after their dependencies and receive those dependencies' outputs in their prompt. Give any subtask that is referenced an explicit `id`. Keep the dependency graph acyclic. Still prefer independent, parallel subtasks when the work does not actually depend on another subtask's completed result. If workers are supposed to communicate live with `talk`, keep the talking participants dependency-free so they start concurrently; a `dependsOn` edge makes real-time talk impossible. A shared run whiteboard and artifacts area is available for opportunistic sharing between workers. Each worker's own `/workspace` is private; workers exchange files through the shared `/common-workspace` directory (or published artifacts), so when one subtask must consume another's finished files, express that as a dependency and instruct the workers to write to and read from `/common-workspace`, never a shared `/workspace`. Workers can discover persistent reusable Codex skills through bootstrap_context.skills, tool_search, search_skills, read_skill, and install_skill; when reuse may fit, plan a bounded discovery/install step before creating a new implementation from scratch. For skill improvement tasks, include a bounded skill-wiki/proposal/impact-history read through bootstrap_context.skillWiki, bootstrap_context.skillProposals, search_skill_wiki, read_skill_wiki, or list_skill_proposals before patching, and stage/finalize candidate edits when proposal tools are available. " +
        "Optional bounded declarations: `contractKey`, `inputs`, `outputs`, and `mutationPaths` may only narrow catalog paths. never declare gate IDs, verifier commands, protected-path exceptions, permissions, timeout extensions, or budgets. " +
        "Use no subtasks only when one ordinary Codex run is sufficient." +
        selectedSkillContext +
        skillGuidance,
    },
    {
      role: "user" as const,
      content:
        "Task:\n" +
        task +
        "\n\nExisting worker role slugs:\n" +
        existingWorkers.map((agent) => agent.specialty).filter(Boolean).join(", ") +
        "\n\nLimits:\nmaxSubtasks=" +
        policy.maxSubtasks,
    },
  ];
}

function preview(text: string): string {
  return JSON.stringify(text.slice(0, 700));
}

/** Names one leader model call so its span is unique within the Run. */
function call(
  recorder: ApiCallRecorder | undefined,
  label: string,
  attempt: number,
) {
  return apiCallContext(recorder, label, attempt);
}
