import { describe, expect, it } from "vitest";
import {
  buildCandidateContextManifest,
  candidateContextHash,
  serializeCandidateContextManifest,
} from "../src/orchestration/healing/candidate-context-manifest.js";
import type {
  DiagnosisRecord,
  EvidenceSnapshot,
  FaultRecord,
} from "../src/types.js";
import type { CandidateContextManifestV1 } from "../src/orchestration/evolution/evolution-types.js";

function fault(): FaultRecord {
  return {
    id: "fault-volatile-1",
    subtaskId: "backend",
    revision: 7,
    class: "hard_failure",
    reasonCode: "targeted_gate_failed",
    summary: "raw summary must remain audit-only",
    repairable: true,
    evidenceRefs: ["audit-ref-1"],
    affectedConsumers: ["integration"],
    detectedAt: "2026-08-29T00:00:00.000Z",
  };
}

function snapshot(): EvidenceSnapshot {
  return {
    id: "snapshot-volatile-1",
    attemptId: "attempt-volatile-1",
    sequence: 3,
    source: "verification",
    mandatoryFailures: 2,
    consumerPassed: false,
    regressionCount: 1,
    failureFingerprints: ["b".repeat(64), "a".repeat(64), "a".repeat(64)],
    changedPaths: ["src/z.ts", "src/a.ts", "src/a.ts"],
    protectedViolations: ["authority/z.ts", "authority/a.ts"],
    diffRiskUnits: 8,
    modelCalls: 9,
    commands: 10,
    toolCalls: 11,
    elapsedMs: 12_000,
    stateFingerprint: "c".repeat(64),
    contentHash: "d".repeat(64),
    createdAt: "2026-08-29T00:00:01.000Z",
  };
}

function diagnosis(): DiagnosisRecord {
  return {
    id: "diagnosis-volatile-1",
    faultId: "fault-volatile-1",
    status: "available",
    classification: "  CONTEXT\npatch  ",
    rationale: "  Missing\tproducer   contract\n evidence.  ",
    allowedMutationFamilies: ["strategy_patch", "control", "context_patch"],
    createdAt: "2026-08-29T00:00:02.000Z",
  };
}

function manifest(overrides: {
  fault?: FaultRecord;
  snapshots?: EvidenceSnapshot[];
  diagnosis?: DiagnosisRecord;
} = {}) {
  return buildCandidateContextManifest({
    fault: overrides.fault ?? fault(),
    snapshots: overrides.snapshots ?? [snapshot()],
    diagnosis: overrides.diagnosis ?? diagnosis(),
  });
}

