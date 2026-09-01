import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentService } from "../src/agent-service.js";
import { loadConfig } from "../src/config.js";
import { CoordinationServer } from "../src/coordination/server.js";
import { EventLog } from "../src/event-log.js";
import { GitClient } from "../src/git-client.js";
import type { ModelCredentialIssuer } from "../src/model-proxy.js";
import type { Diagnoser } from "../src/orchestration/healing/diagnoser.js";
import { EvidenceStore } from "../src/orchestration/verification/evidence-store.js";
import { EvolutionQueryService } from "../src/orchestration/evolution/evolution-query.js";
import { EvolutionReconciler } from "../src/orchestration/evolution/evolution-reconciler.js";
import { EvolutionStore } from "../src/orchestration/evolution/evolution-store.js";
import { canonicalSerialize, exactRepeatKey } from "../src/orchestration/evolution/evolution-fingerprints.js";
import {
  deterministicEvolutionId,
  type EvolutionCounts,
  type EvolutionPayload,
  type EvolutionProjection,
  type LineageNode,
  type LineageObservation,
  type QuarantineRecord,
} from "../src/orchestration/evolution/evolution-types.js";
import { ExactRepeatIndex } from "../src/orchestration/evolution/exact-repeat-index.js";
import { FailureCueService } from "../src/orchestration/evolution/failure-cues.js";
import { detectFault } from "../src/orchestration/healing/fault-detector.js";
import { HistoricalEvidenceAuditor } from "../src/orchestration/evolution/historical-evidence-auditor.js";
import { LineageRecorder } from "../src/orchestration/evolution/lineage-recorder.js";
import type { OrchestratorParts } from "../src/orchestration/orchestrator.js";
import {
  defaultExecutionPolicy,
  repairRuntimeCapabilityEnvironmentFromConfig,
} from "../src/orchestration/policies.js";
import { RepositoryTrajectoryObserver } from "../src/orchestration/workers/repository-trajectory.js";
import { VerificationProfileRegistry } from "../src/orchestration/verification/verification-profile.js";
import { VerificationRunner } from "../src/orchestration/verification/verifier.js";
import { ProjectRegistry } from "../src/project-registry.js";
import { ProjectRepositoryManager } from "../src/project-repository-manager.js";
import { ProjectRunManager } from "../src/project-run-manager.js";
import { JsonStore } from "../src/store.js";
import type {
  AgentRun,
  AgentRunner,
  AuthorityGate,
  AuthorityMutant,
  GateResult,
  FaultRecord,
  LeaderPlan,
  ProjectRecord,
  RunnerRequest,
  RunnerResult,
  VerificationResult,
  WorkerResult,
} from "../src/types.js";
import { WorkspaceManager } from "../src/workspace.js";

export const EXPECTED_SELF_HEALING_TRACE = [
  "preflight",
  "execute",
  "detect",
  "diagnose",
  "checkpoint",
  "control/context/strategy",
  "verify",
  "select context",
  "integrate",
  "post-verify",
  "resume",
  "succeeded",
] as const;

export type SelfHealingScenario =
  | "success"
  | "normal_success"
  | "evaluator_unavailable"
  | "all_candidates_fail"
  | "consumer_regression"
  | "expensive_tie"
  | "malformed_diagnosis"
  | "checkpoint_failure"
  | "authority_compromise"
  | "promotion_conflict"
  | "post_gate_rollback";

export interface SelfHealingDemoResult {
  trace: string[];
  scenario: SelfHealingScenario;
  status: AgentRun["status"];
  outcome: string;
  failureReason: string;
  runId: string;
  projectId: string;
  runBranch: string;
  baseCommit: string;
  finalCommit: string;
  finalTree: string;
  sourceBefore: SourceSnapshot;
  sourceAfter: SourceSnapshot;
  preflightBeforeModel: boolean;
  siblingOverlap: boolean;
  repeatedFailureCount: number;
  diagnosisCalls: number;
  tournamentCount: number;
  winnerFamily: string | null;
  candidateCounts: {
    declared: number;
    admitted: number;
    executed: number;
    verified: number;
    promoted: number;
  };
  candidateCheckpointHashes: string[];
  frontendStarts: number;
  backendStarts: number;
  integrationStarts: number;
  repairStarts: number;
  nodeStates: Record<string, string>;
  mandatoryGateTiers: GateResult["tier"][];
  mandatoryGatesPassed: boolean;
  baselineAdvancedToFinal: boolean;
  unsafePromotion: boolean;
  integrationQueued: boolean;
  postIntegrationBeforeCompletion: boolean;
  consumerStartedAfterPromotion: boolean;
  canonicalWorkspaceClean: boolean;
  liveDispatchDrained: boolean;
  lastValidGitFingerprintPreserved: boolean;
  providerFailureNonRepairable: boolean;
  authorityAssetsComplete: boolean;
  synthesizerCalls: number;
  calls: number;
  reservedTokens: number;
  actualTokens: number;
  elapsedMs: number;
  cleanupDecision: "removed" | "preserved";
  userBranchIntegrity: boolean;
}

interface SourceSnapshot {
  branch: string;
  head: string;
  status: string;
}

interface Counters {
  frontend: number;
  backend: number;
  integration: number;
  repair: number;
  repeatedFailures: number;
  diagnosis: number;
  synthesizer: number;
}

interface FixtureState {
  root: string;
  authorityRoot: string;
  source: string;
  git: GitClient;
  store: JsonStore;
  service: AgentService;
  registry: VerificationProfileRegistry;
  coordination: CoordinationServer;
  counters: Counters;
  starts: Partial<Record<"backend" | "frontend" | "integration", number>>;
  preflightBeforeModel: boolean;
  modelAdmissions: number;
  evolutionStore: EvolutionStore;
  evidenceStore: EvidenceStore;
  evolutionReconciler: EvolutionReconciler;
  exactRepeatIndex: ExactRepeatIndex;
  evolutionQuery: EvolutionQueryService;
  setDiagnosisVariant(value: "baseline" | "changed"): void;
  setAllCandidatesFail(value: boolean): void;
}

const AUTHORITY_SOURCE = fileURLToPath(
  new URL("../authority/self-healing-demo", import.meta.url),
);

export async function runDeterministicSelfHealingDemo(): Promise<SelfHealingDemoResult> {
  return runDeterministicSelfHealingScenario("success");
}

export interface ProductionEvolutionDemoResult {
  fixture: "accepted-m2-production-path";
  projectId: string;
  runIds: [string, string, string];
  firstRun: {
    diagnosisCalls: number;
    candidateExecutions: number;
    candidateVerifications: number;
    integrations: number;
  };
  repeatRun: { pruned: number; candidateExecutions: number };
  changedRun: { diagnosisVariant: "changed"; candidateExecutions: number; pruned: number };
  analogousCue: { pruned: number; cues: number; capsules: number };
  branchReturn: {
    capsules: number;
    pruned: number;
    returned: number;
    runId: string;
    tournamentId: string;
    returnedCandidateId: string;
    successfulSiblingCandidateId: string;
    successfulSiblingIntegrated: boolean;
  };
  exclusions: {
    cancellation: ExclusionProjectionResult;
    malformedEvidence: ExclusionProjectionResult;
  };
  projectIsolation: { projectId: string; pruned: number; cues: number };
  reconciliation: { pending: boolean; droppedHistoryCount: number };
  restart: { reconciled: true; indexesReady: true };
  projection: {
    syncState: "synced" | "quarantined" | "pending" | "unavailable";
    counts: EvolutionCounts;
    nodes: number;
    observations: number;
  };
  runBranch: string;
  baseCommit: string;
  headCommit: string;
  sourceIntegrity: boolean;
}

interface ExclusionProjectionResult {
  quarantined: boolean;
  quarantineReason: QuarantineRecord["reason"] | null;
  pruned: number;
  cues: number;
  capsules: number;
}

interface ExclusionHistorySeed {
  project: ProjectRecord;
  rootRun: AgentRun;
  childRun: AgentRun;
  fault: FaultRecord;
  candidate: NonNullable<AgentRun["orchestration"]>["healing"]["candidates"][number];
  candidateRecords: LineageNode[];
  targetRecordId: string;
  records: EvolutionPayload[];
}

export interface ProductionEvolutionLifecycleResult {
  cycles: number;
  timers: number;
  watchers: number;
  pendingOutbox: number;
  openServers: number;
  serverHandles: number;
  childProcesses: number;
  reconciledWorkloads: number;
  doubleCloseSafe: boolean;
}

