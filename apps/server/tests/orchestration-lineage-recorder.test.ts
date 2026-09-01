import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalHash,
  runtimeCapabilityFingerprint,
} from "../src/orchestration/evolution/evolution-fingerprints.js";
import type { RuntimeCapabilityManifestV2 } from "../src/orchestration/evolution/evolution-types.js";
import { EvidenceStore } from "../src/orchestration/verification/evidence-store.js";
import { EvolutionStore } from "../src/orchestration/evolution/evolution-store.js";
import { HistoricalEvidenceAuditor } from "../src/orchestration/evolution/historical-evidence-auditor.js";
import { LineageRecorder, LineageUnavailableError } from "../src/orchestration/evolution/lineage-recorder.js";
import { Orchestrator, type OrchestratorParts } from "../src/orchestration/orchestrator.js";
import { FailureCueService } from "../src/orchestration/evolution/failure-cues.js";
import { JsonStore, mergeEvolutionOutboxes } from "../src/store.js";
import type {
  AgentRun,
  FaultRecord,
  IntegrationRecord,
  MutationCandidate,
  ProjectRunRecord,
  RepairTournament,
  TaskNodeState,
  VerificationResult,
  ProjectRecord,
} from "../src/types.js";

const roots: string[] = [];
const hash = (value: string) => canonicalHash({ value });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "lineage-recorder-"));
  roots.push(value);
  return value;
}

function project(): ProjectRunRecord {
  return {
    source: {
      mode: "existing_repository",
      repositoryPath: "/repo",
      requestedRevision: "main",
      baseCommit: "a".repeat(40),
      sourceFingerprint: hash("source"),
    },
    runBranch: "launchpad/run/run-1",
    canonicalWorkspacePath: "/workspace",
    headCommit: "b".repeat(40),
    state: "ready",
    attempts: [],
    integrations: [],
  };
}

