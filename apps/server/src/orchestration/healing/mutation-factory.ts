import type {
  DiagnosisRecord,
  FaultRecord,
  MutationCandidate,
  MutationDelta,
  RepairCheckpoint,
  SubtaskContract,
} from "../../types.js";
import { buildEvolutionFingerprints, mutationContentHash } from "../evolution/evolution-fingerprints.js";
import { REPAIR_CANDIDATE_PROMPT_VERSION } from "../policies.js";

export { REPAIR_CANDIDATE_PROMPT_VERSION } from "../policies.js";

export const REPAIR_CANDIDATE_TIMEOUT_MS = 240_000;
export const REPAIR_CANDIDATE_STEP_CAP = 20;

export const REPAIR_EXCLUDED_TOOLS = [
  "dispatch_subagent",
  "inspect_worker_progress",
  "extend_worker_timeout",
  "bootstrap_context",
  "start_job",
  "list_jobs",
  "read_job_output",
  "wait_job",
  "cancel_job",
  "send_message",
  "talk",
  "followup_task",
  "register_custom_tool",
  "list_custom_tools",
  "call_custom_tool",
  "batch_tool_call",
] as const;

const INSPECT_FIRST = ["read_file", "read_many_files", "search_files", "list_files"];

const FORBIDDEN_DELTA = [
  /permissions?/i,
  /credentials?/i,
  /budgets?/i,
  /verifier/i,
  /expected outcomes?/i,
  /protectedPaths/,
  /mutation boundar/i,
  /\$COMMON_WORKSPACE/,
  /COMMON_WORKSPACE/,
  /LAUNCHPAD_COORDINATION/,
  /dispatch_subagent/,
  /inspect_worker_progress/,
  /extend_worker_timeout/,
  /bootstrap_context/,
  /start_job/,
  /wait_job/,
  /batch_tool_call/,
];

export function createMutationCandidates(input: {
  tournamentId: string;
  checkpoint: RepairCheckpoint;
  fault: FaultRecord;
  diagnosis: DiagnosisRecord;
  contract: SubtaskContract;
}): [MutationCandidate, MutationCandidate, MutationCandidate] {
  const tools = [...input.contract.authorizedTools];
  const evidence = [...input.checkpoint.contextEvidenceRefs];
  const control = candidate(input, "control", "", [], tools, "unchanged checkpoint replay");
  const contextPatch = candidate(
    input,
    "context_patch",
    "Consult the frozen failure and contract evidence already referenced by this fault.",
    evidence,
    tools,
    "apply frozen failure and contract evidence",
  );
  const strategy = candidate(
    input,
    "strategy_patch",
    "Inspect consumer and contract evidence before editing.",
    [],
    orderStrategyTools(tools),
    "inspect consumer and contract evidence before editing",
  );
  const tuple: [MutationCandidate, MutationCandidate, MutationCandidate] = [control, contextPatch, strategy];
  for (const item of tuple) validateRepairMutation(item, input.checkpoint, input.contract, input.fault);
  return tuple;
}

export function validateRepairMutation(
  candidate: MutationCandidate,
  checkpoint: RepairCheckpoint,
  contract: SubtaskContract,
  fault: FaultRecord,
  options: { declaredCount?: number } = {},
): void {
  if ((options.declaredCount ?? 3) !== 3) {
    throw new Error("Repair candidate count must be exactly three");
  }
  if (candidate.checkpointId !== checkpoint.id) {
    throw new Error("Mutation checkpoint does not match the frozen checkpoint");
  }
  if (!["control", "context_patch", "strategy_patch"].includes(candidate.delta.family)) {
    throw new Error("Mutation family is not an authorized repair family");
  }
  const blob = candidate.delta.instructionPatch + "\n" + candidate.delta.expectedEffect;
  for (const pattern of FORBIDDEN_DELTA) {
    if (pattern.test(blob)) {
      throw new Error("Mutation expands permissions, credentials, budgets, verifiers, or excluded capability");
    }
  }
  if (candidate.delta.toolRoute.some((tool) => REPAIR_EXCLUDED_TOOLS.includes(tool as typeof REPAIR_EXCLUDED_TOOLS[number]))) {
    throw new Error("Mutation tool route includes an excluded repair tool");
  }
  if (candidate.delta.toolRoute.includes("batch_tool_call")) {
    throw new Error("Mutation must not route excluded tools through batch_tool_call");
  }
  const expectedContentHash = mutationContentHash({
    schemaVersion: 1,
    family: candidate.delta.family,
    targetSubtaskId: candidate.delta.targetSubtaskId,
    instructionPatch: candidate.delta.instructionPatch,
    expectedEffect: candidate.delta.expectedEffect,
    addedEvidenceRefs: candidate.delta.addedEvidenceRefs,
    failureCueIds: candidate.delta.failureCueIds,
    toolRoute: candidate.delta.toolRoute,
    repairPromptVersion: REPAIR_CANDIDATE_PROMPT_VERSION,
  });
  if (candidate.delta.contentHash !== expectedContentHash) {
    throw new Error("Mutation content hash does not cover the complete prompt delta");
  }
  const authorized = new Set(contract.authorizedTools);
  if (candidate.delta.toolRoute.some((tool) => !authorized.has(tool))) {
    throw new Error("Mutation tool route is not a subset of authorizedTools");
  }
  if (new Set(candidate.delta.toolRoute).size !== candidate.delta.toolRoute.length) {
    throw new Error("Mutation tool route contains duplicates");
  }
  if (candidate.delta.failureCueIds.length > 3 ||
    new Set(candidate.delta.failureCueIds).size !== candidate.delta.failureCueIds.length ||
    candidate.delta.failureCueIds.some((id) => !/^[0-9a-f]{64}$/u.test(id))) {
    throw new Error("Mutation failure cue IDs must be zero to three unique content hashes");
  }
  if (candidate.delta.family !== "context_patch" && candidate.delta.failureCueIds.length > 0) {
    throw new Error("Failure cues may alter only the context candidate");
  }
  if (candidate.delta.toolRoute.length !== contract.authorizedTools.length) {
    throw new Error("Mutation tool route must not add or remove authorized tools");
  }
  for (const ref of candidate.delta.addedEvidenceRefs) {
    if (!checkpoint.contextEvidenceRefs.includes(ref)) {
      throw new Error("Mutation evidence is not in the frozen fault bundle");
    }
  }
  if (candidate.delta.family === "control") {
    if (candidate.delta.instructionPatch !== "" || candidate.delta.addedEvidenceRefs.length > 0) {
      throw new Error("Control mutation must have no prompt delta");
    }
    if (candidate.delta.toolRoute.join("\0") !== contract.authorizedTools.join("\0")) {
      throw new Error("Control mutation must not reorder authorized tools");
    }
  }
}

