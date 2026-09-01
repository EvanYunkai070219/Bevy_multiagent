import { createHash } from "node:crypto";
import type {
  EvolutionFingerprints,
  MutationContentManifestV1,
  RepairRuntimeCapabilityEnvironmentV1,
  RuntimeCapabilityManifestV2,
} from "./evolution-types.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MISSING = Object.freeze({ missing: true });
const RUNTIME_FIELDS: readonly (keyof RuntimeCapabilityManifestV2)[] = [
  "schemaVersion",
  "harnessVersion",
  "repairPromptVersion",
  "diagnosisPromptVersion",
  "modelId",
  "runtimeMode",
  "toolSchemaHash",
  "excludedToolHash",
  "sandboxPolicyHash",
  "containerImageId",
  "timeoutMs",
  "stepCap",
  "rootResourceHorizonHash",
];
const FINGERPRINT_FIELDS: readonly (keyof Omit<EvolutionFingerprints, "schemaVersion" | "complete">)[] = [
  "repositoryBaseHash",
  "contractHash",
  "authorityManifestHash",
  "runtimeCapabilityHash",
  "faultEvidenceHash",
  "mutationContentHash",
];

export function canonicalSerialize(value: unknown): string {
  return encodeCanonical(value, new Set<object>());
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalSerialize(value)).digest("hex");
}

export function runtimeCapabilityFingerprint(input: unknown): {
  readonly hash: string;
  readonly complete: boolean;
} {
  const record = isRecord(input) ? input : {};
  const selected = Object.fromEntries(
    RUNTIME_FIELDS.map((field) => [
      field,
      Object.prototype.hasOwnProperty.call(record, field) ? record[field] : MISSING,
    ]),
  );
  return {
    hash: canonicalHash(selected),
    complete: completeRuntimeCapability(record),
  };
}

export function buildRuntimeCapabilityManifest(input: {
  readonly harnessVersion: string;
  readonly repairPromptVersion: string;
  readonly diagnosisPromptVersion: string;
  readonly environment: RepairRuntimeCapabilityEnvironmentV1;
  readonly authorizedTools: readonly string[];
  readonly excludedTools: readonly string[];
  readonly timeoutMs: number;
  readonly stepCap: number;
  readonly rootResourceHorizon: {
    readonly modelCallCap: number | null;
    readonly tokenCap: number | null;
    readonly stepCap: number | null;
    readonly timeoutMs: number | null;
    readonly repairBranchCap: number;
    readonly repairBranchModelCallCap: number;
    readonly repairBranchTokenCap: number;
    readonly repairBranchStepCap: number;
    readonly repairBranchTimeoutMs: number;
  };
}): RuntimeCapabilityManifestV2 {
  return Object.freeze({
    schemaVersion: 2,
    harnessVersion: input.harnessVersion,
    repairPromptVersion: input.repairPromptVersion,
    diagnosisPromptVersion: input.diagnosisPromptVersion,
    modelId: input.environment.modelId,
    runtimeMode: input.environment.runtimeMode,
    toolSchemaHash: authorizedToolSchemaHash(
      input.environment.toolSchemas,
      input.authorizedTools,
      input.excludedTools,
    ),
    excludedToolHash: canonicalHash({
      schemaVersion: 1,
      excludedTools: sortedUniqueStrings(input.excludedTools),
    }),
    sandboxPolicyHash: input.environment.sandboxPolicyHash,
    containerImageId: input.environment.containerImageId,
    timeoutMs: input.timeoutMs,
    stepCap: input.stepCap,
    rootResourceHorizonHash: canonicalHash(input.rootResourceHorizon),
  });
}

export function mutationContentHash(input: unknown): string {
  const record = isRecord(input) ? input : {};
  const cueIdentity = record.failureCueIds === undefined ||
    (Array.isArray(record.failureCueIds) && record.failureCueIds.length === 0)
    ? {}
    : {
        failureCueIds: Array.isArray(record.failureCueIds)
          ? [...record.failureCueIds]
          : MISSING,
      };
  return canonicalHash({
    schemaVersion: selected(record, "schemaVersion"),
    family: selected(record, "family"),
    targetSubtaskId: selected(record, "targetSubtaskId"),
    instructionPatch: selected(record, "instructionPatch"),
    expectedEffect: selected(record, "expectedEffect"),
    addedEvidenceRefs: sortedUniqueStrings(record.addedEvidenceRefs),
    ...cueIdentity,
    toolRoute: Array.isArray(record.toolRoute) ? [...record.toolRoute] : MISSING,
    repairPromptVersion: selected(record, "repairPromptVersion"),
  });
}

