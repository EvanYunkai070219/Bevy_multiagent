import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentService } from "../src/agent-service.js";
import { EventLog } from "../src/event-log.js";
import {
  Orchestrator,
  type OrchestratorParts,
} from "../src/orchestration/orchestrator.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { VerificationProfileRegistry } from "../src/orchestration/verification/verification-profile.js";
import { createVerificationAuthority } from "../src/orchestration/verification/verifier.js";
import { JsonStore } from "../src/store.js";
import { WorkspaceManager } from "../src/workspace.js";
import { demoProfileDocument, materializeAuthority } from "./verification-authority-fixtures.js";

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(root);
  return root;
}

async function isolatedLayout() {
  const sandbox = await scratch("launchpad-authority-");
  const layout = {
    sandbox,
    workspaceRoot: path.join(sandbox, "workspaces"),
    sourceRoot: path.join(sandbox, "sources"),
    eventSessionRoot: path.join(sandbox, "data", "event"),
    projectRepository: path.join(sandbox, "external-repo"),
    runsDirectory: path.join(sandbox, "project", ".runs"),
    authorityRoot: path.join(sandbox, "authority"),
  };
  await Promise.all([
    mkdir(layout.workspaceRoot, { recursive: true, mode: 0o755 }),
    mkdir(layout.sourceRoot, { recursive: true, mode: 0o755 }),
    mkdir(layout.eventSessionRoot, { recursive: true, mode: 0o755 }),
    mkdir(layout.projectRepository, { recursive: true, mode: 0o755 }),
    mkdir(layout.runsDirectory, { recursive: true, mode: 0o755 }),
  ]);
  const profilePath = await materializeAuthority(layout.authorityRoot);
  return { ...layout, profilePath };
}

function registryFor(
  layout: Awaited<ReturnType<typeof isolatedLayout>>,
  profilePath = layout.profilePath,
) {
  return new VerificationProfileRegistry({
    profilePath,
    workspaceRoot: layout.workspaceRoot,
    workspaceSourceRoots: [layout.workspaceRoot, layout.sourceRoot],
    eventSessionRoot: layout.eventSessionRoot,
    projectRepositories: [layout.projectRepository],
    runsDirectories: [layout.runsDirectory],
  });
}

