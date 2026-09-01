import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ContractCatalogEntry } from "../healing/contract-compiler.js";
import type { GateResult, SubtaskContract } from "../../types.js";
import { computeVerifierManifest } from "./verifier-manifest.js";

export interface AuthorityAsset {
  id: string;
  relativePath: string;
}

export interface AuthorityGate {
  id: string;
  tier: GateResult["tier"];
  command: ["node" | "python" | "python3", string, ...string[]];
  assetIds: string[];
  critical: boolean;
  enabled?: boolean;
}

export interface AuthorityMutant {
  id: string;
  category: string;
  command: ["node" | "python" | "python3", string, ...string[]];
  assetIds: string[];
  critical: boolean;
  enabled?: boolean;
}

export interface VerificationProfile {
  id: string;
  version: 1;
  contracts: ContractCatalogEntry[];
  gates: AuthorityGate[];
  mutants: AuthorityMutant[];
  assets: AuthorityAsset[];
  contentHash: string;
}

export interface VerificationProfileRegistryOptions {
  profilePath: string;
  workspaceRoot: string;
  workspaceSourceRoots: readonly string[];
  eventSessionRoot: string;
  projectRepositories?: readonly string[];
  runsDirectories?: readonly string[];
}

const GATE_TIERS: ReadonlySet<GateResult["tier"]> = new Set([
  "targeted",
  "contract",
  "consumer",
  "held_out",
  "mutation_quality",
  "regression",
  "post_integration",
]);

const INTERPRETERS = new Set(["node", "python", "python3"]);

export class VerificationProfileRegistry {
  private loaded: VerificationProfile | undefined;
  private root = "";

  constructor(private readonly options: VerificationProfileRegistryOptions) {}

  async load(): Promise<void> {
    this.loaded = await this.readAndValidate();
  }

  async revalidate(): Promise<void> {
    if (!this.loaded) throw new Error("verification profile has not been loaded");
    const previousHash = this.loaded.contentHash;
    const current = await this.readAndValidate();
    if (current.contentHash !== previousHash) {
      throw new Error("authority manifest changed");
    }
    this.loaded = current;
  }

  catalog(): ContractCatalogEntry[] {
    return this.profile().contracts.map((entry) => ({ ...entry, ...cloneArrays(entry) }));
  }

  profile(): VerificationProfile {
    if (!this.loaded) throw new Error("verification profile has not been loaded");
    return this.loaded;
  }

  authorityRoot(): string {
    if (!this.root) throw new Error("verification profile has not been loaded");
    return this.root;
  }

  async assertCandidatePatch(diff: string, contract: SubtaskContract): Promise<void> {
    for (const file of parseUnifiedDiff(diff)) {
      const relative = normalizeRelative(file.path);
      if (isExistingTestPath(relative, file.isNew)) {
        throw new Error("integrity: existing test may not be edited");
      }
      if (isCiOrLockfilePath(relative)) {
        throw new Error("integrity: candidate may not modify protected configuration");
      }
      if (isProtectedPath(relative, contract.protectedPaths)) {
        throw new Error("integrity: protected path " + relative);
      }
      if (file.isNew && isTestPath(relative)) continue;
      if (!isAllowedMutation(relative, contract.allowedMutationPaths)) {
        throw new Error("integrity: undeclared mutation path " + relative);
      }
    }
  }

  private async readAndValidate(): Promise<VerificationProfile> {
    const profilePath = path.resolve(this.options.profilePath);
    let profileStat;
    try {
      profileStat = await lstat(profilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("authority profile is absent: " + profilePath);
      }
      throw error;
    }
    await assertRegularAuthorityFile(profilePath, profileStat, "profile");
    await assertAuthorityChain(profilePath, path.dirname(profilePath));
    const raw = await readFile(profilePath, "utf8");
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch (error) {
      throw new Error("malformed verification profile", { cause: error });
    }
    const parsed = parseProfileDocument(document);
    const authorityRoot = await this.assertPlacedRoot(path.dirname(profilePath));
    this.root = authorityRoot;
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    for (const asset of parsed.assets) {
      if (seenIds.has(asset.id) || seenPaths.has(asset.relativePath)) {
        throw new Error("duplicate authority asset " + asset.id);
      }
      seenIds.add(asset.id);
      seenPaths.add(asset.relativePath);
      await this.assertAssetFile(authorityRoot, asset);
    }
    const assetIds = new Set(parsed.assets.map((asset) => asset.id));
    for (const gate of [...parsed.gates, ...parsed.mutants]) {
      for (const assetId of gate.assetIds) {
        if (!assetIds.has(assetId)) throw new Error("missing authority asset " + assetId);
      }
    }
    validateGateCatalog(parsed);
    const assetsById = new Map(parsed.assets.map((asset) => [asset.id, asset]));
    for (const executable of [...parsed.gates, ...parsed.mutants]) {
      const script = executable.command[1].slice("/authority/".length);
      const bound = executable.assetIds.some(
        (assetId) => assetsById.get(assetId)?.relativePath === script,
      );
      if (!bound) {
        throw new Error("authority command script must be bound to a hashed asset: " + executable.id);
      }
    }
    const manifest = await computeVerifierManifest(parsed, authorityRoot);
    return { ...parsed, contentHash: manifest.hash };
  }