function candidate(
  input: {
    tournamentId: string;
    checkpoint: RepairCheckpoint;
    diagnosis: DiagnosisRecord;
    contract: SubtaskContract;
  },
  family: MutationDelta["family"],
  instructionPatch: string,
  addedEvidenceRefs: string[],
  toolRoute: string[],
  expectedEffect: string,
): MutationCandidate {
  const delta: MutationDelta = {
    family,
    targetSubtaskId: input.contract.subtaskId,
    diagnosisId: input.diagnosis.id,
    addedEvidenceRefs,
    failureCueIds: [],
    instructionPatch,
    toolRoute,
    expectedEffect,
    contentHash: mutationContentHash({
      schemaVersion: 1,
      family,
      targetSubtaskId: input.contract.subtaskId,
      instructionPatch,
      expectedEffect,
      addedEvidenceRefs,
      failureCueIds: [],
      toolRoute,
      repairPromptVersion: REPAIR_CANDIDATE_PROMPT_VERSION,
    }),
  };
  return {
    id: input.tournamentId + "-" + family,
    tournamentId: input.tournamentId,
    checkpointId: input.checkpoint.id,
    delta,
    state: "not_started",
    attemptId: null,
    verificationIds: [],
    modelCalls: 0,
    reservedTokens: 0,
    actualInputTokens: 0,
    actualOutputTokens: 0,
    elapsedMs: 0,
    terminalReason: null,
    historicalMatchRecordId: null,
    historicalVerificationId: null,
    evolutionFingerprints: buildEvolutionFingerprints({
      repositoryBaseHash: input.checkpoint.repositoryBaseHash,
      contractHash: input.checkpoint.contractHash,
      authorityManifestHash: input.checkpoint.authorityManifestHash,
      runtimeCapabilityHash: input.checkpoint.runtimeCapabilityHash,
      faultEvidenceHash: input.checkpoint.faultEvidenceHash,
      mutationContentHash: delta.contentHash,
      runtimeCapabilityComplete: input.checkpoint.fingerprintComplete === true,
    }),
  };
}

export function enrichContextCandidateWithFailureCues(
  candidateValue: MutationCandidate,
  cues: readonly { readonly id: string }[],
  renderedCues: string,
): MutationCandidate {
  if (candidateValue.delta.family !== "context_patch") {
    throw new Error("Failure cues may enrich only the context candidate");
  }
  if (candidateValue.delta.failureCueIds.length > 0) {
    throw new Error("Failure cues may enrich a candidate only once");
  }
  if (cues.length === 0 || renderedCues.trim().length === 0) return candidateValue;
  const failureCueIds = cues.map((cue) => cue.id);
  if (failureCueIds.length > 3 || new Set(failureCueIds).size !== failureCueIds.length) {
    throw new Error("Failure cue enrichment must contain one to three unique cues");
  }
  const instructionPatch = [candidateValue.delta.instructionPatch, renderedCues]
    .filter((value) => value.trim().length > 0)
    .join("\n\n");
  const contentHash = mutationContentHash({
    schemaVersion: 1,
    family: candidateValue.delta.family,
    targetSubtaskId: candidateValue.delta.targetSubtaskId,
    instructionPatch,
    expectedEffect: candidateValue.delta.expectedEffect,
    addedEvidenceRefs: candidateValue.delta.addedEvidenceRefs,
    failureCueIds,
    toolRoute: candidateValue.delta.toolRoute,
    repairPromptVersion: REPAIR_CANDIDATE_PROMPT_VERSION,
  });
  return {
    ...structuredClone(candidateValue),
    delta: {
      ...structuredClone(candidateValue.delta),
      instructionPatch,
      failureCueIds,
      contentHash,
    },
    evolutionFingerprints: candidateValue.evolutionFingerprints === null
      ? null
      : {
          ...candidateValue.evolutionFingerprints,
          mutationContentHash: contentHash,
        },
  };
}

function orderStrategyTools(tools: string[]): string[] {
  const preferred = INSPECT_FIRST.filter((tool) => tools.includes(tool));
  const rest = tools.filter((tool) => !INSPECT_FIRST.includes(tool));
  return [...preferred, ...rest];
}