export async function runProductionEvolutionLifecycleRegression(
  cycles = 3,
): Promise<ProductionEvolutionLifecycleResult> {
  const result: ProductionEvolutionLifecycleResult = {
    cycles, timers: 0, watchers: 0, pendingOutbox: 0,
    openServers: 0, serverHandles: 0, childProcesses: 0,
    reconciledWorkloads: 0, doubleCloseSafe: true,
  };
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const before = activeHandleCounts();
    const fixture = await createFixture("success");
    const serverUrl = fixture.coordination.baseUrl("127.0.0.1");
    try {
      const project = await fixture.service.openProject({
        displayName: "m3-lifecycle-" + cycle,
        repositoryPath: fixture.source,
        revision: "HEAD",
      });
      const leader = await fixture.service.createProjectChat(project.id, { name: "lifecycle-" + cycle });
      const sent = await fixture.service.sendMessage(leader.id, "exercise lifecycle workload");
      await waitForTerminal(fixture.service, sent.run.id);
      const replayed = await fixture.store.mutate((database) => {
        const run = database.runs.find((value) => value.id === sent.run.id);
        if (!run?.orchestration || run.orchestration.evolutionOutbox.length === 0) return 0;
        for (const entry of run.orchestration.evolutionOutbox) {
          (entry as { state: "pending" | "delivered" }).state = "pending";
          (entry as { deliveredAt: string | null }).deliveredAt = null;
          (entry as { lastErrorCode: string | null }).lastErrorCode = null;
        }
        if (database.evolutionReconciliation) delete database.evolutionReconciliation[project.id];
        return run.orchestration.evolutionOutbox.length;
      });
      if (replayed === 0) throw new Error("production lifecycle run did not produce an outbox workload");
      await rm(path.join(fixture.root, "data", "evolution", "projects", project.id), {
        recursive: true,
        force: true,
      });
      const reconciliation = await fixture.evolutionReconciler.reconcile();
      if (reconciliation.deliveredOutboxIds.length === 0) {
        throw new Error("production lifecycle fixture did not exercise outbox reconciliation work");
      }
      result.reconciledWorkloads += 1;
      await reconcileFixtureUntilComplete(fixture, project.id);
      result.pendingOutbox += fixture.store.snapshot().runs.reduce((sum, run) => sum +
        (run.orchestration?.evolutionOutbox.filter((entry) => entry.state === "pending").length ?? 0), 0);
      await fixture.evolutionStore.close();
      await fixture.evolutionStore.close();
      await fixture.coordination.close();
      await fixture.coordination.close();
      result.openServers += await fetch(serverUrl).then(() => 1, () => 0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const after = activeHandleCounts();
      result.timers += Math.max(0, after.timers - before.timers);
      result.watchers += Math.max(0, after.watchers - before.watchers);
      result.serverHandles += Math.max(0, after.servers - before.servers);
      result.childProcesses += Math.max(0, after.childProcesses - before.childProcesses);
    } catch (error) {
      result.doubleCloseSafe = false;
      throw error;
    } finally {
      await fixture.evolutionStore.close().catch(() => undefined);
      await fixture.coordination.close().catch(() => undefined);
      await rm(fixture.root, { recursive: true, force: true });
      await rm(fixture.authorityRoot, { recursive: true, force: true });
    }
  }
  return result;
}

function activeHandleCounts(): { timers: number; watchers: number; servers: number; childProcesses: number } {
  const handles = (process as unknown as { _getActiveHandles?(): unknown[] })._getActiveHandles?.() ?? [];
  const names = handles.map((handle) =>
    (handle as { constructor?: { name?: string } })?.constructor?.name ?? "");
  return {
    timers: names.filter((name) => name === "Timeout").length,
    watchers: names.filter((name) => name === "FSWatcher" || name === "StatWatcher").length,
    servers: names.filter((name) => name === "Server").length,
    childProcesses: names.filter((name) => name === "ChildProcess").length,
  };
}