describe("VerificationProfileRegistry", () => {
  it("loads a version-1 profile with public contracts, private gates, transitive assets, and critical mutants", async () => {
    const layout = await isolatedLayout();
    const registry = registryFor(layout);
    await registry.load();
    const profile = registry.profile();
    expect(profile.version).toBe(1);
    expect(profile.id).toBe("self-healing-demo");
    expect(profile.contracts[0]?.contractKey).toBe("demo-producer");
    expect(profile.gates.map((gate) => gate.tier)).toEqual(
      expect.arrayContaining(["targeted", "contract", "consumer", "held_out", "regression"]),
    );
    expect(profile.mutants).toEqual([
      expect.objectContaining({ id: "required-field", category: "schema", critical: true }),
    ]);
    expect(profile.assets.map((asset) => asset.relativePath)).toEqual(
      expect.arrayContaining(["helpers/lib.mjs", "fixtures/held.json"]),
    );
    expect(profile.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.catalog()).toEqual(profile.contracts);
  });

  it("rejects an absent profile before any planner, model, or runner call", async () => {
    const layout = await isolatedLayout();
    const registry = registryFor(layout, path.join(layout.sandbox, "missing", "profile.json"));
    await expect(registry.load()).rejects.toThrow(/absent|missing|not found|ENOENT/i);
  });

  it("rejects a malformed profile", async () => {
    const layout = await isolatedLayout();
    await writeFile(layout.profilePath, "{ not json", "utf8");
    await expect(registryFor(layout).load()).rejects.toThrow(/malformed|invalid|JSON/i);
  });

  it("rejects an authority root beneath workspaceRoot", async () => {
    const layout = await isolatedLayout();
    const nested = path.join(layout.workspaceRoot, "managed-project", "authority");
    const profilePath = await materializeAuthority(nested);
    await expect(registryFor(layout, profilePath).load()).rejects.toThrow(/workspaceRoot|workspace root/i);
  });

  it("rejects an authority root beneath a workspace source root", async () => {
    const layout = await isolatedLayout();
    const nested = path.join(layout.sourceRoot, "authority");
    const profilePath = await materializeAuthority(nested);
    await expect(registryFor(layout, profilePath).load()).rejects.toThrow(/source/i);
  });

  it("rejects an authority root beneath a Project repository", async () => {
    const layout = await isolatedLayout();
    const nested = path.join(layout.projectRepository, "authority");
    const profilePath = await materializeAuthority(nested);
    await expect(registryFor(layout, profilePath).load()).rejects.toThrow(/project|repository/i);
  });

  it("rejects an authority root beneath an event-session directory", async () => {
    const layout = await isolatedLayout();
    const nested = path.join(layout.eventSessionRoot, "session-1", "authority");
    const profilePath = await materializeAuthority(nested);
    await expect(registryFor(layout, profilePath).load()).rejects.toThrow(/event.session|event session/i);
  });

  it("rejects an authority root beneath a .runs directory", async () => {
    const layout = await isolatedLayout();
    const nested = path.join(layout.runsDirectory, "run-1", "authority");
    const profilePath = await materializeAuthority(nested);
    await expect(registryFor(layout, profilePath).load()).rejects.toThrow(/\.runs|runs directory/i);
  });

  it("rejects a symlinked authority asset", async () => {
    const layout = await isolatedLayout();
    const target = path.join(layout.authorityRoot, "gates", "targeted.mjs");
    const backup = path.join(layout.authorityRoot, "gates", "targeted.real.mjs");
    const { rename, rm } = await import("node:fs/promises");
    await rename(target, backup);
    await symlink(backup, target);
    await expect(registryFor(layout).load()).rejects.toThrow(/symlink/i);
    await rm(target);
    await rename(backup, target);
  });

  it("rejects a group or world-writable authority asset", async () => {
    const layout = await isolatedLayout();
    await chmod(path.join(layout.authorityRoot, "gates", "targeted.mjs"), 0o666);
    await expect(registryFor(layout).load()).rejects.toThrow(/writab|mode|0o022/i);
  });

  it("rejects a group or world-writable authority directory", async () => {
    const layout = await isolatedLayout();
    await chmod(path.join(layout.authorityRoot, "gates"), 0o775);
    await expect(registryFor(layout).load()).rejects.toThrow(/writab|mode|0o022/i);
  });

  it("rejects a symlinked authority directory", async () => {
    const layout = await isolatedLayout();
    const helpers = path.join(layout.authorityRoot, "helpers");
    const realHelpers = path.join(layout.authorityRoot, "real-helpers");
    const { mkdir: makeDir, rename, rm } = await import("node:fs/promises");
    await makeDir(realHelpers, { recursive: true, mode: 0o755 });
    await chmod(realHelpers, 0o755);
    await rename(path.join(helpers, "lib.mjs"), path.join(realHelpers, "lib.mjs"));
    await rm(helpers, { recursive: true, force: true });
    await symlink(realHelpers, helpers);
    await expect(registryFor(layout).load()).rejects.toThrow(/symlink/i);
  });

  it("rejects a missing listed asset", async () => {
    const layout = await isolatedLayout();
    const { rm } = await import("node:fs/promises");
    await rm(path.join(layout.authorityRoot, "helpers", "lib.mjs"));
    await expect(registryFor(layout).load()).rejects.toThrow(/missing/i);
  });

  it("rejects duplicated asset ids or relative paths", async () => {
    const layout = await isolatedLayout();
    const duplicated = demoProfileDocument();
    duplicated.assets.push({ id: "helper", relativePath: "helpers/other.mjs" });
    const profilePath = await materializeAuthority(path.join(layout.sandbox, "dup-id"), duplicated);
    await expect(registryFor(layout, profilePath).load()).rejects.toThrow(/duplicat/i);

    const dupPath = demoProfileDocument();
    dupPath.assets.push({ id: "helper-2", relativePath: "helpers/lib.mjs" });
    const dupPathFile = await materializeAuthority(path.join(layout.sandbox, "dup-path"), dupPath);
    await expect(registryFor(layout, dupPathFile).load()).rejects.toThrow(/duplicat/i);
  });

  it("rejects fail-open gate catalogs and commands not bound to hashed authority assets", async () => {
    const layout = await isolatedLayout();

    const duplicateGate = demoProfileDocument();
    duplicateGate.gates.push({ ...duplicateGate.gates[0]! });
    const duplicateGatePath = await materializeAuthority(
      path.join(layout.sandbox, "duplicate-gate"),
      duplicateGate,
    );
    await expect(registryFor(layout, duplicateGatePath).load()).rejects.toThrow(/duplicate.*gate/i);

    const wrongTier = demoProfileDocument();
    wrongTier.contracts[0]!.targetedGateIds = ["contract"];
    const wrongTierPath = await materializeAuthority(path.join(layout.sandbox, "wrong-tier"), wrongTier);
    await expect(registryFor(layout, wrongTierPath).load()).rejects.toThrow(/targeted.*tier|tier.*targeted/i);

    const missingGate = demoProfileDocument();
    missingGate.contracts[0]!.consumerGateIds = ["missing-consumer"];
    const missingGatePath = await materializeAuthority(path.join(layout.sandbox, "missing-gate"), missingGate);
    await expect(registryFor(layout, missingGatePath).load()).rejects.toThrow(/missing-consumer|unknown.*gate/i);

    const disabledCritical = demoProfileDocument();
    disabledCritical.gates.find((gate) => gate.id === "held-out")!.enabled = false;
    const disabledCriticalPath = await materializeAuthority(
      path.join(layout.sandbox, "disabled-critical"),
      disabledCritical,
    );
    await expect(registryFor(layout, disabledCriticalPath).load()).rejects.toThrow(/held.out|critical|enabled/i);

    const unboundScript = demoProfileDocument();
    unboundScript.gates[0]!.command = ["node", "fixtures/held.json"];
    const unboundScriptPath = await materializeAuthority(path.join(layout.sandbox, "unbound-script"), unboundScript);
    await expect(registryFor(layout, unboundScriptPath).load()).rejects.toThrow(/command.*asset|script.*asset|bound/i);
  });

  it("normalizes validated gate commands to the read-only authority mount", async () => {
    const layout = await isolatedLayout();
    const registry = registryFor(layout);
    await registry.load();
    expect(registry.profile().gates[0]?.command).toEqual(["node", "/authority/gates/targeted.mjs"]);
    expect(registry.profile().mutants[0]?.command).toEqual([
      "node",
      "/authority/mutants/required-field.mjs",
    ]);
  });

  it("rejects a path-escaping asset", async () => {
    const layout = await isolatedLayout();
    const outside = path.join(layout.sandbox, "escaped.mjs");
    await writeFile(outside, "process.exit(0);\n", { mode: 0o644 });
    const escaping = demoProfileDocument();
    escaping.assets.push({ id: "escaped", relativePath: "../escaped.mjs" });
    const profilePath = await materializeAuthority(path.join(layout.sandbox, "escape"), escaping);
    await expect(registryFor(layout, profilePath).load()).rejects.toThrow(/escape|contain/i);
  });

  it("revalidates the same content hash before and after a gate batch", async () => {
    const layout = await isolatedLayout();
    const registry = registryFor(layout);
    await registry.load();
    const before = registry.profile().contentHash;
    await registry.revalidate();
    expect(registry.profile().contentHash).toBe(before);
  });

  it("rejects revalidate when an asset or profile changes after load", async () => {
    const layout = await isolatedLayout();
    const registry = registryFor(layout);
    await registry.load();
    const before = registry.profile().contentHash;
    await writeFile(path.join(layout.authorityRoot, "gates", "targeted.mjs"), "process.exit(1);\n", "utf8");
    await expect(registry.revalidate()).rejects.toThrow(/authority manifest changed/i);
    expect(registry.profile().contentHash).toBe(before);
    await writeFile(layout.profilePath, JSON.stringify({ ...demoProfileDocument(), id: "tampered" }, null, 2) + "\n", "utf8");
    await expect(registry.revalidate()).rejects.toThrow(/authority manifest changed/i);
    expect(registry.profile().contentHash).toBe(before);
  });
});

