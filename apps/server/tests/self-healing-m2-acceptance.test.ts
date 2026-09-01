import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { detectFault } from "../src/orchestration/healing/fault-detector.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { selectWinner } from "../src/orchestration/healing/repair-tournament.js";
import { RunControl, RunTerminalError } from "../src/orchestration/run-control.js";
import { Scheduler } from "../src/orchestration/scheduler.js";
import { TrajectoryMonitor } from "../src/orchestration/workers/trajectory.js";
import { verificationDenial } from "../src/types.js";
import type { RunEventDraft } from "../src/run-events.js";
import type {
  MutationCandidate,
  VerificationResult,
  WorkerResult,
} from "../src/types.js";
import {
  runDeterministicSelfHealingDemo,
  runDeterministicSelfHealingScenario,
  formatSelfHealingDemo,
  assertSelfHealingDemoAccepted,
  type SelfHealingDemoResult,
  type SelfHealingScenario,
} from "../scripts/self-healing-demo-fixture.js";

const failureScenarios: readonly {
  name: string;
  scenario: SelfHealingScenario;
  reason: RegExp;
}[] = [
  { name: "all candidates fail", scenario: "all_candidates_fail", reason: /candidate|repair|tournament/i },
  { name: "local improvement breaks a consumer", scenario: "consumer_regression", reason: /candidate|repair|consumer/i },
  { name: "an expensive tie keeps control", scenario: "expensive_tie", reason: /conflict|candidate|repair|control/i },
  { name: "malformed diagnosis", scenario: "malformed_diagnosis", reason: /required|diagnos|repair_unavailable/i },
  { name: "checkpoint failure", scenario: "checkpoint_failure", reason: /required|checkpoint/i },
  { name: "authority compromise", scenario: "authority_compromise", reason: /authority|verification|integrity/i },
  { name: "promotion conflict", scenario: "promotion_conflict", reason: /conflict|import|canonical/i },
  { name: "post-integration gate rollback", scenario: "post_gate_rollback", reason: /post|verification|gate/i },
] as const;

let success!: SelfHealingDemoResult;
let normal!: SelfHealingDemoResult;
let evaluatorUnavailable!: SelfHealingDemoResult;
const failed = new Map<SelfHealingScenario, SelfHealingDemoResult>();

beforeAll(async () => {
  success = await runDeterministicSelfHealingDemo();
  normal = await runDeterministicSelfHealingScenario("normal_success");
  evaluatorUnavailable = await runDeterministicSelfHealingScenario(
    "evaluator_unavailable" as SelfHealingScenario,
  );
  for (const entry of failureScenarios) {
    failed.set(entry.scenario, await runDeterministicSelfHealingScenario(entry.scenario));
  }
}, 300_000);

