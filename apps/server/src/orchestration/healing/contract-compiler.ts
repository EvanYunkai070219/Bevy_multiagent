import path from "node:path";
import type { LeaderPlan, LeaderSubtask, SubtaskContract, TaskNodeState } from "../../types.js";

export interface ContractCatalogEntry {
  contractKey: string;
  allowedInputs: string[];
  allowedOutputs: string[];
  allowedMutationPaths: string[];
  protectedPaths: string[];
  artifactSchemaIds: string[];
  targetedGateIds: string[];
  contractGateIds: string[];
  consumerGateIds: string[];
  regressionGateIds: string[];
  authorizedTools: string[];
}

export function compileContracts(
  plan: LeaderPlan,
  catalog: ContractCatalogEntry[],
  previousContracts: SubtaskContract[] = [],
): { contracts: SubtaskContract[]; nodes: TaskNodeState[] } {
  const ids = new Set<string>();
  for (const subtask of plan.subtasks) {
    if (ids.has(subtask.id)) throw new Error("Duplicate subtask id: " + subtask.id);
    ids.add(subtask.id);
  }
  for (const subtask of plan.subtasks) {
    for (const dep of subtask.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error("Subtask " + subtask.id + " depends on unknown subtask " + dep);
      }
    }
    const previous = previousContracts.find((item) => item.subtaskId === subtask.id);
    if (previous && !sameIds(previous.dependencyIds, subtask.dependsOn)) {
      throw new Error("changed dependency set for " + subtask.id);
    }
  }

  const consumers = new Map<string, string[]>();
  for (const subtask of plan.subtasks) consumers.set(subtask.id, []);
  for (const subtask of plan.subtasks) {
    for (const dep of subtask.dependsOn) {
      consumers.get(dep)?.push(subtask.id);
    }
  }

  const now = new Date().toISOString();
  const contracts: SubtaskContract[] = [];
  const nodes: TaskNodeState[] = [];
  for (const subtask of plan.subtasks) {
    const contract = compileOne(subtask, catalog, consumers.get(subtask.id) ?? []);
    contracts.push(contract);
    nodes.push({
      subtaskId: subtask.id,
      revision: 1,
      state: "pending",
      blockedBy: [...contract.dependencyIds],
      attemptId: null,
      faultId: null,
      diagnosisId: null,
      tournamentId: null,
      verificationIds: [],
      integrationContributionId: null,
      updatedAt: now,
    });
  }
  return { contracts, nodes };
}

function compileOne(
  subtask: LeaderSubtask,
  catalog: ContractCatalogEntry[],
  downstreamConsumers: string[],
): SubtaskContract {
  const entry = catalog.find((item) => item.contractKey === subtask.contractKey);
  if (!entry) {
    throw new Error("unknown contract key: " + String(subtask.contractKey ?? "(missing)"));
  }
  return {
    subtaskId: subtask.id,
    revision: 1,
    contractKey: entry.contractKey,
    inputs: boundPaths(subtask.inputs, entry.allowedInputs, "input", entry.protectedPaths),
    outputs: boundPaths(subtask.outputs, entry.allowedOutputs, "output", entry.protectedPaths),
    dependencyIds: [...subtask.dependsOn],
    downstreamConsumers: [...downstreamConsumers],
    allowedMutationPaths: boundPaths(
      subtask.mutationPaths,
      entry.allowedMutationPaths,
      "mutation path",
      entry.protectedPaths,
    ),
    protectedPaths: [...entry.protectedPaths],
    artifactSchemaIds: [...entry.artifactSchemaIds],
    targetedGateIds: [...entry.targetedGateIds],
    contractGateIds: [...entry.contractGateIds],
    consumerGateIds: [...entry.consumerGateIds],
    regressionGateIds: [...entry.regressionGateIds],
    authorizedTools: [...entry.authorizedTools],
  };
}

function boundPaths(
  declared: string[] | undefined,
  allowed: string[],
  kind: string,
  protectedPaths: string[],
): string[] {
  const unique = uniqueSorted(declared ?? allowed);
  for (const item of unique) {
    assertSafeRelativePath(item);
    if (isProtectedPath(item, protectedPaths)) {
      throw new Error("protected path: " + item);
    }
    if (!allowed.includes(item)) {
      throw new Error("undeclared " + kind + ": " + item);
    }
  }
  return unique;
}

function assertSafeRelativePath(value: string): void {
  if (path.isAbsolute(value) || value.startsWith("/") || value.startsWith("\\")) {
    throw new Error("absolute path: " + value);
  }
  const segments = value.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(".. is not allowed in " + value);
  }
}

function isProtectedPath(value: string, protectedPaths: string[]): boolean {
  return protectedPaths.some(
    (item) => value === item || value.startsWith(item + "/") || value.startsWith(item + "\\"),
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
