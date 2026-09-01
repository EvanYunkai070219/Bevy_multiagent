import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { canonicalHash, canonicalSerialize } from "./evolution-fingerprints.js";
import type { EvolutionPayload } from "./evolution-types.js";

const OWNER_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const SEGMENT_MODE = 0o600;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_SEGMENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_QUERY_LIMIT = 200;
const PROJECT_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const SEGMENT_NAME_PATTERN = /^(\d{12})-(\d{12})-([0-9a-f]{64})\.json$/u;

export interface EvolutionSegment {
  schemaVersion: 1;
  projectId: string;
  sequenceStart: number;
  sequenceEnd: number;
  previousSegmentHash: string | null;
  records: { id: string; payload: EvolutionPayload; recordHash: string }[];
  segmentHash: string;
}

export interface EvolutionHead {
  schemaVersion: 1;
  projectId: string;
  sequence: number;
  segmentHash: string | null;
  updatedAt: string;
}

export interface EvolutionStoreHealth {
  state: "ready" | "unavailable" | "corrupt_suffix" | "over_quota";
  validThroughSequence: number;
  headSegmentHash: string | null;
  quarantinableSegmentHashes: string[];
}

export type EvolutionStoreFailurePoint =
  | "before_write"
  | "after_write"
  | "after_fsync"
  | "after_rename"
  | "after_directory_fsync"
  | "before_manifest_publication";

export interface EvolutionStoreOptions {
  readonly dataDirectory: string;
  readonly maxBytes?: number;
  readonly queryLimit?: number;
  readonly failureInjector?: (point: EvolutionStoreFailurePoint) => void | Promise<void>;
  readonly now?: () => string;
}

export class EvolutionStoreError extends Error {
  constructor(
    readonly code:
      | "evolution_store_owned_elsewhere"
      | "evolution_store_compare_failed"
      | "evolution_store_duplicate_record"
      | "evolution_store_over_quota"
      | "evolution_store_invalid_project"
      | "evolution_store_unsafe_path"
      | "evolution_store_record_too_large"
      | "evolution_store_segment_too_large"
      | "evolution_store_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "EvolutionStoreError";
  }
}

interface SharedLease {
  readonly key: string;
  readonly root: string;
  readonly rootIdentity: string;
  readonly ownerPath: string;
  readonly startNonce: string;
  readonly mutexes: Map<string, AsyncMutex>;
  references: number;
}

interface ScannedProject {
  readonly head: EvolutionHead;
  readonly records: readonly { sequence: number; id: string; payload: EvolutionPayload }[];
  readonly ids: ReadonlySet<string>;
  readonly health: EvolutionStoreHealth;
  readonly bytes: number;
}

const leases = new Map<string, SharedLease>();
const leaseLocks = new Map<string, AsyncMutex>();

export class EvolutionStore {
  readonly #root: string;
  readonly #projectsRoot: string;
  readonly #maxBytes: number;
  readonly #queryLimit: number;
  readonly #failureInjector: EvolutionStoreOptions["failureInjector"];
  readonly #now: () => string;
  #lease: SharedLease | null = null;
  #closed = false;

  constructor(options: EvolutionStoreOptions) {
    this.#root = path.resolve(options.dataDirectory, "evolution");
    this.#projectsRoot = path.join(this.#root, "projects");
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#queryLimit = options.queryLimit ?? DEFAULT_QUERY_LIMIT;
    this.#failureInjector = options.failureInjector;
    this.#now = options.now ?? (() => new Date().toISOString());
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 16 * 1024 * 1024 ||
      this.#maxBytes > 100 * 1024 * 1024 * 1024) {
      throw new RangeError("Evolution store quota must be between 16 MiB and 100 GiB");
    }
    if (!Number.isSafeInteger(this.#queryLimit) || this.#queryLimit < 1 || this.#queryLimit > 200) {
      throw new RangeError("Evolution query limit must be between 1 and 200");
    }
  }

