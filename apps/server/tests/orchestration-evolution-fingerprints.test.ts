import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildRuntimeCapabilityManifest,
  buildEvolutionFingerprints,
  canonicalHash,
  canonicalSerialize,
  exactRepeatKey,
  failureCueLookupKey,
  mutationContentHash,
  runtimeCapabilityFingerprint,
} from "../src/orchestration/evolution/evolution-fingerprints.js";
import { loadConfig } from "../src/config.js";
import { repairRuntimeCapabilityEnvironmentFromConfig } from "../src/orchestration/policies.js";
import * as capabilityPolicies from "../src/orchestration/policies.js";
import type {
  MutationContentManifestV1,
  RuntimeCapabilityManifestV2,
} from "../src/orchestration/evolution/evolution-types.js";

const HASHES = ["1", "2", "3", "4", "5", "6"].map((value) => value.repeat(64));

function runtimeManifest(): RuntimeCapabilityManifestV2 {
  return {
    schemaVersion: 2,
    harnessVersion: "orchestration-1",
    repairPromptVersion: "repair-candidate-v1",
    diagnosisPromptVersion: "diagnoser-v1",
    modelId: "model-2026-08",
    runtimeMode: "container:app_server",
    toolSchemaHash: "a".repeat(64),
    excludedToolHash: "b".repeat(64),
    sandboxPolicyHash: "c".repeat(64),
    containerImageId: "sha256:" + "d".repeat(64),
    timeoutMs: 240_000,
    stepCap: 20,
    rootResourceHorizonHash: "e".repeat(64),
  };
}

function mutationManifest(): MutationContentManifestV1 {
  return {
    schemaVersion: 1,
    family: "context_patch",
    targetSubtaskId: "backend",
    instructionPatch: "Read the frozen producer contract.",
    expectedEffect: "restore the missing interface",
    addedEvidenceRefs: ["a".repeat(64), "b".repeat(64)],
    toolRoute: ["read_file", "search_files"],
    repairPromptVersion: "repair-candidate-v1",
  };
}

