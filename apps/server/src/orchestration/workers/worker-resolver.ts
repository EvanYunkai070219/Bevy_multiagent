import { createHash, randomUUID } from "node:crypto";
import type { Agent, ExecutionPolicy, LeaderSubtask } from "../../types.js";
import { normalizeRoleSlug } from "../leader/validation.js";

const now = () => new Date().toISOString();

export class WorkerResolver {
  resolve(
    leader: Agent,
    subtask: LeaderSubtask,
    policy: ExecutionPolicy,
    agents: Agent[],
    workspacePath: (agentId: string) => string,
  ): { agent: Agent; created: boolean } {
    // `specialty` is the identity key: two subtasks resolving to the same value
    // are the same participant. Folding the subtask id in makes each step its own
    // agent, while a replan or retry of that same step still comes back to it
    // rather than leaking a fresh agent and workspace per iteration.
    const specialty = workerSpecialty(subtask, policy);
    const existing = agents.find(
      (agent) =>
        agent.role === "worker" &&
        agent.parentAgentId === leader.id &&
        agent.specialty === specialty,
    );
    if (existing) {
      return {
        agent: {
          ...existing,
          codexThreadId:
            policy.workerSessionPolicy === "fresh" ? null : existing.codexThreadId,
        },
        created: false,
      };
    }
    const timestamp = now();
    const id = randomUUID();
    // A worker's name only has to be distinct among the workers it stands
    // beside. Deduplicating against every agent in the store made the counter
    // global and permanent: rerunning one plan produced `agent4`, then
    // `agent4 2`, then `agent4 3`, because the previous runs' workers were
    // still on file and still holding the name. `specialty` above is the
    // identity that must be globally stable; the name is a label for one
    // leader's crew, and it is read in that crew's company.
    const siblings = agents.filter(
      (agent) => agent.role === "worker" && agent.parentAgentId === leader.id,
    );
    const name = uniqueAgentName(
      desiredWorkerName(subtask, specialty),
      siblings.map((agent) => agent.name),
    );
    return {
      created: true,
      agent: {
        id,
        name,
        description: "Worker specialist for " + specialty,
        instructions:
          "Complete only the delegated subtask. Keep output concise and include concrete files, commands, and verification when relevant.",
        status: "ready",
        role: "worker",
        parentAgentId: leader.id,
        specialty,
        projectId: null,
        unassignedPlacement: "temporary",
        workspacePath: workspacePath(id),
        codexThreadId: null,
        lastError: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };
  }
}

function workerSpecialty(subtask: LeaderSubtask, policy: ExecutionPolicy): string {
  const roleSlug = normalizeRoleSlug(subtask.role);
  if (policy.workerIdentityPolicy === "per_role") return roleSlug;

  // The identity suffix must survive long roles. The old
  // `${role}-${subtaskId}` string was sliced to 64 chars after concatenation,
  // so a 64-char role erased the distinct subtask id and collapsed workers.
  const identity = subtask.id;
  const identitySlug = normalizeRoleSlug(identity);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 8);
  const suffix = identitySlug.slice(0, 31) + "-" + digest;
  const prefixBudget = Math.max(0, 64 - suffix.length - 1);
  const prefix = roleSlug.slice(0, prefixBudget).replace(/-+$/g, "");
  return [prefix, suffix].filter(Boolean).join("-").slice(0, 64);
}

function desiredWorkerName(subtask: LeaderSubtask, specialty: string): string {
  const explicit = subtask.agentName?.trim();
  if (explicit) return explicit.slice(0, 80);
  const title = humanize(subtask.title);
  if (title) return title;
  const role = humanize(subtask.role);
  if (role) return role;
  return humanize(specialty) || "Worker Agent";
}

function humanize(value: string): string {
  const normalized = value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!normalized) return "";
  return normalized
    .split(" ")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")
    .slice(0, 80);
}

function uniqueAgentName(desired: string, existingNames: string[]): string {
  const used = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const base = (desired.trim() || "Worker Agent").slice(0, 80);
  if (!used.has(base.toLowerCase())) return base;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = " " + index;
    const candidate = base.slice(0, 80 - suffix.length).trimEnd() + suffix;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return randomUUID().slice(0, 8);
}
