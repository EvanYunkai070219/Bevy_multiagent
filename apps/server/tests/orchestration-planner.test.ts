import { describe, expect, it } from "vitest";
import { Planner } from "../src/orchestration/leader/planner.js";
import { Replanner } from "../src/orchestration/leader/replanner.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import type { ArkCompletion } from "../src/orchestration/leader/ark-client.js";
import type { RunEventDraft } from "../src/run-events.js";

class FakeArk {
  calls: unknown[][] = [];

  constructor(private readonly completions: string[]) {}

  async completeJson(messages: unknown[]): Promise<ArkCompletion> {
    this.calls.push(messages);
    const text = this.completions.shift();
    if (text === undefined) throw new Error("No fake completion");
    return { text, model: "fake-model", usage: null };
  }
}

describe("Planner", () => {
  it("accepts a dependency pipeline plan without triggering a repair round", async () => {
    const ark = new FakeArk([
      JSON.stringify({
        needsSubagents: true,
        rationale: "Pipeline",
        subtasks: [
          {
            id: "research",
            title: "Research",
            role: "researcher",
            prompt: "Research the topic.",
            objective: "Research",
            successCriteria: ["facts"],
            expectedOutput: "facts",
            dependsOn: [],
          },
          {
            id: "write",
            title: "Write",
            role: "writer",
            prompt: "Write from the research.",
            objective: "Write",
            successCriteria: ["draft"],
            expectedOutput: "draft",
            dependsOn: ["research"],
          },
        ],
      }),
    ]);
    const planner = new Planner(ark as never);

    const result = await planner.plan("Write about agent harnesses", [], defaultExecutionPolicy);

    expect(result.status).toBe("available");
    expect(result.status === "available" ? result.plan.subtasks[0]?.dependsOn : null)
      .toEqual([]);
    expect(result.status === "available" ? result.plan.subtasks[1]?.dependsOn : null)
      .toEqual(["research"]);
    expect(ark.calls).toHaveLength(1);
  });

  it("accepts bounded contract declarations without a repair round", async () => {
    const ark = new FakeArk([
      JSON.stringify({
        needsSubagents: true,
        rationale: "Contracted pipeline",
        subtasks: [
          {
            id: "backend",
            title: "Backend",
            role: "backend",
            prompt: "Write the API.",
            objective: "API",
            successCriteria: ["routes"],
            expectedOutput: "src/api.ts",
            dependsOn: [],
            contractKey: "backend-producer",
            inputs: ["docs/api.md"],
            outputs: ["src/api.ts"],
            mutationPaths: ["src/api.ts"],
          },
        ],
      }),
    ]);
    const planner = new Planner(ark as never);
    const result = await planner.plan("Build the API", [], defaultExecutionPolicy);
    expect(result.status).toBe("available");
    expect(result.status === "available" ? result.plan.subtasks[0] : null).toMatchObject({
      contractKey: "backend-producer",
      inputs: ["docs/api.md"],
      outputs: ["src/api.ts"],
      mutationPaths: ["src/api.ts"],
    });
    expect(ark.calls).toHaveLength(1);
  });

  it("prompts the model with dependency-declaring guidance instead of an independence mandate", async () => {
    const ark = new FakeArk([
      JSON.stringify({
        needsSubagents: false,
        rationale: "Simple",
        subtasks: [],
      }),
    ]);
    const planner = new Planner(ark as never);

    await planner.plan("Write about agent harnesses", [], defaultExecutionPolicy);

    const systemMessage = ark.calls[0]?.[0] as { role: string; content: string };
    expect(systemMessage.role).toBe("system");
    expect(systemMessage.content).toContain(
      "Subtasks may declare dependencies: set `dependsOn` to the ids of subtasks whose completed output this one needs.",
    );
    expect(systemMessage.content).toContain(
      "If workers are supposed to communicate live with `talk`, keep the talking participants dependency-free",
    );
    expect(systemMessage.content).toContain("bootstrap_context.skills");
    expect(systemMessage.content).toContain("read_skill");
    expect(systemMessage.content).toContain("install_skill");
    expect(systemMessage.content).not.toContain("does not pass artifacts between workers");
    expect(systemMessage.content).not.toContain("dependsOn: [] exactly");
    expect(systemMessage.content).toContain("contractKey");
    expect(systemMessage.content).toContain("mutationPaths");
    expect(systemMessage.content).toContain("never declare gate IDs");
  });

  it("adds skill-shaped planning guidance for skill creation tasks", async () => {
    const ark = new FakeArk([
      JSON.stringify({
        needsSubagents: false,
        rationale: "Simple",
        subtasks: [],
      }),
    ]);
    const planner = new Planner(ark as never);

    await planner.plan("Create a high-quality skill for editing PDFs", [], defaultExecutionPolicy);

    const systemMessage = ark.calls[0]?.[0] as { role: string; content: string };
    expect(systemMessage.content).toContain("For skill-creation tasks");
    expect(systemMessage.content).toContain("SKILL.md");
    expect(systemMessage.content).toContain("scripts/references/assets");
    expect(systemMessage.content).toContain("fresh-context natural prompt");
    expect(systemMessage.content).toContain("Do not plan only a one-off CLI");
  });

  it("does not add skill-shaped planning guidance for ordinary tasks", async () => {
    const ark = new FakeArk([
      JSON.stringify({
        needsSubagents: false,
        rationale: "Simple",
        subtasks: [],
      }),
    ]);
    const planner = new Planner(ark as never);

    await planner.plan("Fix the auth flow", [], defaultExecutionPolicy);

    const systemMessage = ark.calls[0]?.[0] as { role: string; content: string };
    expect(systemMessage.content).not.toContain("For skill-creation tasks");
  });

  it("tells the replanner not to replace talk-only tasks with shared-file polling", async () => {
    const ark = new FakeArk([
      JSON.stringify({
        needsSubagents: false,
        rationale: "Done",
        subtasks: [],
      }),
    ]);
    const replanner = new Replanner(ark as never);

    await replanner.replan(
      "Use only talk; shared workspace messages are forbidden.",
      { needsSubagents: true, rationale: "previous", subtasks: [] },
      { sufficient: false, subtaskEvaluations: [], missingInformation: ["no reply"] },
      [],
      defaultExecutionPolicy,
    );

    const systemMessage = ark.calls[0]?.[0] as { role: string; content: string };
    expect(systemMessage.content).toContain(
      "Respect the original user's communication constraints",
    );
    expect(systemMessage.content).toContain(
      "do not replace the task with file polling, locks, turn files, or a shared conversation file",
    );
    expect(systemMessage.content).toContain("bootstrap_context.skills");
    expect(systemMessage.content).toContain("search_skills");
    expect(systemMessage.content).toContain("read_skill");
    expect(systemMessage.content).toContain("install_skill");
    expect(systemMessage.content).toContain("contractKey");
    expect(systemMessage.content).toContain("never declare gate IDs");
  });
});

