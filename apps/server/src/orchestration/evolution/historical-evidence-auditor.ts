import type { AgentRun, FaultRecord, ProjectRecord, VerificationResult } from "../../types.js";
import type { EvidenceStore } from "../verification/evidence-store.js";
import { usableFingerprints } from "./evolution-fingerprints.js";
import {
  deterministicEvolutionId,
  type EvolutionAuditDecision,
  type LineageNode,
  type LineageObservation,
  type QuarantineRecord,
} from "./evolution-types.js";
import { historicalFaultConsistency } from "../healing/fault-detector.js";

export interface HistoricalAuditDecision extends EvolutionAuditDecision {}

type QuarantineReason = QuarantineRecord["reason"];

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const DETERMINISTIC_REJECTION_REASONS = new Set([
  "deterministic_gate_failure",
  "mandatory_gate_failed",
  "targeted_gate_failed",
  "no_evidence_progress",
]);
const VERIFIED_ROLLBACK_REASONS = new Set([
  "post_integration_verification_failed",
]);

export class HistoricalEvidenceAuditor {
  readonly #evidenceStore: EvidenceStore;
  readonly #candidateRun: (record: LineageNode) => AgentRun | null | Promise<AgentRun | null>;

  constructor(options: {
    evidenceStore: EvidenceStore;
    candidateRun: (record: LineageNode) => AgentRun | null | Promise<AgentRun | null>;
  }) {
    this.#evidenceStore = options.evidenceStore;
    this.#candidateRun = options.candidateRun;
  }

