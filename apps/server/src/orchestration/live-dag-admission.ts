import { randomUUID } from "node:crypto";
import { compileContracts, type ContractCatalogEntry } from "./healing/contract-compiler.js";
import type { DispatchSubagentRequest } from "../coordination/ingress.js";
import {
  assertNoForbiddenLeaderKeys,
  emptyHealingState,
  type LeaderSubtask,
  type LeaderPlan,
  type OrchestrationState,
  type SubtaskContract,
  type TaskNodeState,
} from "../types.js";

export interface LiveDagAdmissionResult {
  subtask: LeaderSubtask;
  contract: SubtaskContract;
  node: TaskNodeState;
  startWorker: boolean;
}

export type LiveDagAdmissionAttempt =
  | { ok: true; admission: LiveDagAdmissionResult }
  | { ok: false; error: "repair_graph_frozen" };

export type PlannedGraphAdmissionAttempt =
  | { ok: true }
  | { ok: false; error: "repair_graph_frozen" };

export class LiveDagAdmission {
  constructor(private readonly catalog: ContractCatalogEntry[]) {
    if (!Array.isArray(catalog) || catalog.length === 0) {
      throw new Error(
        "missing contract catalog: healing admission requires a non-empty catalog before any runtime is created",
      );
    }
  }

  tryAdmit(
    state: OrchestrationState,
    request: DispatchSubagentRequest,
    now: string = new Date().toISOString(),
  ): LiveDagAdmissionAttempt {
    if (state.healing?.repairGraphFence !== null && state.healing?.repairGraphFence !== undefined) {
      return { ok: false, error: "repair_graph_frozen" };
    }
    return { ok: true, admission: this.admit(state, request, now) };
  }

  tryAdmitPlan(state: OrchestrationState, plan: LeaderPlan): PlannedGraphAdmissionAttempt {
    if (state.healing.repairGraphFence !== null) {
      return { ok: false, error: "repair_graph_frozen" };
    }
    const compiled = compileContracts(plan, this.catalog);
    for (const contract of compiled.contracts) {
      if (!state.healing.contracts.some((item) => item.subtaskId === contract.subtaskId)) {
        state.healing.contracts.push(contract);
      }
    }
    for (const node of compiled.nodes) {
      if (!state.healing.nodes.some((item) => item.subtaskId === node.subtaskId)) {
        state.healing.nodes.push(node);
      }
    }
    return { ok: true };
  }

