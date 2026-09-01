import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalHash, canonicalSerialize } from "../src/orchestration/evolution/evolution-fingerprints.js";
import {
  EvolutionStore,
  EvolutionStoreError,
  type EvolutionSegment,
} from "../src/orchestration/evolution/evolution-store.js";
import type { EvolutionPayload, LineageNode } from "../src/orchestration/evolution/evolution-types.js";

const roots: string[] = [];
const hash = (value: string) => canonicalHash({ value });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "evolution-store-"));
  roots.push(directory);
  return directory;
}

function node(id: string, summary = ""): EvolutionPayload {
  const value: LineageNode = {
    id: hash(id),
    projectId: "project-1",
    sourceFingerprint: hash("source"),
    runId: "run-1",
    subtaskId: "task-1",
    kind: "attempt",
    entityId: id,
    revision: 1,
    harnessVersionHash: hash("harness"),
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    faultId: null,
    fingerprints: null,
    verificationIds: [],
    evidenceRefs: [],
    changedPaths: summary === "" ? [] : [summary],
    createdAt: "2026-08-30T00:00:00.000Z",
  };
  return { type: "node", value };
}

async function onlySegment(dataDirectory: string): Promise<{ path: string; value: EvolutionSegment }> {
  const directory = path.join(dataDirectory, "evolution", "projects", "project-1", "segments");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  expect(names).toHaveLength(1);
  const segmentPath = path.join(directory, names[0]!);
  return { path: segmentPath, value: JSON.parse(await readFile(segmentPath, "utf8")) as EvolutionSegment };
}

