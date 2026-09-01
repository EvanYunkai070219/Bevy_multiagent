import { describe, expect, it } from "vitest";
import { emptyHealingState } from "../src/types.js";
import {
  deterministicEvolutionId,
  evolutionCountsFromObservations,
  normalizeEvolutionOutboxEntry,
  sanitizeEvolutionProjection,
} from "../src/orchestration/evolution/evolution-types.js";
import type {
  AgentRun,
  MutationCandidate,
  VerificationResult,
} from "../src/types.js";
import type {
  EvolutionOutboxEntry,
  EvolutionProjection,
  FailureCue,
  LineageEdge,
  LineageNode,
  LineageObservation,
  QuarantineRecord,
  TransferObservation,
} from "../src/orchestration/evolution/evolution-types.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_RUN_ID = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);

function acceptedMilestoneTwoRecords(): {
  run: AgentRun;
  candidate: MutationCandidate;
  verification: VerificationResult;
  runs: AgentRun[];
} {
  const candidate: MutationCandidate = {
    id: "candidate-1",
    tournamentId: "tournament-1",
    checkpointId: "checkpoint-1",
    delta: {
      family: "context_patch",
      targetSubtaskId: "backend",
      diagnosisId: "diagnosis-1",
      addedEvidenceRefs: [HASH],
      instructionPatch: "Consult the frozen contract evidence.",
      toolRoute: ["read_file"],
      expectedEffect: "restore the producer contract",
      contentHash: HASH,
    },
    state: "rejected",
    attemptId: CANDIDATE_RUN_ID,
    verificationIds: ["verification-1"],
    modelCalls: 1,
    reservedTokens: 100,
    actualInputTokens: 50,
    actualOutputTokens: 25,
    elapsedMs: 1_000,
    terminalReason: "targeted_gate_failed",
  };
  const verification: VerificationResult = {
    id: "verification-1",
    subjectType: "candidate",
    subjectId: candidate.id,
    stage: "finalist",
    authorityManifestHash: HASH,
    gates: [],
    failureKind: "deterministic_gate_failure",
    mandatoryPassed: false,
    hardProgress: 0,
    regressionCount: 0,
    modelCalls: 1,
    reservedTokens: 100,
    actualInputTokens: 50,
    actualOutputTokens: 25,
    elapsedMs: 1_000,
    verifiedAt: "2026-08-29T00:00:02.000Z",
  };
  const healing = emptyHealingState();
  healing.candidates.push(candidate);
  healing.verifications.push(verification);
  const run: AgentRun = {
    id: RUN_ID,
    agentId: "agent-1",
    projectId: "project-1",
    kind: "orchestration",
    parentRunId: null,
    orchestration: {
      phase: "failed",
      iteration: 1,
      iterationPlans: [],
      evaluationRecords: [],
      workerResults: [],
      usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75, workerRuns: 1 },
      policySnapshot: {
        maxParallel: 10,
        maxSubtasks: 10,
        maxIterations: 2,
        maxTotalWorkerRuns: 30,
        workerTimeoutMs: null,
        workerSessionPolicy: "fresh",
        workerWorkspacePolicy: "fresh_task_scoped",
        workerIdentityPolicy: "per_subtask",
        quiescenceMs: 2_000,
        maxFollowUpTurnsPerWorker: 3,
        maxRepairTournaments: 1,
        maxRepairBranches: 3,
        repairBranchTimeoutMs: 240_000,
        budgetAdvisoryTokens: null,
        budgetSevereTokens: null,
        budgetAdvisoryModelCalls: null,
        budgetSevereModelCalls: null,
        emergencyTokenFuse: null,
        emergencyModelCallFuse: null,
        rootTimeoutMs: null,
        maxRuntimeSteps: null,
        repeatedSignatureLimit: null,
        trajectoryCheckpointMs: 60_000,
      },
      provenance: {
        harnessVersion: "orchestration-1",
        plannerPromptVersion: "planner-v1",
        evaluatorPromptVersion: "evaluator-v1",
        replannerPromptVersion: "replanner-v1",
        synthesizerPromptVersion: "synthesizer-v1",
      },
      healing,
    },
    workspaceSource: {
      mode: "existing_repository",
      repositoryPath: "/fixture/repository",
      revision: "HEAD",
    },
    project: {
      source: {
        mode: "existing_repository",
        repositoryPath: "/fixture/repository",
        requestedRevision: "HEAD",
        baseCommit: COMMIT,
        sourceFingerprint: HASH,
      },
      runBranch: "launchpad/run/" + RUN_ID,
      canonicalWorkspacePath: "/fixture/run",
      headCommit: COMMIT,
      state: "ready",
      attempts: [],
      integrations: [],
    },
    status: "failed",
    prompt: "Build the fixture.",
    output: null,
    error: "repair_failed",
    usage: { inputTokens: 50, outputTokens: 25 },
    startedAt: "2026-08-29T00:00:00.000Z",
    completedAt: "2026-08-29T00:00:03.000Z",
    createdAt: "2026-08-29T00:00:00.000Z",
  };
  const candidateChildRun: AgentRun = {
    ...run,
    id: CANDIDATE_RUN_ID,
    kind: "subtask",
    parentRunId: RUN_ID,
    orchestration: null,
    project: undefined,
    workspaceSource: undefined,
    prompt: "Repair candidate.",
  };
  return { run, candidate, verification, runs: [run, candidateChildRun] };
}