describe("Planner api_call recording", () => {
  const validPlan = JSON.stringify({
    needsSubagents: true,
    rationale: "Split it",
    subtasks: [
      {
        id: "audit",
        title: "Audit",
        role: "auditor",
        prompt: "Audit the repository.",
        objective: "Audit",
        successCriteria: ["findings"],
        expectedOutput: "findings",
        dependsOn: [],
      },
    ],
  });

  it("records one api_call for a plan that parses on the first try", async () => {
    const drafts: RunEventDraft[] = [];
    const ark = new ContextArk([validPlan]);

    await new Planner(ark as never).plan("task", [], defaultExecutionPolicy, {
      sink: { emit: (draft: RunEventDraft) => drafts.push(draft) },
    });

    expect(ark.contexts).toEqual([{ label: "planner", iteration: 0, attempt: 1 }]);
  });

  it("records the repair call as a second attempt", async () => {
    const drafts: RunEventDraft[] = [];
    const ark = new ContextArk(["not json at all", validPlan]);

    const result = await new Planner(ark as never).plan(
      "task",
      [],
      defaultExecutionPolicy,
      { sink: { emit: (draft: RunEventDraft) => drafts.push(draft) } },
    );

    expect(result.status).toBe("available");
    expect(ark.contexts).toEqual([
      { label: "planner", iteration: 0, attempt: 1 },
      { label: "planner_repair", iteration: 0, attempt: 2 },
    ]);
  });
});

