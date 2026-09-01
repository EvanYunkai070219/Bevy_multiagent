import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import { GitClient } from "../../git-client.js";
import { looksSecret, truncateHeadTail } from "../../redact.js";
import type { GateResult, SubtaskContract, VerificationResult } from "../../types.js";
import { EvidenceStore } from "./evidence-store.js";
import { RunControl, RunTerminalError } from "../run-control.js";
import { VerificationContainer } from "./verification-container.js";
import {
  VerificationProfileRegistry,
  type AuthorityGate,
  type AuthorityMutant,
  type VerificationProfile,
} from "./verification-profile.js";

const STAGE_ORDER: GateResult["tier"][] = [
  "targeted",
  "contract",
  "consumer",
  "held_out",
  "mutation_quality",
  "regression",
  "post_integration",
];

export class VerificationRunner {
  private readonly git: GitClient;

  constructor(
    private readonly deps: {
      registry: VerificationProfileRegistry;
      container: Pick<VerificationContainer, "run">;
      store: EvidenceStore;
      git?: GitClient;
    },
  ) {
    if (!deps?.registry || !deps.container || !deps.store) {
      throw new Error("VerificationRunner requires an authority registry, container, and evidence store");
    }
    this.git = deps.git ?? new GitClient(15_000);
  }

