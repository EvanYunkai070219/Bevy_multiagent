/** The one-shot exec backend, behind the AgentRuntime seam. */
import { describe, expect, it } from "vitest";
import { ExecRuntime } from "../src/runtime/exec-runtime.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../src/types.js";
import type { TeamMessageQueued } from "../src/coordination/messages.js";

const request: RunnerRequest = {
  runId: "run-1",
  agentId: "agent-1",
  parentRunId: "leader-1",
  workspacePath: "/workspace",
  prompt: "do the thing",
  threadId: null,
};

const message: TeamMessageQueued = {
  id: "m1",
  parentRunId: "leader-1",
  fromWorkerRunId: "run-2",
  toWorkerRunId: "run-1",
  delivery: "wakeup",
  content: "please continue",
  workspaceRefs: [],
  createdAt: "2026-08-27T00:00:00.000Z",
};

function stubRunner(result: Partial<RunnerResult> = {}): AgentRunner & { calls: RunnerRequest[] } {
  const calls: RunnerRequest[] = [];
  return {
    calls,
    async run(req) {
      calls.push(req);
      return { output: "done", threadId: "thread-1", usage: null, ...result };
    },
    async cancel() {
      return true;
    },
    async isAvailable() {
      return true;
    },
  };
}

describe("exec runtime", () => {
  it("passes the request through to the underlying runner unchanged", async () => {
    const runner = stubRunner();
    const runtime = new ExecRuntime(runner);
    const checkpoint = await runtime.start(request);

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toBe(request);
    expect(checkpoint.output).toBe("done");
    expect(checkpoint.threadId).toBe("thread-1");
  });

  // A one-shot turn is over when it returns. Reporting anything else would
  // invite the coordination layer to address a worker that has already exited.
  it("is not_started before the turn and closed after it", async () => {
    const runtime = new ExecRuntime(stubRunner());
    expect(runtime.snapshot().state).toBe("not_started");
    await runtime.start(request);
    expect(runtime.snapshot().state).toBe("closed");
  });

  it("reports messages as undeliverable rather than silently dropping them", async () => {
    const runtime = new ExecRuntime(stubRunner());
    await runtime.start(request);

    for (const result of [await runtime.inject(message), await runtime.wake(message)]) {
      expect(result.state).toBe("undeliverable");
      expect(result.reason).toBe("RUNTIME_CAPABILITY_UNAVAILABLE");
    }
  });

  it("declares queued_follow_up rather than live_steer", () => {
    expect(new ExecRuntime(stubRunner()).capability()).toBe("queued_follow_up");
  });

  it("cancels through the runner using the agent id", async () => {
    const runner = stubRunner();
    const runtime = new ExecRuntime(runner);
    await runtime.start(request);
    await runtime.cancel("user asked");
    expect(runtime.snapshot().state).toBe("closed");
  });
});
