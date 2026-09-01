import type {
  GateResult,
  MutationCandidate,
  MutationDelta,
  VerificationResult,
} from "../../types.js";
import { usableFingerprints } from "./evolution-fingerprints.js";
import {
  deterministicEvolutionId,
  type EvolutionFingerprints,
  type FailureCue,
  type TransferObservation,
} from "./evolution-types.js";
import type { HistoricalAuditDecision } from "./historical-evidence-auditor.js";

const MAX_CUES = 3;
const MAX_SUMMARY = 512;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const FINGERPRINT_FIELDS = [
  "repositoryBaseHash",
  "contractHash",
  "authorityManifestHash",
  "runtimeCapabilityHash",
  "faultEvidenceHash",
  "mutationContentHash",
] as const;

export class FailureCueService {
  readonly #cues: FailureCue[];
  readonly #trustedSourceNodeIds: Set<string>;
  #available = false;

  constructor(options: {
    cues?: readonly FailureCue[];
    audits?: readonly HistoricalAuditDecision[];
  } = {}) {
    this.#cues = [];
    this.#trustedSourceNodeIds = new Set();
    this.rebuild(options.cues ?? [], options.audits ?? []);
  }

  rebuild(cues: readonly FailureCue[], audits: readonly HistoricalAuditDecision[]): void {
    this.#cues.splice(0, this.#cues.length, ...cues.map((cue) => structuredClone(cue)));
    this.#trustedSourceNodeIds.clear();
    for (const recordId of audits
        .filter((audit) => audit.trustedForCue && audit.quarantine === null)
        .map((audit) => audit.recordId)) this.#trustedSourceNodeIds.add(recordId);
    this.#available = true;
  }

  markUnavailable(): void {
    this.#cues.splice(0, this.#cues.length);
    this.#trustedSourceNodeIds.clear();
    this.#available = false;
  }

  health(): "ready" | "unavailable" {
    return this.#available ? "ready" : "unavailable";
  }

  create(input: {
    projectId: string;
    sourceFingerprint: string;
    contractKey: string;
    candidate: MutationCandidate;
    candidateNodeId: string;
    verification: VerificationResult;
    exactRepeatKey: string;
  }): FailureCue | null {
    const { candidate, verification } = input;
    const fingerprints = candidate.evolutionFingerprints;
    if (!usableCandidateIdentity(input, fingerprints) ||
      (candidate.state !== "rejected" && candidate.state !== "rolled_back") ||
      verification.subjectType !== "candidate" || verification.subjectId !== candidate.id ||
      verification.failureKind !== "deterministic_gate_failure" || verification.mandatoryPassed ||
      verification.authorityManifestHash !== fingerprints!.authorityManifestHash ||
      !Number.isSafeInteger(verification.regressionCount) || verification.regressionCount < 0) {
      return null;
    }
    const failed = verification.gates
      .filter((gate) => !gate.passed && gate.failureFingerprint !== null &&
        HASH_PATTERN.test(gate.failureFingerprint) && HASH_PATTERN.test(gate.evidenceRef))
      .sort(compareGate);
    const selected = failed[0];
    if (selected === undefined) return null;
    const evidenceRefs = [...new Set(failed.map((gate) => gate.evidenceRef))].sort().slice(0, MAX_CUES);
    const summary = boundedSummary(
      `Prior ${candidate.delta.family} trial failed ${selected.tier} gate ` +
      `${selected.failureFingerprint!.slice(0, 12)}; regressions=${verification.regressionCount}; ` +
      `evidence=${selected.evidenceRef.slice(0, 12)}.`,
    );
    const identity = {
      schemaVersion: 1,
      projectId: input.projectId,
      sourceFingerprint: input.sourceFingerprint,
      sourceCandidateNodeId: input.candidateNodeId,
      contractKey: input.contractKey,
      contractHash: fingerprints!.contractHash,
      candidateFamily: candidate.delta.family,
      gateTier: selected.tier,
      failureFingerprint: selected.failureFingerprint!,
      evidenceRefs,
      exactRepeatKey: input.exactRepeatKey,
      createdAt: verification.verifiedAt,
    };
    return Object.freeze({
      id: deterministicEvolutionId("failure-cue", identity),
      projectId: input.projectId,
      sourceFingerprint: input.sourceFingerprint,
      sourceCandidateNodeId: input.candidateNodeId,
      contractKey: input.contractKey,
      contractHash: fingerprints!.contractHash,
      candidateFamily: candidate.delta.family,
      fingerprints: structuredClone(fingerprints!),
      gateTier: selected.tier,
      failureFingerprint: selected.failureFingerprint!,
      summary,
      evidenceRefs,
      exactRepeatKey: input.exactRepeatKey,
      differingFingerprintFields: [],
      createdAt: verification.verifiedAt,
    });
  }