  private async assertPlacedRoot(candidateRoot: string): Promise<string> {
    const rootStat = await lstat(candidateRoot);
    if (rootStat.isSymbolicLink()) throw new Error("authority root may not be a symlink");
    rejectWritable(rootStat.mode, candidateRoot);
    if (!rootStat.isDirectory()) throw new Error("authority root is not a directory");
    const realRoot = await realpath(candidateRoot);
    if (hasNamedAncestor(realRoot, ".runs")) {
      throw new Error("authority root beneath .runs directory");
    }
    const forbidden: { label: string; target: string }[] = [
      { label: "workspace root", target: this.options.workspaceRoot },
      ...this.options.workspaceSourceRoots.map((target) => ({
        label: "workspace source",
        target,
      })),
      { label: "event session", target: this.options.eventSessionRoot },
      ...(this.options.projectRepositories ?? []).map((target) => ({
        label: "project repository",
        target,
      })),
      ...(this.options.runsDirectories ?? []).map((target) => ({
        label: ".runs directory",
        target,
      })),
    ];
    for (const item of forbidden) {
      const outer = await realpathIfExists(item.target);
      if (outer && isInsideOrEqual(realRoot, outer)) {
        throw new Error("authority root beneath " + item.label);
      }
    }
    return realRoot;
  }

  private async assertAssetFile(authorityRoot: string, asset: AuthorityAsset): Promise<void> {
    if (normalizeRelative(asset.relativePath) !== asset.relativePath || asset.relativePath.includes("\\")) {
      throw new Error("authority asset path must be a normalized relative path");
    }
    if (asset.relativePath.split("/").includes("..") || path.isAbsolute(asset.relativePath)) {
      throw new Error("authority asset path escapes the authority root");
    }
    const fullPath = path.join(authorityRoot, asset.relativePath);
    let stat;
    try {
      stat = await lstat(fullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("missing authority asset " + asset.relativePath);
      }
      throw error;
    }
    await assertRegularAuthorityFile(fullPath, stat, "asset");
    const realFile = await realpath(fullPath);
    if (!isInsideOrEqual(realFile, authorityRoot)) {
      throw new Error("authority asset path escapes the authority root");
    }
    await assertAuthorityChain(fullPath, authorityRoot);
  }
}

function parseProfileDocument(document: unknown): Omit<VerificationProfile, "contentHash"> {
  if (!document || typeof document !== "object") {
    throw new Error("malformed verification profile");
  }
  const value = document as Record<string, unknown>;
  if (value.version !== 1 || typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("malformed verification profile");
  }
  if (!Array.isArray(value.contracts) || !Array.isArray(value.gates) || !Array.isArray(value.mutants) || !Array.isArray(value.assets)) {
    throw new Error("malformed verification profile");
  }
  return {
    id: value.id,
    version: 1,
    contracts: value.contracts.map(parseContract),
    gates: value.gates.map(parseGate),
    mutants: value.mutants.map(parseMutant),
    assets: value.assets.map(parseAsset),
  };
}

function parseContract(value: unknown): ContractCatalogEntry {
  if (!value || typeof value !== "object") throw new Error("malformed verification profile");
  const entry = value as Record<string, unknown>;
  if (typeof entry.contractKey !== "string") throw new Error("malformed verification profile");
  return {
    contractKey: entry.contractKey,
    allowedInputs: stringArray(entry.allowedInputs),
    allowedOutputs: stringArray(entry.allowedOutputs),
    allowedMutationPaths: stringArray(entry.allowedMutationPaths),
    protectedPaths: stringArray(entry.protectedPaths),
    artifactSchemaIds: stringArray(entry.artifactSchemaIds),
    targetedGateIds: stringArray(entry.targetedGateIds),
    contractGateIds: stringArray(entry.contractGateIds),
    consumerGateIds: stringArray(entry.consumerGateIds),
    regressionGateIds: stringArray(entry.regressionGateIds),
    authorizedTools: stringArray(entry.authorizedTools),
  };
}