  async audit(input: {
    project: ProjectRecord;
    record: LineageNode;
    relatedRecords?: readonly LineageNode[];
    observations: LineageObservation[];
    verification: VerificationResult | null;
    fault: FaultRecord | null;
  }): Promise<HistoricalAuditDecision> {
    const { project, record, observations, verification, fault } = input;
    if (record.projectId !== project.id) return this.#quarantine(record, "ownership_mismatch");
    if (record.fingerprints === null || record.fingerprints.schemaVersion !== 2) {
      return this.#quarantine(record, "legacy_fingerprint");
    }
    if (!usableFingerprints(record.fingerprints)) return this.#quarantine(record, "fingerprint_incomplete");

    const child = await this.#candidateRun(record);
    if (!child || child.id.length === 0 || child.parentRunId !== record.runId || child.projectId !== project.id) {
      return this.#quarantine(record, "ownership_mismatch");
    }
    const relatedRecords = input.relatedRecords ?? [record];
    if (!relatedRecords.some((value) => value.id === record.id) || relatedRecords.some((value) =>
      value.kind !== "candidate" || value.projectId !== project.id ||
      value.runId !== record.runId || value.entityId !== record.entityId ||
      value.subtaskId !== record.subtaskId || value.revision !== record.revision ||
      value.faultId !== record.faultId)) {
      return this.#quarantine(record, "ownership_mismatch");
    }
    const relatedNodeIds = new Set(relatedRecords.map((value) => value.id));
    if (observations.some((value) => value.projectId !== project.id ||
      value.runId !== record.runId || !relatedNodeIds.has(value.nodeId))) {
      return this.#quarantine(record, "ownership_mismatch");
    }
    const proofNodeIds = new Set(observations.filter((value) =>
      value.kind === "executed" || value.kind === "verified" ||
      value.kind === "rejected" || value.kind === "rolled_back").map((value) => value.nodeId));
    const proofRecords = relatedRecords.filter((value) => proofNodeIds.has(value.id));
    if (proofRecords.length !== proofNodeIds.size) return this.#quarantine(record, "ownership_mismatch");
    if (proofRecords.some((value) => value.fingerprints === null ||
      !usableFingerprints(value.fingerprints))) {
      return this.#quarantine(record, "fingerprint_incomplete");
    }
    const executed = observations.some((value) => value.kind === "executed");
    const rejected = observations.filter((value) => value.kind === "rejected");
    const rolledBack = observations.filter((value) => value.kind === "rolled_back");
    const hasVerified = observations.some((value) => value.kind === "verified");
    const deterministicRejection = rejected.length > 0 && rolledBack.length === 0 && !hasVerified &&
      rejected.every((value) => value.terminalReason !== null &&
        DETERMINISTIC_REJECTION_REASONS.has(value.terminalReason));
    const verifiedRollback = rolledBack.length > 0 && rejected.length === 0 && hasVerified &&
      rolledBack.every((value) => value.terminalReason !== null &&
        VERIFIED_ROLLBACK_REASONS.has(value.terminalReason));
    const ineligibleLifecycle = observations.some((value) =>
      value.kind === "cancelled" || value.kind === "restart_cancelled" || value.kind === "promoted");
    if (!executed || (!deterministicRejection && !verifiedRollback) || ineligibleLifecycle) {
      return this.#quarantine(record, "schema_invalid");
    }

    if (fault === null) return this.#quarantine(record, "schema_invalid");
    if (fault.id !== record.faultId || fault.subtaskId !== record.subtaskId || fault.revision !== record.revision) {
      return this.#quarantine(record, "ownership_mismatch");
    }
    const consistency = historicalFaultConsistency(fault);
    if (consistency.contradicted) return this.#quarantine(record, "classification_contradicted");
    if (!consistency.repairable) return this.#quarantine(record, faultReason(fault));
    if (fault.evidenceRefs.length === 0) return this.#quarantine(record, "evidence_missing");

    const verificationIdentityTrusted = verification !== null &&
      verification.subjectType === "candidate" && verification.subjectId === record.entityId &&
      record.verificationIds.includes(verification.id) &&
      verification.authorityManifestHash === record.fingerprints.authorityManifestHash;
    const rejectionVerification = verification !== null && !verification.mandatoryPassed &&
      verification.failureKind === "deterministic_gate_failure" &&
      verification.gates.some((gate) => gate.passed === false && gate.failureFingerprint !== null);
    const rollbackVerification = verification !== null && verification.mandatoryPassed &&
      verification.failureKind === null && verification.gates.length > 0 &&
      verification.gates.every((gate) => gate.passed && gate.failureFingerprint === null);
    if (!verificationIdentityTrusted ||
      (deterministicRejection ? !rejectionVerification : !rollbackVerification)) {
      return this.#quarantine(record, "authority_untrusted");
    }

    const requiredEvidenceRefs = [
      ...record.evidenceRefs,
      ...proofRecords.flatMap((value) => value.evidenceRefs),
      ...fault.evidenceRefs,
      ...verification.gates.map((gate) => gate.evidenceRef),
    ];
    if (requiredEvidenceRefs.some((value) => typeof value !== "string" || !HASH_PATTERN.test(value))) {
      return this.#quarantine(record, "evidence_reference_invalid", requiredEvidenceRefs);
    }
    const evidenceRefs = [...new Set(requiredEvidenceRefs)].sort();
    for (const ref of evidenceRefs) {
      const checked = await this.#evidenceStore.verify(ref);
      if (!checked.exists) return this.#quarantine(record, "evidence_missing", evidenceRefs);
      if (!checked.hashMatches || !checked.byteLengthMatches) {
        return this.#quarantine(record, "evidence_hash_mismatch", evidenceRefs);
      }
    }
    return {
      recordId: record.id,
      trustedForPruning: true,
      trustedForCue: true,
      quarantine: null,
      verification: structuredClone(verification),
    };
  }

  #quarantine(
    record: LineageNode,
    reason: QuarantineReason,
    evidenceRefs: readonly string[] = record.evidenceRefs,
  ): HistoricalAuditDecision {
    const quarantine: QuarantineRecord = {
      id: deterministicEvolutionId("historical-quarantine", { recordId: record.id, reason }),
      projectId: record.projectId,
      targetRecordId: record.id,
      reason,
      evidenceRefs: [...new Set(evidenceRefs.filter((value) => HASH_PATTERN.test(value)))]
        .sort().slice(0, 200),
      quarantinedAt: record.createdAt,
    };
    return { recordId: record.id, trustedForPruning: false, trustedForCue: false, quarantine };
  }
}

function faultReason(fault: FaultRecord): QuarantineReason {
  if (fault.class === "provider_rate_limited") return "provider_fault";
  if (fault.class === "authority_failure") return "authority_untrusted";
  return "infrastructure_fault";
}
