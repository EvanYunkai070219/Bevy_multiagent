// @vitest-environment jsdom

import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { partitionParty } from "./AgentParty";
import type { Agent, AgentRun, RunEvent } from "./types";

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    description: "",
    instructions: "",
    status: "ready",
    role: "worker",
    parentAgentId: "leader-agent",
    specialty: "Coding worker",
    projectId: null,
    unassignedPlacement: null,
    workspacePath: "/workspace",
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  } as Agent;
}

function run(id: string, agentId: string, status: AgentRun["status"]): AgentRun {
  return {
    id,
    agentId,
    projectId: null,
    kind: "subtask",
    parentRunId: "leader-run",
    orchestration: null,
    status,
    prompt: "",
    output: null,
    error: null,
    usage: null,
    createdAt: "2026-08-30T00:00:00.000Z",
  } as AgentRun;
}

const workers = [agent("a1", "Byte"), agent("a2", "Scout"), agent("a3", "Echo")];

afterEach(cleanup);

describe("partitionParty", () => {
  it("keeps a finished worker in the party while the mission is live", () => {
    const { party, bench } = partitionParty({
      workers,
      runs: [run("r1", "a1", "completed"), run("r2", "a2", "running")],
      byRun: {},
      leaderSettled: false,
    });
    expect(party.map((member) => member.agent.name)).toEqual(["Byte", "Scout"]);
    expect(bench.map((item) => item.name)).toEqual(["Echo"]);
  });

  it("marks a finished member done rather than dropping it", () => {
    const { party } = partitionParty({
      workers,
      runs: [run("r1", "a1", "completed")],
      byRun: {},
      leaderSettled: false,
    });
    expect(party[0]?.state).toBe("done");
  });

  it("empties the party once the mission itself has settled", () => {
    const { party, bench } = partitionParty({
      workers,
      runs: [run("r1", "a1", "completed"), run("r2", "a2", "running")],
      byRun: {},
      leaderSettled: true,
    });
    expect(party).toEqual([]);
    expect(bench).toHaveLength(3);
  });

  it("reports the move a member is in the middle of", () => {
    const events: RunEvent[] = [
      {
        seq: 1,
        runId: "r2",
        agentId: "a2",
        spanId: "s1",
        parentSpanId: "run",
        kind: "web_search",
        name: "web_search",
        status: "in_progress",
        startedAt: "2026-08-30T00:00:00.000Z",
        endedAt: null,
        durationMs: null,
        input: { text: "install .NET" },
        output: {},
        error: null,
        attributes: {},
        usage: null,
      } as RunEvent,
    ];
    const { party } = partitionParty({
      workers,
      runs: [run("r2", "a2", "running")],
      byRun: { r2: events },
      leaderSettled: false,
    });
    expect(party[0]?.move?.label).toBe("SEARCH");
  });

  /**
   * Between two tool calls a member has nothing open. Reporting only the move
   * in flight blanked the row to a dash at exactly those moments -- most
   * visibly on a leader that had just come back from `wait_for_workers` --
   * which read as the agent having stopped.
   */
  it("reports the finished move when a member has nothing in flight", () => {
    const settled = (seq: number, spanId: string): RunEvent =>
      ({
        seq,
        runId: "r2",
        agentId: "a2",
        spanId,
        parentSpanId: "run",
        kind: "mcp_tool",
        name: "wait_for_workers",
        status: "ok",
        startedAt: "2026-08-30T00:00:00.000Z",
        endedAt: "2026-08-30T00:00:01.000Z",
        durationMs: 1000,
        input: {},
        output: {},
        error: null,
        attributes: {},
        usage: null,
      }) as RunEvent;
    const { party } = partitionParty({
      workers,
      runs: [run("r2", "a2", "running")],
      byRun: { r2: [settled(1, "s1")] },
      leaderSettled: false,
    });
    expect(party[0]?.move).toBeNull();
    expect(party[0]?.lastMove?.label).toBe("WAIT_FOR_WORKERS");
  });

  it("does not report a finished move while one is still open", () => {
    const events: RunEvent[] = [
      {
        seq: 1,
        runId: "r2",
        agentId: "a2",
        spanId: "s1",
        parentSpanId: "run",
        kind: "web_search",
        name: "web_search",
        status: "in_progress",
        startedAt: "2026-08-30T00:00:00.000Z",
        endedAt: null,
        durationMs: null,
        input: {},
        output: {},
        error: null,
        attributes: {},
        usage: null,
      } as RunEvent,
    ];
    const { party } = partitionParty({
      workers,
      runs: [run("r2", "a2", "running")],
      byRun: { r2: events },
      leaderSettled: false,
    });
    expect(party[0]?.lastMove).toBeNull();
  });
});
