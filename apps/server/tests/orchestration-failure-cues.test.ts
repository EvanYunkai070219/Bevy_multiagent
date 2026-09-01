import { describe, expect, it } from "vitest";
import { FailureCueService } from "../src/orchestration/evolution/failure-cues.js";
import type { FailureCue } from "../src/orchestration/evolution/evolution-types.js";
import type { HistoricalAuditDecision } from "../src/orchestration/evolution/historical-evidence-auditor.js";
import type { MutationCandidate, VerificationResult } from "../src/types.js";

const hash = (character: string) => character.repeat(64);

function candidate(overrides: Partial<MutationCandidate> = {}): MutationCandidate {
  return {
    id: "tournament-context_patch",
    tournamentId: "tournament",
    checkpointId: "checkpoint",
    delta: {
      family: "context_patch",
      targetSubtaskId: "backend",
      diagnosisId: "diagnosis",
      addedEvidenceRefs: [],
      failureCueIds: [],
      instructionPatch: "Inspect contract evidence.",
      toolRoute: ["read_file"],
      expectedEffect: "repair the contract",
      contentHash: hash("6"),
    },
    state: "rejected",
    attemptId: "attempt",
    verificationIds: ["verification"],
    modelCalls: 1,
    reservedTokens: 10,
    actualInputTokens: 4,
    actualOutputTokens: 3,
    elapsedMs: 12,
    terminalReason: null,
    historicalMatchRecordId: null,
    historicalVerificationId: null,
    evolutionFingerprints: {
      schemaVersion: 2,
      complete: true,
      repositoryBaseHash: hash("1"),
      contractHash: hash("2"),
      authorityManifestHash: hash("3"),
      runtimeCapabilityHash: hash("4"),
      faultEvidenceHash: hash("5"),
      mutationContentHash: hash("6"),
    },
    ...overrides,
  };
}

