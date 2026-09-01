import { randomUUID } from "node:crypto";
import { RunTerminalError } from "../run-control.js";
import type { TrajectoryStop } from "../workers/trajectory.js";
import type { RunEvent, RunEventDraft } from "../../run-events.js";
import type {
  FaultClass,
  FaultRecord,
  EvidenceSnapshot,
  SubtaskContract,
  TaskNodeState,
  VerificationResult,
  WorkerResult,
} from "../../types.js";
import { canonicalSerialize } from "../evolution/evolution-fingerprints.js";

export interface FaultEvidenceStore {
  write(label: string, bytes: Uint8Array): Promise<{ sha256: string }>;
}

export async function persistFaultEvidence(
  snapshots: readonly EvidenceSnapshot[],
  store: FaultEvidenceStore,
): Promise<string[]> {
  const refs: string[] = [];
  const ordered = [...snapshots].sort((left, right) =>
    left.sequence - right.sequence || left.id.localeCompare(right.id, "en"));
  for (const snapshot of ordered) {
    const ref = await store.write(
      `trajectory-${snapshot.attemptId}-${snapshot.sequence}`,
      Buffer.from(canonicalSerialize(snapshot), "utf8"),
    );
    refs.push(ref.sha256);
  }
  return [...new Set(refs)].sort();
}

const REPAIRABLE: ReadonlySet<FaultClass> = new Set([
  "hard_failure",
  "stall",
  "false_completion",
  "coordination_failure",
]);

const NON_TASK_REASON_CODES = new Set([
  "user_cancelled",
  "emergency_token_fuse",
  "emergency_model_call_fuse",
  "root_deadline",
  "provider_rate_limited",
  "git_metadata_tampered",
  "infrastructure_failure",
  "container_failure",
  "authority_failure",
  "authority_denied",
  "integration_conflict",
]);

/** Deterministic replay of fault priority for historical trust decisions. */
export function historicalFaultConsistency(fault: FaultRecord): {
  repairable: boolean;
  contradicted: boolean;
} {
  const repairable = REPAIRABLE.has(fault.class) && fault.repairable === true;
  return { repairable, contradicted: repairable && NON_TASK_REASON_CODES.has(fault.reasonCode) };
}

export class TrajectoryStoppedError extends Error {
  readonly name = "TrajectoryStoppedError";
  constructor(readonly stop: TrajectoryStop) {
    super("trajectory_stop:" + stop.reason);
  }
}

export interface DetectFaultInput {
  contract?: SubtaskContract | null;
  node?: TaskNodeState | null;
  result?: WorkerResult | null;
  verification?: VerificationResult | null;
  trajectory?: TrajectoryStop | null;
  events?: Array<RunEvent | RunEventDraft>;
  terminal?: RunTerminalError | null;
  ephemeral?: boolean;
}

export function detectFault(input: DetectFaultInput): FaultRecord | null {
  const subtaskId = input.node?.subtaskId ?? input.contract?.subtaskId ?? input.result?.subtaskId ?? "unknown";
  const revision = input.node?.revision ?? input.contract?.revision ?? 1;
  const typed = typedCodes(input);
  const classified = classify(input, typed);
  if (
    classified.class === "hard_failure" &&
    (input.result?.status === "completed" || input.result?.status === "contribution_ready") &&
    !input.trajectory
  ) {
    return null;
  }
  const repairable = input.ephemeral === true ? false : REPAIRABLE.has(classified.class);
  return {
    id: randomUUID(),
    subtaskId,
    revision,
    class: classified.class,
    reasonCode: classified.reasonCode,
    summary: classified.summary,
    repairable,
    evidenceRefs: input.trajectory?.evidenceRefs ?? [],
    affectedConsumers: input.contract?.downstreamConsumers ?? [],
    detectedAt: new Date().toISOString(),
  };
}

