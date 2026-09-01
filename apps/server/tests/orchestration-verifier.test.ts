import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { EvidenceStore } from "../src/orchestration/verification/evidence-store.js";
import { GitClient } from "../src/git-client.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { REDACTED } from "../src/redact.js";
import { RunControl, RunTerminalError } from "../src/orchestration/run-control.js";
import type { VerificationContainerOutcome } from "../src/orchestration/verification/verification-container.js";
import { VerificationProfileRegistry } from "../src/orchestration/verification/verification-profile.js";
import { createVerificationAuthority, VerificationRunner } from "../src/orchestration/verification/verifier.js";
import {
  demoContract,
  materializeAuthority,
} from "./verification-authority-fixtures.js";
import { realVerificationFixture } from "./verification-container-fixtures.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type FakeContainer = {
  calls: string[];
  run: (input: {
    gate: { id: string };
    control: RunControl;
  }) => Promise<VerificationContainerOutcome>;
};

async function initCandidateRepo(workspace: string, git: GitClient): Promise<string> {
  await git.run(workspace, ["init", "-b", "main"]);
  await git.run(workspace, ["config", "user.name", "Test"]);
  await git.run(workspace, ["config", "user.email", "test@example.invalid"]);
  await git.run(workspace, ["add", "--", "src/app.ts"]);
  await git.run(workspace, ["commit", "-m", "base"]);
  return git.head(workspace);
}

async function loadedRunner(container: FakeContainer) {
  const sandbox = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-"));
  directories.push(sandbox);
  const authorityRoot = path.join(sandbox, "authority");
  const workspace = path.join(sandbox, "candidate");
  const dataDirectory = path.join(sandbox, "data");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(path.join(workspace, "src", "app.ts"), "export const ok = true;\n", "utf8");
  const profilePath = await materializeAuthority(authorityRoot);
  const registry = new VerificationProfileRegistry({
    profilePath,
    workspaceRoot: path.join(sandbox, "workspaces"),
    workspaceSourceRoots: [path.join(sandbox, "sources")],
    eventSessionRoot: path.join(sandbox, "event"),
    projectRepositories: [],
    runsDirectories: [path.join(sandbox, ".runs")],
  });
  await mkdir(path.join(sandbox, "workspaces"), { recursive: true });
  await mkdir(path.join(sandbox, "sources"), { recursive: true });
  await mkdir(path.join(sandbox, "event"), { recursive: true });
  await mkdir(path.join(sandbox, ".runs"), { recursive: true });
  await registry.load();
  const store = new EvidenceStore({
    dataDirectory,
    secrets: ["sk-provider-live-key", "run-token-abc", authorityRoot],
  });
  const git = new GitClient(5_000);
  const baseCommit = await initCandidateRepo(workspace, git);
  const runner = new VerificationRunner({ registry, container, store, git });
  return { runner, registry, store, workspace, sandbox, authorityRoot, baseCommit, git, dataDirectory };
}

function recordingContainer(exitCode = 0, stdout = "gate"): FakeContainer {
  const calls: string[] = [];
  return {
    calls,
    async run(input) {
      input.control.assertActive();
      calls.push(input.gate.id);
      return {
        kind: "command_exit",
        exitCode,
        stdout: new TextEncoder().encode(stdout + " " + input.gate.id + " sk-provider-live-key"),
        stderr: new Uint8Array(),
        elapsedMs: 2,
      };
    },
  };
}

type VerifyInput = Parameters<VerificationRunner["verify"]>[0];

function verifyInput(
  workspace: string,
  baseCommit: string,
  overrides: Partial<VerifyInput> = {},
): VerifyInput {
  return {
    subjectType: "contribution",
    subjectId: "contrib-1",
    stage: "pre_integration",
    workspacePath: workspace,
    contract: demoContract(),
    control: new RunControl(defaultExecutionPolicy),
    baseCommit,
    ...overrides,
  };
}

