import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LAUNCHPAD_MCP_SERVER_SOURCE } from "./launchpad-mcp-server-source.js";

const optionalInt = (minimum: number) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null) return null;
      if (typeof value === "string" && value.trim() === "") return null;
      return value;
    },
    z.coerce.number().int().min(minimum).nullable(),
  ).default(null);

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  WORKSPACE_SOURCE_ROOTS: z.string().default(path.resolve(".")),
  GIT_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  // The proxy buffers a request only up to this cap; a container could
  // otherwise aim an unbounded body at a credential-bearing endpoint.
  MAX_MODEL_REQUEST_BYTES: z.coerce.number().int().min(65_536).default(1_048_576),
  // `app_server` keeps a worker addressable between turns, which is what makes
  // a mid-turn steer possible at all. `exec` is the one-shot backend: still
  // correct, but a message can only reach a worker at its start. Choosing exec
  // is a decision the UI must show as degraded, never a silent fallback.
  CODEX_RUNTIME_MODE: z.enum(["exec", "app_server"]).default("app_server"),
  COORDINATION_PORT: z.coerce.number().int().min(0).max(65_535).default(3002),
  MODEL_PROXY_PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
  ORCHESTRATION_WORKER_TIMEOUT_MS: optionalInt(60_000),
  ORCHESTRATION_MODEL_TIMEOUT_MS: optionalInt(10_000),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  WORKER_DEPENDENCY_CACHE_DIR: z.string().default(path.resolve(".cache/launchpad-workers")),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  // Codex only ships metadata for OpenAI models. Without this it guesses the
  // window and cannot judge when to compact history. It does not silence the
  // "Model metadata not found" diagnostic -- that fires for any unknown slug
  // regardless of this value (verified against Codex 0.111.0).
  ARK_CONTEXT_WINDOW: z.coerce.number().int().positive().optional(),
  // Rates in US dollars per million tokens. Set input and output together --
  // half a rate table produces a misleading number, which is worse than none.
  ARK_PRICE_INPUT: z.coerce.number().nonnegative().optional(),
  ARK_PRICE_OUTPUT: z.coerce.number().nonnegative().optional(),
  ARK_PRICE_CACHED_INPUT: z.coerce.number().nonnegative().optional(),
  ARK_PRICING_LOOKUP: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  // Which API dialect the orchestration model endpoint speaks. "responses" is the
  // OpenAI Responses API (Volcengine Ark). "chat_completions" is OpenAI Chat
  // Completions (OpenRouter and most others). "auto" infers from the base URL.
  ARK_API_FORMAT: z
    .enum(["auto", "responses", "chat_completions"])
    .default("auto"),
  // Off by default: on the reasoning models used here the leader's thinking pass
  // dominates latency and did not improve the plan — measured >600s vs 11.2s on
  // the same request, with the faster run producing the better DAG. Workers keep
  // their own model policy; this only covers planner/evaluator/replanner/
  // synthesizer.
  // Ceilings for the coordination runtime. They are related: a worker's
  // follow-ups are model turns, so the follow-up limit and the token budget have
  // to be chosen against each other, not independently.
  ORCHESTRATION_MAX_TOTAL_TOKENS: optionalInt(10_000),
  ORCHESTRATION_MAX_FOLLOW_UP_TURNS_PER_WORKER: z.coerce.number().int().min(0).default(3),
  ORCHESTRATION_QUIESCENCE_MS: z.coerce.number().int().min(0).default(2_000),
  ORCHESTRATION_PINGPONG_VOLLEYS: z.coerce.number().int().min(2).default(6),
  ORCHESTRATION_HEALING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ORCHESTRATION_VERIFICATION_PROFILE: z.string().default(""),
  VERIFIER_CONTAINER_IMAGE: z.string().min(1).default("node:22-bookworm-slim"),
  VERIFIER_CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(1),
  VERIFIER_CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("512m"),
  VERIFIER_CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(64),
  VERIFIER_CONTAINER_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  VERIFIER_CONTAINER_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1_024).default(1_048_576),
  VERIFIER_CONTAINER_USER: z.string().min(1).default("65534:65534"),
  ORCHESTRATION_MAX_REPAIR_TOURNAMENTS: z.coerce.number().int().positive().default(1),
  ORCHESTRATION_MAX_REPAIR_BRANCHES: z.coerce.number().int().positive().default(3),
  ORCHESTRATION_REPAIR_BRANCH_TIMEOUT_MS: z.coerce.number().int().positive().default(240_000),
  ORCHESTRATION_BUDGET_ADVISORY_TOKENS: optionalInt(1),
  ORCHESTRATION_BUDGET_SEVERE_TOKENS: optionalInt(1),
  ORCHESTRATION_BUDGET_ADVISORY_MODEL_CALLS: optionalInt(1),
  ORCHESTRATION_BUDGET_SEVERE_MODEL_CALLS: optionalInt(1),
  ORCHESTRATION_EMERGENCY_TOKEN_FUSE: optionalInt(1),
  ORCHESTRATION_EMERGENCY_MODEL_CALL_FUSE: optionalInt(1),
  ORCHESTRATION_ROOT_TIMEOUT_MS: optionalInt(1),
  ORCHESTRATION_MAX_RUNTIME_STEPS: optionalInt(1),
  ORCHESTRATION_REPEATED_SIGNATURE_LIMIT: optionalInt(1),
  ORCHESTRATION_TRAJECTORY_CHECKPOINT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  ORCHESTRATION_EVOLUTION_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(16 * 1024 * 1024)
    .max(100 * 1024 * 1024 * 1024)
    .default(1_073_741_824),
  ORCHESTRATION_EVOLUTION_QUERY_LIMIT: z.coerce.number().int().min(1).max(200).default(200),
  // Empty leaves the worker's own model policy alone. Workers do real reading
  // and editing, where the thinking pass may well earn its cost — unlike the
  // leader's, which measurably did not.
  WORKER_REASONING_ENABLED: z.enum(["", "true", "false"]).default(""),
  ORCHESTRATION_REASONING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
}).superRefine((env, context) => {
  if (
    env.ORCHESTRATION_BUDGET_ADVISORY_TOKENS !== null &&
    env.ORCHESTRATION_BUDGET_SEVERE_TOKENS !== null &&
    env.ORCHESTRATION_BUDGET_ADVISORY_TOKENS >= env.ORCHESTRATION_BUDGET_SEVERE_TOKENS
  ) {
    context.addIssue({
      code: "custom",
      message: "token advisory must be below token severe",
    });
  }
  if (
    env.ORCHESTRATION_BUDGET_SEVERE_TOKENS !== null &&
    env.ORCHESTRATION_EMERGENCY_TOKEN_FUSE !== null &&
    env.ORCHESTRATION_BUDGET_SEVERE_TOKENS >= env.ORCHESTRATION_EMERGENCY_TOKEN_FUSE
  ) {
    context.addIssue({
      code: "custom",
      message: "token severe must be below the emergency token fuse",
    });
  }
  if (
    env.ORCHESTRATION_BUDGET_ADVISORY_MODEL_CALLS !== null &&
    env.ORCHESTRATION_BUDGET_SEVERE_MODEL_CALLS !== null &&
    env.ORCHESTRATION_BUDGET_ADVISORY_MODEL_CALLS >= env.ORCHESTRATION_BUDGET_SEVERE_MODEL_CALLS
  ) {
    context.addIssue({
      code: "custom",
      message: "call advisory must be below call severe",
    });
  }
  if (
    env.ORCHESTRATION_BUDGET_SEVERE_MODEL_CALLS !== null &&
    env.ORCHESTRATION_EMERGENCY_MODEL_CALL_FUSE !== null &&
    env.ORCHESTRATION_BUDGET_SEVERE_MODEL_CALLS >= env.ORCHESTRATION_EMERGENCY_MODEL_CALL_FUSE
  ) {
    context.addIssue({
      code: "custom",
      message: "call severe must be below the emergency call fuse",
    });
  }
  if (env.ORCHESTRATION_MAX_REPAIR_TOURNAMENTS !== 1) {
    context.addIssue({
      code: "custom",
      message: "exactly one repair tournament is allowed",
    });
  }
  if (env.ORCHESTRATION_HEALING_ENABLED && env.ORCHESTRATION_MAX_REPAIR_BRANCHES !== 3) {
    context.addIssue({
      code: "custom",
      message: "healing requires exactly three repair branches",
    });
  }
  if (env.ORCHESTRATION_HEALING_ENABLED && env.ORCHESTRATION_VERIFICATION_PROFILE.trim() === "") {
    context.addIssue({
      code: "custom",
      message: "healing requires ORCHESTRATION_VERIFICATION_PROFILE",
    });
  }
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const workspaceRoot = path.resolve(env.AGENT_WORKSPACE_ROOT);
  const workspaceSourceRoots = [
    ...new Set([
      workspaceRoot,
      ...env.WORKSPACE_SOURCE_ROOTS.split(path.delimiter)
        .map((root) => root.trim())
        .filter((root) => root.length > 0)
        .map((root) => path.resolve(root)),
    ]),
  ];
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot,
    workspaceSourceRoots,
    gitCommandTimeoutMs: env.GIT_COMMAND_TIMEOUT_MS,
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    maxModelRequestBytes: env.MAX_MODEL_REQUEST_BYTES,
    modelProxyPort: env.MODEL_PROXY_PORT,
    coordinationPort: env.COORDINATION_PORT,
    codexRuntimeMode: env.CODEX_RUNTIME_MODE,
    orchestrationWorkerTimeoutMs: env.ORCHESTRATION_WORKER_TIMEOUT_MS,
    orchestrationModelTimeoutMs: env.ORCHESTRATION_MODEL_TIMEOUT_MS,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    workerDependencyCacheDir: path.resolve(env.WORKER_DEPENDENCY_CACHE_DIR),
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    arkApiFormat: resolveArkApiFormat(env.ARK_API_FORMAT, env.ARK_BASE_URL),
    orchestrationReasoningEnabled: env.ORCHESTRATION_REASONING_ENABLED,
    orchestrationMaxTotalTokens: env.ORCHESTRATION_MAX_TOTAL_TOKENS,
    orchestrationMaxFollowUpTurnsPerWorker: env.ORCHESTRATION_MAX_FOLLOW_UP_TURNS_PER_WORKER,
    orchestrationQuiescenceMs: env.ORCHESTRATION_QUIESCENCE_MS,
    orchestrationPingPongVolleys: env.ORCHESTRATION_PINGPONG_VOLLEYS,
    orchestrationHealingEnabled: env.ORCHESTRATION_HEALING_ENABLED,
    orchestrationVerificationProfile: env.ORCHESTRATION_VERIFICATION_PROFILE.trim()
      ? path.resolve(env.ORCHESTRATION_VERIFICATION_PROFILE.trim())
      : "",
    verifierContainerImage: env.VERIFIER_CONTAINER_IMAGE,
    verifierContainerCpuLimit: env.VERIFIER_CONTAINER_CPU_LIMIT,
    verifierContainerMemoryLimit: env.VERIFIER_CONTAINER_MEMORY_LIMIT,
    verifierContainerPidsLimit: env.VERIFIER_CONTAINER_PIDS_LIMIT,
    verifierContainerTimeoutMs: env.VERIFIER_CONTAINER_TIMEOUT_MS,
    verifierContainerMaxOutputBytes: env.VERIFIER_CONTAINER_MAX_OUTPUT_BYTES,
    verifierContainerUser: env.VERIFIER_CONTAINER_USER.trim() || "65534:65534",
    orchestrationMaxRepairTournaments: env.ORCHESTRATION_MAX_REPAIR_TOURNAMENTS,
    orchestrationMaxRepairBranches: env.ORCHESTRATION_MAX_REPAIR_BRANCHES,
    orchestrationRepairBranchTimeoutMs: env.ORCHESTRATION_REPAIR_BRANCH_TIMEOUT_MS,
    orchestrationBudgetAdvisoryTokens: env.ORCHESTRATION_BUDGET_ADVISORY_TOKENS,
    orchestrationBudgetSevereTokens: env.ORCHESTRATION_BUDGET_SEVERE_TOKENS,
    orchestrationBudgetAdvisoryModelCalls: env.ORCHESTRATION_BUDGET_ADVISORY_MODEL_CALLS,
    orchestrationBudgetSevereModelCalls: env.ORCHESTRATION_BUDGET_SEVERE_MODEL_CALLS,
    orchestrationEmergencyTokenFuse: env.ORCHESTRATION_EMERGENCY_TOKEN_FUSE,
    orchestrationEmergencyModelCallFuse: env.ORCHESTRATION_EMERGENCY_MODEL_CALL_FUSE,
    orchestrationRootTimeoutMs: env.ORCHESTRATION_ROOT_TIMEOUT_MS,
    orchestrationMaxRuntimeSteps: env.ORCHESTRATION_MAX_RUNTIME_STEPS,
    orchestrationRepeatedSignatureLimit: env.ORCHESTRATION_REPEATED_SIGNATURE_LIMIT,
    orchestrationTrajectoryCheckpointMs: env.ORCHESTRATION_TRAJECTORY_CHECKPOINT_MS,
    orchestrationEvolutionMaxBytes: env.ORCHESTRATION_EVOLUTION_MAX_BYTES,
    orchestrationEvolutionQueryLimit: env.ORCHESTRATION_EVOLUTION_QUERY_LIMIT,
    workerReasoningEnabled:
      env.WORKER_REASONING_ENABLED === "" ? null : env.WORKER_REASONING_ENABLED === "true",
    arkContextWindow: env.ARK_CONTEXT_WINDOW ?? null,
    arkPriceInput: env.ARK_PRICE_INPUT ?? null,
    arkPriceOutput: env.ARK_PRICE_OUTPUT ?? null,
    arkPriceCachedInput: env.ARK_PRICE_CACHED_INPUT ?? null,
    arkPricingLookup: env.ARK_PRICING_LOOKUP,
    nodeEnv: env.NODE_ENV,
  };
}

