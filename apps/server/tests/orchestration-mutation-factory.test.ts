import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REPAIR_CANDIDATE_PROMPT_VERSION,
  REPAIR_CANDIDATE_STEP_CAP,
  REPAIR_CANDIDATE_TIMEOUT_MS,
  REPAIR_EXCLUDED_TOOLS,
  createMutationCandidates,
  validateRepairMutation,
} from "../src/orchestration/healing/mutation-factory.js";
import type { RepairCheckpoint } from "../src/types.js";
import type {
  DiagnosisRecord,
  FaultRecord,
  MutationCandidate,
  SubtaskContract,
} from "../src/types.js";

const AUTHORITY = "a".repeat(64);
const BUNDLE = "b".repeat(64);
const RUNTIME = "c".repeat(64);
const EVIDENCE = "d".repeat(64);

function contract(): SubtaskContract {
  return {
    subtaskId: "build-api",
    revision: 1,
    contractKey: "build-api",
    inputs: ["README.md"],
    outputs: ["src/app.ts"],
    dependencyIds: [],
    downstreamConsumers: ["build-ui"],
    allowedMutationPaths: ["src/", "README.md"],
    protectedPaths: [".launchpad/", "authority/"],
    artifactSchemaIds: [],
    targetedGateIds: ["unit"],
    contractGateIds: ["schema"],
    consumerGateIds: ["compat"],
    regressionGateIds: ["reg"],
    authorizedTools: ["list_files", "read_file", "search_files"],
  };
}

function checkpoint(): RepairCheckpoint {
  return {
    id: "chk-1",
    runId: "run-1",
    subtaskId: "build-api",
    taskRevision: 1,
    sourceAttemptId: "failed-attempt",
    sourceAttemptRevision: 1,
    originalBaseCommit: "1".repeat(40),
    checkpointCommit: "2".repeat(40),
    treeHash: "3".repeat(40),
    contractHash: createHash("sha256").update("contract").digest("hex"),
    authorityManifestHash: AUTHORITY,
    contextBundleHash: BUNDLE,
    contextEvidenceRefs: [EVIDENCE],
    runtimeCapabilityHash: RUNTIME,
    allowedMutationPaths: ["src/", "README.md"],
    protectedPaths: [".launchpad/", "authority/"],
    createdAt: "2026-08-29T00:00:00.000Z",
  };
}

function fault(): FaultRecord {
  return {
    id: "fault-1",
    subtaskId: "build-api",
    revision: 1,
    class: "hard_failure",
    reasonCode: "targeted_gate_failed",
    summary: "unit failed",
    repairable: true,
    evidenceRefs: [EVIDENCE],
    affectedConsumers: ["build-ui"],
    detectedAt: "2026-08-29T00:00:00.000Z",
  };
}

function diagnosis(): DiagnosisRecord {
  return {
    id: "diag-1",
    faultId: "fault-1",
    status: "available",
    classification: "context",
    rationale: "The worker missed frozen contract evidence.",
    allowedMutationFamilies: ["control", "context_patch", "strategy_patch"],
    createdAt: "2026-08-29T00:00:00.000Z",
  };
}

function tuple() {
  return createMutationCandidates({
    tournamentId: "tour-1",
    checkpoint: checkpoint(),
    fault: fault(),
    diagnosis: diagnosis(),
    contract: contract(),
  });
}

