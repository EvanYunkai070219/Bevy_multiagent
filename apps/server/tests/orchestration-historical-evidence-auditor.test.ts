import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceStore } from "../src/orchestration/verification/evidence-store.js";
import { canonicalHash } from "../src/orchestration/evolution/evolution-fingerprints.js";
import { EvolutionStore } from "../src/orchestration/evolution/evolution-store.js";
import { deterministicEvolutionId, type LineageNode, type LineageObservation } from "../src/orchestration/evolution/evolution-types.js";
import { HistoricalEvidenceAuditor } from "../src/orchestration/evolution/historical-evidence-auditor.js";
import type { AgentRun, FaultRecord, ProjectRecord, VerificationResult } from "../src/types.js";

const roots: string[] = [];
const hash = (value: string) => canonicalHash({ value });
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "historical-auditor-"));
  roots.push(root);
  const evidence = new EvidenceStore({ dataDirectory: root });
  const nodeRef = await evidence.write("node", Buffer.from("candidate node evidence"));
  const faultRef = await evidence.write("fault", Buffer.from("repairable fault evidence"));
  const gateRef = await evidence.write("gate", Buffer.from("mandatory gate failed"));
  const project: ProjectRecord = {
    id: "project-1", displayName: "Project", sourceKind: "managed", repositoryPath: "/repo",
    repositoryRealPath: "/repo", gitCommonRealPath: "/repo/.git", gitCommonDev: 1, gitCommonIno: 2,
    baselineBranch: "main", baselineCommit: "a".repeat(40), state: "ready", lastError: null,
    createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z",
  };
  const record: LineageNode = {
    id: hash("candidate-node"), projectId: project.id, sourceFingerprint: hash("source"), runId: "root-run",
    subtaskId: "backend", kind: "candidate", entityId: "candidate-1", revision: 1,
    harnessVersionHash: hash("harness"), baseCommit: "a".repeat(40), headCommit: null, faultId: "fault-1",
    fingerprints: {
      schemaVersion: 2, complete: true, repositoryBaseHash: hash("repo"), contractHash: hash("contract"),
      authorityManifestHash: hash("authority"), runtimeCapabilityHash: hash("runtime"),
      faultEvidenceHash: hash("fault"), mutationContentHash: hash("mutation"),
    },
    verificationIds: ["verification-1"], evidenceRefs: [nodeRef.sha256], changedPaths: [],
    createdAt: "2026-08-30T00:00:00.000Z",
  };
  const observation = (kind: LineageObservation["kind"]): LineageObservation => ({
    id: deterministicEvolutionId("test-observation", { kind }), projectId: project.id, runId: record.runId,
    nodeId: record.id, kind, candidateState: kind === "executed" ? "running" : "rejected",
    terminalReason: kind === "rejected" ? "deterministic_gate_failure" : null,
    modelCalls: 1, reservedTokens: 1, actualInputTokens: 1, actualOutputTokens: 1, elapsedMs: 1,
    occurredAt: "2026-08-30T00:00:01.000Z",
  });
  const verification: VerificationResult = {
    id: "verification-1", subjectType: "candidate", subjectId: record.entityId, stage: "candidate",
    authorityManifestHash: record.fingerprints.authorityManifestHash,
    gates: [{ gateId: "mandatory", tier: "targeted", passed: false, evidenceRef: gateRef.sha256, failureFingerprint: hash("failure") }],
    failureKind: "deterministic_gate_failure", mandatoryPassed: false, hardProgress: 0, regressionCount: 0,
    modelCalls: 0, reservedTokens: 0, actualInputTokens: 0, actualOutputTokens: 0, elapsedMs: 1,
    verifiedAt: "2026-08-30T00:00:02.000Z",
  };
  const fault: FaultRecord = {
    id: "fault-1", subtaskId: "backend", revision: 1, class: "hard_failure", reasonCode: "targeted_gate_failed",
    summary: "failed", repairable: true, evidenceRefs: [faultRef.sha256], affectedConsumers: [],
    detectedAt: "2026-08-30T00:00:00.000Z",
  };
  const child = { id: "candidate-run", parentRunId: record.runId, projectId: project.id } as AgentRun;
  const auditor = new HistoricalEvidenceAuditor({ evidenceStore: evidence, candidateRun: () => child });
  return {
    auditor, evidenceRoot: root, evidenceRef: gateRef.sha256,
    evidenceRefs: [nodeRef.sha256, faultRef.sha256, gateRef.sha256].sort(), project, record,
    sourceEvidenceRefs: { node: nodeRef.sha256, fault: faultRef.sha256, gate: gateRef.sha256 },
    observations: [observation("executed"), observation("rejected")], verification, fault,
  };
}