describe("Milestone 3 compatibility gate", () => {
  it("constructs the accepted Milestone 2 ownership contracts", () => {
    const { run, candidate, verification, runs } = acceptedMilestoneTwoRecords();

    expect(run.orchestration?.healing).toBeDefined();
    expect(candidate.state).toBe("rejected");
    expect(candidate.delta.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verification.authorityManifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.project?.source.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(run.project?.source.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    const candidateChildRun = runs.find((item) => item.id === candidate.attemptId);
    expect(candidateChildRun).toBeDefined();
    expect(candidate.attemptId).toBe(candidateChildRun?.id);
  });

  it("defines immutable deterministic lineage and bounded internal outbox records", () => {
    const node = lineageNode();
    const entry: EvolutionOutboxEntry = {
      id: deterministicEvolutionId("outbox", { projectId: node.projectId, runId: node.runId }),
      projectId: node.projectId,
      runId: node.runId,
      records: [{ type: "node", value: node }],
      state: "pending",
      createdAt: "2026-08-29T00:00:00.000Z",
      deliveredAt: null,
      lastErrorCode: null,
    };
    const normalized = normalizeEvolutionOutboxEntry(entry);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.records)).toBe(true);
    expect(Object.isFrozen(normalized.records[0]?.value)).toBe(true);
    expect(normalized.records[0]).toMatchObject({ type: "node" });
    expect(deterministicEvolutionId("node", { b: 2, a: 1 })).toBe(
      deterministicEvolutionId("node", { a: 1, b: 2 }),
    );
  });

  it("sorts and deduplicates lineage hash, path, and reference arrays", () => {
    const node = lineageNode({
      verificationIds: ["verification-z", "verification-a", "verification-a"],
      evidenceRefs: ["b".repeat(64), "a".repeat(64), "a".repeat(64)],
      changedPaths: ["src/z.ts", "src/a.ts", "src/a.ts"],
    });
    const normalized = normalizeEvolutionOutboxEntry(outbox(node));
    const value = normalized.records[0]?.value as LineageNode;
    expect(value.verificationIds).toEqual(["verification-a", "verification-z"]);
    expect(value.evidenceRefs).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(value.changedPaths).toEqual(["src/a.ts", "src/z.ts"]);
  });

  it("rejects missing, extra, and malformed fingerprint fields", () => {
    const complete = lineageNode().fingerprints!;
    const missing = { ...complete } as Record<string, unknown>;
    delete missing.contractHash;
    const extra = { ...complete, extraHash: "e".repeat(64) };
    const malformed = { ...complete, runtimeCapabilityHash: "not-a-sha256" };

    for (const [label, fingerprints] of [
      ["missing", missing],
      ["extra", extra],
      ["malformed", malformed],
    ] as const) {
      expect(() => normalizeEvolutionOutboxEntry(outbox(lineageNode({
        fingerprints: fingerprints as LineageNode["fingerprints"],
      }))), label).toThrow(/fingerprint|hash|schema/i);
    }
  });

  it("allowlists every nested evolution record and projection field", () => {
    const edge = {
      id: "a".repeat(64),
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      fromNodeId: "1".repeat(64),
      toNodeId: "2".repeat(64),
      kind: "repair_fork",
      createdAt: "2026-08-29T00:00:00.000Z",
      artifactLocation: "/private/leak-edge",
    } as unknown as LineageEdge;
    const observation = {
      id: "b".repeat(64),
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      runId: RUN_ID,
      nodeId: "1".repeat(64),
      kind: "executed",
      candidateState: "running",
      terminalReason: null,
      modelCalls: 1,
      reservedTokens: 2,
      actualInputTokens: 3,
      actualOutputTokens: 4,
      elapsedMs: 5,
      occurredAt: "2026-08-29T00:00:00.000Z",
      privatePath: "/private/leak-observation",
    } as unknown as LineageObservation;
    const cue = {
      id: "c".repeat(64),
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sourceFingerprint: "8".repeat(64),
      sourceCandidateNodeId: "1".repeat(64),
      contractKey: "backend",
      contractHash: "9".repeat(64),
      candidateFamily: "context_patch",
      fingerprints: {
        schemaVersion: 2,
        complete: true,
        repositoryBaseHash: "8".repeat(64),
        contractHash: "9".repeat(64),
        authorityManifestHash: "a".repeat(64),
        runtimeCapabilityHash: "b".repeat(64),
        faultEvidenceHash: "c".repeat(64),
        mutationContentHash: "d".repeat(64),
      },
      gateTier: "targeted",
      failureFingerprint: "3".repeat(64),
      summary: "Targeted gate failed.",
      evidenceRefs: ["4".repeat(64)],
      exactRepeatKey: "5".repeat(64),
      differingFingerprintFields: [],
      createdAt: "2026-08-29T00:00:00.000Z",
      apiToken: "leak-cue-token",
    } as unknown as FailureCue;
    const transfer = {
      id: "d".repeat(64),
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      cueId: "c".repeat(64),
      targetCandidateNodeId: "1".repeat(64),
      differingFingerprintFields: ["contractHash"],
      outcome: "helped",
      evidenceRefs: ["6".repeat(64)],
      createdAt: "2026-08-29T00:00:00.000Z",
      ownerCredential: "leak-transfer-owner",
    } as unknown as TransferObservation;
    const quarantine = {
      id: "e".repeat(64),
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      targetRecordId: "1".repeat(64),
      reason: "schema_invalid",
      evidenceRefs: ["7".repeat(64)],
      quarantinedAt: "2026-08-29T00:00:00.000Z",
      artifactLocation: "/private/leak-quarantine",
    } as unknown as QuarantineRecord;
    const records = [
      { type: "edge" as const, value: edge },
      { type: "observation" as const, value: observation },
      { type: "cue" as const, value: cue },
      { type: "transfer" as const, value: transfer },
      { type: "quarantine" as const, value: quarantine },
    ];
    const normalized = normalizeEvolutionOutboxEntry({
      ...outbox(lineageNode()),
      records,
    });
    const projection = sanitizeEvolutionProjection({
      syncState: "pending",
      primaryFault: null,
      warningLevel: null,
      terminalReason: null,
      runBranch: null,
      baseCommit: null,
      headCommit: null,
      counts: {
        declared: 0,
        prunedDuplicate: 0,
        admitted: 0,
        executed: 0,
        verified: 0,
        promoted: 0,
        rolledBack: 0,
        historicalEvidenceUsed: 0,
      },
      nodes: [],
      edges: [edge],
      observations: [observation],
      cues: [cue],
      transfers: [transfer],
      quarantines: [quarantine],
      nextCursor: null,
    });
    const encoded = JSON.stringify({ normalized, projection });
    for (const secret of [
      "leak-edge", "leak-observation", "leak-cue-token",
      "leak-transfer-owner", "leak-quarantine",
    ]) expect(encoded, secret).not.toContain(secret);
  });

  it("rejects oversized, over-count, over-depth, escaping-path, and malformed identity records", () => {
    const invalidEntries: Array<[string, EvolutionOutboxEntry]> = [
      ["encoded payload", outbox(lineageNode({
        entityId: "x".repeat(70_000),
      }))],
      ["array", outbox(lineageNode({
        evidenceRefs: Array.from({ length: 201 }, (_, index) => index.toString(16).padStart(64, "0")),
      }))],
      ["path", outbox(lineageNode({ changedPaths: ["/etc/passwd"] }))],
      ["path", outbox(lineageNode({ changedPaths: ["../escape"] }))],
      ["id", outbox(lineageNode({ id: "not-a-hash" }))],
      ["hash", outbox(lineageNode({ sourceFingerprint: "not-a-hash" }))],
      ["commit", outbox(lineageNode({ headCommit: "not-a-commit" }))],
    ];
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) deep = { nested: deep };
    invalidEntries.push(["depth", outbox({ ...lineageNode(), internal: deep } as LineageNode)]);
    for (const [label, entry] of invalidEntries) {
      expect(() => normalizeEvolutionOutboxEntry(entry), label).toThrow(
        new RegExp(label === "encoded payload" ? "64|size|payload" : label, "i"),
      );
    }
  });

  it("returns a bounded public projection with only public record fields", () => {
    const node = lineageNode();
    const projection = {
      syncState: "pending",
      primaryFault: {
        class: "hard_failure",
        summary: "x".repeat(800),
        evidenceRefs: ["a".repeat(64)],
        rawFailureOutput: "secret raw failure",
      },
      warningLevel: "advisory",
      terminalReason: null,
      runBranch: "launchpad/run/fixture",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      counts: {
        declared: 1,
        prunedDuplicate: 0,
        admitted: 1,
        executed: 0,
        verified: 0,
        promoted: 0,
        rolledBack: 0,
        historicalEvidenceUsed: 0,
      },
      nodes: Array.from({ length: 205 }, () => node),
      edges: [],
      observations: [],
      cues: [],
      transfers: [],
      quarantines: [],
      nextCursor: null,
      evolutionOutbox: [outbox(node)],
      ownerToken: "secret-owner",
      authorityPath: "/private/authority",
      credential: "secret-credential",
    } as unknown as EvolutionProjection;
    const publicProjection = sanitizeEvolutionProjection(projection);
    expect(publicProjection.nodes).toHaveLength(200);
    expect(publicProjection.primaryFault?.summary.length).toBeLessThanOrEqual(512);
    const encoded = JSON.stringify(publicProjection);
    expect(encoded).not.toContain("evolutionOutbox");
    expect(encoded).not.toContain("ownerToken");
    expect(encoded).not.toContain("authorityPath");
    expect(encoded).not.toContain("credential");
    expect(encoded).not.toContain("rawFailureOutput");
  });

  it("keeps declaration, pruning, admission, execution, verification, and promotion counts distinct", () => {
    const common = {
      projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      runId: RUN_ID,
      nodeId: "1".repeat(64),
      candidateState: null,
      terminalReason: null,
      modelCalls: 0,
      reservedTokens: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      elapsedMs: 0,
      occurredAt: "2026-08-29T00:00:00.000Z",
    } as const;
    const counts = evolutionCountsFromObservations([
      { ...common, id: "2".repeat(64), kind: "declared" },
      { ...common, id: "3".repeat(64), kind: "pruned_duplicate" },
      { ...common, id: "4".repeat(64), kind: "admitted" },
      { ...common, id: "5".repeat(64), kind: "executed" },
      { ...common, id: "6".repeat(64), kind: "verified" },
      { ...common, id: "7".repeat(64), kind: "promoted" },
    ], 2);
    expect(counts).toEqual({
      declared: 1,
      prunedDuplicate: 1,
      admitted: 1,
      executed: 1,
      verified: 1,
      promoted: 1,
      rolledBack: 0,
      historicalEvidenceUsed: 2,
    });
  });
});