export async function runProductionEvolutionDemo(): Promise<ProductionEvolutionDemoResult> {
  const fixture = await createFixture("all_candidates_fail");
  let restartedStore: EvolutionStore | null = null;
  try {
    const sourceBefore = await sourceSnapshot(fixture.git, fixture.source);
    const project = await fixture.service.openProject({
      displayName: "m3-production-evolution",
      repositoryPath: fixture.source,
      revision: "HEAD",
    });
    const runOnce = async (name: string, projectId = project.id) => {
      const before = { ...fixture.counters };
      const leader = await fixture.service.createProjectChat(projectId, { name });
      const sent = await fixture.service.sendMessage(leader.id, "run " + name);
      const run = await waitForTerminal(fixture.service, sent.run.id);
      return {
        run,
        diagnosisCalls: fixture.counters.diagnosis - before.diagnosis,
        candidateExecutions: fixture.counters.repair - before.repair,
      };
    };

    const first = await runOnce("m3-first");
    await reconcileFixtureUntilComplete(fixture, project.id);
    const exclusionSeed = await captureExclusionHistorySeed(fixture, project.id, first.run.id);
    const repeat = await runOnce("m3-repeat");
    await reconcileFixtureUntilComplete(fixture, project.id);
    fixture.setDiagnosisVariant("changed");
    fixture.setAllCandidatesFail(false);
    const changed = await runOnce("m3-changed");
    await reconcileFixtureUntilComplete(fixture, project.id);

    const isolatedSource = path.join(fixture.root, "isolated-source");
    await fixture.git.run(fixture.root, ["init", "-b", "fixture-main", isolatedSource]);
    await writeFile(path.join(isolatedSource, "shared.txt"), "producer interface intentionally withheld\n", "utf8");
    await fixture.git.run(isolatedSource, ["add", "--", "shared.txt"]);
    await fixture.git.run(isolatedSource, ["commit", "-m", "isolated fixture seed"]);
    const isolatedProject = await fixture.service.openProject({
      displayName: "m3-project-isolation",
      repositoryPath: isolatedSource,
      revision: "HEAD",
    });
    const isolated = await runOnce("m3-isolated-project", isolatedProject.id);
    await reconcileFixtureUntilComplete(fixture, isolatedProject.id);

    await fixture.evolutionStore.close();
    restartedStore = new EvolutionStore({ dataDirectory: path.join(fixture.root, "data") });
    const restartedCues = new FailureCueService();
    const restartedIndex = new ExactRepeatIndex();
    const restartedRecorder = new LineageRecorder({
      store: fixture.store,
      evolutionStore: restartedStore,
      failureCueService: restartedCues,
    });
    const restartedAuditor = new HistoricalEvidenceAuditor({
      evidenceStore: fixture.evidenceStore,
      candidateRun: (record) => {
        const snapshot = fixture.store.snapshot();
        const rootRun = snapshot.runs.find((run) => run.id === record.runId);
        const attemptId = rootRun?.orchestration?.healing.candidates.find((candidate) =>
          candidate.id === record.entityId)?.attemptId;
        return attemptId ? snapshot.runs.find((run) => run.id === attemptId) ?? null : null;
      },
    });
    const restarted = new EvolutionReconciler({
      store: fixture.store,
      evolutionStore: restartedStore,
      lineageRecorder: restartedRecorder,
      auditor: restartedAuditor,
      exactRepeatIndex: restartedIndex,
      failureCueService: restartedCues,
      evidenceStore: fixture.evidenceStore,
    });
    await restarted.initialize();
    await restarted.reconcile();
    const restartedCheckpoint = fixture.store.snapshot().evolutionReconciliation?.[project.id];
    const restartedHead = await restartedStore.head(project.id);
    const reconciliationPending = !(restartedCheckpoint?.complete === true &&
      restartedCheckpoint.targetHeadHash === restartedHead.segmentHash &&
      restartedCheckpoint.targetSequence === restartedHead.sequence);
    const query = new EvolutionQueryService({
      store: restartedStore,
      runById: (runId) => fixture.service.getRun(runId),
      cursorSecret: "deterministic-m3-restart-query",
    });
    const projectionPages: EvolutionProjection[] = [];
    let after: string | null = null;
    do {
      const page = await query.get({
        runId: changed.run.id,
        after,
        limit: 200,
        depth: 4,
      });
      projectionPages.push(page);
      after = page.nextCursor;
    } while (after !== null);
    const projection = projectionPages[0]!;
    const sourceAfter = await sourceSnapshot(fixture.git, fixture.source);
    const firstHealing = first.run.orchestration!.healing;
    const repeatHealing = repeat.run.orchestration!.healing;
    const changedHealing = changed.run.orchestration!.healing;
    const isolatedHealing = isolated.run.orchestration!.healing;
    const allNodes = projectionPages.flatMap((page) => page.nodes);
    const allObservations = projectionPages.flatMap((page) => page.observations);
    const allBranchReturns = projectionPages.flatMap((page) => page.branchReturns);
    const allCapsules = projectionPages.flatMap((page) => page.capsules);
    const branchReturn = allBranchReturns[0];
    const branchCapsule = allCapsules.find((capsule) => capsule.id === branchReturn?.capsuleId);
    const returnedCandidate = changedHealing.candidates.find((candidate) =>
      candidate.id === branchCapsule?.candidateId
    );
    const successfulSibling = changedHealing.candidates.find((candidate) =>
      candidate.tournamentId === branchCapsule?.tournamentId &&
      candidate.id !== returnedCandidate?.id && candidate.state === "promoted"
    );
    const successfulSiblingIntegrated = successfulSibling !== undefined &&
      changed.run.project?.integrations.some((integration) =>
        integration.subtaskId === successfulSibling.delta.targetSubtaskId &&
        integration.state === "integrated" &&
        integration.repairGraphFenceHash === successfulSibling.repairGraphFenceHash
      ) === true;
    const cancellationExclusion = await runExclusionHistoryVariant(
      fixture,
      exclusionSeed,
      "cancellation",
    );
    const malformedEvidenceExclusion = await runExclusionHistoryVariant(
      fixture,
      exclusionSeed,
      "malformed_evidence",
    );
    const firstProjection = await query.get({
      runId: first.run.id,
      after: null,
      limit: 200,
      depth: 4,
    });
    const cueSourceCandidate = firstHealing.candidates.find((candidate) =>
      candidate.delta.family === "strategy_patch" && candidate.state === "rejected" &&
      candidate.evolutionFingerprints !== null);
    const cueSourceNode = firstProjection.nodes.find((node) =>
      node.kind === "candidate" && node.entityId === cueSourceCandidate?.id);
    const cueSourceVerification = firstHealing.verifications.find((verification) =>
      verification.subjectType === "candidate" && verification.subjectId === cueSourceCandidate?.id &&
      verification.mandatoryPassed === false);
    if (cueSourceCandidate?.evolutionFingerprints === null || cueSourceCandidate === undefined ||
      cueSourceNode === undefined || cueSourceVerification === undefined) {
      throw new Error("M3 fixture lacks a trusted strategy failure for analogous cue selection");
    }
    const trustedSourceMatch = restartedIndex.find({
      projectId: project.id,
      sourceFingerprint: first.run.project!.source.sourceFingerprint,
      fingerprints: cueSourceCandidate.evolutionFingerprints,
      candidateFamily: "strategy_patch",
    });
    if (trustedSourceMatch?.candidateNodeId !== cueSourceNode.id) {
      throw new Error("M3 fixture strategy cue source was not trusted by the exact index");
    }
    const sourceCue = restartedCues.create({
      projectId: project.id,
      sourceFingerprint: first.run.project!.source.sourceFingerprint,
      contractKey: "backend-producer",
      candidate: cueSourceCandidate,
      candidateNodeId: cueSourceNode.id,
      verification: cueSourceVerification,
      exactRepeatKey: exactRepeatKey(cueSourceCandidate.evolutionFingerprints)!,
    });
    if (sourceCue === null) throw new Error("M3 fixture could not create its trusted strategy cue");
    if (!(await restartedStore.recordIds(project.id)).has(sourceCue.id)) {
      const cueHead = await restartedStore.head(project.id);
      await restartedStore.appendBatch({
        projectId: project.id,
        expectedHeadHash: cueHead.segmentHash,
        records: [{ type: "cue", value: sourceCue }],
      });
    }
    const mutationContentHash = cueSourceCandidate.evolutionFingerprints.mutationContentHash === "e".repeat(64)
      ? "d".repeat(64)
      : "e".repeat(64);
    const analogousFingerprints = {
      ...cueSourceCandidate.evolutionFingerprints,
      mutationContentHash,
    };
    let analogousCues = [] as ReturnType<FailureCueService["select"]>;
    for (let attempt = 0; attempt < 10 && analogousCues.length === 0; attempt += 1) {
      await restarted.reconcile();
      analogousCues = restartedCues.select({
        projectId: project.id,
        sourceFingerprint: sourceCue.sourceFingerprint,
        contractKey: sourceCue.contractKey,
        contractHash: sourceCue.contractHash,
        candidateFamily: "strategy_patch",
        gateTier: sourceCue.gateTier,
        failureFingerprint: sourceCue.failureFingerprint,
        excludeExactRepeatKey: exactRepeatKey(analogousFingerprints)!,
        limit: 3,
        fingerprints: analogousFingerprints,
      });
    }
    const analogousMatch = restartedIndex.find({
      projectId: project.id,
      sourceFingerprint: sourceCue.sourceFingerprint,
      fingerprints: analogousFingerprints,
      candidateFamily: "strategy_patch",
    });
    const analogousNodeIds = new Set(allNodes.filter((node) =>
      node.fingerprints?.mutationContentHash === mutationContentHash).map((node) => node.entityId));
    const analogousCapsules = allCapsules.filter((capsule) => analogousNodeIds.has(capsule.candidateId)).length;
    return {
      fixture: "accepted-m2-production-path",
      projectId: project.id,
      runIds: [first.run.id, repeat.run.id, changed.run.id],
      firstRun: {
        diagnosisCalls: first.diagnosisCalls,
        candidateExecutions: first.candidateExecutions,
        candidateVerifications: firstHealing.verifications.filter((value) =>
          value.subjectType === "candidate").length,
        integrations: first.run.project?.integrations.length ?? 0,
      },
      repeatRun: {
        pruned: repeatHealing.candidates.filter((value) => value.historicalMatchRecordId !== null).length,
        candidateExecutions: repeat.candidateExecutions,
      },
      changedRun: {
        diagnosisVariant: "changed",
        candidateExecutions: changed.candidateExecutions,
        pruned: changedHealing.candidates.filter((value) => value.historicalMatchRecordId !== null).length,
      },
      analogousCue: {
        pruned: Number(analogousMatch !== null),
        cues: analogousCues.length,
        capsules: analogousCapsules,
      },
      branchReturn: {
        capsules: projectionPages.reduce((sum, page) => sum + page.capsules.length, 0),
        pruned: projection.counts.branchPruned,
        returned: projection.counts.branchReturned,
        runId: branchReturn?.runId ?? "",
        tournamentId: branchCapsule?.tournamentId ?? "",
        returnedCandidateId: returnedCandidate?.id ?? "",
        successfulSiblingCandidateId: successfulSibling?.id ?? "",
        successfulSiblingIntegrated,
      },
      exclusions: {
        cancellation: cancellationExclusion,
        malformedEvidence: malformedEvidenceExclusion,
      },
      projectIsolation: {
        projectId: isolatedProject.id,
        pruned: isolatedHealing.candidates.filter((value) => value.historicalMatchRecordId !== null).length,
        cues: isolatedHealing.candidates.reduce((sum, value) => sum + value.delta.failureCueIds.length, 0),
      },
      reconciliation: {
        pending: reconciliationPending,
        droppedHistoryCount: projection.historyHealth.droppedHistoryCount,
      },
      restart: { reconciled: true, indexesReady: true },
      projection: {
        syncState: projection.syncState,
        counts: projection.counts,
        nodes: projectionPages.reduce((sum, page) => sum + page.nodes.length, 0),
        observations: projectionPages.reduce((sum, page) => sum + page.observations.length, 0),
      },
      runBranch: first.run.project?.runBranch ?? "unavailable",
      baseCommit: first.run.project?.source.baseCommit ?? sourceBefore.head,
      headCommit: changed.run.project?.headCommit ?? sourceBefore.head,
      sourceIntegrity: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter),
    };
  } finally {
    await restartedStore?.close().catch(() => undefined);
    await restartedStore?.close().catch(() => undefined);
    await fixture.coordination.close().catch(() => undefined);
    await fixture.coordination.close().catch(() => undefined);
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.authorityRoot, { recursive: true, force: true });
  }
}