describe("canonical evolution fingerprints", () => {
  it("changes the runtime hash when every capability field independently changes", () => {
    const original = runtimeManifest();
    const baseline = runtimeCapabilityFingerprint(original);
    expect(baseline.complete).toBe(true);
    expect(baseline.hash).toMatch(/^[0-9a-f]{64}$/);

    const changes: Partial<Record<keyof RuntimeCapabilityManifestV2, unknown>>[] = [
      { schemaVersion: 1 },
      { harnessVersion: "orchestration-2" },
      { repairPromptVersion: "repair-candidate-v2" },
      { diagnosisPromptVersion: "diagnoser-v2" },
      { modelId: "model-2026-09" },
      { runtimeMode: "local-process:app_server" },
      { toolSchemaHash: "f".repeat(64) },
      { excludedToolHash: "0".repeat(64) },
      { sandboxPolicyHash: "9".repeat(64) },
      { containerImageId: "sha256:" + "8".repeat(64) },
      { timeoutMs: 240_001 },
      { stepCap: 21 },
      { rootResourceHorizonHash: "7".repeat(64) },
    ];
    for (const change of changes) {
      expect(runtimeCapabilityFingerprint({ ...original, ...change }).hash).not.toBe(baseline.hash);
    }
  });

  it("is invariant to object key order", () => {
    const ordered = runtimeManifest();
    const reversed = Object.fromEntries(Object.entries(ordered).reverse());
    expect(canonicalSerialize(reversed)).toBe(canonicalSerialize(ordered));
    expect(canonicalHash(reversed)).toBe(canonicalHash(ordered));
    expect(runtimeCapabilityFingerprint(reversed).hash).toBe(
      runtimeCapabilityFingerprint(ordered).hash,
    );
  });

  it("fails capability completeness closed for every missing prompt-affecting field", () => {
    const required: (keyof RuntimeCapabilityManifestV2)[] = [
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
    for (const field of required) {
      const manifest = { ...runtimeManifest() } as Record<string, unknown>;
      delete manifest[field];
      const runtime = runtimeCapabilityFingerprint(manifest);
      const fingerprints = buildEvolutionFingerprints({
        repositoryBaseHash: HASHES[0],
        contractHash: HASHES[1],
        authorityManifestHash: HASHES[2],
        runtimeCapabilityHash: runtime.hash,
        faultEvidenceHash: HASHES[4],
        mutationContentHash: HASHES[5],
        runtimeCapabilityComplete: runtime.complete,
      });
      expect(runtime.complete, field).toBe(false);
      expect(fingerprints.complete, field).toBe(false);
      expect(exactRepeatKey(fingerprints), field).toBeNull();
      expect(failureCueLookupKey(fingerprints), field).toBeNull();
    }
  });

  it("allows a null container image only for an explicitly local runtime", () => {
    expect(runtimeCapabilityFingerprint({
      ...runtimeManifest(),
      runtimeMode: "local-process:app_server",
      containerImageId: null,
    }).complete).toBe(true);
    expect(runtimeCapabilityFingerprint({
      ...runtimeManifest(),
      runtimeMode: "container:app_server",
      containerImageId: null,
    }).complete).toBe(false);
  });

  it("hashes the actual authorized tool schemas and fails closed when a schema is unavailable", () => {
    const toolSchemas = [{
      name: "read_file",
      description: "Read one workspace file.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative path" } },
        required: ["path"],
      },
    }];
    const input = {
      harnessVersion: "orchestration-1",
      repairPromptVersion: "repair-candidate-v1",
      diagnosisPromptVersion: "diagnoser-v1",
      environment: {
        schemaVersion: 1 as const,
        modelId: "model-2026-08",
        runtimeMode: "local-process:app_server",
        toolSchemas,
        sandboxPolicyHash: "c".repeat(64),
        containerImageId: null,
      },
      authorizedTools: ["read_file"],
      excludedTools: ["dispatch_subagent"],
      timeoutMs: 240_000,
      stepCap: 20,
      rootResourceHorizon: {
        modelCallCap: 1_000,
        tokenCap: 10_000_000,
        stepCap: 20,
        timeoutMs: 900_000,
        repairBranchCap: 3,
        repairBranchModelCallCap: 4,
        repairBranchTokenCap: 48_000,
        repairBranchStepCap: 20,
        repairBranchTimeoutMs: 240_000,
      },
    };
    const baseline = buildRuntimeCapabilityManifest(input);
    const schemaOnlyChange = buildRuntimeCapabilityManifest({
      ...input,
      environment: {
        ...input.environment,
        toolSchemas: [{
          ...toolSchemas[0]!,
          inputSchema: {
            ...toolSchemas[0]!.inputSchema,
            properties: {
              path: { type: "string", description: "Workspace-relative path", maxLength: 4_096 },
            },
          },
        }],
      },
    });
    expect(schemaOnlyChange.toolSchemaHash).not.toBe(baseline.toolSchemaHash);

    const reordered = buildRuntimeCapabilityManifest({
      ...input,
      environment: {
        ...input.environment,
        toolSchemas: [{
          inputSchema: Object.fromEntries(Object.entries(toolSchemas[0]!.inputSchema).reverse()),
          description: toolSchemas[0]!.description,
          name: toolSchemas[0]!.name,
        }],
      },
    });
    expect(reordered.toolSchemaHash).toBe(baseline.toolSchemaHash);

    const missing = buildRuntimeCapabilityManifest({ ...input, authorizedTools: ["write_file"] });
    expect(runtimeCapabilityFingerprint(missing).complete).toBe(false);
  });

  it("uses a resolved immutable image identity instead of the configured mutable tag", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "container",
      CONTAINER_RUNTIME_IMAGE: "launchpad-runtime:stable",
      ARK_MODEL: "model-2026-08",
    });
    const firstDigest = "sha256:" + "1".repeat(64);
    const secondDigest = "sha256:" + "2".repeat(64);
    const first = repairRuntimeCapabilityEnvironmentFromConfig(config, firstDigest);
    const second = repairRuntimeCapabilityEnvironmentFromConfig(config, secondDigest);

    expect(first.containerImageId).toBe(firstDigest);
    expect(second.containerImageId).toBe(secondDigest);
    const firstManifest = buildRuntimeCapabilityManifest({
      harnessVersion: "orchestration-1",
      repairPromptVersion: "repair-candidate-v1",
      diagnosisPromptVersion: "diagnoser-v1",
      environment: first,
      authorizedTools: ["read_file"],
      excludedTools: ["dispatch_subagent"],
      timeoutMs: 240_000,
      stepCap: 20,
      rootResourceHorizon: {
        modelCallCap: 1_000,
        tokenCap: 10_000_000,
        stepCap: 20,
        timeoutMs: 900_000,
        repairBranchCap: 3,
        repairBranchModelCallCap: 4,
        repairBranchTokenCap: 48_000,
        repairBranchStepCap: 20,
        repairBranchTimeoutMs: 240_000,
      },
    });
    const secondManifest = buildRuntimeCapabilityManifest({
      ...{
        harnessVersion: "orchestration-1",
        repairPromptVersion: "repair-candidate-v1",
        diagnosisPromptVersion: "diagnoser-v1",
        authorizedTools: ["read_file"],
        excludedTools: ["dispatch_subagent"],
        timeoutMs: 240_000,
        stepCap: 20,
        rootResourceHorizon: {
          modelCallCap: 1_000,
          tokenCap: 10_000_000,
          stepCap: 20,
          timeoutMs: 900_000,
          repairBranchCap: 3,
          repairBranchModelCallCap: 4,
          repairBranchTokenCap: 48_000,
          repairBranchStepCap: 20,
          repairBranchTimeoutMs: 240_000,
        },
      },
      environment: second,
    });
    expect(runtimeCapabilityFingerprint(firstManifest).complete).toBe(true);
    expect(runtimeCapabilityFingerprint(secondManifest).complete).toBe(true);
    expect(runtimeCapabilityFingerprint(firstManifest).hash).not.toBe(
      runtimeCapabilityFingerprint(secondManifest).hash,
    );

    const unavailable = repairRuntimeCapabilityEnvironmentFromConfig(config, null);
    expect(runtimeCapabilityFingerprint(buildRuntimeCapabilityManifest({
      ...{
        harnessVersion: "orchestration-1",
        repairPromptVersion: "repair-candidate-v1",
        diagnosisPromptVersion: "diagnoser-v1",
        authorizedTools: ["read_file"],
        excludedTools: ["dispatch_subagent"],
        timeoutMs: 240_000,
        stepCap: 20,
        rootResourceHorizon: {
          modelCallCap: 1_000,
          tokenCap: 10_000_000,
          stepCap: 20,
          timeoutMs: 900_000,
          repairBranchCap: 3,
          repairBranchModelCallCap: 4,
          repairBranchTokenCap: 48_000,
          repairBranchStepCap: 20,
          repairBranchTimeoutMs: 240_000,
        },
      },
      environment: unavailable,
    })).complete).toBe(false);
  });

  it("resolves container identity through the engine and fails closed on unavailable or mutable output", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "fixture-engine",
      CONTAINER_RUNTIME_IMAGE: "launchpad-runtime:stable",
    });
    const resolveEnvironment = (
      capabilityPolicies as unknown as Record<string, unknown>
    ).resolveRepairRuntimeCapabilityEnvironment;
    expect(resolveEnvironment).toBeTypeOf("function");
    const resolve = resolveEnvironment as (
      config: ReturnType<typeof loadConfig>,
      inspect: (engine: string, image: string) => Promise<string | null>,
    ) => Promise<ReturnType<typeof repairRuntimeCapabilityEnvironmentFromConfig>>;
    const calls: string[][] = [];
    const digest = "sha256:" + "d".repeat(64);
    const resolved = await resolve(config, async (engine, image) => {
      calls.push([engine, image]);
      return digest;
    });
    expect(calls).toEqual([["fixture-engine", "launchpad-runtime:stable"]]);
    expect(resolved.containerImageId).toBe(digest);

    const unavailable = await resolve(config, async () => null);
    const mutable = await resolve(config, async () => "launchpad-runtime:stable");
    expect(unavailable.containerImageId).toBeNull();
    expect(mutable.containerImageId).toBeNull();
  });

  it("does not inherit application secrets into engine image inspection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-image-inspect-"));
    const engine = path.join(root, "fixture-engine.mjs");
    const observedEnvironment = path.join(root, "environment.json");
    const secretName = "LAUNCHPAD_ENGINE_INSPECTION_SECRET";
    const previousSecret = process.env[secretName];
    process.env[secretName] = "must-not-reach-engine";
    try {
      await writeFile(engine, [
        "#!/usr/bin/env node",
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(observedEnvironment)}, JSON.stringify(process.env));`,
        "process.stdout.write('sha256:' + 'a'.repeat(64) + '\\n');",
      ].join("\n"), "utf8");
      await chmod(engine, 0o755);
      const config = loadConfig({
        NODE_ENV: "test",
        RUNTIME_PROVIDER: "container",
        CONTAINER_ENGINE: engine,
        CONTAINER_RUNTIME_IMAGE: "launchpad-runtime:stable",
        ARK_MODEL: "model-2026-08",
      });
      const resolveEnvironment = (
        capabilityPolicies as unknown as Record<string, unknown>
      ).resolveRepairRuntimeCapabilityEnvironment as (
        config: ReturnType<typeof loadConfig>,
      ) => Promise<ReturnType<typeof repairRuntimeCapabilityEnvironmentFromConfig>>;

      const resolved = await resolveEnvironment(config);
      const observed = JSON.parse(await readFile(observedEnvironment, "utf8")) as Record<string, string>;

      expect(resolved.containerImageId).toBe("sha256:" + "a".repeat(64));
      expect(observed[secretName]).toBeUndefined();
      expect(observed.LANG).toBe("C.UTF-8");
      expect(observed.LC_ALL).toBe("C.UTF-8");
    } finally {
      if (previousSecret === undefined) delete process.env[secretName];
      else process.env[secretName] = previousSecret;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hashes every mutation prompt field, including expectedEffect, without volatile IDs", () => {
    const original = mutationManifest();
    const baseline = mutationContentHash(original);
    const changes: Partial<Record<keyof MutationContentManifestV1, unknown>>[] = [
      { schemaVersion: 2 },
      { family: "strategy_patch" },
      { targetSubtaskId: "frontend" },
      { instructionPatch: "Inspect the consumer first." },
      { expectedEffect: "prevent a consumer regression" },
      { addedEvidenceRefs: ["c".repeat(64)] },
      { toolRoute: ["search_files", "read_file"] },
      { repairPromptVersion: "repair-candidate-v2" },
    ];
    for (const change of changes) {
      expect(mutationContentHash({ ...original, ...change })).not.toBe(baseline);
    }
    expect(mutationContentHash(Object.fromEntries(Object.entries(original).reverse()))).toBe(
      baseline,
    );
    expect(JSON.stringify(original)).not.toContain("diagnosisId");
    expect(JSON.stringify(original)).not.toContain("checkpointId");
    expect(JSON.stringify(original)).not.toContain("tournamentId");
  });

  it("produces exact-repeat and cue keys only from six complete schema-v2 hashes", () => {
    const complete = buildEvolutionFingerprints({
      repositoryBaseHash: HASHES[0],
      contractHash: HASHES[1],
      authorityManifestHash: HASHES[2],
      runtimeCapabilityHash: HASHES[3],
      faultEvidenceHash: HASHES[4],
      mutationContentHash: HASHES[5],
      runtimeCapabilityComplete: true,
    });
    expect(complete).toMatchObject({ schemaVersion: 2, complete: true });
    expect(exactRepeatKey(complete)).toMatch(/^[0-9a-f]{64}$/);
    expect(failureCueLookupKey(complete)).toMatch(/^[0-9a-f]{64}$/);

    for (const field of [
      "repositoryBaseHash",
      "contractHash",
      "authorityManifestHash",
      "runtimeCapabilityHash",
      "faultEvidenceHash",
      "mutationContentHash",
    ] as const) {
      const changed = buildEvolutionFingerprints({
        ...complete,
        [field]: "f".repeat(64),
        runtimeCapabilityComplete: true,
      });
      expect(exactRepeatKey(changed), field).not.toBe(exactRepeatKey(complete));
    }

    expect(exactRepeatKey({ ...complete, schemaVersion: 1 } as typeof complete)).toBeNull();
    expect(exactRepeatKey({ ...complete, complete: false })).toBeNull();
    expect(exactRepeatKey({ ...complete, contractHash: "legacy" })).toBeNull();
  });
});
