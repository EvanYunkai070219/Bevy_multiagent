import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceStore } from "../src/orchestration/verification/evidence-store.js";
import { detectFault, persistFaultEvidence } from "../src/orchestration/healing/fault-detector.js";
import { RunTerminalError } from "../src/orchestration/run-control.js";
import type { TrajectoryStop } from "../src/orchestration/workers/trajectory.js";
import type {
  FaultRecord,
  SubtaskContract,
  TaskNodeState,
  VerificationResult,
  WorkerResult,
} from "../src/types.js";
import type { RunEvent } from "../src/run-events.js";

function contract(overrides: Partial<SubtaskContract> = {}): SubtaskContract {
  return {
    subtaskId: "worker-1",
    revision: 1,
    contractKey: "demo",
    inputs: [],
    outputs: ["src/app.ts"],
    dependencyIds: [],
    downstreamConsumers: ["tester"],
    allowedMutationPaths: ["src/"],
    protectedPaths: ["package-lock.json"],
    artifactSchemaIds: [],
    targetedGateIds: ["targeted"],
    contractGateIds: ["contract"],
    consumerGateIds: ["consumer"],
    regressionGateIds: ["regression"],
    authorizedTools: ["bash"],
    ...overrides,
  };
}

function node(overrides: Partial<TaskNodeState> = {}): TaskNodeState {
  return {
    subtaskId: "worker-1",
    revision: 1,
    state: "running",
    blockedBy: [],
    attemptId: "attempt-1",
    faultId: null,
    diagnosisId: null,
    tournamentId: null,
    verificationIds: [],
    integrationContributionId: null,
    updatedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function result(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    subtaskId: "worker-1",
    workerId: "agent-1",
    workerRunId: "run-1",
    iteration: 1,
    attempt: 1,
    status: "failed",
    output: "",
    error: "task failed",
    usage: null,
    durationMs: 10,
    artifacts: [],
    ...overrides,
  };
}

function verification(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    id: "ver-1",
    subjectType: "contribution",
    subjectId: "c1",
    stage: "candidate",
    authorityManifestHash: "hash",
    gates: [],
    failureKind: overrides.mandatoryPassed === true ? null : "deterministic_gate_failure",
    mandatoryPassed: false,
    hardProgress: 0,
    regressionCount: 0,
    modelCalls: 0,
    reservedTokens: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    elapsedMs: 1,
    verifiedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function event(code: string, message: string): RunEvent {
  return {
    seq: 1,
    runId: "run-1",
    agentId: "agent-1",
    spanId: "err",
    parentSpanId: "run",
    kind: "error",
    name: "error",
    status: "error",
    startedAt: "2026-08-29T00:00:00.000Z",
    endedAt: "2026-08-29T00:00:00.000Z",
    durationMs: 0,
    input: {},
    output: {},
    error: { message, code },
    attributes: {},
    usage: null,
  };
}

function stall(): TrajectoryStop {
  return { reason: "no_evidence_progress", evidenceRefs: ["snap-1"] };
}

function expectFault(fault: FaultRecord | null, cls: FaultRecord["class"], repairable: boolean) {
  expect(fault).not.toBeNull();
  expect(fault!.class).toBe(cls);
  expect(fault!.repairable).toBe(repairable);
  expect(fault!.reasonCode).toBeTruthy();
  expect(fault!.subtaskId).toBe("worker-1");
}

describe("detectFault", () => {
  const base = { contract: contract(), node: node() };

  it("classifies cancellation first and as non-repairable", () => {
    expectFault(
      detectFault({
        ...base,
        result: result({ status: "cancelled", error: "user_cancelled" }),
        trajectory: stall(),
      }),
      "cancelled",
      false,
    );
  });

  it("classifies emergency budget before deadline and task faults", () => {
    expectFault(
      detectFault({
        ...base,
        result: result({ error: "emergency_token_fuse" }),
        terminal: new RunTerminalError("emergency_token_fuse", "fuse"),
        trajectory: stall(),
      }),
      "budget_failure",
      false,
    );
  });

  it("classifies deadline failure before provider and task faults", () => {
    expectFault(
      detectFault({
        ...base,
        result: result({ status: "timed_out", error: "Worker timed out after 900000 ms" }),
        terminal: new RunTerminalError("root_deadline", "deadline"),
        trajectory: stall(),
      }),
      "deadline_failure",
      false,
    );
  });

  it("classifies typed provider rate limiting as provider_rate_limited, not hard_failure", () => {
    const fault = detectFault({
      ...base,
      result: result({ error: "HTTP 429 Too Many Requests: please retry" }),
      events: [event("provider_rate_limited", "HTTP 429 Too Many Requests: please retry")],
      terminal: new RunTerminalError("provider_rate_limited", "429"),
    });
    expectFault(fault, "provider_rate_limited", false);
    expect(fault?.class).not.toBe("hard_failure");
  });

  it("classifies infrastructure and authority failures as non-repairable", () => {
    expectFault(
      detectFault({
        ...base,
        result: result({ error: "git_metadata_tampered" }),
        events: [event("git_metadata_tampered", "Attempt Git metadata failed")],
      }),
      "infrastructure_failure",
      false,
    );
    expectFault(
      detectFault({
        ...base,
        result: result({ error: "authority_denied" }),
        events: [event("authority_failure", "path escaped authority root")],
      }),
      "authority_failure",
      false,
    );
  });

  it("classifies integration conflict as non-repairable", () => {
    expectFault(
      detectFault({
        ...base,
        result: result({ status: "contribution_ready" }),
        verification: verification({
          gates: [
            {
              gateId: "post",
              tier: "post_integration",
              passed: false,
              evidenceRef: "e",
              failureFingerprint: "conflict",
            },
          ],
        }),
        events: [event("integration_conflict", "canonical integration rejected")],
      }),
      "integration_conflict",
      false,
    );
  });

  it("classifies a trajectory stop as a repairable stall", () => {
    expectFault(
      detectFault({ ...base, result: result(), trajectory: stall() }),
      "stall",
      true,
    );
  });

  it("classifies false completion when a worker claims done but mandatory verification failed", () => {
    expectFault(
      detectFault({
        ...base,
        result: result({ status: "contribution_ready", error: undefined }),
        verification: verification({ mandatoryPassed: false, hardProgress: 0 }),
      }),
      "false_completion",
      true,
    );
  });

  it("classifies coordination failure when a worker is blocked on peers", () => {
    expectFault(
      detectFault({
        ...base,
        node: node({ state: "blocked", blockedBy: ["peer-1"] }),
        result: result({ status: "blocked", error: "blocked on peer-1" }),
      }),
      "coordination_failure",
      true,
    );
  });

  it("classifies remaining hard task failure as repairable", () => {
    expectFault(
      detectFault({
        ...base,
        result: result({ error: "tests failed" }),
        verification: verification({
          mandatoryPassed: false,
          gates: [
            {
              gateId: "targeted",
              tier: "targeted",
              passed: false,
              evidenceRef: "e",
              failureFingerprint: "assert",
            },
          ],
        }),
      }),
      "hard_failure",
      true,
    );
  });

  it("never marks an ephemeral solo stall as repairable", () => {
    const fault = detectFault({
      contract: null,
      node: null,
      result: result({ subtaskId: "leader" }),
      trajectory: stall(),
      ephemeral: true,
    });
    expect(fault?.class).toBe("stall");
    expect(fault?.repairable).toBe(false);
  });

  it("does not use error-message regex when a typed code exists", () => {
    const fault = detectFault({
      ...base,
      result: result({ error: "the tests timed out after a stall" }),
      events: [event("provider_rate_limited", "the tests timed out after a stall")],
    });
    expect(fault?.class).toBe("provider_rate_limited");
    expect(fault?.repairable).toBe(false);
  });

  it("returns no fault for a successful contribution without verification", () => {
    expect(
      detectFault({
        ...base,
        result: result({ status: "contribution_ready", error: undefined }),
      }),
    ).toBeNull();
  });

  it("persists trajectory snapshots as whole-record evidence hashes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-fault-evidence-"));
    const store = new EvidenceStore({ dataDirectory: root });
    try {
      const snapshot = {
        id: "40835797-54c3-46f6-bd75-720c0aabbfe3",
        attemptId: "attempt-1",
        sequence: 1,
        source: "runtime" as const,
        mandatoryFailures: 1,
        consumerPassed: false,
        regressionCount: 0,
        failureFingerprints: ["assertion-failed"],
        changedPaths: ["src/app.ts"],
        protectedViolations: [],
        diffRiskUnits: 1,
        modelCalls: 1,
        commands: 1,
        toolCalls: 0,
        elapsedMs: 10,
        stateFingerprint: "state-1",
        contentHash: "content-1",
        createdAt: "2026-08-31T00:00:00.000Z",
      };

      const refs = await persistFaultEvidence([snapshot], store);

      expect(refs).toHaveLength(1);
      expect(refs[0]).toMatch(/^[0-9a-f]{64}$/u);
      await expect(store.verify(refs[0]!)).resolves.toEqual({
        exists: true,
        hashMatches: true,
        byteLengthMatches: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
