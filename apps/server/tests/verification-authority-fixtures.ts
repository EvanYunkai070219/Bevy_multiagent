import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SubtaskContract } from "../src/types.js";

export function demoProfileDocument() {
  return {
    id: "self-healing-demo",
    version: 1 as const,
    contracts: [
      {
        contractKey: "demo-producer",
        allowedInputs: ["src/app.ts"],
        allowedOutputs: ["src/app.ts"],
        allowedMutationPaths: ["src/app.ts"],
        protectedPaths: [".launchpad", "package.json"],
        artifactSchemaIds: ["demo-schema"],
        targetedGateIds: ["targeted"],
        contractGateIds: ["contract"],
        consumerGateIds: ["consumer"],
        regressionGateIds: ["regression"],
        authorizedTools: ["read_file"],
      },
    ],
    gates: [
      {
        id: "targeted",
        tier: "targeted",
        command: ["node", "gates/targeted.mjs"],
        assetIds: ["targeted-gate", "helper"],
        critical: true,
        enabled: true,
      },
      {
        id: "contract",
        tier: "contract",
        command: ["node", "gates/contract.mjs"],
        assetIds: ["contract-gate"],
        critical: true,
        enabled: true,
      },
      {
        id: "consumer",
        tier: "consumer",
        command: ["node", "gates/consumer.mjs"],
        assetIds: ["consumer-gate"],
        critical: true,
        enabled: true,
      },
      {
        id: "held-out",
        tier: "held_out",
        command: ["node", "gates/held-out.mjs"],
        assetIds: ["held-out-gate", "fixture"],
        critical: true,
        enabled: true,
      },
      {
        id: "regression",
        tier: "regression",
        command: ["node", "gates/regression.mjs"],
        assetIds: ["regression-gate"],
        critical: true,
        enabled: true,
      },
      {
        id: "post-integration",
        tier: "post_integration",
        command: ["node", "gates/regression.mjs"],
        assetIds: ["regression-gate"],
        critical: true,
        enabled: true,
      },
    ],
    mutants: [
      {
        id: "required-field",
        category: "schema",
        command: ["node", "mutants/required-field.mjs"],
        assetIds: ["required-field-mutant"],
        critical: true,
        enabled: true,
      },
    ],
    assets: [
      { id: "targeted-gate", relativePath: "gates/targeted.mjs" },
      { id: "contract-gate", relativePath: "gates/contract.mjs" },
      { id: "consumer-gate", relativePath: "gates/consumer.mjs" },
      { id: "held-out-gate", relativePath: "gates/held-out.mjs" },
      { id: "regression-gate", relativePath: "gates/regression.mjs" },
      { id: "required-field-mutant", relativePath: "mutants/required-field.mjs" },
      { id: "helper", relativePath: "helpers/lib.mjs" },
      { id: "fixture", relativePath: "fixtures/held.json" },
    ],
  };
}

const GATE_SOURCE = "process.exit(0);\n";

export async function materializeAuthority(
  authorityRoot: string,
  document = demoProfileDocument(),
): Promise<string> {
  const files: Record<string, string> = {
    "gates/targeted.mjs": GATE_SOURCE,
    "gates/contract.mjs": GATE_SOURCE,
    "gates/consumer.mjs": GATE_SOURCE,
    "gates/held-out.mjs": GATE_SOURCE,
    "gates/regression.mjs": GATE_SOURCE,
    "mutants/required-field.mjs": GATE_SOURCE,
    "helpers/lib.mjs": "export const helper = true;\n",
    "fixtures/held.json": "{\"secret\":\"fixture-secret-xyz\"}\n",
    "profile.json": JSON.stringify(document, null, 2) + "\n",
  };
  await mkdir(authorityRoot, { recursive: true, mode: 0o755 });
  await chmod(authorityRoot, 0o755);
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(authorityRoot, relative);
    await mkdir(path.dirname(full), { recursive: true, mode: 0o755 });
    await chmod(path.dirname(full), 0o755);
    await writeFile(full, contents, { encoding: "utf8", mode: 0o644 });
    await chmod(full, 0o644);
  }
  return path.join(authorityRoot, "profile.json");
}

export function demoContract(overrides: Partial<SubtaskContract> = {}): SubtaskContract {
  return {
    subtaskId: "task-1",
    revision: 1,
    contractKey: "demo-producer",
    inputs: ["src/app.ts"],
    outputs: ["src/app.ts"],
    dependencyIds: [],
    downstreamConsumers: [],
    allowedMutationPaths: ["src/app.ts"],
    protectedPaths: [".launchpad", "package.json"],
    artifactSchemaIds: ["demo-schema"],
    targetedGateIds: ["targeted"],
    contractGateIds: ["contract"],
    consumerGateIds: ["consumer"],
    regressionGateIds: ["regression"],
    authorizedTools: ["read_file"],
    ...overrides,
  };
}