function classify(
  input: DetectFaultInput,
  typed: Set<string>,
): { class: FaultClass; reasonCode: string; summary: string } {
  if (
    input.result?.status === "cancelled" ||
    typed.has("user_cancelled") ||
    input.terminal?.reason === "user_cancelled"
  ) {
    return { class: "cancelled", reasonCode: "user_cancelled", summary: "Run was cancelled." };
  }
  if (
    input.terminal?.reason === "emergency_token_fuse" ||
    input.terminal?.reason === "emergency_model_call_fuse" ||
    typed.has("emergency_token_fuse") ||
    typed.has("emergency_model_call_fuse")
  ) {
    const reason = input.terminal?.reason ?? "emergency_token_fuse";
    return { class: "budget_failure", reasonCode: reason, summary: "Emergency budget fuse fired." };
  }
  if (
    input.terminal?.reason === "root_deadline" ||
    input.result?.status === "timed_out" ||
    typed.has("root_deadline")
  ) {
    return { class: "deadline_failure", reasonCode: "root_deadline", summary: "Root or worker deadline elapsed." };
  }
  if (input.terminal?.reason === "provider_rate_limited" || typed.has("provider_rate_limited")) {
    return {
      class: "provider_rate_limited",
      reasonCode: "provider_rate_limited",
      summary: "Provider rate limited the run.",
    };
  }
  if (typed.has("git_metadata_tampered") || typed.has("infrastructure_failure") || typed.has("container_failure")) {
    return {
      class: "infrastructure_failure",
      reasonCode: firstOf(typed, ["git_metadata_tampered", "infrastructure_failure", "container_failure"]),
      summary: "Infrastructure or Git ownership failed closed.",
    };
  }
  if (typed.has("authority_failure") || typed.has("authority_denied")) {
    return { class: "authority_failure", reasonCode: "authority_failure", summary: "Authority boundary refused the work." };
  }
  if (typed.has("integration_conflict") || integrationConflict(input.verification)) {
    return {
      class: "integration_conflict",
      reasonCode: "integration_conflict",
      summary: "Canonical integration conflicted.",
    };
  }
  if (input.trajectory) {
    return {
      class: "stall",
      reasonCode: input.trajectory.reason,
      summary: "Trajectory stopped for " + input.trajectory.reason + ".",
    };
  }
  if (input.result?.status === "contribution_ready" && input.verification && !input.verification.mandatoryPassed) {
    return {
      class: "false_completion",
      reasonCode: "false_completion",
      summary: "Worker claimed completion but mandatory verification failed.",
    };
  }
  if (input.result?.status === "blocked" || (input.node?.blockedBy.length ?? 0) > 0) {
    return {
      class: "coordination_failure",
      reasonCode: "coordination_failure",
      summary: "Worker is blocked on peer coordination.",
    };
  }
  return {
    class: "hard_failure",
    reasonCode: "hard_failure",
    summary: input.result?.error ?? "Task failed a mandatory gate.",
  };
}

function typedCodes(input: DetectFaultInput): Set<string> {
  const codes = new Set<string>();
  if (input.terminal instanceof RunTerminalError) codes.add(input.terminal.reason);
  for (const reason of input.result?.error?.split(";") ?? []) {
    const normalized = reason.trim();
    if (isTypedReason(normalized)) codes.add(normalized);
  }
  for (const event of input.events ?? []) {
    const code = event.error?.code;
    if (typeof code === "string" && code.length > 0) codes.add(code);
  }
  if (input.result && typeof input.result === "object" && "error" in input.result) {
    const message = input.result.error;
    if (message === "user_cancelled") codes.add("user_cancelled");
  }
  return codes;
}

function isTypedReason(value: string): boolean {
  return (
    value === "user_cancelled" ||
    value === "emergency_token_fuse" ||
    value === "emergency_model_call_fuse" ||
    value === "root_deadline" ||
    value === "provider_rate_limited" ||
    value === "git_metadata_tampered" ||
    value === "infrastructure_failure" ||
    value === "container_failure" ||
    value === "authority_failure" ||
    value === "authority_denied" ||
    value === "integration_conflict"
  );
}

function integrationConflict(verification: VerificationResult | null | undefined): boolean {
  return verification?.gates.some((gate) => gate.tier === "post_integration" && gate.passed === false) === true;
}

function firstOf(codes: Set<string>, ordered: string[]): string {
  return ordered.find((item) => codes.has(item)) ?? ordered[0]!;
}

export function isTrajectoryStop(error: unknown): error is TrajectoryStoppedError {
  return error instanceof TrajectoryStoppedError;
}