function parseGate(value: unknown): AuthorityGate {
  if (!value || typeof value !== "object") throw new Error("malformed verification profile");
  const gate = value as Record<string, unknown>;
  const tier = gate.tier;
  if (typeof gate.id !== "string" || typeof tier !== "string" || !GATE_TIERS.has(tier as GateResult["tier"])) {
    throw new Error("malformed verification profile");
  }
  return {
    id: gate.id,
    tier: tier as GateResult["tier"],
    command: parseCommand(gate.command),
    assetIds: stringArray(gate.assetIds),
    critical: gate.critical === true,
    enabled: gate.enabled !== false,
  };
}

function parseMutant(value: unknown): AuthorityMutant {
  if (!value || typeof value !== "object") throw new Error("malformed verification profile");
  const mutant = value as Record<string, unknown>;
  if (typeof mutant.id !== "string" || typeof mutant.category !== "string" || mutant.category.length === 0) {
    throw new Error("malformed verification profile");
  }
  return {
    id: mutant.id,
    category: mutant.category,
    command: parseCommand(mutant.command),
    assetIds: stringArray(mutant.assetIds),
    critical: mutant.critical === true,
    enabled: mutant.enabled !== false,
  };
}

function parseAsset(value: unknown): AuthorityAsset {
  if (!value || typeof value !== "object") throw new Error("malformed verification profile");
  const asset = value as Record<string, unknown>;
  if (typeof asset.id !== "string" || typeof asset.relativePath !== "string") {
    throw new Error("malformed verification profile");
  }
  return { id: asset.id, relativePath: normalizeRelative(asset.relativePath) };
}

function parseCommand(value: unknown): AuthorityGate["command"] {
  if (!Array.isArray(value) || value.length < 2 || !value.every((item) => typeof item === "string")) {
    throw new Error("malformed verification profile");
  }
  const interpreter = value[0];
  const script = value[1];
  if (typeof interpreter !== "string" || typeof script !== "string" || !INTERPRETERS.has(interpreter)) {
    throw new Error("malformed verification profile");
  }
  const relativeScript = script.startsWith("/authority/")
    ? script.slice("/authority/".length)
    : normalizeRelative(script);
  if (
    relativeScript.length === 0 ||
    relativeScript.split("/").includes("..") ||
    relativeScript.startsWith("/") ||
    script.includes("\\")
  ) {
    throw new Error("authority command script must be a normalized authority path");
  }
  return [
    interpreter as "node" | "python" | "python3",
    "/authority/" + relativeScript,
    ...value.slice(2),
  ];
}

function validateGateCatalog(profile: Omit<VerificationProfile, "contentHash">): void {
  const gateById = new Map<string, AuthorityGate>();
  for (const gate of profile.gates) {
    if (gateById.has(gate.id)) throw new Error("duplicate authority gate " + gate.id);
    gateById.set(gate.id, gate);
  }
  const executableIds = new Set(gateById.keys());
  for (const mutant of profile.mutants) {
    if (executableIds.has(mutant.id)) throw new Error("duplicate authority gate or mutant " + mutant.id);
    executableIds.add(mutant.id);
  }

  const requiredTiers: GateResult["tier"][] = [
    "targeted",
    "contract",
    "consumer",
    "held_out",
    "regression",
    "post_integration",
  ];
  for (const tier of requiredTiers) {
    if (!profile.gates.some((gate) => gate.tier === tier && gate.enabled !== false && gate.critical)) {
      throw new Error("authority requires a nonempty enabled critical " + tier + " gate tier");
    }
  }
  if (!profile.mutants.some((mutant) => mutant.enabled !== false && mutant.critical)) {
    throw new Error("authority requires a nonempty enabled critical mutation gate tier");
  }

  const fields: Array<[keyof ContractCatalogEntry, GateResult["tier"]]> = [
    ["targetedGateIds", "targeted"],
    ["contractGateIds", "contract"],
    ["consumerGateIds", "consumer"],
    ["regressionGateIds", "regression"],
  ];
  const contractKeys = new Set<string>();
  for (const contract of profile.contracts) {
    if (contractKeys.has(contract.contractKey)) {
      throw new Error("duplicate authority contract " + contract.contractKey);
    }
    contractKeys.add(contract.contractKey);
    for (const [field, tier] of fields) {
      const ids = contract[field] as string[];
      if (ids.length === 0) {
        throw new Error("authority contract " + contract.contractKey + " has no " + tier + " gates");
      }
      if (new Set(ids).size !== ids.length) {
        throw new Error("duplicate " + tier + " gate id in contract " + contract.contractKey);
      }
      for (const id of ids) {
        const gate = gateById.get(id);
        if (!gate) throw new Error("unknown authority gate " + id);
        if (gate.tier !== tier) {
          throw new Error("authority " + tier + " gate " + id + " has tier " + gate.tier);
        }
        if (gate.enabled === false || !gate.critical) {
          throw new Error("authority contract gate must be enabled and critical: " + id);
        }
      }
    }
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("malformed verification profile");
  }
  return [...value];
}