function verification(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    id: "verification",
    subjectType: "candidate",
    subjectId: "tournament-context_patch",
    stage: "candidate",
    authorityManifestHash: hash("3"),
    gates: [{
      gateId: "hidden/protected-contract-gate",
      tier: "contract",
      passed: false,
      evidenceRef: hash("e"),
      failureFingerprint: hash("f"),
    }],
    failureKind: "deterministic_gate_failure",
    mandatoryPassed: false,
    hardProgress: 1,
    regressionCount: 2,
    modelCalls: 0,
    reservedTokens: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    elapsedMs: 2,
    verifiedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function audit(recordId: string, trustedForCue = true): HistoricalAuditDecision {
  return {
    recordId,
    trustedForPruning: trustedForCue,
    trustedForCue,
    quarantine: null,
  };
}

function makeCue(overrides: Partial<FailureCue> = {}): FailureCue {
  const service = new FailureCueService();
  const cue = service.create({
    projectId: "project-1",
    sourceFingerprint: hash("a"),
    contractKey: "backend-contract",
    candidate: candidate(),
    candidateNodeId: hash("b"),
    verification: verification(),
    exactRepeatKey: hash("9"),
  });
  if (cue === null) throw new Error("fixture cue was not created");
  return { ...cue, ...overrides };
}

describe("FailureCueService", () => {
  it("creates a bounded deterministic cue only from a trusted deterministic failed gate", () => {
    const cue = makeCue();
    expect(cue.summary).toBe(
      `Prior context_patch trial failed contract gate ${hash("f").slice(0, 12)}; regressions=2; evidence=${hash("e").slice(0, 12)}.`,
    );
    expect(cue.summary.length).toBeLessThanOrEqual(512);
    expect(cue.summary).not.toContain("hidden/protected-contract-gate");
    expect(cue.evidenceRefs).toEqual([hash("e")]);
    expect(cue.differingFingerprintFields).toEqual([]);
  });

  it.each([
    verification({ failureKind: "authority_failure" }),
    verification({ mandatoryPassed: true, failureKind: null }),
    verification({ gates: [{ ...verification().gates[0]!, passed: true, failureFingerprint: null }] }),
    verification({ subjectId: "other-candidate" }),
  ])("does not create a cue from infrastructure, success, absent failure, or wrong-subject evidence", (result) => {
    expect(new FailureCueService().create({
      projectId: "project-1",
      sourceFingerprint: hash("a"),
      contractKey: "backend-contract",
      candidate: candidate(),
      candidateNodeId: hash("b"),
      verification: result,
      exactRepeatKey: hash("9"),
    })).toBeNull();
  });

  it("selects at most three matching trusted cues, preferring equal contract hash then newest ID", () => {
    const equalOld = makeCue({ id: hash("1"), sourceCandidateNodeId: hash("1"), createdAt: "2026-08-29T00:00:01.000Z" });
    const equalNew = makeCue({ id: hash("2"), sourceCandidateNodeId: hash("2"), createdAt: "2026-08-29T00:00:02.000Z" });
    const equalNewest = makeCue({ id: hash("3"), sourceCandidateNodeId: hash("3"), createdAt: "2026-08-29T00:00:03.000Z" });
    const changedContract = makeCue({
      id: hash("4"),
      sourceCandidateNodeId: hash("4"),
      contractHash: hash("c"),
      fingerprints: { ...makeCue().fingerprints, contractHash: hash("c") },
      createdAt: "2026-08-29T00:00:04.000Z",
    });
    const wrongFamily = makeCue({ id: hash("5"), sourceCandidateNodeId: hash("5"), candidateFamily: "strategy_patch" });
    const quarantined = makeCue({ id: hash("6"), sourceCandidateNodeId: hash("6") });
    const service = new FailureCueService({
      cues: [equalOld, equalNew, equalNewest, changedContract, wrongFamily, quarantined],
      audits: [
        audit(equalOld.sourceCandidateNodeId),
        audit(equalNew.sourceCandidateNodeId),
        audit(equalNewest.sourceCandidateNodeId),
        audit(changedContract.sourceCandidateNodeId),
        audit(wrongFamily.sourceCandidateNodeId),
        audit(quarantined.sourceCandidateNodeId, false),
      ],
    });
    const selected = service.select({
      projectId: "project-1",
      sourceFingerprint: hash("a"),
      contractKey: "backend-contract",
      contractHash: hash("2"),
      candidateFamily: "context_patch",
      gateTier: "contract",
      failureFingerprint: hash("f"),
      excludeExactRepeatKey: hash("0"),
      limit: 99,
    });
    expect(selected.map((cue) => cue.id)).toEqual([hash("3"), hash("2"), hash("1")]);
    expect(selected).toHaveLength(3);
  });

  it("keeps a changed-contract cue advisory and records the differing field", () => {
    const changed = makeCue({
      contractHash: hash("c"),
      fingerprints: { ...makeCue().fingerprints, contractHash: hash("c") },
    });
    const service = new FailureCueService({
      cues: [changed],
      audits: [audit(changed.sourceCandidateNodeId)],
    });
    const [selected] = service.select({
      projectId: changed.projectId,
      sourceFingerprint: changed.sourceFingerprint,
      contractKey: changed.contractKey,
      contractHash: hash("2"),
      candidateFamily: changed.candidateFamily,
      gateTier: changed.gateTier,
      failureFingerprint: changed.failureFingerprint,
      excludeExactRepeatKey: hash("0"),
      limit: 1,
    });
    expect(selected?.differingFingerprintFields).toEqual(["contractHash"]);
    const rendered = service.render(selected ? [selected] : []);
    expect(rendered).toContain("advisory only");
    expect(rendered).toContain("do not alter the current contract or gates");
    expect(rendered).toContain("differs: contractHash");
  });

  it("never selects cues from another Project or from cancelled/positive audit decisions", () => {
    const foreign = makeCue({ projectId: "project-2" });
    const cancelled = makeCue({ id: hash("7"), sourceCandidateNodeId: hash("7") });
    const positive = makeCue({ id: hash("8"), sourceCandidateNodeId: hash("8") });
    const service = new FailureCueService({
      cues: [foreign, cancelled, positive],
      audits: [
        audit(foreign.sourceCandidateNodeId),
        audit(cancelled.sourceCandidateNodeId, false),
        audit(positive.sourceCandidateNodeId, false),
      ],
    });

    expect(service.select({
      projectId: "project-1",
      sourceFingerprint: foreign.sourceFingerprint,
      contractKey: foreign.contractKey,
      contractHash: foreign.contractHash,
      candidateFamily: foreign.candidateFamily,
      gateTier: foreign.gateTier,
      failureFingerprint: foreign.failureFingerprint,
      excludeExactRepeatKey: hash("0"),
      limit: 3,
      fingerprints: foreign.fingerprints,
    })).toEqual([]);
  });

  it("excludes the current exact repeat and legacy/incomplete identities", () => {
    const exact = makeCue();
    const incomplete = makeCue({ fingerprints: { ...makeCue().fingerprints, complete: false } });
    const service = new FailureCueService({
      cues: [exact, incomplete],
      audits: [audit(exact.sourceCandidateNodeId), audit(incomplete.sourceCandidateNodeId)],
    });
    expect(service.select({
      projectId: exact.projectId,
      sourceFingerprint: exact.sourceFingerprint,
      contractKey: exact.contractKey,
      contractHash: exact.contractHash,
      candidateFamily: exact.candidateFamily,
      gateTier: exact.gateTier,
      failureFingerprint: exact.failureFingerprint,
      excludeExactRepeatKey: exact.exactRepeatKey,
      limit: 3,
    })).toEqual([]);
  });

  it.each([
    { progress: 2, regressions: 2, outcome: "helped" },
    { progress: 1, regressions: 2, outcome: "neutral" },
    { progress: 0, regressions: 2, outcome: "regressed" },
    { progress: 2, regressions: 3, outcome: "regressed" },
  ] as const)("records passive $outcome transfer without executing anything", ({ progress, regressions, outcome }) => {
    const service = new FailureCueService();
    const [result] = service.observeTransfer({
      projectId: "project-1",
      cueIds: [hash("1")],
      control: verification({ hardProgress: 1, regressionCount: 2 }),
      candidate: verification({
        id: "candidate-result",
        hardProgress: progress,
        regressionCount: regressions,
      }),
      targetCandidateNodeId: hash("2"),
      differingFingerprintFields: ["contractHash"],
    });
    expect(result?.outcome).toBe(outcome);
    expect(result?.differingFingerprintFields).toEqual(["contractHash"]);
  });

  it("records inconclusive transfer for ambiguous authority evidence", () => {
    const [result] = new FailureCueService().observeTransfer({
      projectId: "project-1",
      cueIds: [hash("1")],
      control: verification(),
      candidate: verification({ failureKind: "authority_failure" }),
      targetCandidateNodeId: hash("2"),
      differingFingerprintFields: [],
    });
    expect(result?.outcome).toBe("inconclusive");
  });

  it("clears stale trusted cues when a refresh becomes unavailable", () => {
    const cue = makeCue();
    const service = new FailureCueService({
      cues: [cue],
      audits: [audit(cue.sourceCandidateNodeId)],
    });
    const query = {
      projectId: cue.projectId,
      sourceFingerprint: cue.sourceFingerprint,
      contractKey: cue.contractKey,
      contractHash: cue.contractHash,
      candidateFamily: cue.candidateFamily,
      gateTier: cue.gateTier,
      failureFingerprint: cue.failureFingerprint,
      excludeExactRepeatKey: hash("0"),
      limit: 3,
    };
    expect(service.select(query)).toHaveLength(1);

    service.markUnavailable();

    expect(service.health()).toBe("unavailable");
    expect(service.select(query)).toEqual([]);
  });
});