  select(input: {
    projectId: string;
    sourceFingerprint: string;
    contractKey: string;
    contractHash: string;
    candidateFamily: MutationDelta["family"];
    gateTier: GateResult["tier"];
    failureFingerprint: string;
    excludeExactRepeatKey: string;
    limit: number;
    fingerprints?: EvolutionFingerprints;
  }): FailureCue[] {
    if (!this.#available) return [];
    const limit = Math.max(0, Math.min(MAX_CUES,
      Number.isFinite(input.limit) ? Math.trunc(input.limit) : 0));
    if (limit === 0) return [];
    return this.#cues
      .filter((cue) => this.#trustedSourceNodeIds.has(cue.sourceCandidateNodeId) &&
        cue.projectId === input.projectId && cue.sourceFingerprint === input.sourceFingerprint &&
        cue.contractKey === input.contractKey && cue.candidateFamily === input.candidateFamily &&
        cue.gateTier === input.gateTier && cue.failureFingerprint === input.failureFingerprint &&
        cue.exactRepeatKey !== input.excludeExactRepeatKey && usableFingerprints(cue.fingerprints))
      .map((cue) => ({
        ...structuredClone(cue),
        differingFingerprintFields: differingFields(cue.fingerprints, input.fingerprints, input.contractHash),
      }))
      .sort((left, right) =>
        Number(right.contractHash === input.contractHash) - Number(left.contractHash === input.contractHash) ||
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, limit);
  }

  render(cues: readonly FailureCue[]): string {
    if (cues.length === 0) return "";
    const lines = cues.slice(0, MAX_CUES).map((cue) => {
      const differences = [...new Set(cue.differingFingerprintFields)].sort();
      const prefix = differences.length === 0 ? "" : `[differs: ${differences.join(", ")}] `;
      return `- ${boundedSummary(prefix + cue.summary)}`;
    });
    return [
      "Prior failure cues (advisory only; they do not alter the current contract or gates):",
      ...lines,
    ].join("\n");
  }

  differingFingerprintFields(
    cueIds: readonly string[],
    current: EvolutionFingerprints,
  ): (keyof EvolutionFingerprints)[] {
    const selected = new Set(cueIds);
    return [...new Set(this.#cues
      .filter((cue) => selected.has(cue.id))
      .flatMap((cue) => differingFields(cue.fingerprints, current, current.contractHash)))]
      .sort();
  }

  observeTransfer(input: {
    projectId: string;
    cueIds: string[];
    control: VerificationResult | null;
    candidate: VerificationResult;
    targetCandidateNodeId: string;
    differingFingerprintFields: (keyof EvolutionFingerprints)[];
  }): TransferObservation[] {
    const cueIds = [...new Set(input.cueIds)].slice(0, MAX_CUES);
    const outcome = transferOutcome(input.control, input.candidate);
    const evidenceRefs = [...new Set([
      ...(input.control?.gates.map((gate) => gate.evidenceRef) ?? []),
      ...input.candidate.gates.map((gate) => gate.evidenceRef),
    ])].filter((ref) => HASH_PATTERN.test(ref)).sort().slice(0, MAX_CUES);
    const fields = [...new Set(input.differingFingerprintFields)].sort();
    return cueIds.map((cueId) => ({
      id: deterministicEvolutionId("failure-cue-transfer", {
        schemaVersion: 1,
        projectId: input.projectId,
        cueId,
        targetCandidateNodeId: input.targetCandidateNodeId,
        outcome,
        evidenceRefs,
        differingFingerprintFields: fields,
      }),
      projectId: input.projectId,
      cueId,
      targetCandidateNodeId: input.targetCandidateNodeId,
      differingFingerprintFields: fields,
      outcome,
      evidenceRefs,
      createdAt: input.candidate.verifiedAt,
    }));
  }
}

function usableCandidateIdentity(
  input: { projectId: string; sourceFingerprint: string; contractKey: string; candidateNodeId: string; exactRepeatKey: string },
  fingerprints: EvolutionFingerprints | null,
): fingerprints is EvolutionFingerprints {
  return input.projectId.length > 0 && input.contractKey.length > 0 &&
    HASH_PATTERN.test(input.sourceFingerprint) && HASH_PATTERN.test(input.candidateNodeId) &&
    HASH_PATTERN.test(input.exactRepeatKey) && fingerprints !== null && usableFingerprints(fingerprints);
}

function transferOutcome(
  control: VerificationResult | null,
  candidate: VerificationResult,
): TransferObservation["outcome"] {
  if (control === null || !trustedComparison(control) || !trustedComparison(candidate)) return "inconclusive";
  if (candidate.regressionCount > control.regressionCount ||
    candidate.hardProgress < control.hardProgress) return "regressed";
  if (candidate.hardProgress > control.hardProgress &&
    candidate.regressionCount <= control.regressionCount) return "helped";
  return candidate.hardProgress === control.hardProgress &&
    candidate.regressionCount === control.regressionCount ? "neutral" : "inconclusive";
}

function trustedComparison(result: VerificationResult): boolean {
  return result.failureKind !== "authority_failure" &&
    Number.isSafeInteger(result.hardProgress) && result.hardProgress >= 0 &&
    Number.isSafeInteger(result.regressionCount) && result.regressionCount >= 0 &&
    ((result.mandatoryPassed && result.failureKind === null) ||
      (!result.mandatoryPassed && result.failureKind === "deterministic_gate_failure"));
}

function differingFields(
  stored: EvolutionFingerprints,
  current: EvolutionFingerprints | undefined,
  currentContractHash: string,
): (keyof EvolutionFingerprints)[] {
  if (current === undefined) return stored.contractHash === currentContractHash ? [] : ["contractHash"];
  return FINGERPRINT_FIELDS.filter((field) => stored[field] !== current[field]);
}

function compareGate(left: GateResult, right: GateResult): number {
  return left.tier.localeCompare(right.tier) ||
    (left.failureFingerprint ?? "").localeCompare(right.failureFingerprint ?? "") ||
    left.evidenceRef.localeCompare(right.evidenceRef);
}

function boundedSummary(value: string): string {
  return [...value.normalize("NFKC").replace(/\s+/gu, " ").trim()].slice(0, MAX_SUMMARY).join("");
}
