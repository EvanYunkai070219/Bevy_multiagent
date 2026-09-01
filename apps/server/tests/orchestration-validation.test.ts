import { describe, expect, it } from "vitest";
import { parseLeaderPlan } from "../src/orchestration/leader/validation.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";

const base = {
  title: "t", role: "worker", prompt: "p", objective: "o",
  successCriteria: ["c"], expectedOutput: "e",
};
const plan = (subtasks: unknown[]) =>
  JSON.stringify({ needsSubagents: true, rationale: "r", subtasks });

describe("parseLeaderPlan dependency DAG", () => {
  it("accepts a valid chain and preserves normalized deps", () => {
    const result = parseLeaderPlan(
      plan([
        { ...base, id: "a" },
        { ...base, id: "b", dependsOn: ["a"] },
        { ...base, id: "c", dependsOn: ["b"] },
      ]),
      defaultExecutionPolicy,
    );
    expect(result.subtasks.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(result.subtasks[1]!.dependsOn).toEqual(["a"]);
  });

  it("preserves leader-provided worker agent names", () => {
    const result = parseLeaderPlan(
      plan([{ ...base, id: "a", agentName: "API Auditor" }]),
      defaultExecutionPolicy,
    );
    expect(result.subtasks[0]?.agentName).toBe("API Auditor");
  });

  it("throws on duplicate worker agent names", () => {
    expect(() =>
      parseLeaderPlan(
        plan([
          { ...base, id: "a", agentName: "Reviewer" },
          { ...base, id: "b", agentName: " reviewer " },
        ]),
        defaultExecutionPolicy,
      ),
    ).toThrow(/duplicate worker agentName/i);
  });

  it("de-duplicates deps preserving order", () => {
    const result = parseLeaderPlan(
      plan([{ ...base, id: "a" }, { ...base, id: "b", dependsOn: ["a", "a"] }]),
      defaultExecutionPolicy,
    );
    expect(result.subtasks[1]!.dependsOn).toEqual(["a"]);
  });

  it("throws on a dependency to an unknown subtask", () => {
    expect(() =>
      parseLeaderPlan(plan([{ ...base, id: "a", dependsOn: ["ghost"] }]), defaultExecutionPolicy),
    ).toThrow(/unknown subtask/i);
  });

  it("throws on a self-dependency", () => {
    expect(() =>
      parseLeaderPlan(plan([{ ...base, id: "a", dependsOn: ["a"] }]), defaultExecutionPolicy),
    ).toThrow(/itself/i);
  });

  it("throws on a cycle", () => {
    expect(() =>
      parseLeaderPlan(
        plan([{ ...base, id: "a", dependsOn: ["b"] }, { ...base, id: "b", dependsOn: ["a"] }]),
        defaultExecutionPolicy,
      ),
    ).toThrow(/cycle/i);
  });

  it("preserves bounded contract declarations and rejects gate or budget fields", () => {
    const result = parseLeaderPlan(
      plan([
        {
          ...base,
          id: "backend",
          contractKey: "backend-producer",
          inputs: ["docs/api.md"],
          outputs: ["src/api.ts"],
          mutationPaths: ["src/api.ts"],
        },
      ]),
      defaultExecutionPolicy,
    );
    expect(result.subtasks[0]).toMatchObject({
      id: "backend",
      contractKey: "backend-producer",
      inputs: ["docs/api.md"],
      outputs: ["src/api.ts"],
      mutationPaths: ["src/api.ts"],
    });
    expect(() =>
      parseLeaderPlan(
        plan([{ ...base, id: "a", targetedGateIds: ["model-gate"] }]),
        defaultExecutionPolicy,
      ),
    ).toThrow(/gate/i);
    expect(() =>
      parseLeaderPlan(
        plan([{ ...base, id: "a", protectedPaths: ["src/secret.ts"] }]),
        defaultExecutionPolicy,
      ),
    ).toThrow(/protected/i);
    expect(() =>
      parseLeaderPlan(
        plan([{ ...base, id: "a", budget: { advisoryTokens: 1 } }]),
        defaultExecutionPolicy,
      ),
    ).toThrow(/budget/i);
  });
});

/**
 * A worker's name is the only thing that tells two of them apart on screen.
 *
 * The planner is asked for a descriptive `agentName` and nothing held it to
 * that, so a plan routinely came back naming its workers `agent1` through
 * `agent10`. Those names satisfied every rule here -- non-empty, under 80
 * characters, distinct -- and produced a sidebar of `Agent10 / Agent9 /
 * Agent8`, where the one question you have (which worker does what?) has no
 * answer. A placeholder is worse than no name at all: dropping it lets the
 * subtask's own title name the worker.
 */
describe("placeholder worker names", () => {
  const named = (agentName: string) =>
    parseLeaderPlan(
      plan([{ ...base, id: "a", title: "Audit the API surface", agentName }]),
      defaultExecutionPolicy,
    ).subtasks[0]?.agentName;

  it.each(["agent1", "Agent 10", "worker-3", "subagent2", "agent", "worker", "task 4"])(
    "drops %s, which names nothing",
    (placeholder) => {
      expect(named(placeholder)).toBeUndefined();
    },
  );

  it("keeps a name that describes the work", () => {
    expect(named("API Auditor")).toBe("API Auditor");
  });

  it("keeps a name that merely contains a placeholder word", () => {
    expect(named("Schema Agent")).toBe("Schema Agent");
    expect(named("Worker Pool Analyst")).toBe("Worker Pool Analyst");
  });

  /**
   * Two workers both called `agent1` used to be a hard planning failure. They
   * are indistinguishable, not invalid: dropping both names lets each subtask's
   * title do the naming, which is what the operator wanted to read anyway.
   */
  it("does not fail a plan whose placeholders collide", () => {
    const result = parseLeaderPlan(
      plan([
        { ...base, id: "a", title: "Audit the API", agentName: "agent1" },
        { ...base, id: "b", title: "Audit the schema", agentName: "agent1" },
      ]),
      defaultExecutionPolicy,
    );
    expect(result.subtasks.map((subtask) => subtask.agentName)).toEqual([undefined, undefined]);
  });

  it("still refuses two real names that collide", () => {
    expect(() =>
      parseLeaderPlan(
        plan([
          { ...base, id: "a", agentName: "Reviewer" },
          { ...base, id: "b", agentName: "reviewer" },
        ]),
        defaultExecutionPolicy,
      ),
    ).toThrow(/duplicate worker agentName/i);
  });
});