describe("VerificationRunner", () => {
  it("cannot be constructed without an authority registry, container, and evidence store", () => {
    expect(() => new (VerificationRunner as unknown as { new (): VerificationRunner })()).toThrow(
      /authority/i,
    );
  });

  it("runs integrity first, then stage-appropriate gates, and fingerprints held-out and mutant ids", async () => {
    const container = recordingContainer();
    const { runner, workspace, registry, baseCommit } = await loadedRunner(container);
    const result = await runner.verify(verifyInput(workspace, baseCommit));
    expect(result.gates[0]?.tier).toBe("integrity");
    expect(result.gates[0]?.passed).toBe(true);
    expect(container.calls).toEqual([
      "targeted",
      "contract",
      "consumer",
      "held-out",
      "required-field",
      "regression",
    ]);
    const publicContract = result.gates.find((gate) => gate.tier === "contract");
    expect(publicContract?.gateId).toBe("contract");
    const held = result.gates.find((gate) => gate.tier === "held_out");
    expect(held?.gateId).toMatch(/^held:[0-9a-f]{64}$/);
    const mutant = result.gates.find((gate) => gate.tier === "mutation_quality");
    expect(mutant?.gateId).toMatch(/^held:[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain("held-out");
    expect(JSON.stringify(result)).not.toContain("required-field");
    expect(result.authorityManifestHash).toBe(registry.profile().contentHash);
    expect(result.mandatoryPassed).toBe(true);
    expect(result.modelCalls).toBe(0);
  });

  it("does not run a partial pre-integration batch when mandatory public tiers are omitted", async () => {
    const container = recordingContainer();
    const { runner, workspace, baseCommit } = await loadedRunner(container);
    const result = await runner.verify(
      verifyInput(workspace, baseCommit, {
        contract: demoContract({
          targetedGateIds: ["targeted"],
          contractGateIds: [],
          consumerGateIds: [],
          regressionGateIds: [],
        }),
      }),
    );
    expect(result.mandatoryPassed).toBe(false);
    expect(container.calls).toEqual([]);
  });

  it("fails closed when a runtime contract omits or names unknown mandatory gates", async () => {
    const container = recordingContainer();
    const { runner, workspace, baseCommit } = await loadedRunner(container);
    const empty = await runner.verify(
      verifyInput(workspace, baseCommit, {
        subjectType: "candidate",
        stage: "candidate",
        contract: demoContract({ targetedGateIds: [], contractGateIds: [] }),
      }),
    );
    expect(empty.mandatoryPassed).toBe(false);
    expect(container.calls).toEqual([]);

    const unknown = await runner.verify(
      verifyInput(workspace, baseCommit, {
        subjectId: "unknown-contract-gate",
        subjectType: "candidate",
        stage: "candidate",
        contract: demoContract({ targetedGateIds: ["not-in-authority"] }),
      }),
    );
    expect(unknown.mandatoryPassed).toBe(false);
    expect(container.calls).toEqual([]);
  });

  it("fails closed when candidate verification omits the targeted tier but retains contract gates", async () => {
    const container = recordingContainer();
    const { runner, workspace, baseCommit } = await loadedRunner(container);
    const result = await runner.verify(
      verifyInput(workspace, baseCommit, {
        subjectType: "candidate",
        stage: "candidate",
        contract: demoContract({ targetedGateIds: [], contractGateIds: ["contract"] }),
      }),
    );
    expect(result.mandatoryPassed).toBe(false);
    expect(container.calls).toEqual([]);
  });

  it("runs the post-integration gate only at the post_integration stage", async () => {
    const container = recordingContainer();
    const { runner, workspace, baseCommit } = await loadedRunner(container);
    await runner.verify(
      verifyInput(workspace, baseCommit, {
        subjectType: "promoted",
        subjectId: "head-1",
        stage: "post_integration",
      }),
    );
    expect(container.calls.at(-1)).toBe("post-integration");
    expect(container.calls).toContain("regression");
    expect(container.calls).not.toContain("targeted");
  });

  it("distinguishes a deterministic gate failure from a container authority failure", async () => {
    const failing = recordingContainer(1);
    const { runner, workspace, baseCommit } = await loadedRunner(failing);
    const failed = await runner.verify(verifyInput(workspace, baseCommit, { subjectId: "contrib-fail" }));
    expect(failed).toMatchObject({
      mandatoryPassed: false,
      failureKind: "deterministic_gate_failure",
    });

    const throwing: FakeContainer = {
      calls: [],
      async run() {
        throw new Error("gate exploded");
      },
    };
    const { runner: broken, workspace: brokenWorkspace, baseCommit: brokenBase } = await loadedRunner(throwing);
    const malformed = await broken.verify(
      verifyInput(brokenWorkspace, brokenBase, {
        subjectType: "candidate",
        subjectId: "cand-1",
        stage: "candidate",
      }),
    );
    expect(malformed).toMatchObject({
      mandatoryPassed: false,
      failureKind: "authority_failure",
    });
  });

  it.each([
    {
      label: "candidate command exit",
      behavior: { gateExitCode: 7, runStderr: "candidate tests failed\n" },
      config: {},
      engine: undefined,
      failureKind: "deterministic_gate_failure",
    },
    {
      label: "numeric engine/daemon/init failure",
      behavior: { engineExitCode: 125 },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "unwrapped numeric success",
      behavior: { engineExitCode: 0 },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "bare reserved success without origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "missing" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "bare reserved failure without origin artifact",
      behavior: { engineExitCode: 201, completionArtifact: "missing" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "malformed origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "malformed" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "missing-field origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "missing_field" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "extra-field origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "extra_field" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "wrong-version origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "wrong_version" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "wrong-nonce origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "wrong_nonce" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "disagreeing origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "wrong_exit" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "invalid-exit origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "invalid_exit" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "wrong-mode origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "wrong_mode" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "symlink origin artifact",
      behavior: { engineExitCode: 200, completionArtifact: "symlink" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "trailing origin artifact state",
      behavior: { engineExitCode: 200, completionArtifact: "trailing" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "unconsumed origin request",
      behavior: { engineExitCode: 200, completionArtifact: "request_retained" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "retained origin publication temp",
      behavior: { engineExitCode: 200, completionArtifact: "temp_retained" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "request copy failure",
      behavior: { requestCopyFails: true },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "created-state inspection failure",
      behavior: { inspectFailsOnceAt: "created" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "start/attach failure",
      behavior: { startFails: true },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "stopped-state inspection failure",
      behavior: { inspectFailsOnceAt: "exited" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "artifact copy failure",
      behavior: { artifactCopyFails: true },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "wrong-type completion volume",
      behavior: { completionMountMutation: "wrong_type" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "read-only completion volume",
      behavior: { completionMountMutation: "read_only" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "invalid-name completion volume",
      behavior: { completionMountMutation: "invalid_name" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "replaced completion volume",
      behavior: { completionMountMutation: "changed_after_start" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "reserved-invalid wrapper code",
      behavior: { engineExitCode: 202 },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "engine signal with null numeric exit",
      behavior: { engineSignal: "TERM" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "malformed trailing legacy protocol state",
      behavior: { engineExitCode: 0, runStdout: "\u001e{not-json}\ntrailing-bytes" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "engine spawn failure",
      behavior: undefined,
      config: {},
      engine: "missing",
      failureKind: "authority_failure",
    },
    {
      label: "outer wall timeout",
      behavior: { runDelaySeconds: 2 },
      config: { VERIFIER_CONTAINER_TIMEOUT_MS: "1000" },
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "outer output limit",
      behavior: { runStdout: "x".repeat(2_048) },
      config: { VERIFIER_CONTAINER_MAX_OUTPUT_BYTES: "1024" },
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "slow ownership resolution inside the shared deadline",
      behavior: { inspectDelayAt: "created", inspectDelayOnce: true, inspectDelaySeconds: 2 },
      config: { VERIFIER_CONTAINER_TIMEOUT_MS: "1000" },
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "oversized ownership resolution inside the shared output ceiling",
      behavior: { inspectOutputAt: "created", inspectOutputBytes: 16_384, inspectOutputOnce: true },
      config: { VERIFIER_CONTAINER_MAX_OUTPUT_BYTES: "8192" },
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "oversized stopped inspection inside the shared output ceiling",
      behavior: { inspectOutputAt: "exited", inspectOutputBytes: 16_384, inspectOutputOnce: true },
      config: { VERIFIER_CONTAINER_MAX_OUTPUT_BYTES: "8192" },
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "ownership proof failure",
      behavior: { inspectOwnerId: "not-the-owner" },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
    {
      label: "absence proof failure",
      behavior: { removeFails: true },
      config: {},
      engine: undefined,
      failureKind: "authority_failure",
    },
  ] as const)("classifies a real adapter $label as $failureKind", async ({ behavior, config, engine, failureKind }) => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-real-boundary-"));
    directories.push(sandbox);
    const fixture = await realVerificationFixture({
      root: sandbox,
      engine: engine === "missing" ? path.join(sandbox, "missing-engine") : undefined,
      behavior,
      config: { ...config },
    });

    const result = await fixture.runner.verify(verifyInput(fixture.workspace, fixture.baseCommit, {
      subjectType: "candidate",
      subjectId: "real-adapter-" + failureKind,
      stage: "candidate",
    }));

    expect(result).toMatchObject({ mandatoryPassed: false, failureKind });
  });

  it("accepts genuine PID 1 wrapper command success through the real adapter", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-real-success-"));
    directories.push(sandbox);
    const fixture = await realVerificationFixture({ root: sandbox });

    const result = await fixture.runner.verify(verifyInput(fixture.workspace, fixture.baseCommit, {
      subjectType: "candidate",
      subjectId: "real-adapter-success",
      stage: "candidate",
    }));

    expect(result).toMatchObject({ mandatoryPassed: true, failureKind: null });
  });

  it.each([
    "user_cancelled",
    "emergency_token_fuse",
  ] as const)("keeps real-adapter %s terminal ahead of resource failure", async (reason) => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-real-terminal-"));
    directories.push(sandbox);
    const ready = path.join(sandbox, "run-ready");
    const fixture = await realVerificationFixture({
      root: sandbox,
      behavior: { runDelaySeconds: 2, runReady: ready },
      config: { VERIFIER_CONTAINER_TIMEOUT_MS: "1000" },
    });
    const control = new RunControl(defaultExecutionPolicy);
    const verifying = fixture.runner.verify(verifyInput(fixture.workspace, fixture.baseCommit, {
      subjectType: "candidate",
      subjectId: "real-terminal-" + reason,
      stage: "candidate",
      control,
    }));
    await expect.poll(async () => readFile(ready, "utf8").then(() => true).catch(() => false)).toBe(true);
    const terminal = control.stop(reason, "terminal during real container verification");

    await expect(verifying).rejects.toBe(terminal);
  });

  it("keeps a real-adapter root deadline terminal ahead of its outer timeout", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-real-deadline-"));
    directories.push(sandbox);
    const fixture = await realVerificationFixture({
      root: sandbox,
      behavior: { runDelaySeconds: 2 },
      config: { VERIFIER_CONTAINER_TIMEOUT_MS: "1000" },
    });
    const control = new RunControl({ ...defaultExecutionPolicy, rootTimeoutMs: 100 });
    let terminal: RunTerminalError | undefined;
    control.onTerminal((error) => {
      terminal = error;
    });
    let thrown: unknown;

    try {
      await fixture.runner.verify(verifyInput(fixture.workspace, fixture.baseCommit, {
        subjectType: "candidate",
        subjectId: "real-terminal-root-deadline",
        stage: "candidate",
        control,
      }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(terminal);
    expect(thrown).toMatchObject({ reason: "root_deadline" });
  });

  it("classifies profile preflight, Git infrastructure, and revalidation failures as authority failures", async () => {
    const preflightContainer = recordingContainer();
    const preflight = await loadedRunner(preflightContainer);
    preflight.registry.revalidate = async () => {
      throw new Error("profile unavailable");
    };
    const unavailable = await preflight.runner.verify(
      verifyInput(preflight.workspace, preflight.baseCommit, { subjectId: "contrib-profile-unavailable" }),
    );
    expect(unavailable).toMatchObject({
      mandatoryPassed: false,
      failureKind: "authority_failure",
    });
    expect(preflightContainer.calls).toEqual([]);

    const infrastructureContainer = recordingContainer();
    const infrastructure = await loadedRunner(infrastructureContainer);
    const invalidRange = await infrastructure.runner.verify(
      verifyInput(infrastructure.workspace, "not-a-real-commit", { subjectId: "contrib-infrastructure" }),
    );
    expect(invalidRange).toMatchObject({
      mandatoryPassed: false,
      failureKind: "authority_failure",
    });
    expect(infrastructureContainer.calls).toEqual([]);

    const revalidationContainer = recordingContainer();
    const revalidation = await loadedRunner(revalidationContainer);
    const original = revalidation.registry.revalidate.bind(revalidation.registry);
    let calls = 0;
    revalidation.registry.revalidate = async () => {
      calls += 1;
      if (calls === 2) throw new Error("authority changed after gate batch");
      await original();
    };
    const changed = await revalidation.runner.verify(
      verifyInput(revalidation.workspace, revalidation.baseCommit, { subjectId: "contrib-revalidation" }),
    );
    expect(changed).toMatchObject({
      mandatoryPassed: false,
      failureKind: "authority_failure",
    });
    expect(revalidationContainer.calls.length).toBeGreaterThan(0);
  });

  it("does not authorize when an asset or profile changes after the gate batch", async () => {
    const container = recordingContainer();
    const { runner, workspace, registry, authorityRoot, baseCommit } = await loadedRunner(container);
    const original = registry.revalidate.bind(registry);
    const before = registry.profile().contentHash;
    let calls = 0;
    registry.revalidate = async () => {
      calls += 1;
      if (calls === 1) {
        await original();
        await writeFile(path.join(authorityRoot, "gates", "targeted.mjs"), "process.exit(9);\n", "utf8");
        return;
      }
      await original();
    };
    const result = await runner.verify(
      verifyInput(workspace, baseCommit, { subjectId: "contrib-revalidate" }),
    );
    expect(result.mandatoryPassed).toBe(false);
    expect(registry.profile().contentHash).toBe(before);
    expect(result.authorityManifestHash).toBe(before);
  });

  it("stores only redacted evidence references and does not leak secrets into the public result", async () => {
    const container = recordingContainer();
    const { runner, workspace, baseCommit } = await loadedRunner(container);
    const result = await runner.verify(
      verifyInput(workspace, baseCommit, { subjectId: "contrib-redact" }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-provider-live-key");
    expect(serialized).not.toContain("run-token-abc");
    expect(serialized).not.toContain("fixture-secret-xyz");
    expect(result.gates.some((gate) => gate.evidenceRef.length > 0)).toBe(true);
  });

  it("redacts fixture secret values from production wiring without hand-feeding them", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "launchpad-verifier-prod-"));
    directories.push(sandbox);
    const authorityRoot = path.join(sandbox, "authority");
    const workspace = path.join(sandbox, "candidate");
    const dataDirectory = path.join(sandbox, "data");
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(path.join(workspace, "src", "app.ts"), "export const ok = true;\n", "utf8");
    const profilePath = await materializeAuthority(authorityRoot);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: dataDirectory,
      AGENT_WORKSPACE_ROOT: path.join(sandbox, "workspaces"),
      WORKSPACE_SOURCE_ROOTS: path.join(sandbox, "sources"),
      CODEX_HOME: path.join(sandbox, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      ORCHESTRATION_HEALING_ENABLED: "true",
      ORCHESTRATION_VERIFICATION_PROFILE: profilePath,
    });
    const authority = await createVerificationAuthority(config);
    const git = new GitClient(5_000);
    const baseCommit = await initCandidateRepo(workspace, git);
    const container: FakeContainer = {
      calls: [],
      async run(input) {
        input.control.assertActive();
        container.calls.push(input.gate.id);
        return {
          kind: "command_exit",
          exitCode: 0,
          stdout: new TextEncoder().encode("held fixture-secret-xyz leaked"),
          stderr: new Uint8Array(),
          elapsedMs: 2,
        };
      },
    };
    const runner = new VerificationRunner({
      registry: authority.registry,
      container,
      store: authority.evidenceStore,
      git,
    });
    const result = await runner.verify(verifyInput(workspace, baseCommit, { subjectId: "contrib-fixture" }));
    expect(result.mandatoryPassed).toBe(true);
    const evidenceRoot = path.join(dataDirectory, "evidence", "sha256");
    const objects = (await readdir(evidenceRoot)).filter((name) => /^[0-9a-f]{64}$/.test(name));
    expect(objects.length).toBeGreaterThan(0);
    for (const name of objects) {
      const stored = await readFile(path.join(evidenceRoot, name), "utf8");
      expect(stored).not.toContain("fixture-secret-xyz");
      if (stored.includes("held")) expect(stored).toContain(REDACTED);
    }
  });

  it.each([
    "user_cancelled",
    "root_deadline",
    "emergency_token_fuse",
  ] as const)("propagates %s during container verification as the terminal result", async (reason) => {
    let terminal: RunTerminalError | undefined;
    const container: FakeContainer = {
      calls: [],
      async run(input) {
        container.calls.push(input.gate.id);
        terminal = input.control.stop(reason, "terminal during verification");
        throw terminal;
      },
    };
    const { runner, workspace, baseCommit } = await loadedRunner(container);
    const control = new RunControl(defaultExecutionPolicy);
    let thrown: unknown;
    try {
      await runner.verify(verifyInput(workspace, baseCommit, { subjectId: "contrib-terminal", control }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RunTerminalError);
    expect(thrown).toBe(terminal);
    expect(thrown).toMatchObject({ reason });
    expect(container.calls).toEqual(["targeted"]);
  });

  it("inspects a committed contribution against baseCommit..HEAD and fails existing-test edits", async () => {
    const container = recordingContainer();
    const { runner, workspace, git } = await loadedRunner(container);
    await mkdir(path.join(workspace, "tests"), { recursive: true });
    await writeFile(path.join(workspace, "tests", "existing.test.ts"), "expect(true).toBe(false);\n", "utf8");
    await git.run(workspace, ["add", "--", "tests/existing.test.ts"]);
    await git.run(workspace, ["commit", "-m", "existing test"]);
    const baseCommit = await git.head(workspace);
    await writeFile(path.join(workspace, "tests", "existing.test.ts"), "expect(true).toBe(true);\n", "utf8");
    await git.run(workspace, ["add", "--", "tests/existing.test.ts"]);
    await git.run(workspace, ["commit", "-m", "weaken existing test"]);
    const result = await runner.verify(
      verifyInput(workspace, baseCommit, { subjectId: "contrib-test-edit" }),
    );
    expect(result.gates[0]?.tier).toBe("integrity");
    expect(result.gates[0]?.passed).toBe(false);
    expect(result.mandatoryPassed).toBe(false);
    expect(container.calls).toEqual([]);
  });

  it("fails integrity closed when Git cannot produce the contribution range", async () => {
    const container = recordingContainer();
    const { runner, workspace } = await loadedRunner(container);
    const result = await runner.verify(
      verifyInput(workspace, "not-a-real-commit", { subjectId: "contrib-git-fail" }),
    );
    expect(result.gates[0]?.tier).toBe("integrity");
    expect(result.gates[0]?.passed).toBe(false);
    expect(result.mandatoryPassed).toBe(false);
    expect(container.calls).toEqual([]);
  });
});