describe("EvolutionStore", () => {
  it("publishes immutable canonical segments with a gap-free hash chain and safe modes", async () => {
    const dataDirectory = await root();
    const store = new EvolutionStore({ dataDirectory });
    await store.initialize();
    const first = await store.appendBatch({
      projectId: "project-1",
      expectedHeadHash: null,
      records: [node("attempt-1")],
    });
    const firstSegment = await onlySegment(dataDirectory);
    expect(first.head.sequence).toBe(1);
    expect(firstSegment.value.previousSegmentHash).toBeNull();
    expect(firstSegment.value.segmentHash).toBe(first.head.segmentHash);
    expect((await stat(path.dirname(path.dirname(firstSegment.path)))).mode & 0o777).toBe(0o700);
    expect((await stat(firstSegment.path)).mode & 0o777).toBe(0o600);

    const second = await store.appendBatch({
      projectId: "project-1",
      expectedHeadHash: first.head.segmentHash,
      records: [node("attempt-2")],
    });
    expect(second.head.sequence).toBe(2);
    const reopened = new EvolutionStore({ dataDirectory });
    await reopened.initialize();
    expect(await reopened.head("project-1")).toEqual(second.head);
    expect((await reopened.read({ projectId: "project-1", afterSequence: 0, limit: 200 })).records)
      .toEqual([node("attempt-1"), node("attempt-2")]);
    await reopened.close();
    await store.close();
  });

  it("allows only one compare-and-append winner across concurrent same-process instances", async () => {
    const dataDirectory = await root();
    const stores = Array.from({ length: 10 }, () => new EvolutionStore({ dataDirectory }));
    await Promise.all(stores.map((store) => store.initialize()));
    const outcomes = await Promise.allSettled(stores.map((store, index) => store.appendBatch({
      projectId: "project-1",
      expectedHeadHash: null,
      records: [node(`attempt-${index}`)],
    })));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const errors = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(errors).toHaveLength(9);
    expect(errors.every((outcome) => outcome.reason instanceof EvolutionStoreError &&
      outcome.reason.code === "evolution_store_compare_failed")).toBe(true);
    expect((await stores[0]!.read({ projectId: "project-1", afterSequence: 0, limit: 200 })).records)
      .toHaveLength(1);
    await Promise.all(stores.map((store) => store.close()));
  });

  it("discovers a rename-success failure exactly once and never duplicates its record", async () => {
    const dataDirectory = await root();
    const store = new EvolutionStore({
      dataDirectory,
      failureInjector: (point) => {
        if (point === "after_rename") throw new Error("crash after rename");
      },
    });
    await store.initialize();
    await expect(store.appendBatch({
      projectId: "project-1",
      expectedHeadHash: null,
      records: [node("attempt-1")],
    })).rejects.toThrow("crash after rename");
    await store.close();

    const reopened = new EvolutionStore({ dataDirectory });
    await reopened.initialize();
    expect(await reopened.recordIds("project-1")).toEqual(new Set([hash("attempt-1")]));
    expect((await reopened.head("project-1")).sequence).toBe(1);
    await expect(reopened.appendBatch({
      projectId: "project-1",
      expectedHeadHash: (await reopened.head("project-1")).segmentHash,
      records: [node("attempt-1")],
    })).rejects.toMatchObject({ code: "evolution_store_duplicate_record" });
    await reopened.close();
  });

  it("keeps pre-rename failures non-authoritative", async () => {
    for (const failurePoint of ["before_write", "after_write", "after_fsync"] as const) {
      const dataDirectory = await root();
      const store = new EvolutionStore({
        dataDirectory,
        failureInjector: (point) => {
          if (point === failurePoint) throw new Error(failurePoint);
        },
      });
      await store.initialize();
      await expect(store.appendBatch({
        projectId: "project-1",
        expectedHeadHash: null,
        records: [node("attempt-1")],
      })).rejects.toThrow(failurePoint);
      await store.close();
      const reopened = new EvolutionStore({ dataDirectory });
      await reopened.initialize();
      expect((await reopened.head("project-1")).sequence).toBe(0);
      await reopened.close();
    }
  });

  it("crosses the directory-fsync durability boundary before reporting append success", async () => {
    const dataDirectory = await root();
    let directorySynced = false;
    const store = new EvolutionStore({
      dataDirectory,
      failureInjector: (point) => {
        if (point === "after_directory_fsync") directorySynced = true;
      },
    });
    await store.initialize();
    await store.appendBatch({ projectId: "project-1", expectedHeadHash: null, records: [node("durable")] });
    expect(directorySynced).toBe(true);
    await store.close();
  });

  it("returns only the longest trusted prefix when a suffix is corrupt", async () => {
    const dataDirectory = await root();
    const store = new EvolutionStore({ dataDirectory });
    await store.initialize();
    const first = await store.appendBatch({ projectId: "project-1", expectedHeadHash: null, records: [node("one")] });
    await store.appendBatch({ projectId: "project-1", expectedHeadHash: first.head.segmentHash, records: [node("two")] });
    const segmentDirectory = path.join(dataDirectory, "evolution", "projects", "project-1", "segments");
    const names = (await readdir(segmentDirectory)).filter((name) => name.endsWith(".json")).sort();
    await writeFile(path.join(segmentDirectory, names[1]!), "{malformed", { mode: 0o600 });
    const read = await store.read({ projectId: "project-1", afterSequence: 0, limit: 200 });
    expect(read.records).toEqual([node("one")]);
    expect(read.health).toMatchObject({ state: "corrupt_suffix", validThroughSequence: 1 });
    await store.close();
  });

  it("rejects a rehashed segment whose previous head does not match", async () => {
    const dataDirectory = await root();
    const store = new EvolutionStore({ dataDirectory });
    await store.initialize();
    const first = await store.appendBatch({ projectId: "project-1", expectedHeadHash: null, records: [node("one")] });
    await store.appendBatch({ projectId: "project-1", expectedHeadHash: first.head.segmentHash, records: [node("two")] });
    const projectDirectory = path.join(dataDirectory, "evolution", "projects", "project-1");
    const segmentDirectory = path.join(projectDirectory, "segments");
    const names = (await readdir(segmentDirectory)).filter((name) => name.endsWith(".json")).sort();
    const oldPath = path.join(segmentDirectory, names[1]!);
    const segment = JSON.parse(await readFile(oldPath, "utf8")) as EvolutionSegment;
    segment.previousSegmentHash = hash("wrong-head");
    const { segmentHash: _oldHash, ...body } = segment;
    segment.segmentHash = canonicalHash(body);
    const newPath = path.join(segmentDirectory,
      `${String(segment.sequenceStart).padStart(12, "0")}-${String(segment.sequenceEnd).padStart(12, "0")}-${segment.segmentHash}.json`);
    await rename(oldPath, newPath);
    await writeFile(newPath, canonicalSerialize(segment));
    await writeFile(path.join(projectDirectory, "head.json"), canonicalSerialize({
      schemaVersion: 1,
      projectId: "project-1",
      sequence: 2,
      segmentHash: segment.segmentHash,
      updatedAt: "2026-08-30T00:00:00.000Z",
    }));
    const read = await store.read({ projectId: "project-1", afterSequence: 0, limit: 200 });
    expect(read.records).toEqual([node("one")]);
    expect(read.health.state).toBe("corrupt_suffix");
    await store.close();
  });

  it("rejects path escapes, symlinked project roots, oversized records, and oversized segments", async () => {
    const dataDirectory = await root();
    const store = new EvolutionStore({ dataDirectory });
    await store.initialize();
    await expect(store.head("../escape")).rejects.toMatchObject({ code: "evolution_store_invalid_project" });
    const projects = path.join(dataDirectory, "evolution", "projects");
    await symlink(await root(), path.join(projects, "linked"));
    await expect(store.head("linked")).rejects.toMatchObject({ code: "evolution_store_unsafe_path" });
    await expect(store.appendBatch({
      projectId: "project-1",
      expectedHeadHash: null,
      records: [node("large", "x".repeat(65 * 1024))],
    })).rejects.toMatchObject({ code: "evolution_store_record_too_large" });
    const records = Array.from({ length: 17 }, (_, index) => node(`large-${index}`, "x".repeat(63 * 1024)));
    await expect(store.appendBatch({ projectId: "project-1", expectedHeadHash: null, records }))
      .rejects.toMatchObject({ code: "evolution_store_segment_too_large" });
    await store.close();
  });

  it("rejects a second active process before it writes any Project history", async () => {
    const dataDirectory = await root();
    const owner = new EvolutionStore({ dataDirectory });
    await owner.initialize();
    const modulePath = fileURLToPath(new URL("../src/orchestration/evolution/evolution-store.ts", import.meta.url));
    const script = `import { EvolutionStore } from ${JSON.stringify(modulePath)}; const s = new EvolutionStore({dataDirectory:${JSON.stringify(dataDirectory)}}); try { await s.initialize(); process.exit(0); } catch (error) { console.error(error?.code ?? error); process.exit(23); }`;
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ code, stderr }));
    });
    expect(result.code).toBe(23);
    expect(result.stderr).toContain("evolution_store_owned_elsewhere");
    expect(await readdir(path.join(dataDirectory, "evolution", "projects"))).toEqual([]);
    await owner.close();
  });
});