  async verify(input: {
    subjectType: VerificationResult["subjectType"];
    subjectId: string;
    stage: VerificationResult["stage"];
    workspacePath: string;
    baseCommit: string;
    contract: SubtaskContract;
    control: RunControl;
  }): Promise<VerificationResult> {
    input.control.assertActive();
    const started = Date.now();
    const gates: GateResult[] = [];
    let mandatoryPassed = true;
    let failureKind: VerificationResult["failureKind"] = null;
    const profile = this.deps.registry.profile();

    try {
      await this.deps.registry.revalidate();
      validateRuntimeContract(input.stage, profile, input.contract);
      await this.git.validateLocalConfig(input.workspacePath);
      const diff = await this.candidateDiff(input.workspacePath, input.baseCommit);
      await this.deps.registry.assertCandidatePatch(diff, input.contract);
      gates.push(await this.recordGate({
        gateId: "integrity",
        tier: "integrity",
        passed: true,
        output: "integrity ok",
      }));
    } catch (error) {
      if (error instanceof RunTerminalError) throw error;
      mandatoryPassed = false;
      failureKind = "authority_failure";
      gates.push(await this.recordGate({
        gateId: "integrity",
        tier: "integrity",
        passed: false,
        output: error instanceof Error ? error.message : String(error),
      }));
      return this.finish(input, profile, gates, mandatoryPassed, failureKind, started);
    }

    const batch = gatesForStage(input.stage, this.deps.registry.profile(), input.contract);
    for (const gate of batch) {
      if (gate.enabled === false) continue;
      input.control.assertActive();
      try {
        const output = await this.deps.container.run({
          candidatePath: input.workspacePath,
          authorityRoot: this.deps.registry.authorityRoot(),
          gate,
          control: input.control,
        });
        const passed = output.kind === "command_exit" && output.exitCode === 0;
        if (output.kind === "authority_failure") {
          mandatoryPassed = false;
          failureKind = "authority_failure";
        } else if (gate.critical !== false && !passed) {
          mandatoryPassed = false;
          if (failureKind === null) failureKind = "deterministic_gate_failure";
        }
        const text = boundedText(output.stdout, output.stderr);
        gates.push(await this.recordGate({
          gateId: publicGateId(gate, profile.contentHash),
          tier: tierOf(gate),
          passed,
          output: text,
        }));
      } catch (error) {
        if (error instanceof RunTerminalError) throw error;
        mandatoryPassed = false;
        failureKind = "authority_failure";
        gates.push(await this.recordGate({
          gateId: publicGateId(gate, profile.contentHash),
          tier: tierOf(gate),
          passed: false,
          output: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    try {
      await this.deps.registry.revalidate();
    } catch (error) {
      if (error instanceof RunTerminalError) throw error;
      mandatoryPassed = false;
      failureKind = "authority_failure";
    }

    const required = batch.filter((gate) => gate.enabled !== false && gate.critical !== false);
    const recorded = new Set(gates.map((gate) => gate.tier + ":" + gate.gateId));
    for (const gate of required) {
      const id = publicGateId(gate, profile.contentHash);
      if (!recorded.has(tierOf(gate) + ":" + id)) {
        mandatoryPassed = false;
        failureKind = "authority_failure";
      }
    }

    return this.finish(
      input,
      this.deps.registry.profile(),
      gates,
      mandatoryPassed,
      failureKind,
      started,
    );
  }

  private async recordGate(input: {
    gateId: string;
    tier: GateResult["tier"];
    passed: boolean;
    output: string;
  }): Promise<GateResult> {
    const ref = await this.deps.store.write(input.tier + ":" + input.gateId, Buffer.from(input.output));
    return {
      gateId: input.gateId,
      tier: input.tier,
      passed: input.passed,
      evidenceRef: ref.sha256,
      failureFingerprint: input.passed ? null : createHash("sha256").update(input.output).digest("hex"),
    };
  }

  private finish(
    input: {
      subjectType: VerificationResult["subjectType"];
      subjectId: string;
      stage: VerificationResult["stage"];
    },
    profile: VerificationProfile,
    gates: GateResult[],
    mandatoryPassed: boolean,
    failureKind: VerificationResult["failureKind"],
    started: number,
  ): VerificationResult {
    return {
      id: randomUUID(),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      stage: input.stage,
      authorityManifestHash: profile.contentHash,
      gates,
      failureKind,
      mandatoryPassed,
      hardProgress: gates.filter((gate) => gate.passed).length,
      regressionCount: gates.filter((gate) => gate.tier === "regression" && !gate.passed).length,
      modelCalls: 0,
      reservedTokens: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      elapsedMs: Date.now() - started,
      verifiedAt: new Date().toISOString(),
    };
  }

  private async candidateDiff(workspacePath: string, baseCommit: string): Promise<string> {
    return this.git.run(workspacePath, [
      "diff",
      "--no-ext-diff",
      "--end-of-options",
      baseCommit,
      "HEAD",
    ]);
  }
}

export async function createVerificationAuthority(config: AppConfig): Promise<{
  registry: VerificationProfileRegistry;
  container: VerificationContainer;
  evidenceStore: EvidenceStore;
  runner: VerificationRunner;
}> {
  const registry = new VerificationProfileRegistry({
    profilePath: config.orchestrationVerificationProfile,
    workspaceRoot: config.workspaceRoot,
    workspaceSourceRoots: config.workspaceSourceRoots,
    eventSessionRoot: path.join(config.dataDirectory, "event"),
  });
  await registry.load();
  const secrets = [config.arkApiKey, config.authToken, registry.authorityRoot()].filter(
    (value) => value.length > 0,
  );
  for (const asset of registry.profile().assets) {
    if (!asset.relativePath.startsWith("fixtures/")) continue;
    const contents = await readFile(path.join(registry.authorityRoot(), asset.relativePath), "utf8");
    secrets.push(...extractFixtureSecrets(contents));
  }
  const evidenceStore = new EvidenceStore({ dataDirectory: config.dataDirectory, secrets });
  const container = new VerificationContainer(config);
  await container.reconcilePending();
  return {
    registry,
    container,
    evidenceStore,
    runner: new VerificationRunner({ registry, container, store: evidenceStore }),
  };
}

export function extractFixtureSecrets(contents: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return [];
  }
  const secrets: string[] = [];
  collectSecretValues(parsed, secrets);
  return secrets;
}

function collectSecretValues(value: unknown, secrets: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSecretValues(item, secrets);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (looksSecret(key) && typeof item === "string" && item.length > 0) {
      secrets.push(item);
    }
    collectSecretValues(item, secrets);
  }
}

function publicContractGateIds(contract: SubtaskContract): Set<string> {
  return new Set([
    ...contract.targetedGateIds,
    ...contract.contractGateIds,
    ...contract.consumerGateIds,
    ...contract.regressionGateIds,
  ]);
}

function validateRuntimeContract(
  stage: VerificationResult["stage"],
  profile: VerificationProfile,
  contract: SubtaskContract,
): void {
  const catalog = profile.contracts.find((entry) => entry.contractKey === contract.contractKey);
  if (!catalog) throw new Error("authority contract is unknown: " + contract.contractKey);
  const gates = new Map(profile.gates.map((gate) => [gate.id, gate]));
  const fields: Array<{
    name: "targetedGateIds" | "contractGateIds" | "consumerGateIds" | "regressionGateIds";
    tier: GateResult["tier"];
  }> = [
    { name: "targetedGateIds", tier: "targeted" },
    { name: "contractGateIds", tier: "contract" },
    { name: "consumerGateIds", tier: "consumer" },
    { name: "regressionGateIds", tier: "regression" },
  ];
  for (const field of fields) {
    const authorized = new Set(catalog[field.name]);
    const declared = contract[field.name];
    if (new Set(declared).size !== declared.length) {
      throw new Error("duplicate runtime " + field.tier + " gate id");
    }
    for (const id of declared) {
      const gate = gates.get(id);
      if (!authorized.has(id) || !gate) throw new Error("unknown runtime authority gate " + id);
      if (gate.tier !== field.tier) {
        throw new Error("runtime " + field.tier + " gate has authority tier " + gate.tier);
      }
      if (gate.enabled === false || !gate.critical) {
        throw new Error("runtime authority gate is not enabled and critical: " + id);
      }
    }
  }
  const requiredFields = stage === "candidate"
    ? (["targetedGateIds", "contractGateIds"] as const)
    : stage === "finalist"
      ? (["consumerGateIds", "regressionGateIds"] as const)
      : stage === "pre_integration"
        ? (["targetedGateIds", "contractGateIds", "consumerGateIds", "regressionGateIds"] as const)
        : (["regressionGateIds"] as const);
  for (const field of requiredFields) {
    if (contract[field].length === 0) {
      throw new Error("runtime contract has no mandatory " + field + " gates for " + stage);
    }
  }
}

function gatesForStage(
  stage: VerificationResult["stage"],
  profile: VerificationProfile,
  contract: SubtaskContract,
): Array<AuthorityGate | AuthorityMutant> {
  const allowed = publicContractGateIds(contract);
  const selected = profile.gates.filter((gate) => {
    if (stage === "post_integration") {
      if (gate.tier === "post_integration") return true;
      return gate.tier === "regression" && allowed.has(gate.id);
    }
    if (gate.tier === "post_integration") return false;
    if (stage === "candidate") {
      return (gate.tier === "targeted" || gate.tier === "contract") && allowed.has(gate.id);
    }
    if (stage === "finalist") {
      if (gate.tier === "held_out") return true;
      return (gate.tier === "consumer" || gate.tier === "regression") && allowed.has(gate.id);
    }
    if (gate.tier === "held_out") return true;
    return allowed.has(gate.id);
  });
  const batch: Array<AuthorityGate | AuthorityMutant> = [...selected];
  if (stage !== "post_integration" && stage !== "candidate") {
    batch.push(...profile.mutants.map((mutant) => ({ ...mutant })));
  }
  return batch.sort((left, right) => STAGE_ORDER.indexOf(tierOf(left)) - STAGE_ORDER.indexOf(tierOf(right)));
}

function tierOf(gate: AuthorityGate | AuthorityMutant): GateResult["tier"] {
  return "tier" in gate ? gate.tier : "mutation_quality";
}

function publicGateId(gate: AuthorityGate | AuthorityMutant, manifestHash: string): string {
  const tier = tierOf(gate);
  if (tier === "held_out" || tier === "mutation_quality") {
    return "held:" + createHash("sha256").update(manifestHash + ":" + gate.id).digest("hex");
  }
  return gate.id;
}

function boundedText(stdout: Uint8Array, stderr: Uint8Array): string {
  return truncateHeadTail(
    Buffer.from(stdout).toString("utf8") + Buffer.from(stderr).toString("utf8"),
  );
}