describe("CandidateContextManifestV1", () => {
  it("is byte-identical across volatile IDs, timestamps, sequences, durations, and counters", () => {
    const left = manifest();
    const rightSnapshot = {
      ...snapshot(),
      id: "snapshot-volatile-999",
      attemptId: "attempt-volatile-999",
      sequence: 999,
      diffRiskUnits: 999,
      modelCalls: 999,
      commands: 999,
      toolCalls: 999,
      elapsedMs: 999_999,
      contentHash: "f".repeat(64),
      createdAt: "2030-01-01T00:00:00.000Z",
    };
    const right = manifest({
      fault: {
        ...fault(),
        id: "fault-volatile-999",
        subtaskId: "different-volatile-subtask-id",
        revision: 999,
        summary: "different raw audit summary",
        evidenceRefs: ["different-audit-ref"],
        affectedConsumers: ["different-consumer-id"],
        detectedAt: "2030-01-01T00:00:00.000Z",
      },
      snapshots: [rightSnapshot],
      diagnosis: {
        ...diagnosis(),
        id: "diagnosis-volatile-999",
        faultId: "fault-volatile-999",
        createdAt: "2030-01-01T00:00:01.000Z",
      },
    });

    expect(serializeCandidateContextManifest(right)).toBe(
      serializeCandidateContextManifest(left),
    );
    expect(candidateContextHash(right)).toBe(candidateContextHash(left));
  });

  it("changes for every candidate-visible failure, outcome, diagnosis, and mutation-family field", () => {
    const baseline = candidateContextHash(manifest());
    const originalSnapshot = snapshot();
    const changes = [
      manifest({ fault: { ...fault(), class: "stall" } }),
      manifest({ fault: { ...fault(), reasonCode: "consumer_contract_failed" } }),
      manifest({ snapshots: [{ ...originalSnapshot, mandatoryFailures: 3 }] }),
      manifest({ snapshots: [{ ...originalSnapshot, consumerPassed: true }] }),
      manifest({ snapshots: [{ ...originalSnapshot, regressionCount: 2 }] }),
      manifest({ snapshots: [{ ...originalSnapshot, failureFingerprints: ["e".repeat(64)] }] }),
      manifest({ snapshots: [{ ...originalSnapshot, changedPaths: ["src/other.ts"] }] }),
      manifest({ snapshots: [{ ...originalSnapshot, protectedViolations: ["authority/other.ts"] }] }),
      manifest({ snapshots: [{ ...originalSnapshot, stateFingerprint: "f".repeat(64) }] }),
      manifest({ diagnosis: { ...diagnosis(), status: "unavailable" } }),
      manifest({ diagnosis: { ...diagnosis(), classification: "reasoning" } }),
      manifest({ diagnosis: { ...diagnosis(), rationale: "A distinct normalized rationale." } }),
      manifest({ diagnosis: { ...diagnosis(), allowedMutationFamilies: ["control"] } }),
    ];
    for (const changed of changes) {
      expect(candidateContextHash(changed)).not.toBe(baseline);
    }
  });

  it("normalizes Unicode and whitespace, bounds diagnosis text, and canonicalizes set-like arrays", () => {
    const normalized = manifest();
    expect(normalized.diagnosis.classification).toBe("CONTEXT patch");
    expect(normalized.diagnosis.rationale).toBe("Missing producer contract evidence.");
    expect(normalized.diagnosis.allowedMutationFamilies).toEqual([
      "context_patch",
      "control",
      "strategy_patch",
    ]);
    expect(normalized.snapshots[0]?.failureFingerprints).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
    expect(normalized.snapshots[0]?.changedPaths).toEqual(["src/a.ts", "src/z.ts"]);
    expect(normalized.snapshots[0]?.protectedViolations).toEqual([
      "authority/a.ts",
      "authority/z.ts",
    ]);

    const unicodeLeft = manifest({
      diagnosis: {
        ...diagnosis(),
        classification: "ＣＯＮＴＥＸＴ　patch",
        rationale: "Missing　producer contract evidence.",
      },
    });
    expect(serializeCandidateContextManifest(unicodeLeft)).toBe(
      serializeCandidateContextManifest(normalized),
    );
    const bounded = manifest({
      diagnosis: { ...diagnosis(), rationale: "x".repeat(600) },
    });
    expect([...bounded.diagnosis.rationale]).toHaveLength(512);
  });

  it("selects only the stable candidate manifest and keeps raw audit evidence out", () => {
    const candidateVisible = manifest();
    const encoded = serializeCandidateContextManifest(candidateVisible);
    for (const forbidden of [
      "fault-volatile-1",
      "snapshot-volatile-1",
      "attempt-volatile-1",
      "diagnosis-volatile-1",
      "2026-08-29",
      "raw summary",
      "audit-ref-1",
      "modelCalls",
      "elapsedMs",
      "contentHash",
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
  });

  it("rejects absolute and escaping candidate-visible paths", () => {
    for (const changedPath of ["/etc/passwd", "../secret", "src/../../secret", "C:\\secret"] ) {
      expect(() => manifest({
        snapshots: [{ ...snapshot(), changedPaths: [changedPath] }],
      }), changedPath).toThrow(/path/i);
    }
  });

  it("fails closed for malformed fingerprints, over-count manifests, and oversized canonical bytes", () => {
    const valid = manifest();
    expect(candidateContextHash(valid)).toMatch(/^[0-9a-f]{64}$/);

    const malformedFailure = structuredClone(valid) as unknown as Record<string, unknown>;
    const malformedFailureSnapshots = malformedFailure.snapshots as Array<Record<string, unknown>>;
    malformedFailureSnapshots[0]!.failureFingerprints = ["not-a-sha256"];

    const malformedState = structuredClone(valid) as unknown as Record<string, unknown>;
    const malformedStateSnapshots = malformedState.snapshots as Array<Record<string, unknown>>;
    malformedStateSnapshots[0]!.stateFingerprint = "not-a-sha256";

    const missingRequired = structuredClone(valid) as unknown as Record<string, unknown>;
    const missingSnapshots = missingRequired.snapshots as Array<Record<string, unknown>>;
    delete missingSnapshots[0]!.consumerPassed;

    const tooManySnapshots = {
      ...valid,
      snapshots: Array.from({ length: 201 }, () => valid.snapshots[0]),
    };
    const tooManyReferences = structuredClone(valid) as unknown as Record<string, unknown>;
    const referenceSnapshots = tooManyReferences.snapshots as Array<Record<string, unknown>>;
    referenceSnapshots[0]!.failureFingerprints = Array.from(
      { length: 201 },
      (_, index) => index.toString(16).padStart(64, "0"),
    );
    const oversized = {
      ...valid,
      diagnosis: {
        ...valid.diagnosis,
        rationale: "x".repeat(70_000),
      },
    };
    const nonCanonicalPath = structuredClone(valid) as unknown as Record<string, unknown>;
    const pathSnapshots = nonCanonicalPath.snapshots as Array<Record<string, unknown>>;
    pathSnapshots[0]!.changedPaths = ["src/./app.ts"];

    for (const [label, candidate] of [
      ["failure fingerprint", malformedFailure],
      ["state fingerprint", malformedState],
      ["required field", missingRequired],
      ["snapshot count", tooManySnapshots],
      ["reference count", tooManyReferences],
      ["encoded size", oversized],
      ["normalized path", nonCanonicalPath],
    ] as const) {
      expect(candidateContextHash(candidate as CandidateContextManifestV1), label).toBeNull();
    }
  });

  it("does not legitimize malformed or missing raw evidence fingerprints", () => {
    const malformedFailure = { ...snapshot(), failureFingerprints: ["not-a-sha256"] };
    const missingFailure = {
      ...snapshot(),
      failureFingerprints: [undefined],
    } as unknown as EvidenceSnapshot;
    const malformedState = { ...snapshot(), stateFingerprint: "not-a-sha256" };
    const missingState = { ...snapshot() } as unknown as Record<string, unknown>;
    delete missingState.stateFingerprint;

    for (const [label, raw] of [
      ["malformed failure", malformedFailure],
      ["missing failure", missingFailure],
      ["malformed state", malformedState],
      ["missing state", missingState as unknown as EvidenceSnapshot],
    ] as const) {
      const built = manifest({ snapshots: [raw] });
      expect(candidateContextHash(built), label).toBeNull();
    }
  });
});
