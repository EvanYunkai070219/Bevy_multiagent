import { execFile } from "node:child_process";
import type { AppConfig } from "../config.js";
import type { ExecutionPolicy } from "../types.js";
import type { RepairRuntimeCapabilityEnvironmentV1 } from "./evolution/evolution-types.js";
import { canonicalHash } from "./evolution/evolution-fingerprints.js";
import { launchpadRuntimeToolSchemas } from "./runtime-tool-schemas.js";

export const HARNESS_VERSION = "orchestration-1";
export const PLANNER_PROMPT_VERSION = "planner-v1";
export const EVALUATOR_PROMPT_VERSION = "evaluator-v1";
export const REPLANNER_PROMPT_VERSION = "replanner-v1";
export const SYNTHESIZER_PROMPT_VERSION = "synthesizer-v1";
export const REPAIR_CANDIDATE_PROMPT_VERSION = "repair-candidate-v1";
export const DIAGNOSER_PROMPT_VERSION = "diagnoser-v1";
const IMMUTABLE_IMAGE_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type ContainerImageInspector = (
  engine: string,
  configuredImage: string,
) => Promise<string | null>;

export function repairRuntimeCapabilityEnvironmentFromConfig(
  config: AppConfig,
  resolvedContainerImageId: string | null = null,
): RepairRuntimeCapabilityEnvironmentV1 {
  const effectiveSandboxMode =
    config.runtimeProvider === "container" && config.codexSandboxMode === "workspace-write"
      ? "danger-full-access"
      : config.codexSandboxMode;
  return Object.freeze({
    schemaVersion: 1,
    modelId: config.arkModel,
    runtimeMode: config.runtimeProvider + ":" + config.codexRuntimeMode,
    toolSchemas: launchpadRuntimeToolSchemas(),
    sandboxPolicyHash: canonicalHash({
      schemaVersion: 1,
      runtimeProvider: config.runtimeProvider,
      sandboxMode: effectiveSandboxMode,
      repairCandidate: {
        coordination: false,
        commonWorkspace: false,
        nestedAgents: false,
        externalWriteCredentials: false,
      },
      container: config.runtimeProvider === "container"
        ? {
            cpuLimit: config.containerCpuLimit,
            memoryLimit: config.containerMemoryLimit,
            pidsLimit: config.containerPidsLimit,
            user: config.containerUser,
          }
        : null,
    }),
    containerImageId:
      config.runtimeProvider === "container" ? resolvedContainerImageId : null,
  });
}

export async function resolveRepairRuntimeCapabilityEnvironment(
  config: AppConfig,
  inspectImage: ContainerImageInspector = inspectContainerImage,
): Promise<RepairRuntimeCapabilityEnvironmentV1> {
  if (config.runtimeProvider !== "container") {
    return repairRuntimeCapabilityEnvironmentFromConfig(config, null);
  }
  let resolved: string | null = null;
  try {
    const candidate = (await inspectImage(
      config.containerEngine,
      config.containerRuntimeImage,
    ))?.trim() ?? "";
    if (IMMUTABLE_IMAGE_PATTERN.test(candidate)) resolved = candidate;
  } catch {
    resolved = null;
  }
  return repairRuntimeCapabilityEnvironmentFromConfig(config, resolved);
}

async function inspectContainerImage(engine: string, configuredImage: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      engine,
      ["image", "inspect", "--format={{.Id}}", configuredImage],
      { encoding: "utf8", timeout: 5_000, env: hostEngineEnv() },
      (error, stdout) => error ? reject(error) : resolve(stdout.trim()),
    );
  });
}

function hostEngineEnv(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  for (const name of ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "XDG_RUNTIME_DIR"] as const) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

export const defaultExecutionPolicy: ExecutionPolicy = {
  // Kept at maxSubtasks: a wave narrower than the plan it was given strands the
  // subtasks that do not fit, and a plan whose members expect each other to be
  // running cannot progress once one is left out.
  maxParallel: 10,
  // A subtask runs exactly once, so a task needing N ordered steps needs N
  // subtasks. At 5 the countdown could only reach 6 of 10 — the plan was correct
  // and simply ran out of room.
  //
  // 12 traded one ceiling for another: the planner's JSON failed validation on
  // `subtasks[0].prompt`, the repair pass failed too, and the run fell back to a
  // single agent after 250s of planning. Longer structured output is less
  // reliable output. 10 is where a bounded plan still fits and the model still
  // returns it correctly. The structural limit is untouched — a subtask cannot
  // loop, so an unbounded rotation remains inexpressible at any cap.
  maxSubtasks: 10,
  maxIterations: 2,
  // Must exceed maxSubtasks, or a single full-width plan consumes the entire
  // budget and leaves nothing for a replan.
  maxTotalWorkerRuns: 30,
  workerTimeoutMs: null,
  workerSessionPolicy: "fresh",
  // A planner labels every peer "worker", so keying identity on the role slug
  // collapsed a five-agent plan into one agent run five times — the delegation
  // was real, the cast was not.
  workerIdentityPolicy: "per_subtask",
  quiescenceMs: 2_000,
  // A spending cap, not a brake: the anomaly detector is what tells a productive
  // exchange from a courteous loop.
  maxFollowUpTurnsPerWorker: 3,
  workerWorkspacePolicy: "fresh_task_scoped",
  maxRepairTournaments: 1,
  maxRepairBranches: 3,
  repairBranchTimeoutMs: 4 * 60 * 1000,
  budgetAdvisoryTokens: null,
  budgetSevereTokens: null,
  budgetAdvisoryModelCalls: null,
  budgetSevereModelCalls: null,
  emergencyTokenFuse: null,
  emergencyModelCallFuse: null,
  rootTimeoutMs: null,
  maxRuntimeSteps: null,
  repeatedSignatureLimit: null,
  trajectoryCheckpointMs: 60_000,
};

export function executionPolicyFromConfig(config: AppConfig): ExecutionPolicy {
  return {
    ...defaultExecutionPolicy,
    workerTimeoutMs: config.orchestrationWorkerTimeoutMs,
    quiescenceMs: config.orchestrationQuiescenceMs,
    maxFollowUpTurnsPerWorker: config.orchestrationMaxFollowUpTurnsPerWorker,
    maxRepairTournaments: config.orchestrationMaxRepairTournaments,
    maxRepairBranches: config.orchestrationMaxRepairBranches,
    repairBranchTimeoutMs: config.orchestrationRepairBranchTimeoutMs,
    budgetAdvisoryTokens: config.orchestrationBudgetAdvisoryTokens,
    budgetSevereTokens: config.orchestrationBudgetSevereTokens,
    budgetAdvisoryModelCalls: config.orchestrationBudgetAdvisoryModelCalls,
    budgetSevereModelCalls: config.orchestrationBudgetSevereModelCalls,
    emergencyTokenFuse: config.orchestrationEmergencyTokenFuse,
    emergencyModelCallFuse: config.orchestrationEmergencyModelCallFuse,
    rootTimeoutMs: config.orchestrationRootTimeoutMs,
    maxRuntimeSteps: config.orchestrationMaxRuntimeSteps,
    repeatedSignatureLimit: config.orchestrationRepeatedSignatureLimit,
    trajectoryCheckpointMs: config.orchestrationTrajectoryCheckpointMs,
  };
}