export type ArkApiFormat = "responses" | "chat_completions";

function resolveArkApiFormat(
  configured: "auto" | ArkApiFormat,
  baseUrl: string,
): ArkApiFormat {
  if (configured !== "auto") return configured;
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = "";
  }
  // OpenRouter (and lookalikes) only implement the Chat Completions API.
  return host.endsWith("openrouter.ai") ? "chat_completions" : "responses";
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const mcpServerPath = path.join(config.codexHome, "launchpad-mcp-server.mjs");
  await writeFile(mcpServerPath, LAUNCHPAD_MCP_SERVER_SOURCE, {
    encoding: "utf8",
    mode: 0o755,
  });
  // Codex spawns MCP servers with a clean environment and does NOT propagate
  // CODEX_HOME to the subprocess. The previous `import(process.env.CODEX_HOME +
  // ...)` form therefore resolved to `import("undefined/...")` and the server
  // never started, so no Launchpad tools/resources ever reached the worker.
  // Emit the absolute path Codex will see at runtime instead. In container mode
  // CODEX_HOME is bind-mounted to /codex-home (see container-codex-runner).
  const inContainer = config.runtimeProvider === "container";
  const mcpServerRuntimePath = inContainer
    ? "/codex-home/launchpad-mcp-server.mjs"
    : mcpServerPath;
  const codexHomeRuntimePath = inContainer ? "/codex-home" : config.codexHome;
  const dataDirRuntimePath = inContainer ? "/launchpad-data" : config.dataDirectory;
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    ...(config.arkContextWindow === null
      ? []
      : ["model_context_window = " + config.arkContextWindow]),
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
    // Codex spawns MCP servers with only HOME and PATH, so the server path
    // cannot be built from `$CODEX_HOME` at spawn time. Runners additionally
    // override these per run (see `mcpConfigOverrides`) to inject the run
    // context the server needs; this baseline is what a manual `codex` run in
    // this CODEX_HOME gets.
    "[mcp_servers.launchpad]",
    'command = "node"',
    "args = " + JSON.stringify([mcpServerRuntimePath]),
    "",
    // Only HOME and PATH are inherited, so the server reads none of its run
    // context unless it is named here. Without LAUNCHPAD_DATA_DIR it silently
    // falls back to `<cwd>/.launchpad` — the worker's own private directory —
    // and every "shared" whiteboard post lands where no sibling can read it.
    "[mcp_servers.launchpad.env]",
    "CODEX_HOME = " + JSON.stringify(codexHomeRuntimePath),
    "LAUNCHPAD_DATA_DIR = " + JSON.stringify(dataDirRuntimePath),
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