class ContextArk {
  contexts: unknown[] = [];

  constructor(private readonly completions: string[]) {}

  async completeJson(
    _messages: unknown[],
    context?: { label: string; iteration?: number; attempt?: number; sink: unknown },
  ): Promise<ArkCompletion> {
    this.contexts.push(
      context === undefined
        ? undefined
        : {
            label: context.label,
            iteration: context.iteration ?? 0,
            attempt: context.attempt ?? 1,
          },
    );
    const text = this.completions.shift();
    if (text === undefined) throw new Error("No fake completion");
    return { text, model: "fake-model", usage: null };
  }
}

describe("evaluator input bounds", () => {
  it("truncates long worker output and marks it", async () => {
    const { boundResults } = await import("../src/orchestration/leader/evaluator.js");
    const bounded = boundResults([
      {
        subtaskId: "a", workerId: "w", workerRunId: "r", iteration: 1, attempt: 1,
        status: "completed", output: "x".repeat(20_000), usage: null,
        durationMs: 1, artifacts: [],
      },
    ]) as { output: string; outputTruncated?: boolean }[];
    expect(bounded[0]?.output.length).toBeLessThan(9_000);
    expect(bounded[0]?.outputTruncated).toBe(true);
  });

  it("keeps failed results in preference to satisfied ones under pressure", async () => {
    const { boundResults } = await import("../src/orchestration/leader/evaluator.js");
    const make = (id: string, status: "completed" | "failed") => ({
      subtaskId: id, workerId: "w", workerRunId: "r", iteration: 1, attempt: 1,
      status, output: "y".repeat(7_500), usage: null, durationMs: 1, artifacts: [],
    });
    const bounded = boundResults([
      make("ok1", "completed"), make("ok2", "completed"), make("ok3", "completed"),
      make("ok4", "completed"), make("ok5", "completed"), make("bad", "failed"),
    ] as never) as { subtaskId: string }[];
    expect(bounded.map((e) => e.subtaskId)).toContain("bad");
  });
});

describe("evaluator schema repair", () => {
  // Observed live: the model returned `missingInformation` as a string, the
  // schema rejected it, and the evaluator went unavailable — which forced the
  // whole run's outcome to `unknown` over one malformed field.
  it("repairs a near-miss schema response instead of going unavailable", async () => {
    const { Evaluator } = await import("../src/orchestration/leader/evaluator.js");
    const { ArkClient } = await import("../src/orchestration/leader/ark-client.js");
    const { loadConfig } = await import("../src/config.js");

    let call = 0;
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "k",
        ARK_MODEL: "m",
        ARK_BASE_URL: "https://openrouter.ai/api/v1",
      }),
      (async () => {
        call += 1;
        const content =
          call === 1
            ? // missingInformation as a bare string — the shape that failed.
              '{"sufficient":true,"subtaskEvaluations":[],"missingInformation":"none"}'
            : '{"sufficient":true,"subtaskEvaluations":[],"missingInformation":[]}';
        return new Response(
          JSON.stringify({ model: "m", choices: [{ message: { content } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );

    const result = await new Evaluator(client).evaluate(
      "task",
      { needsSubagents: true, rationale: "r", subtasks: [] },
      [],
    );

    expect(result.status).toBe("available");
    expect(call).toBe(2);
  });

  it("stays unavailable when the repair also fails", async () => {
    const { Evaluator } = await import("../src/orchestration/leader/evaluator.js");
    const { ArkClient } = await import("../src/orchestration/leader/ark-client.js");
    const { loadConfig } = await import("../src/config.js");

    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "k",
        ARK_MODEL: "m",
        ARK_BASE_URL: "https://openrouter.ai/api/v1",
      }),
      (async () =>
        new Response(
          JSON.stringify({
            model: "m",
            choices: [{ message: { content: '{"sufficient":"yes"}' } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    );

    const result = await new Evaluator(client).evaluate(
      "task",
      { needsSubagents: true, rationale: "r", subtasks: [] },
      [],
    );
    expect(result.status).toBe("unavailable");
  });
});