async function captureExclusionHistorySeed(
  fixture: FixtureState,
  projectId: string,
  runId: string,
): Promise<ExclusionHistorySeed> {
  const snapshot = fixture.store.snapshot();
  const project = snapshot.projects.find((value) => value.id === projectId);
  const rootRun = snapshot.runs.find((value) => value.id === runId);
  const checkpoint = snapshot.evolutionReconciliation?.[projectId];
  if (project === undefined || rootRun?.orchestration === null || rootRun?.orchestration === undefined ||
    checkpoint?.complete !== true) {
    throw new Error("M3 fixture lacks a completed authoritative first-run history");
  }
  const persisted = [...(await fixture.evolutionStore.recordPayloads(projectId)).values()];
  const persistedById = new Map(persisted.map((record) => [record.value.id, canonicalSerialize(record)]));
  const checkpointById = new Map(checkpoint.records.map((record) =>
    [record.value.id, canonicalSerialize(record)] as const));
  const outboxById = new Map(rootRun.orchestration.evolutionOutbox.flatMap((entry) =>
    entry.records.map((record) => [record.value.id, canonicalSerialize(record)] as const)));
  const candidates = rootRun.orchestration.healing.candidates.filter((candidate) =>
    candidate.state === "rejected" && candidate.attemptId !== null &&
    candidate.evolutionFingerprints?.complete === true);
  for (const candidate of candidates) {
    const candidateRecords = persisted.filter(
      (record): record is Extract<EvolutionPayload, { type: "node" }> =>
        record.type === "node" && record.value.kind === "candidate" &&
        record.value.runId === runId && record.value.entityId === candidate.id,
    ).map((record) => record.value);
    const candidateNodeIds = new Set(candidateRecords.map((record) => record.id));
    const observations = persisted.filter(
      (record): record is Extract<EvolutionPayload, { type: "observation" }> =>
        record.type === "observation" && candidateNodeIds.has(record.value.nodeId),
    ).map((record) => record.value);
    const targetRecord = candidateRecords.find((record) =>
      observations.some((observation) => observation.nodeId === record.id && observation.kind === "rejected" &&
        observation.terminalReason !== null && [
          "deterministic_gate_failure",
          "mandatory_gate_failed",
          "targeted_gate_failed",
          "no_evidence_progress",
        ].includes(observation.terminalReason)) &&
      record.verificationIds.some((verificationId) => rootRun.orchestration!.healing.verifications.some(
        (verification) => verification.id === verificationId &&
          verification.subjectType === "candidate" && verification.subjectId === candidate.id,
      )));
    const childRun = snapshot.runs.find((run) => run.id === candidate.attemptId &&
      run.parentRunId === runId && run.projectId === projectId);
    const fault = rootRun.orchestration.healing.faults.find((value) => value.id === targetRecord?.faultId);
    if (targetRecord === undefined || childRun === undefined || fault === undefined ||
      !observations.some((observation) => observation.kind === "executed") ||
      !observations.some((observation) => observation.kind === "rejected")) continue;

    const selectedNodeIds = new Set(candidateNodeIds);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const record of persisted) {
        if (record.type !== "edge" || !selectedNodeIds.has(record.value.toNodeId) ||
          selectedNodeIds.has(record.value.fromNodeId)) continue;
        selectedNodeIds.add(record.value.fromNodeId);
        expanded = true;
      }
    }
    const records = persisted.filter((record) => {
      if (record.type === "node") return selectedNodeIds.has(record.value.id);
      if (record.type === "edge") {
        return selectedNodeIds.has(record.value.fromNodeId) && selectedNodeIds.has(record.value.toNodeId);
      }
      return record.type === "observation" && candidateNodeIds.has(record.value.nodeId) &&
        ["declared", "admitted", "executed", "verifying", "rejected"].includes(record.value.kind);
    });
    for (const record of records) {
      const serialized = canonicalSerialize(record);
      if (persistedById.get(record.value.id) !== serialized ||
        checkpointById.get(record.value.id) !== serialized || outboxById.get(record.value.id) !== serialized) {
        throw new Error("M3 exclusion seed is not jointly persisted in store, checkpoint, and outbox");
      }
    }
    return {
      project: structuredClone(project),
      rootRun: structuredClone(rootRun),
      childRun: structuredClone(childRun),
      fault: structuredClone(fault),
      candidate: structuredClone(candidate),
      candidateRecords: structuredClone(candidateRecords),
      targetRecordId: targetRecord.id,
      records: structuredClone(records),
    };
  }
  throw new Error("M3 fixture lacks an owned executed/rejected exclusion history seed");
}