export function buildEvolutionFingerprints(input: {
  readonly repositoryBaseHash?: unknown;
  readonly contractHash?: unknown;
  readonly authorityManifestHash?: unknown;
  readonly runtimeCapabilityHash?: unknown;
  readonly faultEvidenceHash?: unknown;
  readonly mutationContentHash?: unknown;
  readonly runtimeCapabilityComplete?: boolean;
}): EvolutionFingerprints {
  const fingerprints: EvolutionFingerprints = {
    schemaVersion: 2,
    complete: false,
    repositoryBaseHash: stringOrEmpty(input.repositoryBaseHash),
    contractHash: stringOrEmpty(input.contractHash),
    authorityManifestHash: stringOrEmpty(input.authorityManifestHash),
    runtimeCapabilityHash: stringOrEmpty(input.runtimeCapabilityHash),
    faultEvidenceHash: stringOrEmpty(input.faultEvidenceHash),
    mutationContentHash: stringOrEmpty(input.mutationContentHash),
  };
  return Object.freeze({
    ...fingerprints,
    complete:
      input.runtimeCapabilityComplete === true &&
      FINGERPRINT_FIELDS.every((field) => HASH_PATTERN.test(fingerprints[field])),
  });
}

export function exactRepeatKey(fingerprints: EvolutionFingerprints): string | null {
  return usableFingerprints(fingerprints)
    ? canonicalHash({ domain: "exact-repeat-v2", ...fingerprints })
    : null;
}

export function failureCueLookupKey(fingerprints: EvolutionFingerprints): string | null {
  return usableFingerprints(fingerprints)
    ? canonicalHash({ domain: "failure-cue-v2", ...fingerprints })
    : null;
}

export function usableFingerprints(fingerprints: EvolutionFingerprints): boolean {
  return (
    fingerprints.schemaVersion === 2 &&
    fingerprints.complete === true &&
    FINGERPRINT_FIELDS.every((field) => HASH_PATTERN.test(fingerprints[field]))
  );
}

function completeRuntimeCapability(record: Record<string, unknown>): boolean {
  if (!RUNTIME_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(record, field))) {
    return false;
  }
  if (record.schemaVersion !== 2) return false;
  for (const field of [
    "harnessVersion",
    "repairPromptVersion",
    "diagnosisPromptVersion",
    "modelId",
    "runtimeMode",
  ]) {
    if (!nonEmptyString(record[field])) return false;
  }
  for (const field of [
    "toolSchemaHash",
    "excludedToolHash",
    "sandboxPolicyHash",
    "rootResourceHorizonHash",
  ]) {
    if (typeof record[field] !== "string" || !HASH_PATTERN.test(record[field])) return false;
  }
  if (!positiveSafeInteger(record.timeoutMs) || !positiveSafeInteger(record.stepCap)) return false;
  if (typeof record.runtimeMode !== "string") return false;
  const containerized = record.runtimeMode.toLowerCase().includes("container");
  if (containerized) {
    return typeof record.containerImageId === "string" &&
      /^sha256:[0-9a-f]{64}$/u.test(record.containerImageId);
  }
  return record.containerImageId === null;
}

function authorizedToolSchemaHash(
  schemas: readonly { readonly name: string; readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>> }[],
  authorizedTools: readonly string[],
  excludedTools: readonly string[],
): string {
  if (!Array.isArray(schemas)) return "";
  const byName = new Map<string, typeof schemas[number]>();
  for (const schema of schemas) {
    if (!isRecord(schema) || !nonEmptyString(schema.name) ||
        typeof schema.description !== "string" || !isRecord(schema.inputSchema) ||
        byName.has(schema.name)) return "";
    byName.set(schema.name, schema);
  }
  const excluded = new Set(excludedTools);
  const names = [...new Set(authorizedTools)].sort();
  if (names.some((name) => excluded.has(name) || !byName.has(name))) return "";
  const selectedSchemas = names.map((name) => {
    const schema = byName.get(name)!;
    return {
      name: schema.name,
      description: schema.description,
      inputSchema: schema.inputSchema,
    };
  });
  try {
    return canonicalHash({ schemaVersion: 1, tools: selectedSchemas });
  } catch {
    return "";
  }
}

function encodeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON requires finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("Canonical JSON cannot encode cycles");
    ancestors.add(value);
    try {
      return "[" + value.map((item) => encodeCanonical(item, ancestors)).join(",") + "]";
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isRecord(value)) {
    throw new Error("Canonical JSON accepts only JSON-compatible values");
  }
  if (ancestors.has(value)) throw new Error("Canonical JSON cannot encode cycles");
  ancestors.add(value);
  try {
    return "{" + Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + encodeCanonical(value[key], ancestors))
      .join(",") + "}";
  } finally {
    ancestors.delete(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function selected(record: Record<string, unknown>, field: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, field) ? record[field] : MISSING;
}

function sortedUniqueStrings(value: unknown): unknown {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return MISSING;
  return [...new Set(value)].sort();
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