describe("HistoricalEvidenceAuditor", () => {
  it("trusts only an executed terminal negative with complete v2 authority and verified evidence", async () => {
    const input = await setup();
    await expect(input.auditor.audit(input)).resolves.toMatchObject({ trustedForPruning: true, trustedForCue: true, quarantine: null });
  });

  it("quarantines legacy/incomplete fingerprints and declarations without execution", async () => {
    const input = await setup();
    const incomplete = { ...input.record, fingerprints: { ...input.record.fingerprints!, complete: false } };
    expect((await input.auditor.audit({ ...input, record: incomplete })).quarantine?.reason).toBe("fingerprint_incomplete");
    expect((await input.auditor.audit({ ...input, observations: input.observations.slice(1) })).quarantine?.reason).toBe("schema_invalid");
  });

  it("quarantines provider and typed infrastructure contradictions", async () => {
    const input = await setup();
    const provider = { ...input.fault, class: "provider_rate_limited" as const, reasonCode: "provider_rate_limited", repairable: false };
    expect((await input.auditor.audit({ ...input, fault: provider })).quarantine?.reason).toBe("provider_fault");
    const contradicted = { ...input.fault, reasonCode: "container_failure" };
    expect((await input.auditor.audit({ ...input, fault: contradicted })).quarantine?.reason).toBe("classification_contradicted");
  });

  it("quarantines missing evidence, malformed verification, and ownership mismatch", async () => {
    const input = await setup();
    const missing = { ...input.record, evidenceRefs: [hash("missing")] };
    expect((await input.auditor.audit({ ...input, record: missing })).quarantine?.reason).toBe("evidence_missing");
    expect((await input.auditor.audit({ ...input, verification: { ...input.verification, mandatoryPassed: true } })).quarantine?.reason).toBe("authority_untrusted");
    expect((await input.auditor.audit({ ...input, record: { ...input.record, projectId: "other" } })).quarantine?.reason).toBe("ownership_mismatch");
  });

  it("fails closed when the live fault could not persist its historical evidence", async () => {
    const input = await setup();

    await expect(input.auditor.audit({
      ...input,
      fault: { ...input.fault, evidenceRefs: [] },
    })).resolves.toMatchObject({
      trustedForPruning: false,
      trustedForCue: false,
      quarantine: { reason: "evidence_missing" },
    });
  });

  it.each([
    ["node", (input: Awaited<ReturnType<typeof setup>>) => ({
      ...input, record: { ...input.record, evidenceRefs: [...input.record.evidenceRefs, "MALFORMED"] },
    })],
    ["fault", (input: Awaited<ReturnType<typeof setup>>) => ({
      ...input, fault: { ...input.fault, evidenceRefs: [...input.fault.evidenceRefs, "short"] },
    })],
    ["verification gate", (input: Awaited<ReturnType<typeof setup>>) => ({
      ...input,
      verification: {
        ...input.verification,
        gates: [...input.verification.gates, {
          ...input.verification.gates[0]!, gateId: "passing", passed: true,
          evidenceRef: "A".repeat(64), failureFingerprint: null,
        }],
      },
    })],
  ])("quarantines the whole record when a %s evidence reference is invalid", async (_source, mutate) => {
    const input = await setup();
    const decision = await input.auditor.audit(mutate(input));
    expect(decision).toMatchObject({
      trustedForPruning: false,
      trustedForCue: false,
      quarantine: { reason: "evidence_reference_invalid" },
    });
    expect(decision.quarantine?.evidenceRefs).toEqual(input.evidenceRefs);
  });

  it.each([
    ["node", (input: Awaited<ReturnType<typeof setup>>) => ({
      ...input, record: { ...input.record, evidenceRefs: [hash("missing-node")] },
    })],
    ["fault", (input: Awaited<ReturnType<typeof setup>>) => ({
      ...input, fault: { ...input.fault, evidenceRefs: [hash("missing-fault")] },
    })],
    ["verification gate", (input: Awaited<ReturnType<typeof setup>>) => ({
      ...input, verification: { ...input.verification, gates: input.verification.gates.map((gate) => ({
        ...gate, evidenceRef: hash("missing-gate"),
      })) },
    })],
  ])("quarantines the whole record when a %s evidence object is missing", async (_source, mutate) => {
    const input = await setup();
    await expect(input.auditor.audit(mutate(input))).resolves.toMatchObject({
      trustedForPruning: false, trustedForCue: false,
      quarantine: { reason: "evidence_missing" },
    });
  });

  it("persists an invalid-reference quarantine as sanitized history", async () => {
    const input = await setup();
    const decision = await input.auditor.audit({
      ...input,
      record: { ...input.record, evidenceRefs: [...input.record.evidenceRefs, "not-a-hash"] },
    });
    const evolution = new EvolutionStore({ dataDirectory: input.evidenceRoot });
    await evolution.initialize();
    await expect(evolution.appendBatch({
      projectId: input.project.id,
      expectedHeadHash: null,
      records: [{ type: "quarantine", value: decision.quarantine! }],
    })).resolves.toMatchObject({ head: { sequence: 1 } });
    await expect(evolution.read({
      projectId: input.project.id, afterSequence: 0, limit: 10,
    })).resolves.toMatchObject({
      records: [{ type: "quarantine", value: { reason: "evidence_reference_invalid" } }],
    });
  });

  it.each(["node", "fault", "gate"] as const)(
    "quarantines the whole record when stored %s evidence is truncated or hash-mismatched",
    async (source) => {
      const input = await setup();
      const evidencePath = path.join(
        input.evidenceRoot, "evidence", "sha256", input.sourceEvidenceRefs[source],
      );
      await writeFile(evidencePath, "truncated");
      await expect(input.auditor.audit(input)).resolves.toMatchObject({
        trustedForPruning: false,
        trustedForCue: false,
        quarantine: { reason: "evidence_hash_mismatch" },
      });
    },
  );

  it.each([
    ["cancelled", { observation: "cancelled" }],
    ["restart cancellation", { observation: "restart_cancelled" }],
    ["inconclusive terminal", { terminalReason: "inconclusive" }],
    ["contradictory positive terminal", { observation: "promoted" }],
  ] as const)("never trusts %s lifecycle history", async (_name, scenario) => {
    const input = await setup();
    const extra = { ...input.observations[1]!, kind: scenario.observation ?? "rejected",
      terminalReason: scenario.terminalReason ?? null };
    const decision = await input.auditor.audit({ ...input, observations: [...input.observations, extra] });
    expect(decision).toMatchObject({ trustedForPruning: false, trustedForCue: false });
  });

  it("never trusts a server-restarted rejection", async () => {
    const input = await setup();
    const restarted = { ...input.observations[1]!, terminalReason: "server_restarted" };
    await expect(input.auditor.audit({
      ...input, observations: [input.observations[0]!, restarted],
    })).resolves.toMatchObject({ trustedForPruning: false, trustedForCue: false });
  });

  it("trusts a verified deterministic rollback", async () => {
    const input = await setup();
    const verified = {
      ...input.observations[1]!, kind: "verified" as const,
      candidateState: "verified" as const, terminalReason: null,
    };
    const rolledBack = {
      ...input.observations[1]!, kind: "rolled_back" as const,
      candidateState: "rolled_back" as const,
      terminalReason: "post_integration_verification_failed",
    };
    const verification: VerificationResult = {
      ...input.verification,
      gates: input.verification.gates.map((gate) => ({
        ...gate, passed: true, failureFingerprint: null,
      })),
      mandatoryPassed: true,
      failureKind: null,
    };
    await expect(input.auditor.audit({
      ...input,
      observations: [input.observations[0]!, verified, rolledBack],
      verification,
    })).resolves.toMatchObject({ trustedForPruning: true, trustedForCue: true, quarantine: null });
  });

  it("rejects a rollback without a verified lifecycle proof", async () => {
    const input = await setup();
    const rolledBack = {
      ...input.observations[1]!, kind: "rolled_back" as const,
      candidateState: "rolled_back" as const,
      terminalReason: "post_integration_verification_failed",
    };
    const verification: VerificationResult = {
      ...input.verification,
      gates: input.verification.gates.map((gate) => ({
        ...gate, passed: true, failureFingerprint: null,
      })),
      mandatoryPassed: true,
      failureKind: null,
    };
    await expect(input.auditor.audit({
      ...input, observations: [input.observations[0]!, rolledBack], verification,
    })).resolves.toMatchObject({ trustedForPruning: false, trustedForCue: false });
  });

  it("accepts lifecycle proof across explicitly related candidate-node versions", async () => {
    const input = await setup();
    const related = { ...input.record, id: hash("earlier-candidate-node-version") };
    const executed = { ...input.observations[0]!, nodeId: related.id };
    await expect(input.auditor.audit({
      ...input,
      relatedRecords: [input.record, related],
      observations: [executed, input.observations[1]!],
    })).resolves.toMatchObject({ trustedForPruning: true, trustedForCue: true, quarantine: null });
  });

  it.each([
    ["incomplete fingerprints", (input: Awaited<ReturnType<typeof setup>>) => ({
      ...input.record,
      id: hash("incomplete-related-candidate"),
      fingerprints: { ...input.record.fingerprints!, complete: false },
    }), "fingerprint_incomplete"],
    ["missing evidence", (input: Awaited<ReturnType<typeof setup>>) => ({
      ...input.record,
      id: hash("missing-evidence-related-candidate"),
      evidenceRefs: [hash("missing-related-evidence")],
    }), "evidence_missing"],
  ] as const)("rejects related lifecycle proof with %s", async (_name, buildRelated, reason) => {
    const input = await setup();
    const related = buildRelated(input);
    const executed = { ...input.observations[0]!, nodeId: related.id };
    await expect(input.auditor.audit({
      ...input,
      relatedRecords: [input.record, related],
      observations: [executed, input.observations[1]!],
    })).resolves.toMatchObject({
      trustedForPruning: false,
      trustedForCue: false,
      quarantine: { reason },
    });
  });

  it.each([
    ["user cancellation", "cancelled", "user_cancelled"],
    ["deadline", "deadline_failure", "root_deadline"],
    ["provider", "provider_rate_limited", "provider_rate_limited"],
    ["infrastructure", "infrastructure_failure", "container_failure"],
    ["authority", "authority_failure", "authority_failure"],
  ] as const)("never trusts %s fault history", async (_name, faultClass, reasonCode) => {
    const input = await setup();
    const decision = await input.auditor.audit({
      ...input,
      fault: { ...input.fault, class: faultClass, reasonCode, repairable: false },
    });
    expect(decision).toMatchObject({ trustedForPruning: false, trustedForCue: false });
  });

  it("requires exact observation and fault ownership", async () => {
    const input = await setup();
    const foreignObservation = { ...input.observations[0]!, projectId: "project-2" };
    await expect(input.auditor.audit({
      ...input, observations: [foreignObservation, input.observations[1]!],
    })).resolves.toMatchObject({ trustedForPruning: false, trustedForCue: false,
      quarantine: { reason: "ownership_mismatch" } });
    await expect(input.auditor.audit({
      ...input, fault: { ...input.fault, subtaskId: "other-task" },
    })).resolves.toMatchObject({ trustedForPruning: false, trustedForCue: false,
      quarantine: { reason: "ownership_mismatch" } });
  });
});
