import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeVerifierManifest } from "../src/orchestration/verification/verifier-manifest.js";
import { VerificationProfileRegistry } from "../src/orchestration/verification/verification-profile.js";
import {
  demoContract,
  demoProfileDocument,
  materializeAuthority,
} from "./verification-authority-fixtures.js";

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function loadFromDocument(document = demoProfileDocument()) {
  const sandbox = await mkdtemp(path.join(tmpdir(), "launchpad-manifest-"));
  directories.push(sandbox);
  const authorityRoot = path.join(sandbox, "authority");
  const profilePath = await materializeAuthority(authorityRoot, document);
  const registry = new VerificationProfileRegistry({
    profilePath,
    workspaceRoot: path.join(sandbox, "workspaces"),
    workspaceSourceRoots: [path.join(sandbox, "sources")],
    eventSessionRoot: path.join(sandbox, "data", "event"),
    projectRepositories: [],
    runsDirectories: [path.join(sandbox, ".runs")],
  });
  await mkdir(path.join(sandbox, "workspaces"), { recursive: true });
  await mkdir(path.join(sandbox, "sources"), { recursive: true });
  await mkdir(path.join(sandbox, "data", "event"), { recursive: true });
  await mkdir(path.join(sandbox, ".runs"), { recursive: true });
  await registry.load();
  return { sandbox, authorityRoot, profilePath, registry, document };
}

async function hashOf(document: ReturnType<typeof demoProfileDocument>): Promise<string> {
  const loaded = await loadFromDocument(document);
  return loaded.registry.profile().contentHash;
}