async function assertRegularAuthorityFile(
  fullPath: string,
  stat: { isSymbolicLink(): boolean; isFile(): boolean; mode: number },
  kind: string,
): Promise<void> {
  if (stat.isSymbolicLink()) throw new Error("authority " + kind + " may not be a symlink");
  rejectWritable(stat.mode, fullPath);
  if (!stat.isFile()) throw new Error("authority " + kind + " is not a regular file");
}

function rejectWritable(mode: number, label: string): void {
  if ((mode & 0o022) !== 0) {
    throw new Error("authority path is group or world-writable: " + label);
  }
}

export function isInsideOrEqual(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathIfExists(target: string): Promise<string | null> {
  try {
    const resolved = path.resolve(target);
    const stat = await lstat(resolved);
    if (stat.isSymbolicLink()) return null;
    return await realpath(resolved);
  } catch {
    return null;
  }
}

function hasNamedAncestor(absPath: string, name: string): boolean {
  let cursor = absPath;
  for (;;) {
    if (path.basename(cursor) === name) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function normalizeRelative(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function parseUnifiedDiff(diff: string): { path: string; isNew: boolean }[] {
  const files: { path: string; isNew: boolean }[] = [];
  const chunks = diff.split(/^diff --git /m).slice(1);
  for (const chunk of chunks) {
    const header = chunk.split(/\r?\n/, 1)[0] ?? "";
    const match = /(?:^| )b\/(.+)$/.exec(header.trim());
    const filePath = match?.[1] ?? "";
    if (!filePath) continue;
    files.push({
      path: filePath,
      isNew: /^new file mode /m.test(chunk),
    });
  }
  return files;
}

async function assertAuthorityChain(leaf: string, authorityRoot: string): Promise<void> {
  const root = path.resolve(authorityRoot);
  let cursor = path.resolve(leaf);
  for (;;) {
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error("authority path may not be a symlink");
    rejectWritable(stat.mode, cursor);
    if (cursor === root) return;
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error("authority asset path escapes the authority root");
    }
    cursor = parent;
  }
}

function isProtectedPath(value: string, protectedPaths: string[]): boolean {
  return protectedPaths.some(
    (item) => value === item || value.startsWith(item + "/") || value.startsWith(item + "\\"),
  );
}

function isAllowedMutation(value: string, allowed: string[]): boolean {
  if (allowed.length === 0) return false;
  return allowed.some(
    (item) => value === item || value.startsWith(item.endsWith("/") ? item : item + "/"),
  );
}

function isTestPath(relative: string): boolean {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative) ||
    /(^|\/)tests?\//.test(relative) ||
    /(^|\/)__tests__\//.test(relative)
  );
}

function isExistingTestPath(relative: string, isNew: boolean): boolean {
  return !isNew && isTestPath(relative);
}

function isCiOrLockfilePath(relative: string): boolean {
  if (
    relative === "package.json" ||
    relative === "package-lock.json" ||
    relative === "pnpm-lock.yaml" ||
    relative === "yarn.lock" ||
    relative === "npm-shrinkwrap.json"
  ) {
    return true;
  }
  return (
    relative.startsWith(".github/") ||
    relative.startsWith(".circleci/") ||
    relative === ".gitlab-ci.yml" ||
    relative === "azure-pipelines.yml" ||
    relative === "Jenkinsfile"
  );
}

function cloneArrays(entry: ContractCatalogEntry): ContractCatalogEntry {
  return {
    ...entry,
    allowedInputs: [...entry.allowedInputs],
    allowedOutputs: [...entry.allowedOutputs],
    allowedMutationPaths: [...entry.allowedMutationPaths],
    protectedPaths: [...entry.protectedPaths],
    artifactSchemaIds: [...entry.artifactSchemaIds],
    targetedGateIds: [...entry.targetedGateIds],
    contractGateIds: [...entry.contractGateIds],
    consumerGateIds: [...entry.consumerGateIds],
    regressionGateIds: [...entry.regressionGateIds],
    authorizedTools: [...entry.authorizedTools],
  };
}
