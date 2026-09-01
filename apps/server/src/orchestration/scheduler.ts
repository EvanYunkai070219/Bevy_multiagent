import { RunCancelledError } from "../errors.js";
import { TrajectoryStoppedError } from "./healing/fault-detector.js";
import type { ExecutionPolicy, LeaderSubtask, WorkerResult } from "../types.js";
import type { RunControl } from "./run-control.js";

export type RunSubtask = (
  subtask: LeaderSubtask,
  attempt: number,
  upstream: WorkerResult[],
) => Promise<WorkerResult>;

/**
 * Reports a wave wider than `maxParallel` before it runs. Such a wave still
 * executes, in batches — but a plan whose subtasks expect their siblings to be
 * running has already lost, and without this the symptom is a silent wait until
 * the worker timeout.
 */
export type OnOversizedWave = (waveSize: number, maxParallel: number) => void;
export type SettleWave = (results: WorkerResult[]) => Promise<WorkerResult[]>;

export class Scheduler {
  async execute(
    subtasks: LeaderSubtask[],
    policy: ExecutionPolicy,
    alreadyRunCount: number,
    runOne: RunSubtask,
    iteration: number,
    onOversizedWave?: OnOversizedWave,
    settleWave?: SettleWave,
    control?: RunControl,
    onResult?: (result: WorkerResult) => Promise<WorkerResult>,
  ): Promise<WorkerResult[]> {
    const byId = new Map(subtasks.map((s) => [s.id, s]));
    const known = (s: LeaderSubtask) => s.dependsOn.filter((d) => byId.has(d));
    const resultsById = new Map<string, WorkerResult>();
    const satisfied = new Set<string>();
    let budget = Math.max(0, policy.maxTotalWorkerRuns - alreadyRunCount);

    // Kahn layering: level(node) = max(level(dep)) + 1
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const s of subtasks) indegree.set(s.id, known(s).length);
    for (const s of subtasks) {
      for (const dep of known(s)) {
        (dependents.get(dep) ?? dependents.set(dep, []).get(dep)!).push(s.id);
      }
    }
    const level = new Map<string, number>();
    const queue = subtasks.filter((s) => (indegree.get(s.id) ?? 0) === 0).map((s) => s.id);
    for (const id of queue) level.set(id, 0);
    while (queue.length) {
      const id = queue.shift()!;
      for (const child of dependents.get(id) ?? []) {
        level.set(child, Math.max(level.get(child) ?? 0, (level.get(id) ?? 0) + 1));
        const n = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, n);
        if (n === 0) queue.push(child);
      }
    }
    const maxLevel = level.size ? Math.max(...level.values()) : 0;
    const levels: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
    for (const s of subtasks) {
      const lv = level.get(s.id);
      if (lv !== undefined) levels[lv]!.push(s.id);
    }

    const blocked = (s: LeaderSubtask, reason: string): WorkerResult => ({
      subtaskId: s.id, workerId: null, workerRunId: null, iteration,
      attempt: 0, status: "blocked", output: "", error: reason,
      usage: null, durationMs: 0, artifacts: [],
    });

    for (const ids of levels) {
      control?.assertActive();
      const runnable: LeaderSubtask[] = [];
      for (const id of ids) {
        const s = byId.get(id)!;
        const unmet = known(s).find((d) => !satisfied.has(d));
        if (unmet) {
          const r = blocked(s, "Skipped: dependency " + unmet + " did not complete");
          resultsById.set(id, r); continue;
        }
        if (budget <= 0) {
          const r = blocked(s, "Skipped: worker run budget exhausted");
          resultsById.set(id, r); continue;
        }
        runnable.push(s); budget -= 1;
      }
      if (runnable.length > policy.maxParallel) {
        onOversizedWave?.(runnable.length, policy.maxParallel);
      }
      let next = 0;
      const waveResults: WorkerResult[] = new Array(runnable.length);
      const pump = async (): Promise<void> => {
        while (next < runnable.length) {
          const index = next++;
          const s = runnable[index]!;
          const upstream = known(s)
            .map((d) => resultsById.get(d))
            .filter((r): r is WorkerResult => !!r && satisfied.has(r.subtaskId));
          control?.assertActive();
          const result = await runOne(s, 1, upstream);
          waveResults[index] = onResult ? await onResult(result) : result;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(policy.maxParallel, runnable.length) }, () => pump()),
      );
      const settled = settleWave ? await settleWave(waveResults) : waveResults;
      if (
        settled.length !== runnable.length ||
        settled.some((result, index) => result.subtaskId !== runnable[index]!.id)
      ) throw new Error("wave_settlement_order_mismatch");
      for (const result of settled) {
        resultsById.set(result.subtaskId, result);
        if (result.status === "completed" || result.status === "partial") {
          satisfied.add(result.subtaskId);
        }
      }
    }
    // Cycle leftovers (unreachable when validation ran, but defensive):
    for (const s of subtasks) {
      if (!resultsById.has(s.id)) {
        const r = blocked(s, "Skipped: dependency cycle");
        resultsById.set(s.id, r);
      }
    }
    return subtasks.map((subtask) => resultsById.get(subtask.id)!);
  }
}

export function classifyWorkerError(error: unknown): WorkerResult["status"] {
  if (error instanceof RunCancelledError) return "cancelled";
  if (error instanceof TrajectoryStoppedError) return "failed";
  if (error && typeof error === "object" && "reason" in error) {
    const reason = (error as { reason?: string }).reason;
    if (reason === "user_cancelled") return "cancelled";
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("timed out") ? "timed_out" : "failed";
}
