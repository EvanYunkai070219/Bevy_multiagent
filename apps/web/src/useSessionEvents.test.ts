import { describe, expect, it } from "vitest";
import { buildActors, mergeLeaderEvents } from "./useSessionEvents";
import type { Agent, AgentRun, RunEvent } from "./types";

function agent(id: string, name: string, role: Agent["role"]): Agent {
  return {
    id,
    name,
    description: "",
    instructions: "",
    status: "ready",
    role,
    parentAgentId: role === "worker" ? "leader-agent" : null,
    specialty: role === "worker" ? "Coding worker" : null,
    projectId: null,
    unassignedPlacement: null,
    workspacePath: "/workspace",
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  } as Agent;
}

function run(id: string, agentId: string): AgentRun {
  return {
    id,
    agentId,
    projectId: null,
    kind: "subtask",
    parentRunId: "leader-run",
    orchestration: null,
    status: "running",
    prompt: "",
    output: null,
    error: null,
    usage: null,
    createdAt: "2026-08-30T00:00:00.000Z",
  } as AgentRun;
}

const agents = [agent("leader-agent", "Ada", "leader"), agent("worker-agent", "Byte", "worker")];

describe("buildActors", () => {
  it("names the leader run and every worker run", () => {
    const actors = buildActors(agents, [run("worker-run", "worker-agent")], "leader-run", "leader-agent");
    expect(actors["leader-run"]?.name).toBe("Ada");
    expect(actors["leader-run"]?.isLeader).toBe(true);
    expect(actors["worker-run"]?.name).toBe("Byte");
    expect(actors["worker-run"]?.isLeader).toBe(false);
  });

  it("gives each actor a creature", () => {
    const actors = buildActors(agents, [run("worker-run", "worker-agent")], "leader-run", "leader-agent");
    expect(actors["worker-run"]?.creature.sprite).toContain("/creatures/");
  });

  it("still names a run whose agent is not in the list yet", () => {
    const actors = buildActors(agents, [run("ghost-run", "not-loaded")], "leader-run", "leader-agent");
    expect(actors["ghost-run"]?.name).toBe("Worker");
  });
});

describe("mergeLeaderEvents", () => {
  const event = (runId: string, seq: number): RunEvent =>
    ({
      seq,
      runId,
      agentId: "a",
      spanId: runId + "-" + seq,
      parentSpanId: "run",
      kind: "command",
      name: "command",
      status: "ok",
      startedAt: "2026-08-30T00:00:00.000Z",
      endedAt: "2026-08-30T00:00:00.000Z",
      durationMs: 0,
      input: {},
      output: {},
      error: null,
      attributes: {},
      usage: null,
    }) as RunEvent;

  it("keeps the leader's events even when there is no active run to key them to", () => {
    const merged = mergeLeaderEvents({}, [event("run-x", 1)]);
    expect(merged["run-x"]).toHaveLength(1);
  });

  it("files them under the run they belong to, not one handed in from outside", () => {
    const merged = mergeLeaderEvents({}, [event("run-x", 1), event("run-y", 1)]);
    expect(Object.keys(merged).sort()).toEqual(["run-x", "run-y"]);
  });

  it("leaves the workers' streams alone", () => {
    const merged = mergeLeaderEvents({ "run-w": [event("run-w", 1)] }, [event("run-x", 1)]);
    expect(Object.keys(merged).sort()).toEqual(["run-w", "run-x"]);
  });
});
