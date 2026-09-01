/**
 * A leader that produced nothing did not succeed.
 *
 * Reported as "调用 multiagent 处理任务时啥都没做就显示完成了". The run in question
 * held two events -- the run starting and the leader's Codex session opening --
 * no model call, no worker, and an empty final answer, and it was written to
 * the store as `completed` with a blank assistant message. On screen that is
 * indistinguishable from a mission that worked: green status, ticked phases,
 * an empty result box.
 *
 * Whatever stopped the session, "produced nothing" is not a result, and the
 * transcript has to say so rather than leave the reader to notice the blank.
 */
import { describe, expect, it } from "vitest";
import { leaderProducedNothing } from "../src/orchestration/orchestrator.js";
import type { OrchestrationState } from "../src/types.js";

function state(over: Partial<OrchestrationState> = {}): OrchestrationState {
  return {
    phase: "completed",
    iteration: 1,
    iterationPlans: [],
    evaluationRecords: [],
    workerResults: [],
    provenance: { harnessVersion: "test" },
    ...over,
  } as OrchestrationState;
}

const worker = {
  subtaskId: "a",
  workerId: "w",
  workerRunId: "r",
  iteration: 1,
  attempt: 1,
  status: "completed" as const,
  output: "did the thing",
};

describe("leaderProducedNothing", () => {
  it("is true for an empty answer from a mission that dispatched nobody", () => {
    expect(leaderProducedNothing("", state())).toBe(true);
  });

  it("treats whitespace as empty", () => {
    expect(leaderProducedNothing("   \n\t ", state())).toBe(true);
  });

  it("is false when the leader actually answered", () => {
    expect(leaderProducedNothing("Here is the countdown.", state())).toBe(false);
  });

  /**
   * Workers ran, so the mission did something even if the leader's closing text
   * came back blank. That is a different, milder problem and not this one.
   */
  it("is false when workers reported results", () => {
    expect(leaderProducedNothing("", state({ workerResults: [worker] }))).toBe(false);
  });
});
