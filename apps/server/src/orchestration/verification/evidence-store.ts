import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRedactor } from "../../redact.js";

export interface EvidenceRef {
  sha256: string;
  relativePath: string;
  byteLength: number;
}

export interface EvidenceVerification {
  exists: boolean;
  hashMatches: boolean;
  byteLengthMatches: boolean;
}

export class EvidenceStore {
  private readonly redact: (value: unknown) => unknown;
  private readonly root: string;

  constructor(options: { dataDirectory: string; secrets?: string[] }) {
    this.redact = createRedactor(options.secrets ?? []);
    this.root = path.join(options.dataDirectory, "evidence", "sha256");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  async write(_label: string, bytes: Uint8Array): Promise<EvidenceRef> {
    const redacted = this.redactBytes(bytes);
    const sha256 = createHash("sha256").update(redacted).digest("hex");
    const relativePath = path.join("evidence", "sha256", sha256);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const destination = path.join(this.root, sha256);
    const temp = path.join(this.root, sha256 + ".tmp." + randomBytes(8).toString("hex"));
    await writeFile(temp, redacted, { mode: 0o600 });
    try {
      await rename(temp, destination);
    } catch (error) {
      await rm(temp, { force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        try {
          await writeFile(destination, redacted, { flag: "wx", mode: 0o600 });
        } catch (exists) {
          if ((exists as NodeJS.ErrnoException).code !== "EEXIST") throw exists;
        }
      }
    }
    return { sha256, relativePath, byteLength: redacted.byteLength };
  }

  async cleanupTemps(options: {
    pinnedHashes?: ReadonlySet<string>;
    minimumAgeMs?: number;
    now?: number;
  } = {}): Promise<number> {
    let entries: string[] = [];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    const minimumAgeMs = options.minimumAgeMs ?? 60 * 60 * 1_000;
    const now = options.now ?? Date.now();
    let removed = 0;
    for (const name of entries.filter((value) => value.includes(".tmp."))) {
      const hash = name.split(".tmp.", 1)[0]!;
      if (options.pinnedHashes?.has(hash)) continue;
      const temporary = path.join(this.root, name);
      const value = await lstat(temporary).catch(() => null);
      if (
        value === null ||
        !value.isFile() ||
        value.isSymbolicLink() ||
        (minimumAgeMs > 0 && now - value.mtimeMs < minimumAgeMs)
      ) {
        continue;
      }
      await rm(temporary, { force: true });
      removed += 1;
    }
    return removed;
  }

  /** Re-reads immutable evidence; persisted metadata is never treated as proof. */
  async verify(ref: string | EvidenceRef): Promise<EvidenceVerification> {
    const expectedHash = typeof ref === "string" ? ref : ref.sha256;
    const expectedLength = typeof ref === "string" ? null : ref.byteLength;
    if (!/^[0-9a-f]{64}$/u.test(expectedHash)) {
      return { exists: false, hashMatches: false, byteLengthMatches: false };
    }
    const evidencePath = path.join(this.root, expectedHash);
    try {
      const stat = await lstat(evidencePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { exists: false, hashMatches: false, byteLengthMatches: false };
      }
      const bytes = await readFile(evidencePath);
      return {
        exists: true,
        hashMatches: createHash("sha256").update(bytes).digest("hex") === expectedHash,
        byteLengthMatches: expectedLength === null || bytes.byteLength === expectedLength,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { exists: false, hashMatches: false, byteLengthMatches: false };
      }
      throw error;
    }
  }

  private redactBytes(bytes: Uint8Array): Uint8Array {
    const text = Buffer.from(bytes).toString("utf8");
    const redacted = this.redact(text);
    return Buffer.from(typeof redacted === "string" ? redacted : text, "utf8");
  }
}