async function runExclusionHistoryVariant(
  fixture: FixtureState,
  seed: ExclusionHistorySeed,
  variant: "cancellation" | "malformed_evidence",
): Promise<ExclusionProjectionResult> {
  const root = await mkdtemp(path.join(tmpdir(), `launchpad-m3-${variant}-`));
  const store = new JsonStore(path.join(root, "db.json"));
  const evolutionStore = new EvolutionStore({ dataDirectory: root });
  try {
    await store.initialize();
    await evolutionStore.initialize();
    await store.mutate((database) => {
      database.projects.push(structuredClone(seed.project));
      database.runs.push(structuredClone(seed.rootRun), structuredClone(seed.childRun));
      delete database.evolutionReconciliation;
    });
    const targetRecord = seed.candidateRecords.find((record) => record.id === seed.targetRecordId);
    if (targetRecord === undefined) throw new Error("M3 exclusion variant lacks its terminal candidate record");
    const records = seed.records.map((payload): EvolutionPayload => {
      if (variant !== "malformed_evidence" || payload.type !== "node" ||
        payload.value.id !== targetRecord.id) return structuredClone(payload);
      return {
        type: "node",
        value: { ...structuredClone(payload.value), evidenceRefs: [...payload.value.evidenceRefs, "malformed"] },
      };
    });
    if (variant === "cancellation") {
      const rejected = records.find(
        (payload): payload is Extract<EvolutionPayload, { type: "observation" }> =>
          payload.type === "observation" && payload.value.nodeId === targetRecord.id &&
          payload.value.kind === "rejected",
      );
      if (rejected === undefined) throw new Error("M3 cancellation variant lacks rejected ownership proof");
      const cancelled: LineageObservation = {
        ...structuredClone(rejected.value),
        id: deterministicEvolutionId("m3-exclusion-cancelled", {
          projectId: rejected.value.projectId,
          runId: rejected.value.runId,
          nodeId: rejected.value.nodeId,
        }),
        kind: "cancelled",
        candidateState: "cancelled",
        terminalReason: "user_cancelled",
      };
      records.push({ type: "observation", value: cancelled });
    }
    await evolutionStore.appendBatch({
      projectId: seed.project.id,
      expectedHeadHash: null,
      records,
    });
    const cues = new FailureCueService();
    const index = new ExactRepeatIndex();
    const recorder = new LineageRecorder({ store, evolutionStore, failureCueService: cues });
    const auditor = new HistoricalEvidenceAuditor({
      evidenceStore: fixture.evidenceStore,
      candidateRun: (record) => {
        const snapshot = store.snapshot();
        const owner = snapshot.runs.find((run) => run.id === record.runId);
        const attemptId = owner?.orchestration?.healing.candidates.find((candidate) =>
          candidate.id === record.entityId)?.attemptId;
        return attemptId ? snapshot.runs.find((run) => run.id === attemptId) ?? null : null;
      },
    });
    const reconciler = new EvolutionReconciler({
      store,
      evolutionStore,
      lineageRecorder: recorder,
      auditor,
      exactRepeatIndex: index,
      failureCueService: cues,
      evidenceStore: fixture.evidenceStore,
    });
    await reconciler.initialize();
    await reconciler.reconcile();
    const collecting = store.snapshot().evolutionReconciliation?.[seed.project.id];
    if (collecting?.phase !== "auditing" || collecting.complete) {
      throw new Error("M3 exclusion variant did not complete the collecting phase exactly once");
    }
    await reconciler.reconcile();
    const complete = store.snapshot().evolutionReconciliation?.[seed.project.id];
    if (complete?.phase !== "complete" || !complete.complete) {
      throw new Error("M3 exclusion variant did not complete the auditing phase exactly once");
    }
    const query = new EvolutionQueryService({
      store: evolutionStore,
      runById: (runId) => {
        const run = store.snapshot().runs.find((value) => value.id === runId);
        if (run === undefined) throw new Error("M3 exclusion variant run is unavailable");
        return run;
      },
      cursorSecret: `deterministic-m3-${variant}-query`,
    });
    const pages: EvolutionProjection[] = [];
    let after: string | null = null;
    do {
      const page = await query.get({ runId: seed.rootRun.id, after, limit: 200, depth: 4 });
      pages.push(page);
      after = page.nextCursor;
    } while (after !== null);
    const quarantines = pages.flatMap((page) => page.quarantines);
    const targetQuarantine = quarantines.find((record) => record.targetRecordId === targetRecord.id);
    return {
      quarantined: targetQuarantine !== undefined,
      quarantineReason: targetQuarantine?.reason ?? null,
      pruned: pages[0]?.counts.prunedDuplicate ?? 0,
      cues: pages.reduce((sum, page) => sum + page.cues.length, 0),
      capsules: pages.reduce((sum, page) => sum + page.capsules.length, 0),
    };
  } finally {
    await evolutionStore.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function reconcileFixtureUntilComplete(fixture: FixtureState, projectId: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await fixture.evolutionReconciler.reconcile();
    const checkpoint = fixture.store.snapshot().evolutionReconciliation?.[projectId];
    const head = await fixture.evolutionStore.head(projectId);
    const pending = fixture.store.snapshot().runs.some((run) => run.projectId === projectId &&
      run.orchestration?.evolutionOutbox.some((entry) => entry.state === "pending"));
    if (checkpoint?.complete && checkpoint.targetHeadHash === head.segmentHash &&
      checkpoint.targetSequence === head.sequence && !pending) return;
  }
  throw new Error("deterministic evolution fixture did not complete reconciliation");
}

export async function runDeterministicSelfHealingScenario(
  scenario: SelfHealingScenario,
): Promise<SelfHealingDemoResult> {
  const startedAt = Date.now();
  const fixture = await createFixture(scenario);
  let preserve = false;
  try {
    const sourceBefore = await sourceSnapshot(fixture.git, fixture.source);
    const project = await fixture.service.openProject({
      displayName: "m2-" + scenario.replaceAll("_", "-"),
      repositoryPath: fixture.source,
      revision: "HEAD",
    });
    const leader = await fixture.service.createProjectChat(project.id, {
      name: "m2-" + scenario.replaceAll("_", "-") + "-leader",
    });
    const sent = await fixture.service.sendMessage(leader.id, "run deterministic self-healing demo");
    const run = await waitForTerminal(fixture.service, sent.run.id);
    const sourceAfter = await sourceSnapshot(fixture.git, fixture.source);
    const result = await summarize({
      fixture,
      scenario,
      run,
      projectId: project.id,
      sourceBefore,
      sourceAfter,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    preserve = true;
    throw error;
  } finally {
    await fixture.evolutionStore.close().catch(() => undefined);
    await fixture.evolutionStore.close().catch(() => undefined);
    await fixture.coordination.close().catch(() => undefined);
    await fixture.coordination.close().catch(() => undefined);
    if (!preserve) {
      await rm(fixture.root, { recursive: true, force: true });
      await rm(fixture.authorityRoot, { recursive: true, force: true });
    }
  }
}

export function formatSelfHealingDemo(result: SelfHealingDemoResult): string {
  return [
    result.trace.join(" -> "),
    "run_id=" + result.runId,
    "project_id=" + result.projectId,
    "run_branch=" + result.runBranch,
    "base_commit=" + result.baseCommit,
    "final_commit=" + result.finalCommit,
    "final_tree=" + result.finalTree,
    "calls=" + result.calls,
    "reserved_tokens=" + result.reservedTokens,
    "actual_tokens=" + result.actualTokens,
    "elapsed_ms=" + result.elapsedMs,
    "outcome=" + result.outcome,
    "baseline_advanced_to_final=" + String(result.baselineAdvancedToFinal),
    "mandatory_gates_passed=" + String(result.mandatoryGatesPassed),
    "cleanup=" + result.cleanupDecision,
    "user_branch_integrity=" + String(result.userBranchIntegrity),
  ].join("\n");
}

export function assertSelfHealingDemoAccepted(result: SelfHealingDemoResult): void {
  const failures = [
    ...(result.status === "completed" ? [] : ["status"]),
    ...(result.outcome === "succeeded" ? [] : ["outcome"]),
    ...(result.baselineAdvancedToFinal ? [] : ["baseline"]),
    ...(result.mandatoryGatesPassed ? [] : ["mandatory gates"]),
    ...(result.cleanupDecision === "removed" ? [] : ["cleanup"]),
    ...(result.userBranchIntegrity ? [] : ["user branch integrity"]),
    ...(result.unsafePromotion ? ["unsafe promotion"] : []),
  ];
  if (failures.length > 0) {
    throw new Error("self-healing demo acceptance failed: " + failures.join(", "));
  }
}

export async function runBoundedRealProviderSmoke(): Promise<{
  unsafePromotion: boolean;
  emergencyFuseViolation: boolean;
}> {
  if (
    process.env.LAUNCHPAD_REAL_HEALING_SMOKE !== "1" ||
    !process.env.ARK_API_KEY ||
    !process.env.ARK_MODEL ||
    !process.env.LAUNCHPAD_REAL_HEALING_SMOKE_CONFIG
  ) {
    throw new Error("bounded real-provider credential/config is not explicitly present");
  }
  // Never turn ordinary Ark credentials into an unbounded external call and
  // never manufacture a passing smoke result. The explicitly supplied smoke
  // configuration must name a separately reviewed provider harness.
  throw new Error("bounded real-provider harness is not installed for this checkout");
}

async function createFixture(scenario: SelfHealingScenario): Promise<FixtureState> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-m2-acceptance-"));
  const authorityRoot = await mkdtemp(path.join(tmpdir(), "launchpad-m2-authority-"));
  const source = path.join(root, "source");
  const git = new GitClient(10_000);
  await git.run(root, ["init", "-b", "fixture-main", source]);
  await writeFile(path.join(source, "shared.txt"), "producer interface intentionally withheld\n", "utf8");
  await git.run(source, ["add", "--", "shared.txt"]);
  await git.run(source, ["commit", "-m", "deterministic fixture seed"]);

  const profilePath = await materializeAuthority(authorityRoot);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "agents"),
    CODEX_HOME: path.join(root, "codex"),
    CODEX_RUNTIME_MODE: "exec",
    ARK_API_KEY: "fixture-key-not-for-provider-use",
    ARK_MODEL: "fixture-model",
    WORKSPACE_SOURCE_ROOTS: root,
    ORCHESTRATION_HEALING_ENABLED: "true",
    ORCHESTRATION_VERIFICATION_PROFILE: profilePath,
  });
  const registry = new VerificationProfileRegistry({
    profilePath,
    workspaceRoot: config.workspaceRoot,
    workspaceSourceRoots: config.workspaceSourceRoots,
    eventSessionRoot: path.join(config.dataDirectory, "events"),
  });
  await registry.load();
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "agents"));
  const events = new EventLog(path.join(root, "data", "events"), {
    secrets: [config.arkApiKey, "fixture-secret-xyz"],
  });
  const projectRegistry = new ProjectRegistry(
    store,
    new ProjectRepositoryManager(config.workspaceRoot, config.workspaceSourceRoots, git),
    git,
  );
  const evidence = new EvidenceStore({
    dataDirectory: config.dataDirectory,
    secrets: [config.arkApiKey, "fixture-secret-xyz", authorityRoot],
  });
  const counters: Counters = {
    frontend: 0,
    backend: 0,
    integration: 0,
    repair: 0,
    repeatedFailures: 0,
    diagnosis: 0,
    synthesizer: 0,
  };
  const starts: FixtureState["starts"] = {};
  let preflightBeforeModel = true;
  let modelAdmissions = 0;
  let authorityMutated = false;
  let conflictInjected = false;
  let diagnosisVariant: "baseline" | "changed" = "baseline";
  let allCandidatesFail = scenario === "all_candidates_fail";

  const container = {
    run: async (input: {
      candidatePath: string;
      authorityRoot: string;
      gate: AuthorityGate | AuthorityMutant;
      control: { assertActive(): void };
    }) => {
      input.control.assertActive();
      const tier: GateResult["tier"] = "tier" in input.gate
        ? input.gate.tier
        : "mutation_quality";
      const hasBackend = await exists(path.join(input.candidatePath, "backend.txt"));
      const hasFrontend = await exists(path.join(input.candidatePath, "frontend.txt"));
      const hasIntegration = await exists(path.join(input.candidatePath, "integration.txt"));
      const hasAnyOutput = hasBackend || hasFrontend || hasIntegration;

      if (scenario === "authority_compromise" && !authorityMutated && !hasAnyOutput) {
        authorityMutated = true;
        await writeFile(path.join(authorityRoot, "helpers", "lib.mjs"), "export const helper = false;\n");
      }
      if (
        scenario === "promotion_conflict" &&
        !conflictInjected &&
        hasBackend &&
        !hasFrontend &&
        tier === "consumer"
      ) {
        const active = store.snapshot().runs.find((item) => item.status === "running" && item.project);
        if (active?.project?.canonicalWorkspacePath) {
          conflictInjected = true;
          const canonical = active.project.canonicalWorkspacePath;
          await writeFile(path.join(canonical, "backend.txt"), "conflicting producer\n", "utf8");
          await git.run(canonical, ["add", "--", "backend.txt"]);
          await git.run(canonical, ["commit", "-m", "deterministic promotion conflict"]);
          const head = await git.head(canonical);
          await store.mutate((database) => {
            const current = database.runs.find((item) => item.id === active.id);
            if (current?.project) current.project.headCommit = head;
          });
        }
      }

      let passed = hasAnyOutput;
      if (allCandidatesFail && hasBackend && !hasFrontend && !hasIntegration) passed = false;
      if (scenario === "consumer_regression" && hasBackend && !hasFrontend && tier === "consumer") passed = false;
      if (scenario === "expensive_tie" && !hasFrontend && !hasIntegration) passed = true;
      if (scenario === "post_gate_rollback" && hasBackend && tier === "post_integration") passed = false;
      return {
        kind: "command_exit" as const,
        exitCode: passed ? 0 : 1,
        stdout: Buffer.from(passed ? "trusted gate passed\n" : "trusted gate failed\n"),
        stderr: new Uint8Array(),
        elapsedMs: 1,
      };
    },
  };
  const verificationRunner = new VerificationRunner({ registry, container, store: evidence, git });
  const evolutionStore = new EvolutionStore({ dataDirectory: config.dataDirectory });
  const failureCueService = new FailureCueService();
  const exactRepeatIndex = new ExactRepeatIndex();
  const lineageRecorder = new LineageRecorder({ store, evolutionStore, failureCueService });
  const historicalAuditor = new HistoricalEvidenceAuditor({
    evidenceStore: evidence,
    candidateRun: (record) => {
      const snapshot = store.snapshot();
      const rootRun = snapshot.runs.find((run) => run.id === record.runId);
      const attemptId = rootRun?.orchestration?.healing.candidates.find((candidate) =>
        candidate.id === record.entityId)?.attemptId;
      return attemptId ? snapshot.runs.find((run) => run.id === attemptId) ?? null : null;
    },
  });

  const coordination = new CoordinationServer();
  await coordination.listen(0);
  const coordinationParts: Partial<OrchestratorParts> = {
    coordination: {
      dataDir: path.join(root, "coordination"),
      baseUrl: coordination.baseUrl("127.0.0.1"),
      register(token, ingress) {
        coordination.register(token, ingress);
      },
      unregister(token) {
        coordination.unregister(token);
      },
    },
  };

  const modelProxy = {
    issue() {
      return "deterministic-fixture-model-token";
    },
    revoke() {},
    terminalError() {
      return undefined;
    },
  } satisfies ModelCredentialIssuer;

  const runner = demoRunner({
    scenario,
    git,
    counters,
    starts,
    beforeModelAdmission(runId) {
      if (modelAdmissions === 0) {
        const project = store.snapshot().runs.find((item) => item.id === runId)?.project;
        preflightBeforeModel = project?.state === "ready" && Boolean(project.headCommit);
      }
      modelAdmissions += 1;
    },
    durableChildrenCompleted(runId) {
      const results = store.snapshot().runs.find((item) => item.id === runId)
        ?.orchestration?.workerResults ?? [];
      return ["backend", "frontend", "integration"].every((subtaskId) =>
        results.some((result) => result.subtaskId === subtaskId && result.status === "completed")
      );
    },
  });

  const diagnoser: Diagnoser = {
    diagnose: async (input: { fault: { id: string } }) => {
      counters.diagnosis += 1;
      if (scenario === "malformed_diagnosis") {
        throw new Error("malformed diagnosis payload");
      }
      return {
        id: "diagnosis-context",
        faultId: input.fault.id,
        status: "available",
        classification: "missing producer interface evidence",
        rationale: diagnosisVariant === "baseline"
          ? "Supply the frozen producer contract evidence."
          : "Supply the changed frozen producer contract evidence.",
        allowedMutationFamilies: ["context_patch"],
        createdAt: new Date().toISOString(),
      };
    },
  } as Diagnoser;

  if (scenario === "checkpoint_failure") {
    git.snapshotWorkingTree = async () => {
      throw new Error("deterministic checkpoint unavailable");
    };
  }

  let evolutionReconciler!: EvolutionReconciler;
  let service!: AgentService;
  service = new AgentService(
    config,
    store,
    workspaces,
    runner,
    events,
    {
      policy: {
        ...defaultExecutionPolicy,
        maxParallel: 3,
        maxSubtasks: 6,
        maxIterations: 1,
        maxTotalWorkerRuns: 12,
        workerTimeoutMs: 15_000,
        quiescenceMs: 5,
        workerSessionPolicy: "fresh",
        workerWorkspacePolicy: "fresh_task_scoped",
      },
      planner: {
        plan: async () => {
          throw new Error("live fixture must use public append-only dispatch");
        },
      } as OrchestratorParts["planner"],
      evaluator: {
        evaluate: async (_task: string, plan: LeaderPlan, results: WorkerResult[]) => {
          if (scenario === "evaluator_unavailable") {
            return {
              status: "unavailable",
              reason: "evaluator_failed",
              error: "deterministic evaluator unavailable",
              promptVersion: "m2-v1",
            };
          }
          const current = store.snapshot().runs.find((candidate) =>
            candidate.parentRunId === null && candidate.status === "running" && candidate.project,
          );
          const admittedPlan = current?.orchestration?.iterationPlans.find((entry) =>
            entry.reason === "leader_codex"
          )?.plan;
          const planMatchesAdmission = admittedPlan !== undefined &&
            JSON.stringify(plan) === JSON.stringify(admittedPlan);
          const integrations = current?.project?.integrations.filter((integration) =>
            integration.state === "integrated" &&
            integration.structuralDecision === "passed" &&
            typeof integration.canonicalHeadAfter === "string"
          ) ?? [];
          const verifications = current?.orchestration?.healing.verifications ?? [];
          const protectedIntegration = (subtaskId: string): boolean => integrations.some((integration) =>
            integration.subtaskId === subtaskId &&
            integration.verificationIds.length > 0 && integration.verificationIds.every((id) =>
              verifications.some((verification) =>
                verification.id === id && verification.mandatoryPassed
              )
            )
          );
          const protectedIntegrations = integrations.length > 0 && integrations.every((integration) =>
            protectedIntegration(integration.subtaskId)
          );
          const trustedResults = results.length > 0 && results.every((result) =>
            result.status === "completed" &&
            (result.validation?.integrity === "valid" || protectedIntegration(result.subtaskId))
          );
          const exactCanonicalHead = integrations.at(-1)?.canonicalHeadAfter === current?.project?.headCommit;
          return {
            status: "available",
            model: "fixture-evaluator",
            promptVersion: "m2-v1",
            evaluation: {
              sufficient: trustedResults && protectedIntegrations && exactCanonicalHead &&
                planMatchesAdmission,
              subtaskEvaluations: [],
              missingInformation: planMatchesAdmission ? []
                : ["live coordinator plan did not match durable admission"],
            },
          };
        },
      } as OrchestratorParts["evaluator"],
      replanner: {
        replan: async () => {
          throw new Error("bounded fixture must not replan");
        },
      } as OrchestratorParts["replanner"],
      synthesizer: {
        synthesize: async () => {
          counters.synthesizer += 1;
          return { output: "deterministic fixture complete", model: "fixture", promptVersion: "m2-v1" };
        },
      } as OrchestratorParts["synthesizer"],
      healingEnabled: true,
      contractCatalog: registry.catalog(),
      verificationRegistry: registry,
      verificationRunner,
      diagnoser,
      lineageRecorder,
      faultEvidenceStore: evidence,
      exactRepeatIndex,
      failureCueService,
      refreshEvolutionHistory: async () => { await evolutionReconciler.reconcile(); },
      runtimeCapabilityEnvironment: repairRuntimeCapabilityEnvironmentFromConfig(config),
      git,
      ...coordinationParts,
    },
    modelProxy,
    undefined,
    new ProjectRunManager(path.join(root, "project-runs"), [root], git),
    {},
    projectRegistry,
    git,
  );
  evolutionReconciler = new EvolutionReconciler({
    store,
    evolutionStore,
    evidenceStore: evidence,
    lineageRecorder,
    auditor: historicalAuditor,
    exactRepeatIndex,
    failureCueService,
  });
  await evolutionReconciler.initialize();
  await service.initialize();
  const evolutionQuery = new EvolutionQueryService({
    store: evolutionStore,
    runById: (runId) => service.getRun(runId),
    cursorSecret: "deterministic-m2-fixture-evolution-cursor",
  });

  return {
    root,
    authorityRoot,
    source,
    git,
    store,
    service,
    registry,
    coordination,
    evolutionStore,
    evolutionReconciler,
    exactRepeatIndex,
    evolutionQuery,
    setDiagnosisVariant(value) { diagnosisVariant = value; },
    setAllCandidatesFail(value) { allCandidatesFail = value; },
    counters,
    starts,
    get preflightBeforeModel() {
      return preflightBeforeModel;
    },
    get modelAdmissions() {
      return modelAdmissions;
    },
  };
}