  async initialize(): Promise<void> {
    if (this.#lease !== null) return;
    if (this.#closed) throw new EvolutionStoreError("evolution_store_unavailable", "Evolution store is closed");
    await ensureDirectory(this.#root);
    await ensureDirectory(this.#projectsRoot);
    const rootRealPath = await realpath(this.#root);
    const identity = await directoryIdentity(this.#root);
    const key = rootRealPath;
    const lock = leaseLocks.get(key) ?? new AsyncMutex();
    leaseLocks.set(key, lock);
    await lock.run(async () => {
      const existing = leases.get(key);
      if (existing !== undefined) {
        if (existing.rootIdentity !== identity) {
          throw new EvolutionStoreError("evolution_store_unsafe_path", "Evolution root was replaced");
        }
        existing.references += 1;
        this.#lease = existing;
        return;
      }
      const lease = await acquireLease(key, this.#root, identity);
      leases.set(key, lease);
      this.#lease = lease;
      await cleanupProvenOrphans(this.#projectsRoot);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const lease = this.#lease;
    this.#lease = null;
    if (lease === null) return;
    const lock = leaseLocks.get(lease.key) ?? new AsyncMutex();
    await lock.run(async () => {
      lease.references -= 1;
      if (lease.references > 0 || leases.get(lease.key) !== lease) return;
      await assertRootIdentity(lease.root, lease.rootIdentity);
      const owner = await readOwner(lease.ownerPath);
      if (owner !== null && owner.pid === process.pid && owner.startNonce === lease.startNonce) {
        await unlink(lease.ownerPath);
        await fsyncDirectory(lease.root);
      }
      leases.delete(lease.key);
      leaseLocks.delete(lease.key);
    });
  }

  async head(projectId: string): Promise<EvolutionHead> {
    return this.#withProject(projectId, async (projectDirectory) =>
      (await this.#scanProject(projectId, projectDirectory, true)).head);
  }

  async appendBatch(input: {
    projectId: string;
    expectedHeadHash: string | null;
    records: EvolutionPayload[];
  }): Promise<{ head: EvolutionHead; appendedRecordIds: string[] }> {
    const lease = this.#requireLease();
    assertProjectId(input.projectId);
    const mutex = lease.mutexes.get(input.projectId) ?? new AsyncMutex();
    lease.mutexes.set(input.projectId, mutex);
    return mutex.run(async () => this.#withProject(input.projectId, async (projectDirectory) => {
      const scanned = await this.#scanProject(input.projectId, projectDirectory, true);
      if (scanned.health.state === "corrupt_suffix") {
        throw new EvolutionStoreError("evolution_store_unavailable", "Evolution history has a corrupt suffix");
      }
      if (scanned.head.segmentHash !== input.expectedHeadHash) {
        throw new EvolutionStoreError("evolution_store_compare_failed", "Evolution head changed");
      }
      if (input.records.length === 0) return { head: scanned.head, appendedRecordIds: [] };
      const storedRecords = input.records.map((payload) => {
        const id = payloadId(payload);
        const bytes = Buffer.byteLength(canonicalSerialize(payload), "utf8");
        if (bytes > MAX_RECORD_BYTES) {
          throw new EvolutionStoreError("evolution_store_record_too_large", "Evolution record exceeds 64 KiB");
        }
        return { id, payload, recordHash: canonicalHash(payload) };
      });
      const batchIds = new Set<string>();
      for (const record of storedRecords) {
        if (batchIds.has(record.id) || scanned.ids.has(record.id)) {
          throw new EvolutionStoreError("evolution_store_duplicate_record", "Evolution record ID already exists");
        }
        batchIds.add(record.id);
      }
      const body = {
        schemaVersion: 1 as const,
        projectId: input.projectId,
        sequenceStart: scanned.head.sequence + 1,
        sequenceEnd: scanned.head.sequence + storedRecords.length,
        previousSegmentHash: scanned.head.segmentHash,
        records: storedRecords,
      };
      const segment: EvolutionSegment = { ...body, segmentHash: canonicalHash(body) };
      const bytes = Buffer.from(canonicalSerialize(segment), "utf8");
      if (bytes.byteLength > MAX_SEGMENT_BYTES) {
        throw new EvolutionStoreError("evolution_store_segment_too_large", "Evolution segment exceeds 1 MiB");
      }
      const usedBytes = await this.#historyBytes();
      if (usedBytes + bytes.byteLength > this.#maxBytes) {
        throw new EvolutionStoreError("evolution_store_over_quota", "Evolution store is over quota");
      }
      const segmentsDirectory = path.join(projectDirectory, "segments");
      const segmentName = segmentFileName(segment);
      await this.#publishFile(segmentsDirectory, segmentName, bytes, true);
      await this.#inject("before_manifest_publication");
      const head: EvolutionHead = {
        schemaVersion: 1,
        projectId: input.projectId,
        sequence: segment.sequenceEnd,
        segmentHash: segment.segmentHash,
        updatedAt: this.#now(),
      };
      await publishAtomic(projectDirectory, "head.json", Buffer.from(canonicalSerialize(head)), SEGMENT_MODE);
      return { head, appendedRecordIds: [...batchIds] };
    }));
  }

  async read(input: {
    projectId: string;
    afterSequence: number;
    limit: number;
  }): Promise<{ records: EvolutionPayload[]; nextSequence: number | null; health: EvolutionStoreHealth }> {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      throw new RangeError("Evolution sequence must be a non-negative integer");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > this.#queryLimit) {
      throw new RangeError(`Evolution read limit must be between 1 and ${this.#queryLimit}`);
    }
    return this.#withProject(input.projectId, async (projectDirectory) => {
      const scanned = await this.#scanProject(input.projectId, projectDirectory, true);
      const candidates = scanned.records.filter((record) => record.sequence > input.afterSequence);
      const page = candidates.slice(0, input.limit);
      return {
        records: page.map((record) => record.payload),
        nextSequence: candidates.length > page.length && page.length > 0
          ? page[page.length - 1]!.sequence
          : null,
        health: scanned.health,
      };
    });
  }

  async recordIds(projectId: string): Promise<Set<string>> {
    return this.#withProject(projectId, async (projectDirectory) =>
      new Set((await this.#scanProject(projectId, projectDirectory, true)).ids));
  }

  async recordPayloads(projectId: string): Promise<Map<string, EvolutionPayload>> {
    return this.#withProject(projectId, async (projectDirectory) =>
      new Map((await this.#scanProject(projectId, projectDirectory, true)).records
        .map((record) => [record.id, record.payload] as const)));
  }

  async #withProject<T>(projectId: string, operation: (directory: string) => Promise<T>): Promise<T> {
    const lease = this.#requireLease();
    assertProjectId(projectId);
    await assertRootIdentity(lease.root, lease.rootIdentity);
    const directory = path.join(this.#projectsRoot, projectId);
    await ensureDirectory(directory);
    await ensureDirectory(path.join(directory, "segments"));
    return operation(directory);
  }

  async #scanProject(projectId: string, projectDirectory: string, reconcile: boolean): Promise<ScannedProject> {
    const segmentsDirectory = path.join(projectDirectory, "segments");
    const entries = await readdir(segmentsDirectory, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.name.endsWith(".json") && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    let expectedSequence = 1;
    let previousHash: string | null = null;
    let bytes = 0;
    let corrupt = false;
    const quarantinableSegmentHashes: string[] = [];
    const records: { sequence: number; id: string; payload: EvolutionPayload }[] = [];
    const ids = new Set<string>();
    for (const name of names) {
      const nameMatch = SEGMENT_NAME_PATTERN.exec(name);
      if (corrupt || nameMatch === null) {
        corrupt = true;
        if (nameMatch !== null) quarantinableSegmentHashes.push(nameMatch[3]!);
        continue;
      }
      const segmentPath = path.join(segmentsDirectory, name);
      try {
        const file = await lstat(segmentPath);
        if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o777) !== SEGMENT_MODE ||
          file.size > MAX_SEGMENT_BYTES) throw new Error("unsafe segment file");
        bytes += file.size;
        const segment = JSON.parse(await readFile(segmentPath, "utf8")) as EvolutionSegment;
        validateSegment(segment, projectId, expectedSequence, previousHash, ids);
        if (segment.segmentHash !== nameMatch[3] || segment.sequenceStart !== Number(nameMatch[1]) ||
          segment.sequenceEnd !== Number(nameMatch[2])) throw new Error("segment filename mismatch");
        for (let index = 0; index < segment.records.length; index += 1) {
          const record = segment.records[index]!;
          records.push({ sequence: segment.sequenceStart + index, id: record.id, payload: record.payload });
          ids.add(record.id);
        }
        expectedSequence = segment.sequenceEnd + 1;
        previousHash = segment.segmentHash;
      } catch {
        corrupt = true;
        quarantinableSegmentHashes.push(nameMatch[3]!);
      }
    }
    const validHead: EvolutionHead = {
      schemaVersion: 1,
      projectId,
      sequence: expectedSequence - 1,
      segmentHash: previousHash,
      updatedAt: this.#now(),
    };
    const manifest = await readHead(projectDirectory, projectId);
    const manifestMatches = manifest !== null && manifest.sequence === validHead.sequence &&
      manifest.segmentHash === validHead.segmentHash;
    let manifestCorrupt = false;
    if (manifest === null) {
      const headPath = path.join(projectDirectory, "head.json");
      try {
        await lstat(headPath);
        manifestCorrupt = true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    } else if (!manifestMatches && manifest.sequence > validHead.sequence) {
      manifestCorrupt = true;
    }
    const head = manifestMatches ? manifest! : validHead;
    if (reconcile && !corrupt && !manifestCorrupt && !manifestMatches) {
      await publishAtomic(projectDirectory, "head.json", Buffer.from(canonicalSerialize(validHead)), SEGMENT_MODE);
    }
    const overQuota = await this.#historyBytes(false) > this.#maxBytes;
    const health: EvolutionStoreHealth = {
      state: corrupt || manifestCorrupt ? "corrupt_suffix" : overQuota ? "over_quota" : "ready",
      validThroughSequence: validHead.sequence,
      headSegmentHash: validHead.segmentHash,
      quarantinableSegmentHashes: [...new Set(quarantinableSegmentHashes)].sort(),
    };
    return { head, records, ids, health, bytes };
  }

  async #historyBytes(validate = true): Promise<number> {
    let total = 0;
    const projects = await readdir(this.#projectsRoot, { withFileTypes: true });
    for (const project of projects) {
      const projectPath = path.join(this.#projectsRoot, project.name);
      if (!project.isDirectory() || project.isSymbolicLink() || !PROJECT_ID_PATTERN.test(project.name)) {
        if (validate) throw new EvolutionStoreError("evolution_store_unsafe_path", "Unsafe evolution Project entry");
        continue;
      }
      const segmentsPath = path.join(projectPath, "segments");
      let segments;
      try {
        segments = await readdir(segmentsPath, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const segment of segments) {
        if (!segment.isFile() || segment.isSymbolicLink() || !segment.name.endsWith(".json")) continue;
        total += (await lstat(path.join(segmentsPath, segment.name))).size;
      }
    }
    return total;
  }

  async #publishFile(directory: string, name: string, bytes: Buffer, inject: boolean): Promise<void> {
    const temporary = path.join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    let renamed = false;
    let handle;
    try {
      if (inject) await this.#inject("before_write");
      handle = await open(temporary, "wx", SEGMENT_MODE);
      await handle.writeFile(bytes);
      if (inject) await this.#inject("after_write");
      await handle.sync();
      if (inject) await this.#inject("after_fsync");
      await handle.close();
      handle = undefined;
      await rename(temporary, path.join(directory, name));
      renamed = true;
      if (inject) await this.#inject("after_rename");
      await fsyncDirectory(directory);
      if (inject) await this.#inject("after_directory_fsync");
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }

  async #inject(point: EvolutionStoreFailurePoint): Promise<void> {
    await this.#failureInjector?.(point);
  }

  #requireLease(): SharedLease {
    if (this.#lease === null || this.#closed) {
      throw new EvolutionStoreError("evolution_store_unavailable", "Evolution store is not initialized");
    }
    return this.#lease;
  }
}

class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function acquireLease(key: string, root: string, rootIdentity: string): Promise<SharedLease> {
  const ownerPath = path.join(root, "owner.json");
  const startNonce = randomUUID();
  const owner = { schemaVersion: 1, pid: process.pid, startNonce };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(ownerPath, "wx", OWNER_MODE);
      try {
        await handle.writeFile(canonicalSerialize(owner));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(root);
      return { key, root, rootIdentity, ownerPath, startNonce, mutexes: new Map(), references: 1 };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const current = await readOwner(ownerPath);
      if (current === null || await processExists(current.pid)) {
        throw new EvolutionStoreError("evolution_store_owned_elsewhere", "Evolution store is owned by another process");
      }
      await assertRootIdentity(root, rootIdentity);
      const rechecked = await readOwner(ownerPath);
      if (rechecked === null || rechecked.pid !== current.pid || rechecked.startNonce !== current.startNonce) {
        throw new EvolutionStoreError("evolution_store_owned_elsewhere", "Evolution store owner changed during stale-owner validation");
      }
      await unlink(ownerPath);
      await fsyncDirectory(root);
    }
  }
  throw new EvolutionStoreError("evolution_store_owned_elsewhere", "Evolution store ownership could not be acquired");
}

async function readOwner(ownerPath: string): Promise<{ schemaVersion: 1; pid: number; startNonce: string } | null> {
  try {
    const file = await lstat(ownerPath);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o777) !== OWNER_MODE) return null;
    const value = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || typeof value.startNonce !== "string" ||
      value.startNonce.length === 0 || Object.keys(value).sort().join(",") !== "pid,schemaVersion,startNonce") return null;
    return value as { schemaVersion: 1; pid: number; startNonce: string };
  } catch (error) {
    if (isMissing(error)) return null;
    return null;
  }
}

async function readHead(projectDirectory: string, projectId: string): Promise<EvolutionHead | null> {
  const headPath = path.join(projectDirectory, "head.json");
  try {
    const file = await lstat(headPath);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o777) !== SEGMENT_MODE) return null;
    const value = JSON.parse(await readFile(headPath, "utf8")) as EvolutionHead;
    if (value.schemaVersion !== 1 || value.projectId !== projectId || !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0 || (value.segmentHash !== null && !/^[0-9a-f]{64}$/u.test(value.segmentHash)) ||
      Number.isNaN(Date.parse(value.updatedAt))) return null;
    if ((value.sequence === 0) !== (value.segmentHash === null)) return null;
    return value;
  } catch (error) {
    if (isMissing(error)) return null;
    return null;
  }
}

function validateSegment(
  segment: EvolutionSegment,
  projectId: string,
  expectedSequence: number,
  previousHash: string | null,
  existingIds: ReadonlySet<string>,
): void {
  if (segment.schemaVersion !== 1 || segment.projectId !== projectId ||
    segment.sequenceStart !== expectedSequence || segment.previousSegmentHash !== previousHash ||
    !Array.isArray(segment.records) || segment.records.length === 0 ||
    segment.sequenceEnd !== segment.sequenceStart + segment.records.length - 1) throw new Error("invalid segment boundary");
  const body = {
    schemaVersion: segment.schemaVersion,
    projectId: segment.projectId,
    sequenceStart: segment.sequenceStart,
    sequenceEnd: segment.sequenceEnd,
    previousSegmentHash: segment.previousSegmentHash,
    records: segment.records,
  };
  if (segment.segmentHash !== canonicalHash(body)) throw new Error("segment hash mismatch");
  const local = new Set<string>();
  for (const record of segment.records) {
    if (record.id !== payloadId(record.payload) || record.recordHash !== canonicalHash(record.payload) ||
      existingIds.has(record.id) || local.has(record.id) ||
      Buffer.byteLength(canonicalSerialize(record.payload), "utf8") > MAX_RECORD_BYTES) {
      throw new Error("invalid segment record");
    }
    local.add(record.id);
  }
}

function payloadId(payload: EvolutionPayload): string {
  const id = payload?.value?.id;
  if (typeof id !== "string" || !/^[0-9a-f]{64}$/u.test(id)) {
    throw new EvolutionStoreError("evolution_store_record_too_large", "Evolution payload has no valid record ID");
  }
  return id;
}

function segmentFileName(segment: EvolutionSegment): string {
  return `${String(segment.sequenceStart).padStart(12, "0")}-${String(segment.sequenceEnd).padStart(12, "0")}-${segment.segmentHash}.json`;
}

async function publishAtomic(directory: string, name: string, bytes: Buffer, mode: number): Promise<void> {
  const temporary = path.join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path.join(directory, name));
    renamed = true;
    await chmod(path.join(directory, name), mode);
    await fsyncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const value = await lstat(directory);
  if (!value.isDirectory() || value.isSymbolicLink() || (value.mode & 0o777) !== DIRECTORY_MODE) {
    throw new EvolutionStoreError("evolution_store_unsafe_path", `Unsafe evolution directory: ${directory}`);
  }
}