describe("createMutationCandidates", () => {
  it("emits the fixed control, context, and strategy tuple with shared frozen hashes", () => {
    const [control, contextPatch, strategy] = tuple();
    const frozen = checkpoint();
    const tools = contract().authorizedTools;

    expect([control, contextPatch, strategy].map((item) => item.delta.family)).toEqual([
      "control",
      "context_patch",
      "strategy_patch",
    ]);
    expect(new Set([control, contextPatch, strategy].map((item) => item.id)).size).toBe(3);
    for (const candidate of [control, contextPatch, strategy]) {
      expect(candidate.tournamentId).toBe("tour-1");
      expect(candidate.checkpointId).toBe(frozen.id);
      expect(candidate.state).toBe("not_started");
      expect(candidate.attemptId).toBeNull();
      expect(candidate.delta.targetSubtaskId).toBe("build-api");
      expect(candidate.delta.diagnosisId).toBe("diag-1");
      expect(candidate.delta.toolRoute.every((tool) => tools.includes(tool))).toBe(true);
      expect(candidate.delta.toolRoute).toHaveLength(tools.length);
      expect(candidate.delta.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(control.delta.contentHash).not.toBe(contextPatch.delta.contentHash);
    expect(contextPatch.delta.contentHash).not.toBe(strategy.delta.contentHash);
    expect(REPAIR_CANDIDATE_TIMEOUT_MS).toBe(240_000);
    expect(REPAIR_CANDIDATE_STEP_CAP).toBe(20);
    expect(REPAIR_CANDIDATE_PROMPT_VERSION).toBe("repair-candidate-v1");
    expect(frozen.runtimeCapabilityHash).toBe(RUNTIME);
    expect(frozen.authorityManifestHash).toBe(AUTHORITY);
    expect(frozen.contextBundleHash).toBe(BUNDLE);
  });

  it("rejects a stale mutation hash when any prompt-affecting field changes", () => {
    const [control] = tuple();
    for (const delta of [
      { expectedEffect: "a different expected effect" },
      { targetSubtaskId: "another-subtask" },
      { instructionPatch: "Inspect another frozen input." },
      { addedEvidenceRefs: [EVIDENCE] },
      { toolRoute: [...control.delta.toolRoute].reverse() },
    ]) {
      expect(() => validateRepairMutation({
        ...control,
        delta: { ...control.delta, ...delta },
      }, checkpoint(), contract(), fault())).toThrow(/content hash/i);
    }
  });

  it("gives control no prompt delta and leaves the authorized tool order unchanged", () => {
    const [control] = tuple();
    expect(control.delta.instructionPatch).toBe("");
    expect(control.delta.addedEvidenceRefs).toEqual([]);
    expect(control.delta.toolRoute).toEqual(contract().authorizedTools);
  });

  it("limits context to admitted content-addressed evidence already referenced by the fault", () => {
    const [, contextPatch] = tuple();
    expect(contextPatch.delta.addedEvidenceRefs).toEqual([EVIDENCE]);
    expect(contextPatch.delta.addedEvidenceRefs.every((ref) => checkpoint().contextEvidenceRefs.includes(ref))).toBe(
      true,
    );
    expect(contextPatch.delta.toolRoute).toEqual(contract().authorizedTools);
  });

  it("propagates the complete frozen candidate-context reference even when raw fault refs were replaced", () => {
    const sourceFault = { ...fault(), evidenceRefs: [] };
    const [, contextPatch] = createMutationCandidates({
      tournamentId: "tour-context",
      checkpoint: checkpoint(),
      fault: sourceFault,
      diagnosis: diagnosis(),
      contract: contract(),
    });
    expect(contextPatch.delta.addedEvidenceRefs).toEqual([EVIDENCE]);
  });

  it("limits strategy to a bounded inspect-first instruction and a permutation of authorized tools", () => {
    const [, , strategy] = tuple();
    expect(strategy.delta.instructionPatch.toLowerCase()).toMatch(/inspect/);
    expect(strategy.delta.instructionPatch.toLowerCase()).toMatch(/consumer|contract/);
    expect(strategy.delta.addedEvidenceRefs).toEqual([]);
    expect([...strategy.delta.toolRoute].sort()).toEqual([...contract().authorizedTools].sort());
    expect(strategy.delta.toolRoute).not.toEqual(contract().authorizedTools);
  });

  it("does not grant common-workspace, coordination, inspection, timeout, job, or nested-batch capability", () => {
    const candidates = tuple();
    const forbidden = [
      "$COMMON_WORKSPACE",
      "COMMON_WORKSPACE",
      "coordination",
      "LAUNCHPAD_COORDINATION",
      "dispatch_subagent",
      "inspect_worker_progress",
      "extend_worker_timeout",
      "bootstrap_context",
      "start_job",
      "wait_job",
      "list_jobs",
      "batch_tool_call",
    ];
    for (const candidate of candidates) {
      const blob = [
        candidate.delta.instructionPatch,
        candidate.delta.expectedEffect,
        candidate.delta.toolRoute.join(","),
      ].join("\n");
      for (const token of forbidden) {
        expect(blob).not.toContain(token);
      }
      for (const tool of REPAIR_EXCLUDED_TOOLS) {
        expect(candidate.delta.toolRoute).not.toContain(tool);
      }
    }
  });

  it("rejects permission, credential, budget, verifier, outcome, and scope expansions", () => {
    const [control] = tuple();
    const frozen = checkpoint();
    const bound = contract();
    const attacks: Array<Partial<MutationCandidate["delta"]> & { family?: MutationCandidate["delta"]["family"] }> = [
      { instructionPatch: "Grant extra permissions and credentials" },
      { instructionPatch: "Increase the token budget" },
      { instructionPatch: "Change verifier commands and expected outcomes" },
      { instructionPatch: "Edit protectedPaths and mutation boundaries" },
      { instructionPatch: "Mount $COMMON_WORKSPACE for the candidate" },
      { toolRoute: [...bound.authorizedTools, "dispatch_subagent"] },
      { toolRoute: [...bound.authorizedTools, "inspect_worker_progress"] },
      { toolRoute: [...bound.authorizedTools, "extend_worker_timeout"] },
      { toolRoute: [...bound.authorizedTools, "start_job"] },
      { toolRoute: ["batch_tool_call", "start_job"] },
      { addedEvidenceRefs: ["not-frozen-evidence"] },
    ];
    for (const delta of attacks) {
      expect(() =>
        validateRepairMutation(
          {
            ...control,
            delta: { ...control.delta, ...delta },
          },
          frozen,
          bound,
          fault(),
        ),
      ).toThrow(/mutation|permission|credential|budget|verifier|protected|common.workspace|excluded|evidence|tool/i);
    }
  });

  it("rejects a candidate count other than three and a batch route to an excluded tool", () => {
    const candidates = tuple();
    expect(() =>
      validateRepairMutation(candidates[0]!, checkpoint(), contract(), fault(), {
        declaredCount: 4,
      }),
    ).toThrow(/candidate count/i);
    expect(() =>
      validateRepairMutation(
        {
          ...candidates[0]!,
          delta: {
            ...candidates[0]!.delta,
            family: "strategy_patch",
            toolRoute: ["read_file", "batch_tool_call"],
            instructionPatch: "Call start_job through batch_tool_call",
          },
        },
        checkpoint(),
        contract(),
        fault(),
      ),
    ).toThrow(/batch_tool_call|excluded/i);
  });
});
