import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Agent,
  AgentRun,
  AttemptWorkspaceRecord,
  ContributionRecord,
  Database,
  IntegrationRecord,
  OrchestrationState,
  ProjectBaselineTransition,
  ProjectRecord,
  ProjectRunRecord,
  RepairGraphFence,
  WorkerResult,
} from "./types.js";
import { emptyHealingState } from "./types.js";
import {
  normalizeEvolutionHistoryStatus,
  normalizeEvolutionOutbox,
} from "./orchestration/evolution/evolution-types.js";
import type { EvolutionOutboxEntry } from "./orchestration/evolution/evolution-types.js";
import { canonicalSerialize } from "./orchestration/evolution/evolution-fingerprints.js";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

const emptyDatabase = (): Database => ({
  version: 1,
  projects: [],
  agents: [],
  messages: [],
  runs: [],
});

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Database;
      if (parsed.version !== 1 || !Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      this.data = normalizeDatabase(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      normalizeEvolutionOutboxes(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

function normalizeDatabase(database: Database): Database {
  return {
    version: 1,
    projects: Array.isArray(database.projects)
      ? database.projects.map(normalizeProject)
      : [],
    agents: database.agents.map(normalizeAgent),
    messages: Array.isArray(database.messages) ? database.messages : [],
    runs: Array.isArray(database.runs) ? database.runs.map(normalizeRun) : [],
    ...(database.evolutionReconciliation === undefined ? {} : {
      evolutionReconciliation: structuredClone(database.evolutionReconciliation),
    }),
  };
}

function normalizeAgent(agent: Agent): Agent {
  const projectId = agent.projectId ?? null;
  return {
    ...agent,
    projectId,
    unassignedPlacement: projectId
      ? null
      : agent.unassignedPlacement ?? "previous",
    role: agent.role ?? "standalone",
    parentAgentId: agent.parentAgentId ?? null,
    specialty: agent.specialty ?? null,
  };
}

function normalizeRun(run: AgentRun): AgentRun {
  return {
    ...run,
    projectId: run.projectId ?? null,
    kind: run.kind ?? "single",
    parentRunId: run.parentRunId ?? null,
    orchestration: run.orchestration === null || run.orchestration === undefined
      ? run.orchestration ?? null
      : normalizeOrchestration(run.orchestration, run.id),
    ...(run.project === undefined ? {} : {
      project: normalizeProjectRun(run.project),
    }),
  };
}

function normalizeOrchestration(state: OrchestrationState, runId: string): OrchestrationState {
  const healing = state.healing ?? emptyHealingState();
  const evolutionHistory = normalizeEvolutionHistoryStatus(state.evolutionHistory);
  return {
    ...state,
    healing: {
      ...emptyHealingState(),
      ...healing,
      snapshots: healing.snapshots ?? [],
      candidates: (healing.candidates ?? []).map((candidate) => ({
        ...candidate,
        historicalMatchRecordId: candidate.historicalMatchRecordId ?? null,
        historicalVerificationId: candidate.historicalVerificationId ?? null,
        evolutionFingerprints: candidate.evolutionFingerprints ?? null,
      })),
      repairGraphFence: normalizeRepairGraphFence(healing.repairGraphFence, runId),
    },
    workerResults: (state.workerResults ?? []).map(normalizeWorkerResult),
    evolutionOutbox: [...normalizeEvolutionOutbox(state.evolutionOutbox ?? [])],
    skillRouting: state.skillRouting ?? [],
    ...(evolutionHistory === undefined ? {} : { evolutionHistory }),
  };
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function normalizeRepairGraphFence(value: unknown, runId: string): RepairGraphFence | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid repair graph fence");
  }
  const fence = value as Partial<RepairGraphFence>;
  if (
    fence.runId !== runId ||
    typeof fence.tournamentId !== "string" || fence.tournamentId.length === 0 ||
    !Number.isSafeInteger(fence.graphRevision) || Number(fence.graphRevision) < 0 ||
    typeof fence.graphHash !== "string" || !SHA256_PATTERN.test(fence.graphHash) ||
    !Array.isArray(fence.contractHashes) ||
    fence.contractHashes.some((hash) => typeof hash !== "string" || !SHA256_PATTERN.test(hash)) ||
    typeof fence.admittedAt !== "string" || !Number.isFinite(Date.parse(fence.admittedAt))
  ) throw new Error("Invalid repair graph fence");
  return structuredClone(fence as RepairGraphFence);
}

function normalizeEvolutionOutboxes(database: Database): void {
  for (const run of database.runs) {
    if (!run.orchestration) continue;
    run.orchestration.evolutionOutbox = [
      ...normalizeEvolutionOutbox(run.orchestration.evolutionOutbox ?? []),
    ];
  }
}

export function mergeEvolutionOutboxes(
  incoming: readonly EvolutionOutboxEntry[],
  durable: readonly EvolutionOutboxEntry[],
): EvolutionOutboxEntry[] {
  const normalizedIncoming = normalizeEvolutionOutbox(incoming);
  const normalizedDurable = normalizeEvolutionOutbox(durable);
  const durableById = new Map(normalizedDurable.map((entry) => [entry.id, entry]));
  const incomingIds = new Set(normalizedIncoming.map((entry) => entry.id));
  const merged = normalizedIncoming.map((entry) => {
    const stored = durableById.get(entry.id);
    if (stored === undefined) return entry;
    if (canonicalSerialize({
      projectId: entry.projectId,
      runId: entry.runId,
      records: entry.records,
      createdAt: entry.createdAt,
    }) !== canonicalSerialize({
      projectId: stored.projectId,
      runId: stored.runId,
      records: stored.records,
      createdAt: stored.createdAt,
    })) throw new Error("Evolution outbox deterministic content mismatch");
    if (stored.state === "delivered") return stored;
    if (entry.state === "delivered") return entry;
    return stored.lastErrorCode !== null ? stored : entry;
  });
  merged.push(...normalizedDurable.filter((entry) => !incomingIds.has(entry.id)));
  return structuredClone(merged);
}

function normalizeWorkerResult(result: WorkerResult): WorkerResult {
  if (result.contribution === undefined) return result;
  return {
    ...result,
    contribution: normalizeContribution(result.contribution),
  };
}

function normalizeProjectRun(project: ProjectRunRecord): ProjectRunRecord {
  return {
    ...project,
    attempts: (project.attempts ?? []).map(normalizeAttempt),
    integrations: (project.integrations ?? []).map(normalizeIntegration),
  };
}

function normalizeAttempt(attempt: AttemptWorkspaceRecord): AttemptWorkspaceRecord {
  return {
    ...attempt,
    revision: Number.isSafeInteger(attempt.revision) && attempt.revision > 0
      ? attempt.revision
      : 1,
    ownerToken: typeof attempt.ownerToken === "string" && attempt.ownerToken.length > 0
      ? attempt.ownerToken
      : "legacy-unowned-" + attempt.attemptId,
    kind: attempt.kind === "repair" ? "repair" : "task",
    checkpointId: attempt.checkpointId ?? null,
  };
}

function normalizeContribution(contribution: ContributionRecord): ContributionRecord {
  return {
    ...contribution,
    verificationIds: Array.isArray(contribution.verificationIds)
      ? contribution.verificationIds
      : [],
  };
}

function normalizeIntegration(integration: IntegrationRecord): IntegrationRecord {
  return {
    ...integration,
    verificationIds: Array.isArray(integration.verificationIds)
      ? integration.verificationIds
      : [],
  };
}

function normalizeProject(project: ProjectRecord): ProjectRecord {
  assertNonEmptyString(project.id, "project.id");
  assertNonEmptyString(project.displayName, "project.displayName");
  assertSourceKind(project.sourceKind, "project.sourceKind");
  assertNonEmptyString(project.repositoryPath, "project.repositoryPath");
  assertNonEmptyString(project.repositoryRealPath, "project.repositoryRealPath");
  assertNonEmptyString(project.gitCommonRealPath, "project.gitCommonRealPath");
  assertSafeInteger(project.gitCommonDev, "project.gitCommonDev");
  assertSafeInteger(project.gitCommonIno, "project.gitCommonIno");
  assertNonEmptyString(project.baselineBranch, "project.baselineBranch");
  assertCommit(project.baselineCommit, "project.baselineCommit");
  assertProjectState(project.state, "project.state");
  if (project.lastError !== null && typeof project.lastError !== "string") {
    throw new Error("Malformed persisted project.lastError");
  }
  assertTimestamp(project.createdAt, "project.createdAt");
  assertTimestamp(project.updatedAt, "project.updatedAt");

  const baselineTransition = project.baselineTransition === undefined
    ? undefined
    : normalizeBaselineTransition(project.baselineTransition);

  return {
    ...project,
    lastError: project.lastError ?? null,
    ...(baselineTransition === undefined ? {} : { baselineTransition }),
  };
}

function normalizeBaselineTransition(
  transition: ProjectBaselineTransition,
): ProjectBaselineTransition {
  assertNonEmptyString(transition.runId, "project.baselineTransition.runId");
  assertCommit(transition.expectedCommit, "project.baselineTransition.expectedCommit");
  assertCommit(transition.nextCommit, "project.baselineTransition.nextCommit");
  if (transition.state !== "prepared" && transition.state !== "ref_updated") {
    throw new Error("Malformed persisted project.baselineTransition.state");
  }
  return transition;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Malformed persisted " + field);
  }
}

function assertCommit(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !COMMIT_PATTERN.test(value)) {
    throw new Error("Malformed persisted " + field);
  }
}

function assertSafeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value)) {
    throw new Error("Malformed persisted " + field);
  }
}

function assertSourceKind(
  value: unknown,
  field: string,
): asserts value is ProjectRecord["sourceKind"] {
  if (value !== "managed" && value !== "external") {
    throw new Error("Malformed persisted " + field);
  }
}

function assertProjectState(
  value: unknown,
  field: string,
): asserts value is ProjectRecord["state"] {
  if (value !== "ready" && value !== "unavailable") {
    throw new Error("Malformed persisted " + field);
  }
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("Malformed persisted " + field);
  }
}
