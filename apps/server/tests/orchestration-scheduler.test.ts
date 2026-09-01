import { describe, expect, it } from "vitest";
import { Scheduler } from "../src/orchestration/scheduler.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { RunControl, RunTerminalError } from "../src/orchestration/run-control.js";
import type { LeaderSubtask, WorkerResult } from "../src/types.js";

const sub = (id: string, dependsOn: string[] = []): LeaderSubtask => ({
  id, title: id, role: "worker", prompt: id, objective: "o",
  successCriteria: ["c"], expectedOutput: "e", dependsOn,
});
const ok = (id: string, upstream: WorkerResult[]): WorkerResult => ({
  subtaskId: id, workerId: "w-" + id, workerRunId: "r-" + id, iteration: 1,
  attempt: 1, status: "completed", output: id + "<-" + upstream.map((u) => u.subtaskId).join(","),
  usage: null, durationMs: 1, artifacts: [],
});

describe("Scheduler topological waves", () => {
  it("settles a wave in planner order before admitting dependants", async () => {
    const trace: string[] = [];
    const results = await new Scheduler().execute(
      [sub("slow"), sub("fast"), sub("consumer", ["slow", "fast"])],
      defaultExecutionPolicy,
      0,
      async (s, _a, upstream) => {
        trace.push("start:" + s.id);
        if (s.id === "slow") await new Promise((resolve) => setTimeout(resolve, 10));
        trace.push("finish:" + s.id);
        return s.id === "consumer"
          ? ok(s.id, upstream)
          : { ...ok(s.id, upstream), status: "contribution_ready" };
      },
      1,
      undefined,
      async (wave) => {
        trace.push("settle:" + wave.map((result) => result.subtaskId).join(","));
        return wave.map((result) => ({ ...result, status: "completed" }));
      },
    );

    expect(trace).toEqual([
      "start:slow", "start:fast", "finish:fast", "finish:slow",
      "settle:slow,fast", "start:consumer", "finish:consumer", "settle:consumer",
    ]);
    expect(results.map((result) => result.subtaskId)).toEqual(["slow", "fast", "consumer"]);
  });

  it("never treats an unsettled contribution as dependency satisfaction", async () => {
    let consumerRan = false;
    const results = await new Scheduler().execute(
      [sub("producer"), sub("consumer", ["producer"])], defaultExecutionPolicy, 0,
      async (s, _a, upstream) => {
        if (s.id === "consumer") consumerRan = true;
        return { ...ok(s.id, upstream), status: "contribution_ready" };
      }, 1,
    );

    expect(consumerRan).toBe(false);
    expect(results.find((result) => result.subtaskId === "consumer")?.status).toBe("blocked");
  });

  it("runs a dependency after its upstream and passes its result down", async () => {
    const order: string[] = [];
    const results = await new Scheduler().execute(
      [sub("a"), sub("b", ["a"])], defaultExecutionPolicy, 0,
      async (s, _a, upstream) => { order.push(s.id); return ok(s.id, upstream); }, 1,
    );
    expect(order).toEqual(["a", "b"]);
    const b = results.find((r) => r.subtaskId === "b")!;
    expect(b.output).toContain("<-a"); // received a's result as upstream
  });

  it("blocks a dependent (transitively) when an upstream fails", async () => {
    const results = await new Scheduler().execute(
      [sub("a"), sub("b", ["a"]), sub("c", ["b"])], defaultExecutionPolicy, 0,
      async (s, _a, upstream) =>
        s.id === "a"
          ? { ...ok(s.id, upstream), status: "failed", output: "" }
          : ok(s.id, upstream),
      1,
    );
    const byId = Object.fromEntries(results.map((r) => [r.subtaskId, r]));
    expect(byId.b!.status).toBe("blocked");
    expect(byId.c!.status).toBe("blocked");
    expect(byId.b!.workerRunId).toBeNull();
  });

  it("does not consume run budget for blocked subtasks", async () => {
    let ran = 0;
    const results = await new Scheduler().execute(
      [sub("a"), sub("b", ["a"])], { ...defaultExecutionPolicy, maxTotalWorkerRuns: 1 }, 0,
      async (s, _a, upstream) => { ran++; return ok(s.id, upstream); }, 1,
    );
    // a runs (budget 1), b is a real run only if budget remains; here b runs too
    // because a succeeded and consumed 1 of 1 -> b is budget-blocked.
    expect(ran).toBe(1);
    expect(results.find((r) => r.subtaskId === "b")!.status).toBe("blocked");
  });

  it("runs all-independent subtasks in one level (flat-pool behavior)", async () => {
    const results = await new Scheduler().execute(
      [sub("a"), sub("b"), sub("c")], defaultExecutionPolicy, 0,
      async (s, _a, upstream) => ok(s.id, upstream), 1,
    );
    expect(results.every((r) => r.status === "completed")).toBe(true);
  });

  it("does not start the next queued node after a terminal signal", async () => {
    const control = new RunControl({
      ...defaultExecutionPolicy,
      rootTimeoutMs: 60_000,
    });
    const started: string[] = [];
    await expect(
      new Scheduler().execute(
        [sub("a"), sub("b")],
        { ...defaultExecutionPolicy, maxParallel: 1 },
        0,
        async (s, _a, upstream) => {
          started.push(s.id);
          if (s.id === "a") control.stop("root_deadline", "stop after first");
          return ok(s.id, upstream);
        },
        1,
        undefined,
        undefined,
        control,
      ),
    ).rejects.toBeInstanceOf(RunTerminalError);
    expect(started).toEqual(["a"]);
    control.close();
  });

  it("checks control before each wave so a later layer never starts", async () => {
    const control = new RunControl({
      ...defaultExecutionPolicy,
      rootTimeoutMs: 60_000,
    });
    const started: string[] = [];
    await expect(
      new Scheduler().execute(
        [sub("a"), sub("b", ["a"])],
        defaultExecutionPolicy,
        0,
        async (s, _a, upstream) => {
          started.push(s.id);
          control.stop("provider_rate_limited", "provider died");
          return ok(s.id, upstream);
        },
        1,
        undefined,
        undefined,
        control,
      ),
    ).rejects.toBeInstanceOf(RunTerminalError);
    expect(started).toEqual(["a"]);
    control.close();
  });

  it("lets independent siblings in the same wave finish when a required task fails", async () => {
    const started: string[] = [];
    const results = await new Scheduler().execute(
      [sub("producer"), sub("sibling"), sub("consumer", ["producer"])],
      defaultExecutionPolicy,
      0,
      async (s, _a, upstream) => {
        started.push(s.id);
        if (s.id === "producer") {
          return { ...ok(s.id, upstream), status: "failed", output: "", error: "repair_unavailable" };
        }
        return ok(s.id, upstream);
      },
      1,
    );
    expect(started).toContain("producer");
    expect(started).toContain("sibling");
    expect(started).not.toContain("consumer");
    const byId = Object.fromEntries(results.map((result) => [result.subtaskId, result]));
    expect(byId.producer!.status).toBe("failed");
    expect(byId.sibling!.status).toBe("completed");
    expect(byId.consumer!.status).toBe("blocked");
  });

  it("does not retry a failed required task after an unavailable diagnosis", async () => {
    const runs: string[] = [];
    const results = await new Scheduler().execute(
      [sub("a"), sub("b", ["a"])],
      { ...defaultExecutionPolicy, maxIterations: 2, maxTotalWorkerRuns: 10 } as typeof defaultExecutionPolicy,
      0,
      async (s, attempt, upstream) => {
        runs.push(s.id + ":" + attempt);
        if (s.id === "a") {
          return { ...ok(s.id, upstream), status: "failed", output: "", error: "repair_unavailable" };
        }
        return ok(s.id, upstream);
      },
      1,
    );
    expect(runs).toEqual(["a:1"]);
    expect(results.find((result) => result.subtaskId === "a")?.status).toBe("failed");
    expect(results.find((result) => result.subtaskId === "b")?.status).toBe("blocked");
  });

  it("invokes onResult for each finished sibling before blocking consumers", async () => {
    const healed: string[] = [];
    const results = await new Scheduler().execute(
      [sub("producer"), sub("sibling")],
      defaultExecutionPolicy,
      0,
      async (s, _a, upstream) =>
        s.id === "producer"
          ? { ...ok(s.id, upstream), status: "failed", output: "", error: "tests failed" }
          : ok(s.id, upstream),
      1,
      undefined,
      undefined,
      undefined,
      async (result) => {
        healed.push(result.subtaskId);
        return result;
      },
    );
    expect(healed.sort()).toEqual(["producer", "sibling"]);
    expect(results.find((result) => result.subtaskId === "sibling")?.status).toBe("completed");
    expect(results.find((result) => result.subtaskId === "producer")?.status).toBe("failed");
  });

  it("settles the wave only after every onResult returns, never during onResult", async () => {
    const order: string[] = [];
    await new Scheduler().execute(
      [sub("producer"), sub("sibling")],
      defaultExecutionPolicy,
      0,
      async (s, _a, upstream) =>
        s.id === "producer"
          ? { ...ok(s.id, upstream), status: "failed", output: "", error: "tests failed" }
          : ok(s.id, upstream),
      1,
      undefined,
      async (wave) => {
        order.push("settle");
        return wave;
      },
      undefined,
      async (result) => {
        order.push("onResult:" + result.subtaskId);
        return result;
      },
    );
    expect(order.filter((item) => item.startsWith("onResult"))).toHaveLength(2);
    expect(order.at(-1)).toBe("settle");
  });

  it("starts a dependent after settleWave heals a failed producer to completed", async () => {
    const started: string[] = [];
    const results = await new Scheduler().execute(
      [sub("backend"), sub("frontend"), sub("integration", ["backend", "frontend"])],
      defaultExecutionPolicy,
      0,
      async (s, _a, upstream) => {
        started.push(s.id);
        if (s.id === "backend") {
          return { ...ok(s.id, upstream), status: "failed", output: "", error: "tests failed" };
        }
        return ok(s.id, upstream);
      },
      1,
      undefined,
      async (wave) =>
        wave.map((result) =>
          result.subtaskId === "backend" && result.status === "failed"
            ? { ...result, status: "completed" as const, error: null }
            : result,
        ),
    );
    expect(started).toEqual(["backend", "frontend", "integration"]);
    expect(results.find((result) => result.subtaskId === "integration")?.status).toBe("completed");
    expect(results.map((result) => result.subtaskId)).toEqual(["backend", "frontend", "integration"]);
  });
});