async function directoryIdentity(directory: string): Promise<string> {
  const value = await stat(directory);
  return `${value.dev}:${value.ino}`;
}

async function assertRootIdentity(root: string, expected: string): Promise<void> {
  const value = await lstat(root);
  if (!value.isDirectory() || value.isSymbolicLink() || `${value.dev}:${value.ino}` !== expected) {
    throw new EvolutionStoreError("evolution_store_unsafe_path", "Evolution root identity changed");
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function processExists(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function cleanupProvenOrphans(projectsRoot: string): Promise<void> {
  const projects = await readdir(projectsRoot, { withFileTypes: true });
  const segmentTemp = /^\.\d{12}-\d{12}-[0-9a-f]{64}\.json\.\d+\.[0-9a-f-]{36}\.tmp$/u;
  const headTemp = /^\.head\.json\.\d+\.[0-9a-f-]{36}\.tmp$/u;
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink() || !PROJECT_ID_PATTERN.test(project.name)) continue;
    const projectDirectory = path.join(projectsRoot, project.name);
    const locations = [
      { directory: projectDirectory, pattern: headTemp },
      { directory: path.join(projectDirectory, "segments"), pattern: segmentTemp },
    ];
    for (const location of locations) {
      let entries;
      try {
        entries = await readdir(location.directory, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || !location.pattern.test(entry.name)) continue;
        const temporary = path.join(location.directory, entry.name);
        const value = await lstat(temporary);
        if ((value.mode & 0o777) !== SEGMENT_MODE) continue;
        await unlink(temporary);
      }
      await fsyncDirectory(location.directory);
    }
  }
}

function assertProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new EvolutionStoreError("evolution_store_invalid_project", "Evolution Project ID is unsafe");
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "EEXIST";
}
