/** Covers the generated Codex provider config across OpenAI-compatible APIs. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, writeCodexConfig } from "../src/config.js";
import { defaultExecutionPolicy, executionPolicyFromConfig } from "../src/orchestration/policies.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function generate(
  environment: Record<string, string>,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codex-config-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    CODEX_HOME: root,
    ARK_API_KEY: "test-key",
    ...environment,
  });
  await writeCodexConfig(config);
  return readFile(path.join(root, "config.toml"), "utf8");
}

describe("Codex provider config", () => {
  it("defaults worker coordination to the live app-server runtime", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.codexRuntimeMode).toBe("app_server");
  });

  it("uses the Responses wire API", async () => {
    const toml = await generate({ ARK_MODEL: "ep-test" });
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('model = "ep-test"');
    expect(toml).toContain("[mcp_servers.launchpad]");
    expect(toml).toContain("launchpad-mcp-server.mjs");
  });

  it("launches the MCP server by absolute path, not via process.env.CODEX_HOME", async () => {
    const toml = await generate({ ARK_MODEL: "ep-test" });
    // Codex spawns the MCP subprocess without CODEX_HOME, so the old
    // import(process.env.CODEX_HOME + ...) form resolved to "undefined/..." and
    // the server never started. The command must carry the absolute path itself.
    expect(toml).not.toContain("process.env.CODEX_HOME");
    expect(toml).toMatch(/args = \[.*launchpad-mcp-server\.mjs.*\]/);
  });

  it("uses the in-container MCP path for the container runtime", async () => {
    const toml = await generate({
      ARK_MODEL: "ep-test",
      RUNTIME_PROVIDER: "container",
    });
    expect(toml).toContain("/codex-home/launchpad-mcp-server.mjs");
    expect(toml).not.toContain("process.env.CODEX_HOME");
  });

  it("points Codex at whichever base URL is configured", async () => {
    const toml = await generate({
      ARK_MODEL: "deepseek/deepseek-chat",
      ARK_BASE_URL: "https://openrouter.ai/api/v1",
    });
    expect(toml).toContain('base_url = "https://openrouter.ai/api/v1"');
    expect(toml).toContain('model = "deepseek/deepseek-chat"');
  });

  it("keeps reading the key from the environment rather than the file", async () => {
    const toml = await generate({ ARK_MODEL: "ep-test" });
    expect(toml).toContain('env_key = "ARK_API_KEY"');
    expect(toml).not.toContain("test-key");
  });

  it("strips a trailing slash from the base URL", async () => {
    const toml = await generate({
      ARK_MODEL: "gpt-4o-mini",
      ARK_BASE_URL: "https://openrouter.ai/api/v1/",
    });
    expect(toml).toContain('base_url = "https://openrouter.ai/api/v1"');
  });

  it("omits the context window when it is not configured", async () => {
    const toml = await generate({ ARK_MODEL: "ep-test" });
    expect(toml).not.toContain("model_context_window");
  });

  it("declares the context window so Codex stops guessing model metadata", async () => {
    const toml = await generate({
      ARK_MODEL: "deepseek/deepseek-chat",
      ARK_BASE_URL: "https://openrouter.ai/api/v1",
      ARK_CONTEXT_WINDOW: "131072",
    });
    expect(toml).toContain("model_context_window = 131072");
  });
});

describe("pricing configuration", () => {
  const base = { NODE_ENV: "test", ARK_MODEL: "ep-test" } as const;

  it("defaults to no configured rates and lookup enabled", () => {
    const config = loadConfig({ ...base });
    expect(config.arkPriceInput).toBeNull();
    expect(config.arkPriceOutput).toBeNull();
    expect(config.arkPriceCachedInput).toBeNull();
    expect(config.arkPricingLookup).toBe(true);
  });

  it("reads all three rates", () => {
    const config = loadConfig({
      ...base,
      ARK_PRICE_INPUT: "0.04",
      ARK_PRICE_OUTPUT: "0.08",
      ARK_PRICE_CACHED_INPUT: "0.008",
    });
    expect(config.arkPriceInput).toBe(0.04);
    expect(config.arkPriceOutput).toBe(0.08);
    expect(config.arkPriceCachedInput).toBe(0.008);
  });

  it("can disable the lookup", () => {
    expect(loadConfig({ ...base, ARK_PRICING_LOOKUP: "false" }).arkPricingLookup)
      .toBe(false);
  });

  it("rejects a negative rate", () => {
    expect(() => loadConfig({ ...base, ARK_PRICE_INPUT: "-1" })).toThrow();
  });
});

describe("orchestration configuration", () => {
  const base = { NODE_ENV: "test", ARK_MODEL: "ep-test" } as const;

  it("defaults orchestration timeout fuses off", () => {
    const config = loadConfig(base);
    expect(config.orchestrationWorkerTimeoutMs).toBeNull();
    expect(config.orchestrationModelTimeoutMs).toBeNull();
  });

  it("defaults evolution storage to a 1 GiB quota and 200-record query bound", () => {
    const config = loadConfig(base);
    expect(config.orchestrationEvolutionMaxBytes).toBe(1_073_741_824);
    expect(config.orchestrationEvolutionQueryLimit).toBe(200);
  });

  it("accepts only bounded evolution storage and query limits", () => {
    const config = loadConfig({
      ...base,
      ORCHESTRATION_EVOLUTION_MAX_BYTES: String(16 * 1024 * 1024),
      ORCHESTRATION_EVOLUTION_QUERY_LIMIT: "1",
    });
    expect(config.orchestrationEvolutionMaxBytes).toBe(16 * 1024 * 1024);
    expect(config.orchestrationEvolutionQueryLimit).toBe(1);
    expect(() => loadConfig({ ...base, ORCHESTRATION_EVOLUTION_MAX_BYTES: String(16 * 1024 * 1024 - 1) })).toThrow();
    expect(() => loadConfig({ ...base, ORCHESTRATION_EVOLUTION_MAX_BYTES: String(100 * 1024 * 1024 * 1024 + 1) })).toThrow();
    expect(() => loadConfig({ ...base, ORCHESTRATION_EVOLUTION_QUERY_LIMIT: "201" })).toThrow();
  });

  it("reads orchestration timeout overrides", () => {
    const config = loadConfig({
      ...base,
      ORCHESTRATION_WORKER_TIMEOUT_MS: "1200000",
      ORCHESTRATION_MODEL_TIMEOUT_MS: "45000",
    });
    expect(config.orchestrationWorkerTimeoutMs).toBe(1_200_000);
    expect(config.orchestrationModelTimeoutMs).toBe(45_000);
  });

  it("configures a shared worker dependency cache", () => {
    const config = loadConfig({
      ...base,
      WORKER_DEPENDENCY_CACHE_DIR: "./tmp/worker-cache",
    });

    expect(config.workerDependencyCacheDir).toBe(path.resolve("./tmp/worker-cache"));
  });

  it("defaults healing off with orchestration fuses disabled", () => {
    const config = loadConfig(base);
    expect(config.orchestrationHealingEnabled).toBe(false);
    expect(config.orchestrationMaxRepairTournaments).toBe(1);
    expect(config.orchestrationMaxRepairBranches).toBe(3);
    expect(config.orchestrationRepairBranchTimeoutMs).toBe(240_000);
    expect(config.orchestrationBudgetAdvisoryTokens).toBeNull();
    expect(config.orchestrationBudgetSevereTokens).toBeNull();
    expect(config.orchestrationBudgetAdvisoryModelCalls).toBeNull();
    expect(config.orchestrationBudgetSevereModelCalls).toBeNull();
    expect(config.orchestrationEmergencyTokenFuse).toBeNull();
    expect(config.orchestrationEmergencyModelCallFuse).toBeNull();
    expect(config.orchestrationRootTimeoutMs).toBeNull();
    expect(config.orchestrationMaxRuntimeSteps).toBeNull();
    expect(config.orchestrationRepeatedSignatureLimit).toBeNull();
    expect(config.orchestrationTrajectoryCheckpointMs).toBe(60_000);
  });

  it("copies healing budget fields onto execution policy without changing collaboration ceilings", () => {
    const policy = executionPolicyFromConfig(loadConfig(base));
    expect(policy.maxParallel).toBe(10);
    expect(policy.maxSubtasks).toBe(10);
    expect(policy.maxIterations).toBe(2);
    expect(policy.maxTotalWorkerRuns).toBe(30);
    expect(policy.maxFollowUpTurnsPerWorker).toBe(3);
    expect(policy.workerTimeoutMs).toBeNull();
    expect(policy.emergencyTokenFuse).toBeNull();
    expect(policy.rootTimeoutMs).toBeNull();
    expect(defaultExecutionPolicy.maxParallel).toBe(10);
    expect(defaultExecutionPolicy.maxSubtasks).toBe(10);
  });

  it("rejects token thresholds that are not advisory < severe < emergency", () => {
    expect(() => loadConfig({
      ...base,
      ORCHESTRATION_BUDGET_ADVISORY_TOKENS: "1000",
      ORCHESTRATION_BUDGET_SEVERE_TOKENS: "1000",
      ORCHESTRATION_EMERGENCY_TOKEN_FUSE: "2000",
    })).toThrow();
    expect(() => loadConfig({
      ...base,
      ORCHESTRATION_BUDGET_ADVISORY_TOKENS: "500",
      ORCHESTRATION_BUDGET_SEVERE_TOKENS: "400",
      ORCHESTRATION_EMERGENCY_TOKEN_FUSE: "2000",
    })).toThrow();
  });

  it("rejects call thresholds that are not advisory < severe < emergency", () => {
    expect(() => loadConfig({
      ...base,
      ORCHESTRATION_BUDGET_ADVISORY_MODEL_CALLS: "24",
      ORCHESTRATION_BUDGET_SEVERE_MODEL_CALLS: "24",
      ORCHESTRATION_EMERGENCY_MODEL_CALL_FUSE: "100",
    })).toThrow();
    expect(() => loadConfig({
      ...base,
      ORCHESTRATION_BUDGET_ADVISORY_MODEL_CALLS: "50",
      ORCHESTRATION_BUDGET_SEVERE_MODEL_CALLS: "40",
      ORCHESTRATION_EMERGENCY_MODEL_CALL_FUSE: "100",
    })).toThrow();
  });

  it("rejects non-positive horizons", () => {
    expect(() => loadConfig({ ...base, ORCHESTRATION_ROOT_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadConfig({ ...base, ORCHESTRATION_WORKER_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadConfig({ ...base, ORCHESTRATION_MODEL_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadConfig({ ...base, ORCHESTRATION_REPAIR_BRANCH_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadConfig({ ...base, ORCHESTRATION_MAX_RUNTIME_STEPS: "0" })).toThrow();
    expect(() => loadConfig({ ...base, ORCHESTRATION_REPEATED_SIGNATURE_LIMIT: "0" })).toThrow();
    expect(() => loadConfig({ ...base, ORCHESTRATION_TRAJECTORY_CHECKPOINT_MS: "0" })).toThrow();
    expect(() => loadConfig({ ...base, ORCHESTRATION_TRAJECTORY_CHECKPOINT_MS: "500" })).toThrow();
  });

  it("kills mutation: allow a fourth candidate or second tournament", () => {
    expect(() => loadConfig({
      ...base,
      ORCHESTRATION_HEALING_ENABLED: "true",
      ORCHESTRATION_MAX_REPAIR_BRANCHES: "2",
    })).toThrow();
    expect(() => loadConfig({
      ...base,
      ORCHESTRATION_MAX_REPAIR_TOURNAMENTS: "2",
    })).toThrow();
    expect(loadConfig({
      ...base,
      ORCHESTRATION_HEALING_ENABLED: "true",
      ORCHESTRATION_MAX_REPAIR_BRANCHES: "3",
      ORCHESTRATION_VERIFICATION_PROFILE: "/tmp/authority/profile.json",
    }).orchestrationHealingEnabled).toBe(true);
    expect(loadConfig({
      ...base,
      ORCHESTRATION_HEALING_ENABLED: "false",
      ORCHESTRATION_MAX_REPAIR_BRANCHES: "2",
    }).orchestrationMaxRepairBranches).toBe(2);
  });

  it("kills mutation: permit absent trusted authority while healing is enabled", () => {
    expect(() => loadConfig({
      ...base,
      ORCHESTRATION_HEALING_ENABLED: "true",
    })).toThrow(/ORCHESTRATION_VERIFICATION_PROFILE|verification profile/i);
    const off = loadConfig(base);
    expect(off.orchestrationHealingEnabled).toBe(false);
    expect(off.orchestrationVerificationProfile).toBe("");
    const on = loadConfig({
      ...base,
      ORCHESTRATION_HEALING_ENABLED: "true",
      ORCHESTRATION_VERIFICATION_PROFILE: "/opt/launchpad/authority/profile.json",
    });
    expect(on.orchestrationVerificationProfile).toBe(
      path.resolve("/opt/launchpad/authority/profile.json"),
    );
  });

  it("reads bounded verifier container settings", () => {
    const defaults = loadConfig(base);
    expect(defaults.verifierContainerImage).toBe("node:22-bookworm-slim");
    expect(defaults.verifierContainerCpuLimit).toBe(1);
    expect(defaults.verifierContainerMemoryLimit).toBe("512m");
    expect(defaults.verifierContainerPidsLimit).toBe(64);
    expect(defaults.verifierContainerTimeoutMs).toBe(60_000);
    expect(defaults.verifierContainerMaxOutputBytes).toBe(1_048_576);
    expect(defaults.verifierContainerUser).toBe("65534:65534");
    const overridden = loadConfig({
      ...base,
      VERIFIER_CONTAINER_IMAGE: "node:20-alpine",
      VERIFIER_CONTAINER_CPU_LIMIT: "2",
      VERIFIER_CONTAINER_MEMORY_LIMIT: "256m",
      VERIFIER_CONTAINER_PIDS_LIMIT: "16",
      VERIFIER_CONTAINER_TIMEOUT_MS: "15000",
      VERIFIER_CONTAINER_MAX_OUTPUT_BYTES: "65536",
      VERIFIER_CONTAINER_USER: "1000:1000",
    });
    expect(overridden.verifierContainerImage).toBe("node:20-alpine");
    expect(overridden.verifierContainerCpuLimit).toBe(2);
    expect(overridden.verifierContainerMemoryLimit).toBe("256m");
    expect(overridden.verifierContainerPidsLimit).toBe(16);
    expect(overridden.verifierContainerTimeoutMs).toBe(15_000);
    expect(overridden.verifierContainerMaxOutputBytes).toBe(65_536);
    expect(overridden.verifierContainerUser).toBe("1000:1000");
  });
});

describe("workspace source configuration", () => {
  it("resolves, deduplicates, and ignores empty workspace source roots", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      AGENT_WORKSPACE_ROOT: "./workspaces-root",
      WORKSPACE_SOURCE_ROOTS: ["", "./fixtures", "", "./other", "./fixtures", ""].join(
        path.delimiter,
      ),
    });

    expect(config.workspaceSourceRoots).toEqual([
      path.resolve("./workspaces-root"),
      path.resolve("./fixtures"),
      path.resolve("./other"),
    ]);
  });

  it("always admits the agent workspace root so managed Projects can start runs", () => {
    const workspaceRoot = path.resolve("/tmp/launchpad-managed-workspaces");
    const externalRoot = path.resolve("./fixtures");
    const config = loadConfig({
      NODE_ENV: "test",
      AGENT_WORKSPACE_ROOT: workspaceRoot,
      WORKSPACE_SOURCE_ROOTS: externalRoot,
    });

    expect(config.workspaceSourceRoots).toEqual([workspaceRoot, externalRoot]);
  });

  it("bounds git command timeouts", () => {
    expect(loadConfig({ NODE_ENV: "test" }).gitCommandTimeoutMs).toBe(15_000);
    expect(
      loadConfig({ NODE_ENV: "test", GIT_COMMAND_TIMEOUT_MS: "15000" })
        .gitCommandTimeoutMs,
    ).toBe(15_000);
    expect(() => loadConfig({ NODE_ENV: "test", GIT_COMMAND_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadConfig({ NODE_ENV: "test", GIT_COMMAND_TIMEOUT_MS: "60001" })).toThrow();
  });
});