function node(): TaskNodeState {
  return {
    subtaskId: "backend",
    revision: 3,
    state: "repairing",
    blockedBy: [],
    attemptId: "attempt-original",
    faultId: "fault-1",
    diagnosisId: "diagnosis-1",
    tournamentId: "tournament-1",
    verificationIds: [],
    integrationContributionId: null,
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function fault(): FaultRecord {
  return {
    id: "fault-1",
    subtaskId: "backend",
    revision: 3,
    class: "hard_failure",
    reasonCode: "targeted_gate_failed",
    summary: "targeted gate failed",
    repairable: true,
    evidenceRefs: [hash("fault-evidence")],
    affectedConsumers: ["integration"],
    detectedAt: "2026-08-30T00:00:00.000Z",
  };
}

function candidate(family: MutationCandidate["delta"]["family"], state: MutationCandidate["state"]): MutationCandidate {
  return {
    id: `candidate-${family}`,
    tournamentId: "tournament-1",
    checkpointId: "checkpoint-1",
    delta: {
      family,
      targetSubtaskId: "backend",
      diagnosisId: "diagnosis-1",
      addedEvidenceRefs: family === "context_patch" ? [hash("context")] : [],
      failureCueIds: [],
      instructionPatch: family,
      toolRoute: ["read_file"],
      expectedEffect: "repair backend",
      contentHash: hash("mutation-" + family),
    },
    state,
    attemptId: `attempt-${family}`,
    verificationIds: state === "declared" ? [] : ["verification-" + family],
    modelCalls: 1,
    reservedTokens: 100,
    actualInputTokens: 9,
    actualOutputTokens: 7,
    elapsedMs: 20,
    terminalReason: null,
    historicalMatchRecordId: null,
    historicalVerificationId: null,
  };
}

function tournament(status: RepairTournament["status"]): RepairTournament {
  return {
    id: "tournament-1",
    subtaskId: "backend",
    revision: 3,
    checkpointId: "checkpoint-1",
    candidateIds: ["candidate-control", "candidate-context_patch", "candidate-strategy_patch"],
    status,
    winnerCandidateId: status === "promotion_pending" || status === "promoted"
      ? "candidate-context_patch"
      : null,
    failureReason: null,
    startedAt: "2026-08-30T00:00:00.000Z",
    completedAt: status === "promoted" ? "2026-08-30T00:01:00.000Z" : null,
  };
}

function verification(subjectId = "candidate-context_patch"): VerificationResult {
  return {
    id: "verification-context_patch",
    subjectType: "candidate",
    subjectId,
    stage: "candidate",
    authorityManifestHash: hash("authority"),
    gates: [{
      gateId: "targeted",
      tier: "targeted",
      passed: true,
      evidenceRef: hash("verification-evidence"),
      failureFingerprint: null,
    }],
    failureKind: null,
    mandatoryPassed: true,
    hardProgress: 1,
    regressionCount: 0,
    modelCalls: 0,
    reservedTokens: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    elapsedMs: 5,
    verifiedAt: "2026-08-30T00:00:30.000Z",
  };
}

function integration(state: IntegrationRecord["state"] = "integrated"): IntegrationRecord {
  return {
    contributionId: "contribution-context",
    subtaskId: "backend",
    canonicalHeadBefore: "b".repeat(40),
    canonicalHeadAfter: state === "integrated" ? "c".repeat(40) : null,
    state,
    structuralDecision: state === "integrated" ? "passed" : "failed",
    reason: state === "integrated" ? null : "post_integration_verification_failed",
    verificationIds: ["verification-post-integration"],
  };
}

function rootRun(): AgentRun {
  return {
    id: "run-1",
    agentId: "agent-1",
    projectId: "project-1",
    kind: "orchestration",
    parentRunId: null,
    orchestration: {
      phase: "executing",
      iteration: 1,
      iterationPlans: [],
      evaluationRecords: [],
      workerResults: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, workerRuns: 0 },
      policySnapshot: {} as AgentRun["orchestration"] extends infer _T ? never : never,
      provenance: {
        harnessVersion: "m2-harness-v1",
        plannerPromptVersion: "p",
        evaluatorPromptVersion: "e",
        replannerPromptVersion: "r",
        synthesizerPromptVersion: "s",
      },
      healing: {
        contracts: [], nodes: [], faults: [], snapshots: [], diagnoses: [], candidates: [], tournaments: [], verifications: [], budget: null,
      },
      evolutionOutbox: [],
    } as unknown as NonNullable<AgentRun["orchestration"]>,
    project: project(),
    status: "running",
    prompt: "repair backend",
    output: null,
    error: null,
    usage: null,
    startedAt: "2026-08-30T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

function childRun(candidateValue: MutationCandidate): AgentRun {
  return {
    ...rootRun(),
    id: candidateValue.attemptId!,
    kind: "subtask",
    parentRunId: "run-1",
    orchestration: null,
    project: undefined,
    usage: { inputTokens: 11, outputTokens: 13 },
    status: "completed",
  };
}

function input(candidateValue: MutationCandidate, transition: Parameters<LineageRecorder["build"]>[0]["transition"]) {
  return {
    run: rootRun(),
    project: project(),
    node: node(),
    fault: fault(),
    candidate: candidateValue,
    tournament: tournament(transition === "promoted" ? "promoted" : "running"),
    verification: candidateValue.verificationIds.length > 0 ? verification(candidateValue.id) : null,
    integration: transition === "promoted" || transition === "rolled_back"
      ? integration(transition === "promoted" ? "integrated" : "rolled_back")
      : null,
    candidateRun: transition === "declared" || transition === "admitted" || transition === "cancelled" || transition === "pruned_duplicate"
      ? null
      : childRun(candidateValue),
    transition,
    eventEvidenceRefs: [hash("event")],
    occurredAt: "2026-08-30T00:01:00.000Z",
    runtimeCapabilityIdentity: {
      runtimeCapabilityHash: hash("runtime"),
      manifestComplete: true,
    },
  };
}

describe("LineageRecorder", () => {
  it("persists idempotent branch returns through the live callback without blocking settlement on advisory failure", async () => {
    const directory = await temporaryRoot();
    const file = path.join(directory, "store.json");
    const store = new JsonStore(file);
    await store.initialize();
    const candidateValue = candidate("context_patch", "rolled_back");
    candidateValue.terminalReason = "post_integration_verification_failed";
    candidateValue.repairGraphFenceHash = hash("fence");
    candidateValue.evolutionFingerprints = {
      schemaVersion: 2, complete: true, repositoryBaseHash: hash("repository"), contractHash: hash("contract"),
      authorityManifestHash: hash("authority"), runtimeCapabilityHash: hash("runtime"), faultEvidenceHash: hash("fault"),
      mutationContentHash: candidateValue.delta.contentHash,
    };
    const transition = input(candidateValue, "rolled_back");
    transition.tournament.status = "rolled_back";
    transition.tournament.winnerCandidateId = candidateValue.id;
    transition.tournament.repairGraphFenceHash = hash("fence");
    transition.verification!.subjectType = "contribution";
    transition.verification!.subjectId = transition.integration!.contributionId;
    transition.verification!.stage = "post_integration";
    transition.verification!.mandatoryPassed = false;
    transition.verification!.failureKind = "deterministic_gate_failure";
    transition.verification!.repairGraphFenceHash = hash("fence");
    transition.verification!.gates[0]!.passed = false;
    transition.verification!.gates[0]!.failureFingerprint = hash("failed-gate");
    transition.integration!.repairGraphFenceHash = hash("fence");
    transition.integration!.verificationIds = [transition.verification!.id];
    transition.contribution = {
      contributionId: transition.integration!.contributionId, attemptId: candidateValue.attemptId!, attemptRevision: 3,
      ownerFingerprint: hash("owner"), subtaskId: "backend", baseCommit: "a".repeat(40), headCommit: "b".repeat(40),
      changedPaths: ["apps/server/index.ts"], diffHash: hash("diff"), verificationLevel: "structural",
      verificationIds: [transition.verification!.id], repairGraphFenceHash: hash("fence"),
    };
    transition.repairCheckpoint = {
      id: "checkpoint-1", runId: "run-1", subtaskId: "backend", taskRevision: 3,
      sourceAttemptId: "attempt-original", sourceAttemptRevision: 3, originalBaseCommit: "a".repeat(40),
      checkpointCommit: "b".repeat(40), treeHash: hash("tree"), fingerprintSchemaVersion: 2,
      fingerprintComplete: true, repositoryBaseHash: hash("repository"), contractHash: hash("contract"),
      authorityManifestHash: hash("authority"), contextBundleHash: hash("context-bundle"), faultEvidenceHash: hash("fault"),
      contextEvidenceRefs: [hash("context")], contextAuditEvidenceRefs: [hash("audit")], runtimeCapabilityHash: hash("runtime"),
      allowedMutationPaths: ["apps/server"], protectedPaths: [".github"], createdAt: "2026-08-30T00:00:00.000Z",
      repairGraphFenceHash: hash("fence"),
    };
    const persisted = rootRun();
    persisted.project = transition.project;
    persisted.project.integrations = [transition.integration!];
    persisted.orchestration!.healing = {
      ...persisted.orchestration!.healing, nodes: [transition.node], faults: [transition.fault!],
      candidates: [candidateValue], tournaments: [transition.tournament], verifications: [transition.verification!],
    };
    await store.mutate((database) => { database.runs.push(persisted, transition.candidateRun!); });

    const emitted: unknown[] = [];
    const makeOrchestrator = (lineageRecorder: LineageRecorder) => new Orchestrator(
      store, {} as never, {} as never,
      { createSink: () => ({ emit: (event: unknown) => { emitted.push(event); } }) } as never,
      { lineageRecorder } as OrchestratorParts, () => false,
    );
    type Callback = { recordSettledBranchReturns(
      runId: string, tournamentId: string, checkpoint: NonNullable<typeof transition.repairCheckpoint>,
      contribution: NonNullable<typeof transition.contribution>,
    ): Promise<void> };
    const invoke = (orchestrator: Orchestrator) => (orchestrator as unknown as Callback).recordSettledBranchReturns(
      "run-1", "tournament-1", transition.repairCheckpoint!, transition.contribution!,
    );
    const orchestrator = makeOrchestrator(new LineageRecorder());
    await invoke(orchestrator);
    await invoke(orchestrator);

    const reopened = new JsonStore(file);
    await reopened.initialize();
    const durable = reopened.snapshot().runs.find((run) => run.id === "run-1")!;
    expect(durable.orchestration!.evolutionOutbox).toHaveLength(1);
    expect(durable.orchestration!.evolutionOutbox[0]!.records.filter((record) => record.type === "branch_return"))
      .toHaveLength(1);
    const settledState = structuredClone(store.snapshot().runs.find((run) => run.id === "run-1")!.orchestration!.healing);

    const failingRecorder = new LineageRecorder();
    failingRecorder.enqueue = () => { throw new Error("evolution store unavailable"); };
    await expect(invoke(makeOrchestrator(failingRecorder))).resolves.toBeUndefined();
    expect(store.snapshot().runs.find((run) => run.id === "run-1")!.orchestration!.healing).toEqual(settledState);
    expect(emitted).toHaveLength(1);
  });

  it("preserves durable delivered outbox truth over a stale live pending copy", () => {
    const recorder = new LineageRecorder();
    const state = rootRun().orchestration!;
    const entry = recorder.enqueue(state, input(candidate("control", "declared"), "declared"));
    const delivered = { ...entry, state: "delivered" as const, deliveredAt: "2026-08-30T00:02:00.000Z" };
    expect(mergeEvolutionOutboxes([entry], [delivered])).toEqual([delivered]);
  });

  it("builds deterministic source/harness/attempt/candidate/integration/promotion graph records", () => {
    const recorder = new LineageRecorder();
    const declared = ["control", "context_patch", "strategy_patch"].flatMap((family) =>
      recorder.build(input(candidate(family as MutationCandidate["delta"]["family"], "declared"), "declared")));
    const promotedCandidate = candidate("context_patch", "promoted");
    const promoted = recorder.build(input(promotedCandidate, "promoted"));
    const all = [...declared, ...promoted];
    const nodes = new Map(all.filter((record) => record.type === "node").map((record) => [record.value.id, record.value]));
    const edges = new Map(all.filter((record) => record.type === "edge").map((record) => [record.value.id, record.value]));
    expect([...nodes.values()].map((value) => value.kind).sort()).toEqual([
      "attempt", "candidate", "candidate", "candidate", "candidate", "harness", "integration", "promotion", "source",
    ]);
    expect([...edges.values()].map((value) => value.kind).sort()).toEqual([
      "continuation", "executed_by", "integrated_as", "promoted_as", "repair_fork", "repair_fork", "repair_fork", "repair_fork",
    ]);
    expect(recorder.build(input(promotedCandidate, "promoted"))).toEqual(promoted);
  });

  it("gives observations and terminal nodes distinct identities when their durable times differ", () => {
    const recorder = new LineageRecorder();
    const promotedCandidate = candidate("context_patch", "promoted");
    const first = input(promotedCandidate, "promoted");
    const second = input(promotedCandidate, "promoted");
    first.tournament.completedAt = "2026-08-30T00:02:00.000Z";
    second.tournament.completedAt = "2026-08-30T00:03:00.000Z";

    const firstRecords = recorder.build(first);
    const secondRecords = recorder.build(second);
    const id = (records: typeof firstRecords, type: "promotion" | "observation") => records.find((record) =>
      type === "observation" ? record.type === "observation" :
        record.type === "node" && record.value.kind === "promotion")!.value.id;

    expect(id(firstRecords, "promotion")).not.toBe(id(secondRecords, "promotion"));
    expect(id(firstRecords, "observation")).not.toBe(id(secondRecords, "observation"));
  });

  it("records rollback lineage without inventing a promotion", () => {
    const recorder = new LineageRecorder();
    const candidateValue = candidate("context_patch", "rolled_back");
    candidateValue.terminalReason = "post_integration_verification_failed";
    candidateValue.repairGraphFenceHash = hash("fence");
    candidateValue.evolutionFingerprints = {
      schemaVersion: 2,
      complete: true,
      repositoryBaseHash: hash("repository"),
      contractHash: hash("contract"),
      authorityManifestHash: hash("authority"),
      runtimeCapabilityHash: hash("runtime"),
      faultEvidenceHash: hash("fault"),
      mutationContentHash: candidateValue.delta.contentHash,
    };
    const transition = input(candidateValue, "rolled_back");
    transition.tournament.repairGraphFenceHash = hash("fence");
    transition.tournament.winnerCandidateId = candidateValue.id;
    transition.tournament.status = "rolled_back";
    transition.verification!.repairGraphFenceHash = hash("fence");
    transition.verification!.subjectType = "contribution";
    transition.verification!.subjectId = transition.integration!.contributionId;
    transition.verification!.stage = "post_integration";
    transition.verification!.mandatoryPassed = false;
    transition.verification!.failureKind = "deterministic_gate_failure";
    transition.verification!.gates[0]!.passed = false;
    transition.verification!.gates[0]!.failureFingerprint = hash("post-integration-failure");
    transition.integration!.repairGraphFenceHash = hash("fence");
    transition.integration!.verificationIds = [transition.verification!.id];
    transition.contribution = {
      contributionId: transition.integration!.contributionId,
      attemptId: candidateValue.attemptId!,
      attemptRevision: 3,
      ownerFingerprint: hash("owner"),
      subtaskId: "backend",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      changedPaths: ["apps/server/index.ts"],
      diffHash: hash("diff"),
      verificationLevel: "structural",
      verificationIds: [transition.verification!.id],
      repairGraphFenceHash: hash("fence"),
    };
    transition.repairCheckpoint = {
      id: "checkpoint-1",
      runId: "run-1",
      subtaskId: "backend",
      taskRevision: 3,
      sourceAttemptId: "attempt-original",
      sourceAttemptRevision: 3,
      originalBaseCommit: "a".repeat(40),
      checkpointCommit: "b".repeat(40),
      treeHash: hash("tree"),
      fingerprintSchemaVersion: 2,
      fingerprintComplete: true,
      repositoryBaseHash: hash("repository"),
      contractHash: hash("contract"),
      authorityManifestHash: hash("authority"),
      contextBundleHash: hash("context-bundle"),
      faultEvidenceHash: hash("fault"),
      contextEvidenceRefs: [hash("context")],
      contextAuditEvidenceRefs: [hash("audit")],
      runtimeCapabilityHash: hash("runtime"),
      allowedMutationPaths: ["apps/server"],
      protectedPaths: [".github"],
      createdAt: "2026-08-30T00:00:00.000Z",
      repairGraphFenceHash: hash("fence"),
    };
    const rolledBack = recorder.build(transition);
    expect(rolledBack.filter((record) => record.type === "node").map((record) => record.value.kind))
      .toContain("rollback");
    expect(rolledBack.some((record) => record.type === "node" && record.value.kind === "promotion")).toBe(false);
    expect(rolledBack.some((record) => record.type === "edge" && record.value.kind === "rolled_back_to")).toBe(true);
    expect(rolledBack.filter((record) => record.type === "capsule")).toHaveLength(1);
    expect(rolledBack.filter((record) => record.type === "branch_return")).toHaveLength(1);
    expect(rolledBack.filter((record) =>
      record.type === "observation" && record.value.kind === "branch_pruned")).toHaveLength(1);
    expect(rolledBack.filter((record) =>
      record.type === "edge" && record.value.kind === "returned_to")).toHaveLength(1);
    const state = rootRun().orchestration!;
    recorder.enqueue(state, transition);
    recorder.enqueue(state, transition);
    expect(state.evolutionOutbox).toHaveLength(1);
    expect(state.evolutionOutbox[0]!.records.filter((record) => record.type === "branch_return"))
      .toHaveLength(1);
  });

  it("binds otherwise identical lineage nodes to their owning run and fault", () => {
    const recorder = new LineageRecorder();
    const first = input(candidate("control", "declared"), "declared");
    const second = {
      ...first,
      run: { ...first.run, id: "run-2" },
      fault: { ...first.fault!, id: "fault-2" },
    };
    const firstIds = new Set(recorder.build(first).map((record) => record.value.id));
    expect(recorder.build(second).some((record) => firstIds.has(record.value.id))).toBe(false);
  });

  it("binds the harness node to the complete frozen runtime capability rather than the version label", () => {
    const manifest: RuntimeCapabilityManifestV2 = {
      schemaVersion: 2,
      harnessVersion: "same-version",
      repairPromptVersion: "repair-v1",
      diagnosisPromptVersion: "diagnosis-v1",
      modelId: "model-a",
      runtimeMode: "container",
      toolSchemaHash: hash("tools-a"),
      excludedToolHash: hash("excluded"),
      sandboxPolicyHash: hash("sandbox"),
      containerImageId: "sha256:" + "a".repeat(64),
      timeoutMs: 1_000,
      stepCap: 20,
      rootResourceHorizonHash: hash("horizon-a"),
    };
    const changed = {
      ...manifest,
      modelId: "model-b",
      toolSchemaHash: hash("tools-b"),
      containerImageId: "sha256:" + "b".repeat(64),
      rootResourceHorizonHash: hash("horizon-b"),
    };
    const firstIdentity = runtimeCapabilityFingerprint(manifest);
    const secondIdentity = runtimeCapabilityFingerprint(changed);
    expect(firstIdentity.complete).toBe(true);
    expect(secondIdentity.complete).toBe(true);
    const base = input(candidate("control", "declared"), "declared");
    const harness = (identity: typeof firstIdentity) => new LineageRecorder().build({
      ...base,
      runtimeCapabilityIdentity: {
        runtimeCapabilityHash: identity.hash,
        manifestComplete: identity.complete,
      },
    }).find((record) => record.type === "node" && record.value.kind === "harness");
    const firstHarness = harness(firstIdentity);
    const secondHarness = harness(secondIdentity);
    expect(firstHarness?.type === "node" && firstHarness.value.harnessVersionHash).toBe(firstIdentity.hash);
    expect(secondHarness?.type === "node" && secondHarness.value.harnessVersionHash).toBe(secondIdentity.hash);
    expect(secondHarness?.value.id).not.toBe(firstHarness?.value.id);
  });

  it("records complete production candidate fingerprints and actual verification IDs for audit", async () => {
    const directory = await temporaryRoot();
    const evidenceStore = new EvidenceStore({ dataDirectory: directory });
    const evidence = await evidenceStore.write("failed-gate", Buffer.from("mandatory gate failed"));
    const rejected = {
      ...candidate("context_patch", "rejected"),
      terminalReason: "deterministic_gate_failure",
      verificationIds: ["verification-context_patch"],
      delta: { ...candidate("context_patch", "rejected").delta, addedEvidenceRefs: [evidence.sha256] },
      evolutionFingerprints: {
        schemaVersion: 2,
        complete: true,
        repositoryBaseHash: hash("repository"),
        contractHash: hash("contract"),
        authorityManifestHash: hash("authority"),
        runtimeCapabilityHash: hash("runtime"),
        faultEvidenceHash: hash("fault-context"),
        mutationContentHash: hash("mutation-context"),
      },
    } as MutationCandidate & { evolutionFingerprints: NonNullable<import("../src/orchestration/evolution/evolution-types.js").EvolutionFingerprints> };
    const failedVerification = {
      ...verification(rejected.id),
      id: "verification-context_patch",
      authorityManifestHash: rejected.evolutionFingerprints.authorityManifestHash,
      mandatoryPassed: false,
      failureKind: "deterministic_gate_failure",
      gates: [{ gateId: "targeted", tier: "targeted" as const, passed: false,
        evidenceRef: evidence.sha256, failureFingerprint: hash("gate-failure") }],
    };
    const failedFault = { ...fault(), evidenceRefs: [evidence.sha256] };
    const running = { ...rejected, state: "running" as const, verificationIds: [] };
    const executedRecords = new LineageRecorder().build({
      ...input(running, "executed"), candidate: running, fault: failedFault, verification: null,
    });
    const rejectedInput = input(rejected, "rejected");
    rejectedInput.run.orchestration!.healing.contracts = [{
      subtaskId: "backend", revision: 3, contractKey: "backend-contract",
      inputs: [], outputs: [], dependencyIds: [], downstreamConsumers: [],
      allowedMutationPaths: [], protectedPaths: [], artifactSchemaIds: [],
      targetedGateIds: ["targeted"], contractGateIds: [], consumerGateIds: [],
      regressionGateIds: [], authorizedTools: ["read_file"],
    }];
    const rejectedRecords = new LineageRecorder({ failureCueService: new FailureCueService() }).build({
      ...rejectedInput, candidate: rejected, fault: failedFault, verification: failedVerification,
    });
    const finalNode = rejectedRecords.find((record) =>
      record.type === "node" && record.value.kind === "candidate");
    expect(finalNode?.type).toBe("node");
    if (finalNode?.type !== "node") throw new Error("missing candidate node");
    expect(finalNode.value.fingerprints?.complete).toBe(true);
    expect(finalNode.value.verificationIds).toEqual([failedVerification.id]);
    expect(rejectedRecords.filter((record) => record.type === "cue")).toHaveLength(1);
    const observations = [...executedRecords, ...rejectedRecords]
      .filter((record) => record.type === "observation").map((record) => record.value);
    const relatedRecords = [...executedRecords, ...rejectedRecords]
      .filter((record): record is Extract<(typeof rejectedRecords)[number], { type: "node" }> =>
        record.type === "node" && record.value.kind === "candidate")
      .map((record) => record.value);
    const owner: ProjectRecord = {
      id: "project-1", displayName: "Project", sourceKind: "managed", repositoryPath: "/repo",
      repositoryRealPath: "/repo", gitCommonRealPath: "/repo/.git", gitCommonDev: 1, gitCommonIno: 2,
      baselineBranch: "main", baselineCommit: "a".repeat(40), state: "ready", lastError: null,
      createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z",
    };
    const auditor = new HistoricalEvidenceAuditor({ evidenceStore, candidateRun: () => childRun(rejected) });
    await expect(auditor.audit({ project: owner, record: finalNode.value, relatedRecords, observations,
      verification: failedVerification, fault: failedFault })).resolves.toMatchObject({
      trustedForPruning: true, trustedForCue: true, quarantine: null,
    });
  });

  it("refuses executed resource truth without the exactly matching persisted child run", () => {
    const recorder = new LineageRecorder();
    const executed = candidate("control", "running");
    expect(() => recorder.build({ ...input(executed, "executed"), candidateRun: null }))
      .toThrow(LineageUnavailableError);
    expect(() => recorder.build({
      ...input(executed, "executed"),
      candidateRun: { ...childRun(executed), id: "different-attempt" },
    })).toThrow(/candidate child run/i);
    const observation = recorder.build(input(executed, "executed"))
      .find((record) => record.type === "observation");
    expect(observation?.type === "observation" && observation.value).toMatchObject({
      actualInputTokens: 11,
      actualOutputTokens: 13,
    });
  });

  it("records passive cue transfer against the exact control without extra execution", () => {
    const baseFingerprints = {
      schemaVersion: 2 as const,
      complete: true,
      repositoryBaseHash: hash("repository"),
      contractHash: hash("contract"),
      authorityManifestHash: hash("authority"),
      runtimeCapabilityHash: hash("runtime"),
      faultEvidenceHash: hash("fault-context"),
      mutationContentHash: hash("historical-mutation"),
    };
    const sourceCandidate = {
      ...candidate("context_patch", "rejected"),
      evolutionFingerprints: baseFingerprints,
    };
    const failed = {
      ...verification(sourceCandidate.id),
      authorityManifestHash: baseFingerprints.authorityManifestHash,
      mandatoryPassed: false,
      failureKind: "deterministic_gate_failure" as const,
      regressionCount: 1,
      gates: [{ gateId: "hidden", tier: "contract" as const, passed: false,
        evidenceRef: hash("cue-evidence"), failureFingerprint: hash("cue-failure") }],
    };
    const creator = new FailureCueService();
    const cue = creator.create({
      projectId: "project-1",
      sourceFingerprint: project().source.sourceFingerprint,
      contractKey: "backend-contract",
      candidate: sourceCandidate,
      candidateNodeId: hash("historical-node"),
      verification: failed,
      exactRepeatKey: hash("repeat"),
    });
    if (cue === null) throw new Error("missing cue fixture");
    const cueService = new FailureCueService({
      cues: [cue],
      audits: [{ recordId: cue.sourceCandidateNodeId, trustedForPruning: true,
        trustedForCue: true, quarantine: null }],
    });
    const control = {
      ...candidate("control", "verified"),
      verificationIds: ["verification-control"],
      evolutionFingerprints: { ...baseFingerprints, mutationContentHash: hash("control-mutation") },
    };
    const current = {
      ...candidate("context_patch", "verified"),
      verificationIds: ["verification-current"],
      delta: { ...candidate("context_patch", "verified").delta, failureCueIds: [cue.id] },
      evolutionFingerprints: { ...baseFingerprints, mutationContentHash: hash("current-mutation") },
    };
    const controlVerification = {
      ...verification(control.id), id: "verification-control", hardProgress: 1, regressionCount: 1,
    };
    const currentVerification = {
      ...verification(current.id), id: "verification-current", hardProgress: 2, regressionCount: 1,
    };
    const run = rootRun();
    run.orchestration!.healing.candidates = [control, current];
    run.orchestration!.healing.verifications = [controlVerification, currentVerification];
    const records = new LineageRecorder({ failureCueService: cueService }).build({
      ...input(current, "verified"),
      run,
      candidate: current,
      verification: currentVerification,
      candidateRun: childRun(current),
      includeSettledTransfers: true,
    });
    expect(records.filter((record) => record.type === "transfer").map((record) => record.value.outcome))
      .toEqual(["helped"]);
  });

  it("persists a pending outbox atomically and flushes idempotently after append/delivery failures", async () => {
    const directory = await temporaryRoot();
    const store = new JsonStore(path.join(directory, "launchpad.json"));
    await store.initialize();
    const run = rootRun();
    await store.mutate((database) => { database.runs.push(run); });
    let failAppend = true;
    const evolutionStore = new EvolutionStore({
      dataDirectory: directory,
      failureInjector: (point) => {
        if (point === "before_write" && failAppend) {
          failAppend = false;
          throw new Error("injected append failure");
        }
      },
    });
    await evolutionStore.initialize();
    let failDelivery = true;
    const recorder = new LineageRecorder({
      store,
      evolutionStore,
      beforeMarkDelivered: () => {
        if (failDelivery) {
          failDelivery = false;
          throw new Error("injected delivery failure");
        }
      },
    });
    const declared = candidate("control", "declared");
    await store.mutate((database) => {
      const state = database.runs[0]!.orchestration!;
      recorder.enqueue(state, input(declared, "declared"));
    });
    expect(store.snapshot().runs[0]!.orchestration!.evolutionOutbox[0]!.state).toBe("pending");
    await expect(recorder.flush("run-1")).rejects.toThrow("injected append failure");
    expect(store.snapshot().runs[0]!.orchestration!.evolutionOutbox[0]!.state).toBe("pending");
    await expect(recorder.flush("run-1")).rejects.toThrow("injected delivery failure");
    expect(store.snapshot().runs[0]!.orchestration!.evolutionOutbox[0]!.state).toBe("pending");
    await recorder.flush("run-1");
    expect(store.snapshot().runs[0]!.orchestration!.evolutionOutbox[0]!.state).toBe("delivered");
    expect(await evolutionStore.recordIds("project-1")).toEqual(new Set(
      store.snapshot().runs[0]!.orchestration!.evolutionOutbox[0]!.records.map((record) => record.value.id),
    ));
    await evolutionStore.close();
  });

  it("fails closed when a persisted record ID has unequal deterministic content", async () => {
    const directory = await temporaryRoot();
    const store = new JsonStore(path.join(directory, "launchpad.json"));
    await store.initialize();
    await store.mutate((database) => { database.runs.push(rootRun()); });
    const evolutionStore = new EvolutionStore({ dataDirectory: directory });
    await evolutionStore.initialize();
    const recorder = new LineageRecorder({ store, evolutionStore });
    const transition = input(candidate("control", "declared"), "declared");
    const records = recorder.build(transition);
    const seed = records[0]!;
    if (seed.type !== "node") throw new Error("expected source node");
    await evolutionStore.appendBatch({ projectId: "project-1", expectedHeadHash: null, records: [{
      type: "node", value: { ...seed.value, entityId: seed.value.entityId + "-unequal" },
    }] });
    await store.mutate((database) => { recorder.enqueue(database.runs[0]!.orchestration!, transition); });
    await expect(recorder.flush("run-1")).rejects.toThrow(/unequal|collision|content/i);
    expect(store.snapshot().runs[0]!.orchestration!.evolutionOutbox[0]!.state).toBe("pending");
    await evolutionStore.close();
  });
});