describe("Milestone 2 complete acceptance trace", () => {
  it("preflights, overlaps three-node Git work, repairs once, verifies, integrates, resumes, and succeeds", () => {
    expect(success).toMatchObject({
      status: "completed",
      outcome: "succeeded",
      preflightBeforeModel: true,
      siblingOverlap: true,
      repeatedFailureCount: 3,
      diagnosisCalls: 1,
      tournamentCount: 1,
      winnerFamily: "context_patch",
      frontendStarts: 1,
      backendStarts: 1,
      integrationStarts: 1,
      repairStarts: 3,
      mandatoryGatesPassed: true,
      userBranchIntegrity: true,
      baselineAdvancedToFinal: true,
      cleanupDecision: "removed",
    });
    expect(success.nodeStates).toEqual({
      backend: "completed",
      frontend: "completed",
      integration: "completed",
    });
    expect(success.candidateCounts).toEqual({
      declared: 3,
      admitted: 3,
      executed: 3,
      verified: 1,
      promoted: 1,
    });
    expect(new Set(success.candidateCheckpointHashes)).toHaveLength(1);
    expect(success.sourceAfter).toEqual(success.sourceBefore);
  });

  it("runs a normal three-node success without diagnosis or healing", () => {
    expect(normal).toMatchObject({
      status: "completed",
      outcome: "succeeded",
      diagnosisCalls: 0,
      tournamentCount: 0,
      repairStarts: 0,
      frontendStarts: 1,
      backendStarts: 1,
      integrationStarts: 1,
      userBranchIntegrity: true,
      baselineAdvancedToFinal: true,
      cleanupDecision: "removed",
    });
  });

  it("keeps a completed run unknown and the baseline fixed when trusted evaluation is unavailable", () => {
    expect(evaluatorUnavailable).toMatchObject({
      status: "completed",
      outcome: "unknown",
      mandatoryGatesPassed: true,
      baselineAdvancedToFinal: false,
      cleanupDecision: "removed",
    });
  });

  it("prints the computed acceptance fields instead of implying success from process completion", () => {
    expect(formatSelfHealingDemo(success)).toContain("outcome=succeeded");
    expect(formatSelfHealingDemo(success)).toContain("baseline_advanced_to_final=true");
    expect(formatSelfHealingDemo(success)).toContain("mandatory_gates_passed=true");
    expect(formatSelfHealingDemo(success)).toContain("cleanup=removed");
  });

  it("rejects a zero exit status when any computed acceptance invariant is false", () => {
    expect(() => assertSelfHealingDemoAccepted(success)).not.toThrow();
    expect(() => assertSelfHealingDemoAccepted({ ...success, outcome: "unknown" })).toThrow(/outcome/i);
    expect(() => assertSelfHealingDemoAccepted({ ...success, baselineAdvancedToFinal: false })).toThrow(/baseline/i);
    expect(() => assertSelfHealingDemoAccepted({ ...success, mandatoryGatesPassed: false })).toThrow(/gate/i);
    expect(() => assertSelfHealingDemoAccepted({ ...success, cleanupDecision: "preserved" })).toThrow(/cleanup/i);
  });
});