  admit(
    state: OrchestrationState,
    request: DispatchSubagentRequest,
    now: string = new Date().toISOString(),
  ): LiveDagAdmissionResult {
    assertNoForbiddenLeaderKeys(request, "Leader dispatch");
    if (!state.healing) state.healing = emptyHealingState();
    const subtask = leaderDispatchSubtask(request, state.healing.nodes.length + 1);
    if (
      state.healing.nodes.some((node) => node.subtaskId === subtask.id) ||
      state.healing.contracts.some((contract) => contract.subtaskId === subtask.id) ||
      state.iterationPlans.some((plan) =>
        plan.plan.subtasks.some((item) => item.id === subtask.id),
      )
    ) {
      throw new Error("already admitted: " + subtask.id);
    }
    for (const dep of subtask.dependsOn) {
      if (!state.healing.nodes.some((node) => node.subtaskId === dep)) {
        throw new Error("dependsOn not admitted: " + dep);
      }
    }
    if (!state.iterationPlans.some((plan) => plan.reason === "leader_codex")) {
      state.iterationPlans.push({
        iteration: 1,
        createdAt: now,
        reason: "leader_codex",
        plan: {
          needsSubagents: true,
          rationale: "Leader Codex session dispatches workers through Launchpad MCP tools.",
          subtasks: [],
        },
      });
    }
    const plan = state.iterationPlans.at(-1)!.plan;
    const compiled = compileContracts(
      {
        needsSubagents: true,
        rationale: plan.rationale,
        subtasks: [...plan.subtasks, subtask],
      },
      this.catalog,
    );
    const previousContracts = state.healing.contracts;
    const nextContracts = compiled.contracts.map((contract) => {
      const existing = previousContracts.find((item) => item.subtaskId === contract.subtaskId);
      if (!existing) return contract;
      const node = state.healing.nodes.find((item) => item.subtaskId === contract.subtaskId);
      const inFlight = node &&
        node.state !== "pending" &&
        node.state !== "ready" &&
        node.state !== "blocked";
      if (inFlight) return { ...contract, revision: existing.revision };
      const consumersChanged = existing.downstreamConsumers.join("\0") !==
        contract.downstreamConsumers.join("\0");
      return { ...contract, revision: existing.revision + (consumersChanged ? 1 : 0) };
    });
    const nextNodes: TaskNodeState[] = compiled.nodes.map((node) => {
      const contract = nextContracts.find((item) => item.subtaskId === node.subtaskId)!;
      const existing = state.healing.nodes.find((item) => item.subtaskId === node.subtaskId);
      if (node.subtaskId === subtask.id) {
        const blockedBy = subtask.dependsOn.filter((dep) => !producerComplete(state, dep));
        return {
          ...node,
          revision: contract.revision,
          state: blockedBy.length > 0 ? "blocked" : "ready",
          blockedBy,
          updatedAt: now,
        };
      }
      const previous = previousContracts.find((item) => item.subtaskId === node.subtaskId);
      const contractAdvanced = previous !== undefined && contract.revision > previous.revision;
      const inFlight = existing &&
        existing.state !== "pending" &&
        existing.state !== "ready" &&
        existing.state !== "blocked";
      return {
        ...(existing ?? node),
        revision: inFlight
          ? (existing?.revision ?? node.revision)
          : contractAdvanced
            ? Math.max(existing?.revision ?? contract.revision, contract.revision)
            : (existing?.revision ?? node.revision),
        updatedAt: now,
      };
    });
    state.healing.contracts = nextContracts;
    state.healing.nodes = nextNodes;
    plan.subtasks.push(subtask);
    const admitted = nextNodes.find((item) => item.subtaskId === subtask.id)!;
    const admittedContract = nextContracts.find((item) => item.subtaskId === subtask.id)!;
    return {
      subtask,
      contract: admittedContract,
      node: admitted,
      startWorker: admitted.state === "ready",
    };
  }
}

export function leaderDispatchSubtask(
  request: DispatchSubagentRequest,
  ordinal: number,
): LeaderSubtask {
  const prompt = String(request.prompt ?? "").trim();
  if (!prompt) throw new Error("EMPTY_PROMPT: dispatch_subagent requires prompt");
  const fallbackId = "leader-dispatch-" + ordinal + "-" + randomUUID().slice(0, 8);
  const rawId = String(request.id || fallbackId)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const id = rawId || fallbackId;
  const title = String(request.title || request.objective || prompt.slice(0, 80) || id).trim();
  const role = String(request.role || request.agentName || title || "Worker").trim();
  const agentName = request.agentName?.trim();
  return {
    id,
    title,
    role,
    prompt,
    objective: String(request.objective || title).trim(),
    successCriteria:
      request.successCriteria && request.successCriteria.length > 0
        ? request.successCriteria.map(String)
        : ["Return concise findings with evidence and unresolved gaps."],
    expectedOutput: String(
      request.expectedOutput ||
        "Concise worker result with findings, evidence, files/artifacts, and gaps.",
    ),
    dependsOn: request.dependsOn?.map(String) ?? [],
    ...(agentName ? { agentName } : {}),
    ...(request.requiresGitContribution === undefined
      ? {}
      : { requiresGitContribution: request.requiresGitContribution }),
    ...(request.initialMessage === undefined ? {} : { initialMessage: request.initialMessage }),
    ...(request.initialMessageWorkspaceRefs === undefined
      ? {}
      : { initialMessageWorkspaceRefs: request.initialMessageWorkspaceRefs }),
    ...(request.contractKey ? { contractKey: String(request.contractKey) } : {}),
    ...(request.inputs ? { inputs: request.inputs.map(String) } : {}),
    ...(request.outputs ? { outputs: request.outputs.map(String) } : {}),
    ...(request.mutationPaths ? { mutationPaths: request.mutationPaths.map(String) } : {}),
  };
}

function producerComplete(state: OrchestrationState, subtaskId: string): boolean {
  const node = state.healing.nodes.find((item) => item.subtaskId === subtaskId);
  return node?.state === "completed";
}
