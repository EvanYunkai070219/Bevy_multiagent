import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceStore } from "../src/orchestration/verification/evidence-store.js";
import { REDACTED } from "../src/redact.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStore(secrets: string[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-evidence-"));
  directories.push(root);
  const dataDirectory = path.join(root, "data");
  await mkdir(dataDirectory, { recursive: true });
  const store = new EvidenceStore({ dataDirectory, secrets });
  return { root, dataDirectory, store };
}

describe("EvidenceStore", () => {
  it("persists identical redacted bytes once under a SHA-256 object and reference", async () => {
    const { store, dataDirectory } = await makeStore();
    const bytes = new TextEncoder().encode("same-evidence-bytes");
    const first = await store.write("stdout", bytes);
    const second = await store.write("stderr", bytes);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.sha256).toBe(second.sha256);
    expect(first.relativePath).toBe(second.relativePath);
    expect(first.relativePath).toBe(path.join("evidence", "sha256", first.sha256));
    expect(first.byteLength).toBe(bytes.byteLength);
    const published = (await readdir(path.join(dataDirectory, "evidence", "sha256")))
      .filter((name) => /^[0-9a-f]{64}$/.test(name));
    expect(published).toEqual([first.sha256]);
    expect(await readFile(path.join(dataDirectory, first.relativePath), "utf8")).toBe(
      "same-evidence-bytes",
    );
  });

  it("redacts provider keys, run tokens, absolute authority paths, and fixture secrets from stored bytes and public records", async () => {
    const providerKey = "sk-provider-live-key";
    const runToken = "run-token-abc123";
    const authorityPath = "/abs/authority/self-healing-demo";
    const fixtureSecret = "fixture-secret-xyz";
    const { store, dataDirectory } = await makeStore([
      providerKey,
      runToken,
      authorityPath,
      fixtureSecret,
    ]);
    const payload = [
      "provider=" + providerKey,
      "token=" + runToken,
      "authority=" + authorityPath,
      "fixture=" + fixtureSecret,
      "ok",
    ].join(" ");
    const ref = await store.write("gate-stdout", new TextEncoder().encode(payload));
    const stored = await readFile(path.join(dataDirectory, ref.relativePath), "utf8");
    expect(stored).toContain(REDACTED);
    expect(stored).not.toContain(providerKey);
    expect(stored).not.toContain(runToken);
    expect(stored).not.toContain(authorityPath);
    expect(stored).not.toContain(fixtureSecret);
    expect(JSON.stringify(ref)).not.toContain(providerKey);
    expect(JSON.stringify(ref)).not.toContain(runToken);
    expect(JSON.stringify(ref)).not.toContain(authorityPath);
    expect(JSON.stringify(ref)).not.toContain(fixtureSecret);
  });

  it("publishes one atomically renamed object for concurrent identical writes", async () => {
    const { store, dataDirectory } = await makeStore();
    const bytes = new TextEncoder().encode("concurrent-evidence");
    const [a, b, c] = await Promise.all([
      store.write("a", bytes),
      store.write("b", bytes),
      store.write("c", bytes),
    ]);
    expect(new Set([a.sha256, b.sha256, c.sha256]).size).toBe(1);
    const published = (await readdir(path.join(dataDirectory, "evidence", "sha256")))
      .filter((name) => /^[0-9a-f]{64}$/.test(name));
    expect(published).toHaveLength(1);
  });

  it("ignores interrupted temp files and cleans them idempotently", async () => {
    const { store, dataDirectory } = await makeStore();
    const dir = path.join(dataDirectory, "evidence", "sha256");
    await mkdir(dir, { recursive: true });
    const leftover = path.join(dir, "deadbeef.tmp.partial");
    await writeFile(leftover, "interrupted", "utf8");
    await store.cleanupTemps({ minimumAgeMs: 0 });
    await store.cleanupTemps({ minimumAgeMs: 0 });
    const names = await readdir(dir);
    expect(names.some((name) => name.includes(".tmp."))).toBe(false);
    const bytes = new TextEncoder().encode("published");
    const ref = await store.write("ok", bytes);
    expect(names.includes(ref.sha256) || (await readdir(dir)).includes(ref.sha256)).toBe(true);
    expect(await readFile(path.join(dataDirectory, ref.relativePath), "utf8")).toBe("published");
  });
});
