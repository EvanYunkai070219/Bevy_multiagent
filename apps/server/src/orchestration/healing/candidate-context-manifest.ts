import path from "node:path";
import type {
  DiagnosisRecord,
  EvidenceSnapshot,
  FaultRecord,
} from "../../types.js";
import type { CandidateContextManifestV1 } from "../evolution/evolution-types.js";
import { canonicalHash, canonicalSerialize } from "../evolution/evolution-fingerprints.js";

const NORMALIZED_DIAGNOSIS_LIMIT = 512;
const CANDIDATE_CONTEXT_MAX_BYTES = 64 * 1024;
const CANDIDATE_CONTEXT_MAX_ITEMS = 200;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const FAULT_CLASSES = new Set([
  "hard_failure", "stall", "false_completion", "coordination_failure",
  "budget_failure", "deadline_failure", "provider_rate_limited",
  "infrastructure_failure", "authority_failure", "integration_conflict", "cancelled",
]);
const MUTATION_FAMILIES = new Set(["control", "context_patch", "strategy_patch"]);

export function buildCandidateContextManifest(input: {
  readonly fault: FaultRecord;
  readonly snapshots: readonly EvidenceSnapshot[];
  readonly diagnosis: DiagnosisRecord;
}): CandidateContextManifestV1 {
  const snapshots = input.snapshots.map((snapshot) => ({
    source: snapshot.source,
    mandatoryFailures: snapshot.mandatoryFailures,
    consumerPassed: snapshot.consumerPassed,
    regressionCount: snapshot.regressionCount,
    failureFingerprints: normalizeSourceFingerprints(snapshot.failureFingerprints),
    changedPaths: sortedUnique(snapshot.changedPaths.map(assertRelativePath)),
    protectedViolations: sortedUnique(snapshot.protectedViolations.map(assertRelativePath)),
    stateFingerprint: sourceFingerprint(snapshot.stateFingerprint),
  }));
  snapshots.sort((left, right) =>
    canonicalSerialize(left).localeCompare(canonicalSerialize(right), "en"));
  const manifest: CandidateContextManifestV1 = {
    schemaVersion: 1,
    fault: {
      class: input.fault.class,
      reasonCode: input.fault.reasonCode,
    },
    snapshots,
    diagnosis: {
      status: input.diagnosis.status,
      classification: normalizeDiagnosisText(input.diagnosis.classification),
      rationale: normalizeDiagnosisText(input.diagnosis.rationale),
      allowedMutationFamilies: sortedUnique(input.diagnosis.allowedMutationFamilies),
    },
  };
  return deepFreeze(manifest);
}

export function serializeCandidateContextManifest(manifest: CandidateContextManifestV1): string {
  if (!isCompleteCandidateContextManifest(manifest)) {
    throw new Error("Candidate context manifest is incomplete or malformed");
  }
  return canonicalSerialize(manifest);
}

export function candidateContextHash(manifest: unknown): string | null {
  return isCompleteCandidateContextManifest(manifest) ? canonicalHash(manifest) : null;
}

export function normalizeDiagnosisText(value: string): string {
  const folded = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return [...folded].slice(0, NORMALIZED_DIAGNOSIS_LIMIT).join("");
}

function assertRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value)
  ) {
    throw new Error("Candidate context path must be repository-relative");
  }
  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Candidate context path must not escape the repository");
  }
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function isCompleteCandidateContextManifest(value: unknown): value is CandidateContextManifestV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "fault", "snapshots", "diagnosis"])) {
    return false;
  }
  if (value.schemaVersion !== 1 || !isRecord(value.fault) || !isRecord(value.diagnosis)) {
    return false;
  }
  if (!hasExactKeys(value.fault, ["class", "reasonCode"]) ||
      !FAULT_CLASSES.has(value.fault.class as string) ||
      !boundedIdentifier(value.fault.reasonCode)) {
    return false;
  }
  if (!Array.isArray(value.snapshots) || value.snapshots.length > CANDIDATE_CONTEXT_MAX_ITEMS) {
    return false;
  }
  if (!value.snapshots.every(isCompleteSnapshot)) return false;
  if (!hasExactKeys(value.diagnosis, [
    "status", "classification", "rationale", "allowedMutationFamilies",
  ])) return false;
  if (value.diagnosis.status !== "available" && value.diagnosis.status !== "unavailable") return false;
  if (!normalizedDiagnosis(value.diagnosis.classification) ||
      !normalizedDiagnosis(value.diagnosis.rationale)) return false;
  if (!isCanonicalStringSet(value.diagnosis.allowedMutationFamilies, MUTATION_FAMILIES)) return false;
  try {
    return Buffer.byteLength(canonicalSerialize(value), "utf8") <= CANDIDATE_CONTEXT_MAX_BYTES;
  } catch {
    return false;
  }
}

function isCompleteSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "source", "mandatoryFailures", "consumerPassed", "regressionCount",
    "failureFingerprints", "changedPaths", "protectedViolations", "stateFingerprint",
  ])) return false;
  if (value.source !== "runtime" && value.source !== "verification") return false;
  if (!nonNegativeInteger(value.mandatoryFailures) ||
      typeof value.consumerPassed !== "boolean" ||
      !nonNegativeInteger(value.regressionCount) ||
      typeof value.stateFingerprint !== "string" ||
      !HASH_PATTERN.test(value.stateFingerprint)) return false;
  if (!isCanonicalHashSet(value.failureFingerprints)) return false;
  return isCanonicalPathSet(value.changedPaths) && isCanonicalPathSet(value.protectedViolations);
}

function isCanonicalHashSet(value: unknown): boolean {
  return Array.isArray(value) &&
    value.length <= CANDIDATE_CONTEXT_MAX_ITEMS &&
    value.every((item) => typeof item === "string" && HASH_PATTERN.test(item)) &&
    isSortedUnique(value as string[]);
}

function isCanonicalPathSet(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > CANDIDATE_CONTEXT_MAX_ITEMS) return false;
  if (!value.every((item) => typeof item === "string")) return false;
  try {
    const paths = value as string[];
    return paths.every((item) => assertRelativePath(item) === item) && isSortedUnique(paths);
  } catch {
    return false;
  }
}

function isCanonicalStringSet(value: unknown, allowed: ReadonlySet<string>): boolean {
  return Array.isArray(value) &&
    value.length <= CANDIDATE_CONTEXT_MAX_ITEMS &&
    value.every((item) => typeof item === "string" && allowed.has(item)) &&
    isSortedUnique(value as string[]);
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value, "en") < 0);
}

function normalizedDiagnosis(value: unknown): boolean {
  return typeof value === "string" && normalizeDiagnosisText(value) === value;
}

function boundedIdentifier(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeSourceFingerprints(value: unknown): string[] {
  if (!Array.isArray(value)) return [""];
  return sortedUnique(value.map(sourceFingerprint));
}

function sourceFingerprint(value: unknown): string {
  return typeof value === "string" && HASH_PATTERN.test(value) ? value : "";
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value;
}