describe("VerifierManifest integrity", () => {
  it("changes hash when command argv changes", async () => {
    const base = demoProfileDocument();
    const mutated = demoProfileDocument();
    mutated.gates[0]!.command = ["node", "gates/targeted.mjs", "--strict"];
    expect(await hashOf(mutated)).not.toBe(await hashOf(base));
  });

  it("changes hash when config bytes change", async () => {
    const base = demoProfileDocument();
    const mutated = demoProfileDocument();
    mutated.id = "self-healing-demo-v2";
    expect(await hashOf(mutated)).not.toBe(await hashOf(base));
  });

  it("changes hash when a gate script changes", async () => {
    const first = await loadFromDocument();
    const before = first.registry.profile().contentHash;
    await writeFile(path.join(first.authorityRoot, "gates", "targeted.mjs"), "process.exit(1);\n", "utf8");
    await expect(first.registry.revalidate()).rejects.toThrow(/authority manifest changed/i);
    expect(first.registry.profile().contentHash).toBe(before);
    const reloaded = new VerificationProfileRegistry({
      profilePath: first.profilePath,
      workspaceRoot: path.join(first.sandbox, "workspaces"),
      workspaceSourceRoots: [path.join(first.sandbox, "sources")],
      eventSessionRoot: path.join(first.sandbox, "data", "event"),
      projectRepositories: [],
      runsDirectories: [path.join(first.sandbox, ".runs")],
    });
    await reloaded.load();
    expect(reloaded.profile().contentHash).not.toBe(before);
  });

  it("changes hash when an explicitly listed helper changes", async () => {
    const first = await loadFromDocument();
    const before = first.registry.profile().contentHash;
    await writeFile(
      path.join(first.authorityRoot, "helpers", "lib.mjs"),
      "export const helper = false;\n",
      "utf8",
    );
    await expect(first.registry.revalidate()).rejects.toThrow(/authority manifest changed/i);
    expect(first.registry.profile().contentHash).toBe(before);
  });

  it("changes hash when a fixture changes", async () => {
    const first = await loadFromDocument();
    const before = first.registry.profile().contentHash;
    await writeFile(path.join(first.authorityRoot, "fixtures", "held.json"), "{\"secret\":\"changed\"}\n", "utf8");
    await expect(first.registry.revalidate()).rejects.toThrow(/authority manifest changed/i);
    expect(first.registry.profile().contentHash).toBe(before);
  });

  it("changes hash when a mutant bundle changes", async () => {
    const first = await loadFromDocument();
    const before = first.registry.profile().contentHash;
    await writeFile(
      path.join(first.authorityRoot, "mutants", "required-field.mjs"),
      "process.exit(2);\n",
      "utf8",
    );
    await expect(first.registry.revalidate()).rejects.toThrow(/authority manifest changed/i);
    expect(first.registry.profile().contentHash).toBe(before);
  });

  it("changes hash when an enabled flag changes", async () => {
    const base = demoProfileDocument();
    const mutated = demoProfileDocument();
    const optional = { ...base.gates[0]!, id: "optional-targeted" };
    base.gates.push(optional);
    mutated.gates.push({ ...optional, enabled: false });
    expect(await hashOf(mutated)).not.toBe(await hashOf(base));
  });

  it("changes hash when a critical flag changes", async () => {
    const base = demoProfileDocument();
    const mutated = demoProfileDocument();
    const optional = { ...base.gates[0]!, id: "optional-targeted" };
    base.gates.push(optional);
    mutated.gates.push({ ...optional, critical: false });
    expect(await hashOf(mutated)).not.toBe(await hashOf(base));
  });

  it("changes hash when a mutant category changes", async () => {
    const base = demoProfileDocument();
    const mutated = demoProfileDocument();
    mutated.mutants[0]!.category = "behavior";
    expect(await hashOf(mutated)).not.toBe(await hashOf(base));
  });

  it("fails integrity when a candidate edits an existing test", async () => {
    const { registry } = await loadFromDocument();
    const diff = [
      "diff --git a/tests/existing.test.ts b/tests/existing.test.ts",
      "index 1111111..2222222 100644",
      "--- a/tests/existing.test.ts",
      "+++ b/tests/existing.test.ts",
      "@@ -1,1 +1,1 @@",
      "-expect(true).toBe(false);",
      "+expect(true).toBe(true);",
      "",
    ].join("\n");
    await expect(registry.assertCandidatePatch(diff, demoContract())).rejects.toThrow(/integrity|existing test/i);
  });

  it("fails integrity when a candidate edits package scripts, locks, CI, verifier config, or authority assets", async () => {
    const { registry } = await loadFromDocument();
    const contract = demoContract();
    const cases = [
      "diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{\"scripts\":{\"test\":\"vitest\"}}\n+{\"scripts\":{\"test\":\"true\"}}\n",
      "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-{}\n+{\"lockfileVersion\":0}\n",
      "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1 @@\n-run: npm test\n+run: true\n",
      "diff --git a/profile.json b/profile.json\n--- a/profile.json\n+++ b/profile.json\n@@ -1 +1 @@\n-{}\n+{\"version\":1}\n",
      "diff --git a/gates/targeted.mjs b/gates/targeted.mjs\n--- a/gates/targeted.mjs\n+++ b/gates/targeted.mjs\n@@ -1 +1 @@\n-process.exit(0);\n+process.exit(0);\n",
    ];
    for (const diff of cases) {
      await expect(registry.assertCandidatePatch(diff, contract)).rejects.toThrow(/integrity/i);
    }
  });

  it("fails integrity when a candidate mutates an undeclared path or a contract-protected path", async () => {
    const { registry } = await loadFromDocument();
    const undeclared = [
      "diff --git a/lib/other.ts b/lib/other.ts",
      "index 1111111..2222222 100644",
      "--- a/lib/other.ts",
      "+++ b/lib/other.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    await expect(registry.assertCandidatePatch(undeclared, demoContract())).rejects.toThrow(
      /undeclared mutation path/i,
    );
    const protectedDiff = [
      "diff --git a/.launchpad/config.json b/.launchpad/config.json",
      "index 1111111..2222222 100644",
      "--- a/.launchpad/config.json",
      "+++ b/.launchpad/config.json",
      "@@ -1 +1 @@",
      "-{}",
      "+{\"ok\":true}",
      "",
    ].join("\n");
    await expect(registry.assertCandidatePatch(protectedDiff, demoContract())).rejects.toThrow(
      /protected path/i,
    );
  });

  it("allows a candidate gates/ path when the compiled contract lists it as a mutation path", async () => {
    const { registry } = await loadFromDocument();
    const contract = demoContract({ allowedMutationPaths: ["src/app.ts", "gates"] });
    const diff = [
      "diff --git a/gates/build.ts b/gates/build.ts",
      "index 1111111..2222222 100644",
      "--- a/gates/build.ts",
      "+++ b/gates/build.ts",
      "@@ -1 +1 @@",
      "-export {}",
      "+export const gates = true;",
      "",
    ].join("\n");
    await expect(registry.assertCandidatePatch(diff, contract)).resolves.toBeUndefined();
  });

  it("treats a newly added candidate test as supplementary rather than an integrity failure", async () => {
    const { registry } = await loadFromDocument();
    const diff = [
      "diff --git a/tests/new-agent.test.ts b/tests/new-agent.test.ts",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/tests/new-agent.test.ts",
      "@@ -0,0 +1,1 @@",
      "+expect(1).toBe(1);",
      "",
    ].join("\n");
    await expect(registry.assertCandidatePatch(diff, demoContract())).resolves.toBeUndefined();
  });

  it("computeVerifierManifest hashes bytes plus normalized relative paths and argv", async () => {
    const loaded = await loadFromDocument();
    const manifest = await computeVerifierManifest(loaded.registry.profile(), loaded.authorityRoot);
    expect(manifest.hash).toBe(loaded.registry.profile().contentHash);
    expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
