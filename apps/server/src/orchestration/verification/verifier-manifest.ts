import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VerificationProfile } from "./verification-profile.js";

export interface VerifierManifest {
  hash: string;
}

export async function computeVerifierManifest(
  profile: Omit<VerificationProfile, "contentHash"> | VerificationProfile,
  authorityRoot: string,
): Promise<VerifierManifest> {
  const hash = createHash("sha256");
  hash.update(profile.id);
  hash.update("\0");
  hash.update(String(profile.version));
  hash.update("\0");
  hash.update(stable(profile.contracts));
  hash.update("\0");
  hash.update(stable(profile.gates.map((gate) => ({
    id: gate.id,
    tier: gate.tier,
    command: gate.command,
    assetIds: gate.assetIds,
    critical: gate.critical === true,
    enabled: gate.enabled !== false,
  }))));
  hash.update("\0");
  hash.update(stable(profile.mutants.map((mutant) => ({
    id: mutant.id,
    category: mutant.category,
    command: mutant.command,
    assetIds: mutant.assetIds,
    critical: mutant.critical === true,
    enabled: mutant.enabled !== false,
  }))));
  const assets = [...profile.assets].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath) || left.id.localeCompare(right.id),
  );
  for (const asset of assets) {
    const relative = asset.relativePath.replace(/\\/g, "/");
    hash.update("\0");
    hash.update(relative);
    hash.update("\0");
    hash.update(await readFile(path.join(authorityRoot, asset.relativePath)));
  }
  return { hash: hash.digest("hex") };
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}