describe("healing fail-closed startup", () => {
  it("fails AgentService construction when healing is enabled without a catalog", async () => {
    const root = await scratch("launchpad-healing-start-");
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      WORKSPACE_SOURCE_ROOTS: root,
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      ORCHESTRATION_HEALING_ENABLED: "true",
      ORCHESTRATION_VERIFICATION_PROFILE: path.join(root, "missing-profile.json"),
    });
    const store = new JsonStore(path.join(root, "db.json"));
    const workspaces = new WorkspaceManager(config.workspaceRoot);
    const events = new EventLog(path.join(root, "events"));
    const runner = { async run() { return { output: "nope", threadId: null, usage: null }; } };
    expect(
      () => new AgentService(config, store, workspaces, runner, events),
    ).toThrow(/catalog|authority|profile/i);
  });

  it("does not construct an Orchestrator with healing enabled and an empty catalog", () => {
    expect(
      () =>
        new Orchestrator(
          new JsonStore("/tmp/unused.json"),
          new WorkspaceManager("/tmp/unused-ws"),
          { async run() { return { output: "nope", threadId: null, usage: null }; } },
          new EventLog("/tmp/unused-events"),
          {
            planner: { complete() { throw new Error("planner must not run"); } },
            evaluator: { complete() { throw new Error("evaluator must not run"); } },
            replanner: { complete() { throw new Error("replanner must not run"); } },
            synthesizer: { complete() { throw new Error("synthesizer must not run"); } },
            policy: defaultExecutionPolicy,
            healingEnabled: true,
            contractCatalog: [],
          } as unknown as OrchestratorParts,
          () => false,
        ),
    ).toThrow(/catalog/i);
  });

  it("createVerificationAuthority loads the catalog used for healing admission", async () => {
    const layout = await isolatedLayout();
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(layout.sandbox, "data"),
      AGENT_WORKSPACE_ROOT: layout.workspaceRoot,
      WORKSPACE_SOURCE_ROOTS: layout.sourceRoot,
      CODEX_HOME: path.join(layout.sandbox, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      ORCHESTRATION_HEALING_ENABLED: "true",
      ORCHESTRATION_VERIFICATION_PROFILE: layout.profilePath,
    });
    const authority = await createVerificationAuthority(config);
    expect(authority.registry.catalog()[0]?.contractKey).toBe("demo-producer");
    expect(authority.runner).toBeDefined();
  });
});
