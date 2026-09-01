import { z } from "zod";
import { assertNoForbiddenLeaderKeys, type ExecutionPolicy, type LeaderPlan } from "../../types.js";

const subtaskSchema = z.object({
  id: z.string().trim().min(1).optional(),
  agentName: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().min(1),
  role: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  successCriteria: z.array(z.string().trim().min(1)).min(1),
  expectedOutput: z.string().trim().min(1),
  dependsOn: z.array(z.string()).default([]),
  contractKey: z.string().trim().min(1).optional(),
  inputs: z.array(z.string().trim().min(1)).optional(),
  outputs: z.array(z.string().trim().min(1)).optional(),
  mutationPaths: z.array(z.string().trim().min(1)).optional(),
});

const planSchema = z.object({
  needsSubagents: z.boolean(),
  rationale: z.string().trim().min(1),
  subtasks: z.array(subtaskSchema),
});

export function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Completion was not valid JSON");
    return JSON.parse(match[0]);
  }
}

export function parseLeaderPlan(text: string, policy: ExecutionPolicy): LeaderPlan {
  const raw = parseJsonObject(text);
  assertBoundedPlanDeclarations(raw);
  const parsed = planSchema.parse(raw);
  if (!parsed.needsSubagents) {
    return { needsSubagents: false, rationale: parsed.rationale, subtasks: [] };
  }
  if (parsed.subtasks.length === 0) {
    throw new Error("Plan requested subagents without subtasks");
  }
  if (parsed.subtasks.length > policy.maxSubtasks) {
    throw new Error("Plan exceeded maxSubtasks");
  }
  const ids = new Set<string>();
  const subtasks = parsed.subtasks.map((subtask, index) => {
    const role = normalizeRoleSlug(subtask.role);
    if (!role) throw new Error("Invalid worker role slug");
    const id = normalizeSubtaskId(subtask.id ?? "task-" + (index + 1));
    if (ids.has(id)) throw new Error("Duplicate subtask id: " + id);
    ids.add(id);
    const seen = new Set<string>();
    const dependsOn: string[] = [];
    for (const raw of subtask.dependsOn) {
      const dep = normalizeSubtaskId(raw);
      if (!seen.has(dep)) {
        seen.add(dep);
        dependsOn.push(dep);
      }
    }
    const { agentName, contractKey, inputs, outputs, mutationPaths, ...rest } = subtask;
    const named = agentName !== undefined && !isPlaceholderName(agentName);
    return {
      ...rest,
      id,
      role,
      dependsOn,
      ...(named ? { agentName } : {}),
      ...(contractKey === undefined ? {} : { contractKey }),
      ...(inputs === undefined ? {} : { inputs }),
      ...(outputs === undefined ? {} : { outputs }),
      ...(mutationPaths === undefined ? {} : { mutationPaths }),
    };
  });
  for (const subtask of subtasks) {
    for (const dep of subtask.dependsOn) {
      if (dep === subtask.id) {
        throw new Error("Subtask " + subtask.id + " cannot depend on itself");
      }
      if (!ids.has(dep)) {
        throw new Error("Subtask " + subtask.id + " depends on unknown subtask " + dep);
      }
    }
  }
  assertAcyclic(subtasks);
  assertDistinctAgentNames(subtasks);
  return { needsSubagents: true, rationale: parsed.rationale, subtasks };
}

/**
 * A name that only says "this is an agent".
 *
 * The planner is asked for a name describing the worker's specialty, and every
 * rule here was satisfied by `agent1` -- non-empty, short, distinct -- so a
 * plan naming its workers `agent1` through `agent10` was accepted, and the
 * sidebar listed ten agents whose names answered nothing. Dropping the name
 * hands the job to the subtask's title, which is always about the work.
 *
 * Only the whole name counts: "Schema Agent" and "Worker Pool Analyst" say
 * something and are left alone.
 */
export function isPlaceholderName(name: string): boolean {
  return /^(agent|worker|subagent|sub-agent|assistant|task|node|step)[\s_-]*\d*$/i.test(
    name.trim(),
  );
}

function assertDistinctAgentNames(subtasks: { agentName?: string }[]): void {
  const names = new Set<string>();
  for (const subtask of subtasks) {
    if (subtask.agentName === undefined) continue;
    const normalized = subtask.agentName.trim().toLowerCase();
    if (names.has(normalized)) {
      throw new Error("Duplicate worker agentName: " + subtask.agentName);
    }
    names.add(normalized);
  }
}

function assertAcyclic(subtasks: { id: string; dependsOn: string[] }[]): void {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const s of subtasks) indegree.set(s.id, 0);
  for (const s of subtasks) {
    for (const dep of s.dependsOn) {
      indegree.set(s.id, (indegree.get(s.id) ?? 0) + 1);
      (dependents.get(dep) ?? dependents.set(dep, []).get(dep)!).push(s.id);
    }
  }
  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited += 1;
    for (const child of dependents.get(id) ?? []) {
      const n = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, n);
      if (n === 0) queue.push(child);
    }
  }
  if (visited !== subtasks.length) throw new Error("Subtask dependency cycle detected");
}

export function normalizeRoleSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeSubtaskId(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) throw new Error("Invalid subtask id");
  return slug;
}

function assertBoundedPlanDeclarations(raw: unknown): void {
  if (!raw || typeof raw !== "object" || !("subtasks" in raw)) return;
  const subtasks = (raw as { subtasks: unknown }).subtasks;
  if (!Array.isArray(subtasks)) return;
  for (const item of subtasks) {
    if (!item || typeof item !== "object") continue;
    assertNoForbiddenLeaderKeys(item, "Plan");
  }
}