describe("Milestone 2 fail-closed acceptance matrix", () => {
  it.each(failureScenarios)("fails closed when $name", ({ scenario, reason }) => {
    const result = failed.get(scenario)!;
    expect(result.status).toMatch(/failed|cancelled/);
    expect(result.outcome).not.toBe("succeeded");
    expect(result.unsafePromotion).toBe(false);
    expect(result.userBranchIntegrity).toBe(true);
    expect(result.baselineAdvancedToFinal).toBe(false);
    expect(result.failureReason).toMatch(reason);
  });

  it("classifies first/second 429 truth as infrastructure and never a repairable task fault", () => {
    const fault = detectFault({
      result: failedWorker("provider_rate_limited"),
      verification: null,
      trajectory: null,
      ephemeral: false,
    });
    expect(fault).toMatchObject({ class: "provider_rate_limited", repairable: false });
  });

  it("stops repeated signatures and silent checkpoints exactly at three", () => {
    const monitor = new TrajectoryMonitor({
      attemptId: "acceptance-repeated",
      maxSteps: 20,
      repeatedSignatureLimit: 3,
      checkpointMs: 0,
    });
    const event = commandEvent("npm test", "FAIL protected contract");
    expect(monitor.observe(event).action).toBe("continue");
    expect(monitor.observe(event).action).toBe("warn");
    expect(monitor.observe(event)).toEqual({ action: "stop", reason: "no_evidence_progress" });
    expect(monitor.snapshots()).toHaveLength(3);
  });

  it("latches a simultaneous budget-fuse race and denies every later admission", async () => {
    const control = new RunControl({
      ...defaultExecutionPolicy,
      emergencyModelCallFuse: 1,
      rootTimeoutMs: 10_000,
    });
    const results = await Promise.allSettled([
      Promise.resolve().then(() => control.budget.reserve("a", 1, 1)),
      Promise.resolve().then(() => control.budget.reserve("b", 1, 1)),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(() => control.assertActive()).toThrow(RunTerminalError);
    control.close();
  });

  it("root-races leader, solo, and async-dispatch waits that never settle", async () => {
    for (const scope of ["leader", "solo", "async-dispatch"]) {
      const control = new RunControl({ ...defaultExecutionPolicy, rootTimeoutMs: 10 });
      let cancelled = 0;
      await expect(control.race(new Promise<never>(() => undefined), () => { cancelled += 1; }))
        .rejects.toMatchObject({ reason: "root_deadline" });
      expect(cancelled, scope).toBe(1);
      control.close();
    }
  });

  it("blocks a consumer while its producer remains repairing", async () => {
    const started: string[] = [];
    const results = await new Scheduler().execute(
      [
        subtask("backend", []),
        subtask("integration", ["backend"]),
      ],
      { ...defaultExecutionPolicy, maxParallel: 2 },
      0,
      async (task) => {
        started.push(task.id);
        return failedWorker("repairing", task.id);
      },
      1,
      undefined,
      async (wave) => wave.map((result) => result.subtaskId === "backend"
        ? { ...result, status: "failed" as const, error: "producer repairing" }
        : result),
    );
    expect(started).toEqual(["backend"]);
    expect(results.find((item) => item.subtaskId === "integration")?.status).toBe("blocked");
  });

  it("rejects absent trusted authority and agent-authored-test self-authorization", () => {
    expect(verificationDenial(null, "post_integration", "winner")).toBe(
      "post_integration_verification_malformed",
    );
    expect(verificationDenial({
      id: "agent-test-only",
      subjectType: "candidate",
      subjectId: "winner",
      stage: "post_integration",
      authorityManifestHash: "",
      gates: [],
      failureKind: "deterministic_gate_failure",
      mandatoryPassed: false,
      hardProgress: 99,
      regressionCount: 0,
      modelCalls: 0,
      reservedTokens: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      elapsedMs: 0,
      verifiedAt: new Date(0).toISOString(),
    }, "post_integration", "winner")).toBe("post_integration_verification_failed");
  });

  it("requires exactly three candidates, one tournament, finite horizons, and authority configuration", () => {
    expect(() => loadConfig(healingEnv({ ORCHESTRATION_MAX_REPAIR_BRANCHES: "4" }))).toThrow();
    expect(() => loadConfig(healingEnv({ ORCHESTRATION_MAX_REPAIR_TOURNAMENTS: "2" }))).toThrow();
    expect(() => loadConfig(healingEnv({ ORCHESTRATION_WORKER_TIMEOUT_MS: "NaN" }))).toThrow();
    expect(() => loadConfig(healingEnv({ ORCHESTRATION_VERIFICATION_PROFILE: "" }))).toThrow();
  });
});

describe("named mutation-sensitive acceptance assertions", () => {
  const mutations: readonly [string, () => void][] = [
    ["omit failure-path async-dispatch cancellation/drain", () => expect(failed.get("all_candidates_fail")?.liveDispatchDrained).toBe(true)],
    ["accept a late worker completion after terminal revision", () => expect(failed.get("all_candidates_fail")?.nodeStates.backend).toBe("failed")],
    ["replace the last valid Git fingerprint with fallback hash", () => expect(success.lastValidGitFingerprintPreserved).toBe(true)],
    ["diagnose provider failure", () => expect(success.providerFailureNonRepairable).toBe(true)],
    ["permit absent trusted authority", () => expect(failed.get("authority_compromise")?.unsafePromotion).toBe(false)],
    ["remove one manifest asset hash", () => expect(success.authorityAssetsComplete).toBe(true)],
    ["remove expected owner/revision CAS", () => expect(failed.get("promotion_conflict")?.baselineAdvancedToFinal).toBe(false)],
    ["allow a fourth candidate or second tournament", () => expect(success.candidateCounts.declared).toBe(3)],
    ["rank a tie as mutant", () => expect(failed.get("expensive_tie")?.winnerFamily).not.toBe("context_patch")],
    ["apply winner outside integration queue", () => expect(success.integrationQueued).toBe(true)],
    ["complete before the post-integration gate", () => expect(success.postIntegrationBeforeCompletion).toBe(true)],
    ["omit rollback clean/reset", () => expect(failed.get("post_gate_rollback")?.canonicalWorkspaceClean).toBe(true)],
    ["start consumer while producer is repairing", () => expect(success.consumerStartedAfterPromotion).toBe(true)],
    ["synthesize with a required failed/blocked node", () => expect(failed.get("all_candidates_fail")?.synthesizerCalls).toBe(0)],
  ];

  it.each(mutations)("kills mutation: %s", (_name, assertion) => assertion());

  it("keeps control on an independently constructed ambiguous tie", () => {
    const candidates = [candidate("control", "control"), candidate("context", "context_patch")];
    const verifications = candidates.map((item) => verification(item.id, true, 4));
    expect(selectWinner(candidates[0]!, candidates, verifications).id).toBe("control");
  });
});

const boundedRealProviderConfig = process.env.LAUNCHPAD_REAL_HEALING_SMOKE === "1"
  && Boolean(process.env.ARK_API_KEY)
  && Boolean(process.env.ARK_MODEL)
  && Boolean(process.env.LAUNCHPAD_REAL_HEALING_SMOKE_CONFIG);

describe("bounded real-provider acceptance", () => {
  it.skipIf(!boundedRealProviderConfig)("real provider smoke", async () => {
    const { runBoundedRealProviderSmoke } = await import("../scripts/self-healing-demo-fixture.js");
    const result = await runBoundedRealProviderSmoke();
    expect(result.unsafePromotion).toBe(false);
    expect(result.emergencyFuseViolation).toBe(false);
    expect(JSON.stringify(result)).not.toContain(process.env.ARK_API_KEY);
  }, 300_000);
});

function failedWorker(error: string, subtaskId = "backend"): WorkerResult {
  return {
    subtaskId,
    workerId: null,
    workerRunId: null,
    iteration: 1,
    attempt: 1,
    status: "failed",
    output: "",
    error,
    usage: null,
    durationMs: 1,
    artifacts: [],
  };
}

function commandEvent(command: string, output: string): RunEventDraft {
  return {
    spanId: "acceptance-command",
    parentSpanId: "run",
    kind: "command",
    name: "bash",
    status: "error",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(0).toISOString(),
    durationMs: 1,
    input: { command },
    output: { exitCode: 1, text: output },
    error: { message: output, code: "1" },
    attributes: {},
    usage: null,
  };
}

function subtask(id: string, dependsOn: string[]) {
  return {
    id,
    title: id,
    role: "engineer",
    prompt: "TASK:" + id,
    objective: id,
    successCriteria: [id],
    expectedOutput: "commit",
    dependsOn,
  };
}

function healingEnv(overrides: Record<string, string>) {
  return {
    NODE_ENV: "test",
    APP_DATA_DIR: "/tmp/launchpad-m2-config",
    AGENT_WORKSPACE_ROOT: "/tmp/launchpad-m2-agents",
    CODEX_HOME: "/tmp/launchpad-m2-codex",
    ARK_API_KEY: "bounded-fixture-key",
    ARK_MODEL: "bounded-fixture-model",
    ORCHESTRATION_HEALING_ENABLED: "true",
    ORCHESTRATION_VERIFICATION_PROFILE: "/tmp/launchpad-m2-authority/profile.json",
    ...overrides,
  };
}

function candidate(id: string, family: MutationCandidate["delta"]["family"]): MutationCandidate {
  return {
    id,
    tournamentId: "tournament",
    checkpointId: "checkpoint",
    delta: {
      family,
      targetSubtaskId: "backend",
      diagnosisId: "diagnosis",
      addedEvidenceRefs: [],
      instructionPatch: "",
      toolRoute: [],
      expectedEffect: "",
      contentHash: id,
    },
    state: "verified",
    attemptId: id + "-attempt",
    verificationIds: [id + "-verification"],
    modelCalls: 1,
    reservedTokens: 10,
    actualInputTokens: 5,
    actualOutputTokens: 5,
    elapsedMs: 1,
    terminalReason: null,
  };
}

function verification(subjectId: string, mandatoryPassed: boolean, hardProgress: number): VerificationResult {
  return {
    id: subjectId + "-verification",
    subjectType: "candidate",
    subjectId,
    stage: "finalist",
    authorityManifestHash: "authority",
    gates: [],
    failureKind: mandatoryPassed ? null : "deterministic_gate_failure",
    mandatoryPassed,
    hardProgress,
    regressionCount: 0,
    modelCalls: 1,
    reservedTokens: 10,
    actualInputTokens: 5,
    actualOutputTokens: 5,
    elapsedMs: 1,
    verifiedAt: new Date(0).toISOString(),
  };
}