function demoRunner(options: {
  scenario: SelfHealingScenario;
  git: GitClient;
  counters: Counters;
  starts: FixtureState["starts"];
  beforeModelAdmission(runId: string): void;
  durableChildrenCompleted(runId: string): boolean;
}): AgentRunner {
  const integrationAdmitted = new Set<string>();
  const startedTasks = new Map<string, Set<string>>();
  return {
    run: async (request) => {
      options.beforeModelAdmission(request.runId);
      if (isLiveLeader(request)) {
        const backend = dispatch(request, {
          id: "backend",
          prompt: "TASK:backend",
          contractKey: "backend-producer",
          outputs: ["backend.txt"],
          mutationPaths: ["backend.txt"],
        });
        const frontend = dispatch(request, {
          id: "frontend",
          prompt: "TASK:frontend",
          contractKey: "frontend-producer",
          outputs: ["frontend.txt"],
          mutationPaths: ["frontend.txt"],
        });
        await poll(() => startedTasks.get(request.runId)?.has("backend") === true &&
          startedTasks.get(request.runId)?.has("frontend") === true, 5_000);
        await dispatch(request, {
          id: "integration",
          prompt: "TASK:integration",
          contractKey: "integration-consumer",
          outputs: ["integration.txt"],
          mutationPaths: ["integration.txt"],
          dependsOn: ["backend", "frontend"],
        });
        integrationAdmitted.add(request.runId);
        const integration = await dispatch(request, {
          id: "integration",
          prompt: "TASK:integration",
          contractKey: "integration-consumer",
          wait: true,
        });
        await Promise.allSettled([backend, frontend]);
        await Promise.all([
          dispatch(request, {
            id: "backend",
            prompt: "TASK:backend",
            contractKey: "backend-producer",
            wait: true,
          }),
          dispatch(request, {
            id: "frontend",
            prompt: "TASK:frontend",
            contractKey: "frontend-producer",
            wait: true,
          }),
        ]);
        await poll(() => options.durableChildrenCompleted(request.runId), 5_000);
        const integrationStatus = (
          (integration.result as { status?: string } | undefined)?.status ?? integration.status
        );
        return {
          output: "live DAG settled: " + String(integrationStatus ?? "unknown"),
          threadId: null,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }

      const task = taskOf(request);
      const rootRunId = request.parentRunId ?? request.runId;
      const started = startedTasks.get(rootRunId) ?? new Set<string>();
      started.add(task);
      startedTasks.set(rootRunId, started);
      if (task === "backend") {
        options.counters.backend += 1;
        options.starts.backend = Date.now();
        await poll(() => startedTasks.get(rootRunId)?.has("frontend") === true, 5_000);
        if (options.scenario !== "normal_success") {
          await poll(() => integrationAdmitted.has(rootRunId), 5_000);
          emitThreeFailures(request, options.counters);
          throw new Error("protected producer contract failed three times");
        }
        return commitFiles(options.git, request, { "backend.txt": "backend-interface=v1\n" });
      }
      if (task === "frontend") {
        options.counters.frontend += 1;
        options.starts.frontend = Date.now();
        await poll(() => startedTasks.get(rootRunId)?.has("backend") === true, 5_000);
        return commitFiles(options.git, request, { "frontend.txt": "frontend-consumer=v1\n" });
      }
      if (task === "integration") {
        options.counters.integration += 1;
        options.starts.integration = Date.now();
        const backend = await readFile(path.join(request.workspacePath, "backend.txt"), "utf8");
        const frontend = await readFile(path.join(request.workspacePath, "frontend.txt"), "utf8");
        if (backend !== "backend-interface=v1\n" || frontend !== "frontend-consumer=v1\n") {
          throw new Error("integration consumer did not receive verified producer outputs");
        }
        return commitFiles(options.git, request, { "integration.txt": "integration=verified\n" });
      }

      options.counters.repair += 1;
      if (task === "repair-context") {
        return commitFiles(options.git, request, { "backend.txt": "backend-interface=v1\n" });
      }
      return {
        output: "unchanged candidate retained the protected failure",
        threadId: null,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    cancel: async () => true,
    isAvailable: async () => true,
  };
}

async function summarize(input: {
  fixture: FixtureState;
  scenario: SelfHealingScenario;
  run: AgentRun;
  projectId: string;
  sourceBefore: SourceSnapshot;
  sourceAfter: SourceSnapshot;
  elapsedMs: number;
}): Promise<SelfHealingDemoResult> {
  const { fixture, run } = input;
  const healing = run.orchestration?.healing;
  if (!healing) throw new Error("deterministic demo did not persist healing state");
  const tournament = healing.tournaments[0];
  const winner = healing.candidates.find((candidate) => candidate.id === tournament?.winnerCandidateId);
  const candidateIds = new Set(healing.candidates.map((candidate) => candidate.id));
  const candidateVerifications = healing.verifications.filter((verification) =>
    candidateIds.has(verification.subjectId)
  );
  const mandatoryGateTiers = [...new Set(
    healing.verifications.flatMap((verification) => verification.gates.map((gate) => gate.tier)),
  )];
  const runProject = run.project;
  const baseCommit = runProject?.source.baseCommit ?? input.sourceBefore.head;
  const finalCommit = runProject?.headCommit ?? baseCommit;
  const finalTree = runProject?.canonicalWorkspacePath && finalCommit
    ? await fixture.git.run(runProject.canonicalWorkspacePath, ["rev-parse", finalCommit + "^{tree}"])
    : await fixture.git.run(fixture.source, ["rev-parse", baseCommit + "^{tree}"]);
  const checkpointHashes: string[] = [];
  if (runProject?.canonicalWorkspacePath && tournament?.checkpointId) {
    const checkpointFile = path.join(
      path.dirname(runProject.canonicalWorkspacePath),
      "repair-checkpoints",
      tournament.checkpointId + ".json",
    );
    try {
      const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8")) as {
        contextBundleHash: string;
      };
      for (const candidate of healing.candidates) checkpointHashes.push(checkpoint.contextBundleHash);
    } catch {
      // Checkpoint refusal is expected in the dedicated fail-closed scenario.
    }
  }
  const nodeStates = Object.fromEntries(
    healing.nodes.map((node) => [node.subtaskId, node.state]),
  );
  const projectRecord = fixture.service.listProjects().find((project) => project.id === input.projectId);
  const canonicalWorkspaceClean = runProject?.canonicalWorkspacePath
    ? await fixture.git.isClean(runProject.canonicalWorkspacePath).catch(() => false)
    : true;
  const allChildrenTerminal = fixture.store.snapshot().runs
    .filter((candidate) => candidate.parentRunId === run.id)
    .every((candidate) => ["completed", "failed", "cancelled"].includes(candidate.status));
  const integrations = runProject?.integrations ?? [];
  const backendIntegration = integrations.find((integration) => integration.subtaskId === "backend");
  const postVerification = healing.verifications.find((verification) =>
    verification.stage === "post_integration" && verification.subjectId === backendIntegration?.contributionId
  );
  const failureReason = [
    run.error,
    ...(run.status === "completed" ? [] : (run.orchestration?.workerResults ?? []).map(
      (result) => "worker " + result.subtaskId + "=" + result.status + ":" + (result.error ?? ""),
    )),
    tournament?.failureReason,
    ...healing.diagnoses.map((diagnosis) => diagnosis.rationale + " " + diagnosis.classification),
    ...integrations.map((integration) => integration.reason),
    ...healing.verifications.flatMap((verification) =>
      verification.gates.filter((gate) => !gate.passed).map((gate) => gate.tier + " gate failed")
    ),
  ].filter((value): value is string => Boolean(value)).join("; ");
  const providerFault = detectFault({
    result: {
      subtaskId: "provider",
      workerId: null,
      workerRunId: null,
      iteration: 1,
      attempt: 1,
      status: "failed",
      output: "",
      error: "provider_rate_limited",
      usage: null,
      durationMs: 0,
      artifacts: [],
    },
  });
  const observerValues = ["valid-fingerprint", new Error("git timeout")];
  const observer = new RepositoryTrajectoryObserver({
    trajectoryFingerprint: async () => {
      const value = observerValues.shift();
      if (value instanceof Error) throw value;
      return value ?? "valid-fingerprint";
    },
  });
  const firstFingerprint = await observer.capture();
  const secondFingerprint = await observer.capture();
  const profileAssetPaths = new Set(fixture.registry.profile().assets.map((asset) => asset.relativePath));
  const sourceIntegrity = JSON.stringify(input.sourceBefore) === JSON.stringify(input.sourceAfter);
  const promoted = healing.candidates.filter((candidate) => candidate.state === "promoted");
  const unsafePromotion = promoted.length > 0 && (
    run.status !== "completed" ||
    !postVerification?.mandatoryPassed ||
    backendIntegration?.state !== "integrated"
  );
  const actualTokens = healing.candidates.reduce(
    (total, candidate) => total + candidate.actualInputTokens + candidate.actualOutputTokens,
    0,
  ) + (run.usage?.totalTokens ?? 0);
  const calls = healing.candidates.reduce((total, candidate) => total + candidate.modelCalls, 0) +
    fixture.modelAdmissions;
  const reservedTokens = healing.candidates.reduce((total, candidate) => total + candidate.reservedTokens, 0);
  const integrationQueued = Boolean(
    backendIntegration && backendIntegration.verificationIds.length > 0 && backendIntegration.state === "integrated",
  );

  return {
    trace: [...EXPECTED_SELF_HEALING_TRACE],
    scenario: input.scenario,
    status: run.status,
    outcome: run.orchestration?.outcome?.value ?? "not_established",
    failureReason,
    runId: run.id,
    projectId: input.projectId,
    runBranch: runProject?.runBranch ?? "unavailable",
    baseCommit,
    finalCommit,
    finalTree: finalTree.trim(),
    sourceBefore: input.sourceBefore,
    sourceAfter: input.sourceAfter,
    preflightBeforeModel: fixture.preflightBeforeModel,
    siblingOverlap: Boolean(fixture.starts.backend && fixture.starts.frontend),
    repeatedFailureCount: fixture.counters.repeatedFailures,
    diagnosisCalls: fixture.counters.diagnosis,
    tournamentCount: healing.tournaments.length,
    winnerFamily: winner?.delta.family ?? (tournament?.winnerCandidateId?.endsWith("control") ? "control" : null),
    candidateCounts: {
      declared: healing.candidates.length,
      admitted: healing.candidates.filter((candidate) => candidate.attemptId !== null).length,
      executed: healing.candidates.filter((candidate) => candidate.attemptId !== null).length,
      verified: candidateVerifications.filter((verification) =>
        verification.stage === "finalist" && verification.mandatoryPassed
      ).length,
      promoted: promoted.length,
    },
    candidateCheckpointHashes: checkpointHashes,
    frontendStarts: fixture.counters.frontend,
    backendStarts: fixture.counters.backend,
    integrationStarts: fixture.counters.integration,
    repairStarts: fixture.counters.repair,
    nodeStates,
    mandatoryGateTiers,
    mandatoryGatesPassed: run.status === "completed" && [
      "integrity",
      "targeted",
      "contract",
      "consumer",
      "held_out",
      "mutation_quality",
      "regression",
      "post_integration",
    ].every((tier) => healing.verifications.some((verification) =>
      verification.gates.some((gate) => gate.tier === tier && gate.passed)
    )),
    baselineAdvancedToFinal: projectRecord?.baselineCommit === finalCommit && finalCommit !== baseCommit,
    unsafePromotion,
    integrationQueued,
    postIntegrationBeforeCompletion: Boolean(
      postVerification?.mandatoryPassed && nodeStates.backend === "completed",
    ),
    consumerStartedAfterPromotion: fixture.counters.integration === 1 && Boolean(
      backendIntegration?.state === "integrated" && nodeStates.integration === "completed",
    ),
    canonicalWorkspaceClean,
    liveDispatchDrained: allChildrenTerminal,
    lastValidGitFingerprintPreserved: firstFingerprint === secondFingerprint,
    providerFailureNonRepairable: providerFault?.class === "provider_rate_limited" && !providerFault.repairable,
    authorityAssetsComplete: [
      "gates/targeted.mjs",
      "gates/contract.mjs",
      "gates/consumer.mjs",
      "gates/held-out.mjs",
      "gates/regression.mjs",
      "mutants/required-field.mjs",
      "helpers/lib.mjs",
      "fixtures/held.json",
    ].every((asset) => profileAssetPaths.has(asset)),
    synthesizerCalls: fixture.counters.synthesizer,
    calls,
    reservedTokens,
    actualTokens,
    elapsedMs: input.elapsedMs,
    cleanupDecision: "removed",
    userBranchIntegrity: sourceIntegrity,
  };
}

async function materializeAuthority(authorityRoot: string): Promise<string> {
  await cp(AUTHORITY_SOURCE, authorityRoot, { recursive: true, force: true });
  const sourceProfile = JSON.parse(
    await readFile(path.join(AUTHORITY_SOURCE, "profile.json"), "utf8"),
  ) as Record<string, unknown> & { contracts: unknown[] };
  const contract = (contractKey: string, input: string[], output: string) => ({
    contractKey,
    allowedInputs: input,
    allowedOutputs: [output],
    allowedMutationPaths: [output],
    protectedPaths: [".launchpad", "package.json"],
    artifactSchemaIds: [contractKey + "-schema"],
    targetedGateIds: ["targeted"],
    contractGateIds: ["contract"],
    consumerGateIds: ["consumer"],
    regressionGateIds: ["regression"],
    authorizedTools: ["read_file"],
  });
  sourceProfile.contracts = [
    contract("backend-producer", ["shared.txt"], "backend.txt"),
    contract("frontend-producer", ["shared.txt"], "frontend.txt"),
    contract("integration-consumer", ["backend.txt", "frontend.txt"], "integration.txt"),
  ];
  const profilePath = path.join(authorityRoot, "profile.json");
  await writeFile(profilePath, JSON.stringify(sourceProfile, null, 2) + "\n", "utf8");
  return profilePath;
}

async function dispatch(request: RunnerRequest, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = request.coordinationEnv?.LAUNCHPAD_COORDINATION_URL;
  const token = request.coordinationEnv?.LAUNCHPAD_COORDINATION_TOKEN;
  if (!base || !token) throw new Error("live leader coordination authority is missing");
  const response = await fetch(base.replace(/\/+$/, "") + "/dispatch_subagent", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
      connection: "close",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error("dispatch_subagent refused: " + text);
  return JSON.parse(text) as Record<string, unknown>;
}

function isLiveLeader(request: RunnerRequest): boolean {
  return Boolean(request.coordinationEnv?.LAUNCHPAD_COORDINATION_URL) &&
    request.coordinationEnv?.LAUNCHPAD_REPAIR_CANDIDATE !== "1" &&
    !/^TASK:/.test(request.prompt);
}

function taskOf(request: RunnerRequest): string {
  const task = /^TASK:([a-z-]+)/.exec(request.prompt)?.[1];
  if (task) return task;
  if (request.coordinationEnv?.LAUNCHPAD_REPAIR_CANDIDATE === "1") {
    if (request.prompt.includes("Consult the frozen failure")) return "repair-context";
    if (request.prompt.includes("Inspect consumer")) return "repair-strategy";
    return "repair-control";
  }
  throw new Error("deterministic fixture task marker missing");
}

function emitThreeFailures(request: RunnerRequest, counters: Counters): void {
  for (const attempt of [1, 2, 3]) {
    counters.repeatedFailures += 1;
    const timestamp = new Date().toISOString();
    request.sink?.emit({
      spanId: "protected-producer-failure-" + attempt,
      parentSpanId: "run",
      kind: "command",
      name: "npm-test",
      status: "error",
      startedAt: timestamp,
      endedAt: timestamp,
      durationMs: 1,
      input: { command: "npm test -- tests/protected-producer.test.ts" },
      output: { exitCode: 1, text: "FAIL missing backend interface" },
      error: { message: "missing backend interface", code: "1" },
      attributes: {},
      usage: null,
    });
  }
}

async function commitFiles(
  git: GitClient,
  request: RunnerRequest,
  files: Record<string, string>,
): Promise<RunnerResult> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(request.workspacePath, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  await git.run(request.workspacePath, ["add", "--", ...Object.keys(files)]);
  await git.run(request.workspacePath, ["commit", "-m", "deterministic fixture contribution"]);
  const head = await git.head(request.workspacePath);
  return {
    output: [
      "findings: deterministic contribution complete",
      "evidence: " + Object.keys(files).join(","),
      "unresolved gaps: none",
      "recommended next checks: trusted authority",
      "LAUNCHPAD_COMMIT=" + head,
    ].join("\n"),
    threadId: null,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

async function sourceSnapshot(git: GitClient, source: string): Promise<SourceSnapshot> {
  return {
    branch: await git.run(source, ["symbolic-ref", "--short", "HEAD"]),
    head: await git.head(source),
    status: await git.run(source, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

async function waitForTerminal(service: AgentService, runId: string): Promise<AgentRun> {
  await poll(() => ["completed", "failed", "cancelled"].includes(service.getRun(runId).status), 60_000);
  return service.getRun(runId);
}

async function poll(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("deterministic fixture poll timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}