function lineageNode(overrides: Partial<LineageNode> = {}): LineageNode {
  return {
    id: "1".repeat(64),
    projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceFingerprint: "2".repeat(64),
    runId: RUN_ID,
    subtaskId: "backend",
    kind: "candidate",
    entityId: "candidate-1",
    revision: 1,
    harnessVersionHash: "3".repeat(64),
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    faultId: "fault-1",
    fingerprints: {
      schemaVersion: 2,
      complete: true,
      repositoryBaseHash: "4".repeat(64),
      contractHash: "5".repeat(64),
      authorityManifestHash: "6".repeat(64),
      runtimeCapabilityHash: "7".repeat(64),
      faultEvidenceHash: "8".repeat(64),
      mutationContentHash: "9".repeat(64),
    },
    verificationIds: ["verification-1"],
    evidenceRefs: ["a".repeat(64)],
    changedPaths: ["src/app.ts"],
    createdAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function outbox(node: LineageNode): EvolutionOutboxEntry {
  return {
    id: "f".repeat(64),
    projectId: node.projectId,
    runId: node.runId,
    records: [{ type: "node", value: node }],
    state: "pending",
    createdAt: "2026-08-29T00:00:00.000Z",
    deliveredAt: null,
    lastErrorCode: null,
  };
}
