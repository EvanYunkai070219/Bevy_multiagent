import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import { RunControl } from "../src/orchestration/run-control.js";
import { VerificationContainer } from "../src/orchestration/verification/verification-container.js";
import type { AuthorityGate } from "../src/orchestration/verification/verification-profile.js";
import { realVerificationFixture } from "./verification-container-fixtures.js";

const directories: string[] = [];
const LEASE_NAME = ".authority-lease";
const POSIX_PROCESS_GROUPS_SUPPORTED = process.platform !== "win32";
const PROCESS_CLEANUP_TIMEOUT_MS = 5_000;
const PROCESS_ABSENCE_SETTLE_MS = 250;

const gate: AuthorityGate = {
  id: "targeted",
  tier: "targeted",
  command: ["node", "gates/targeted.mjs"],
  assetIds: ["targeted-gate"],
  critical: true,
};

interface ReconciliationHooks {
  afterEngineSpawnForTest?: (args: readonly string[], child: ChildProcess) => void;
  afterReconciliationRecordRenameForTest?: (recordPath: string) => void | Promise<void>;
  afterDeadReconciliationLeaseObservedForTest?: (leasePath: string) => void | Promise<void>;
  beforeReconciliationLeaseQuarantineForTest?: (
    leasePath: string,
    purpose: "reclaim" | "release",
  ) => void | Promise<void>;
  reconciliationLockHostForTest?: string;
}

interface RecoveryFixture {
  config: AppConfig;
  enginePidPath: string;
  inspectReady: string;
  inspectRelease: string;
  leasePath: string;
  log: string;
  recordPath: string;
}

interface ReconcilerProcess {
  child: ChildProcess;
  result: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
}

function withHooks(config: AppConfig, hooks: ReconciliationHooks): VerificationContainer {
  const Constructor = VerificationContainer as unknown as new (
    config: AppConfig,
    hooks: ReconciliationHooks,
  ) => VerificationContainer;
  return new Constructor(config, hooks);
}

function reconciliationDirectory(dataDirectory: string): string {
  return path.join(dataDirectory, "container-authority", "verification-reconciliation");
}

async function reconciliationRecordPaths(dataDirectory: string): Promise<string[]> {
  const directory = reconciliationDirectory(dataDirectory);
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((entry) => entry.endsWith(".json")).sort().map((entry) => path.join(directory, entry));
}

async function waitForPath(target: string): Promise<void> {
  await expect.poll(
    async () => access(target).then(() => true).catch(() => false),
    { timeout: 15_000 },
  ).toBe(true);
}

async function reconciliationLockPort(dataDirectory: string): Promise<number> {
  const authorityRealPath = await realpath(reconciliationDirectory(dataDirectory));
  const digest = createHash("sha256")
    .update("launchpad-verification-reconciliation-lock\0")
    .update(authorityRealPath)
    .digest();
  return 20_000 + (digest.readUInt32BE(0) % 40_000);
}

async function loopbackPortAvailable(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
    throw error;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
}

async function prepareRecoveryFixture(
  root: string,
  behavior: { volumeInspectPidDelaySeconds?: number } = {},
): Promise<RecoveryFixture> {
  const enginePidPath = path.join(root, "recovery-engine.pid");
  const inspectReady = path.join(root, "recovery-inspect-ready");
  const inspectRelease = path.join(root, "recovery-inspect-release");
  const log = path.join(root, "commands.log");
  const fixture = await realVerificationFixture({
    root,
    behavior: {
      log,
      volumeInspectReady: inspectReady,
      volumeInspectRelease: inspectRelease,
      volumeInspectPid: enginePidPath,
      volumeInspectPidDelaySeconds: behavior.volumeInspectPidDelaySeconds,
    },
  });
  const directory = reconciliationDirectory(fixture.config.dataDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ownerId = "1".repeat(64);
  const recordPath = path.join(directory, ownerId + ".json");
  await writeFile(recordPath, JSON.stringify({
    schemaVersion: 2,
    revision: 1,
    ownerToken: "2".repeat(64),
    ownerId,
    containerName: "launchpad-verifier-" + ownerId,
    containerId: null,
    volumeName: "launchpad-verifier-completion-" + ownerId,
    volumeIdentity: null,
    state: "volume_ready",
  }) + "\n", { mode: 0o600 });
  return {
    config: fixture.config,
    enginePidPath,
    inspectReady,
    inspectRelease,
    leasePath: path.join(directory, LEASE_NAME),
    log,
    recordPath,
  };
}

function startReconciler(config: AppConfig): ReconcilerProcess {
  const configModule = new URL("../src/config.ts", import.meta.url).href;
  const containerModule = new URL("../src/orchestration/verification/verification-container.ts", import.meta.url).href;
  const source = [
    `import { loadConfig } from ${JSON.stringify(configModule)};`,
    `import { VerificationContainer } from ${JSON.stringify(containerModule)};`,
    "const [dataDirectory, containerEngine] = process.argv.slice(1);",
    "const config = loadConfig({ NODE_ENV: 'test', APP_DATA_DIR: dataDirectory, CONTAINER_ENGINE: containerEngine, ARK_API_KEY: 'test-key', ARK_MODEL: 'ep-test' });",
    "try {",
    "  const result = await new VerificationContainer(config).reconcilePending();",
    "  process.stdout.write(JSON.stringify({ kind: 'result', result }) + '\\n');",
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({ kind: 'error', code: error?.code, message: error?.message }) + '\\n');",
    "  process.exitCode = 2;",
    "}",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    source,
    config.dataDirectory,
    config.containerEngine,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
    },
  );
  return { child, result };
}

async function cleanupReconcilerAndExactEngines(
  reconciler: ReconcilerProcess | readonly ReconcilerProcess[] | undefined,
  fixture: RecoveryFixture,
): Promise<void> {
  if (!POSIX_PROCESS_GROUPS_SUPPORTED) {
    throw new Error("Exact fake-engine process-group cleanup requires a POSIX platform");
  }
  const cleanupErrors: unknown[] = [];
  const reconcilers = reconciler === undefined
    ? []
    : Array.isArray(reconciler) ? reconciler : [reconciler];
  for (const manager of reconcilers) {
    try {
      if (manager.child.exitCode === null && manager.child.signalCode === null) {
        const pid = manager.child.pid;
        if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
          throw new Error(`Refusing to signal unsafe reconciliation manager PID ${String(pid)}`);
        }
        manager.child.kill("SIGKILL");
      }
      await bounded(
        manager.result,
        PROCESS_CLEANUP_TIMEOUT_MS,
        "reconciliation manager did not exit after cleanup",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  try {
    await terminateExactFakeEngineGroupsAndProveAbsence(fixture);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Failed to clean reconciliation manager and exact fake engines");
  }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function terminateExactFakeEngineGroupsAndProveAbsence(fixture: RecoveryFixture): Promise<void> {
  const deadline = Date.now() + PROCESS_CLEANUP_TIMEOUT_MS;
  let absentSince: number | undefined;
  while (Date.now() <= deadline) {
    const processes = await exactFakeEngineProcesses(fixture.config.containerEngine);
    if (processes.length === 0) {
      await rm(fixture.enginePidPath, { force: true });
      absentSince ??= Date.now();
      if (Date.now() - absentSince >= PROCESS_ABSENCE_SETTLE_MS) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }

    absentSince = undefined;
    const currentProcessGroup = await processGroupFor(process.pid);
    const processGroups = [...new Set(processes.map((entry) => entry.pgid))];
    for (const processGroup of processGroups) {
      const groupMembers = processes.filter((entry) => entry.pgid === processGroup);
      for (const member of groupMembers) assertSafeExactProcess(member, currentProcessGroup);
      const refreshed = await exactFakeEngineProcesses(fixture.config.containerEngine);
      const refreshedGroup = refreshed.filter((entry) => entry.pgid === processGroup);
      if (refreshedGroup.length === 0) continue;
      for (const member of refreshedGroup) assertSafeExactProcess(member, currentProcessGroup);
      try {
        process.kill(-processGroup, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const survivors = await exactFakeEngineProcesses(fixture.config.containerEngine);
  throw new Error(`Exact fake engine processes survived cleanup: ${JSON.stringify(survivors)}`);
}

async function crashLeaseOwner(fixture: RecoveryFixture): Promise<Buffer> {
  let holder: ReconcilerProcess | undefined;
  try {
    holder = startReconciler(fixture.config);
    await waitForPath(fixture.inspectReady);
    return await readFile(fixture.leasePath);
  } finally {
    await cleanupReconcilerAndExactEngines(holder, fixture);
  }
}

function parseReconcilerResult(output: string): Record<string, unknown> {
  const line = output.trim().split("\n").at(-1);
  if (line === undefined || line.length === 0) throw new Error("Reconciler child returned no result");
  return JSON.parse(line) as Record<string, unknown>;
}

interface SystemProcess {
  pid: number;
  pgid: number;
  command: string;
}

async function systemProcesses(): Promise<SystemProcess[]> {
  const ps = spawn("ps", ["-axo", "pid=,pgid=,command="], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  ps.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  ps.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    ps.once("error", reject);
    ps.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`ps failed while locating exact fake-engine processes: ${stderr.trim()}`);
  }
  return stdout.split("\n").flatMap((line): SystemProcess[] => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match === null) return [];
    return [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3]! }];
  });
}

async function exactFakeEngineProcesses(enginePath: string): Promise<SystemProcess[]> {
  return (await systemProcesses())
    .filter((entry) => commandContainsExactArgument(entry.command, enginePath));
}

function commandContainsExactArgument(command: string, argument: string): boolean {
  let offset = command.indexOf(argument);
  while (offset !== -1) {
    const before = offset === 0 ? " " : command[offset - 1]!;
    const afterOffset = offset + argument.length;
    const after = afterOffset === command.length ? " " : command[afterOffset]!;
    if (/\s/.test(before) && /\s/.test(after)) return true;
    offset = command.indexOf(argument, offset + 1);
  }
  return false;
}

async function processGroupFor(pid: number): Promise<number> {
  const processEntry = (await systemProcesses()).find((entry) => entry.pid === pid);
  if (processEntry === undefined) throw new Error(`Unable to identify process group for PID ${pid}`);
  return processEntry.pgid;
}

function assertSafeExactProcess(entry: SystemProcess, currentProcessGroup: number): void {
  if (
    !Number.isSafeInteger(entry.pid)
    || !Number.isSafeInteger(entry.pgid)
    || entry.pid <= 1
    || entry.pgid <= 1
    || entry.pid === process.pid
    || entry.pgid === currentProcessGroup
  ) {
    throw new Error(`Refusing to signal unsafe exact fake-engine process: ${JSON.stringify(entry)}`);
  }
}

async function run(container: VerificationContainer, fixture: {
  workspace: string;
  authorityRoot: string;
}) {
  return container.run({
    candidatePath: fixture.workspace,
    authorityRoot: fixture.authorityRoot,
    gate,
    control: new RunControl(defaultExecutionPolicy),
  });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("verification reconciliation authority", () => {
  it("serializes a live run and an in-process reconciler for the same authority directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-mutex-"));
    directories.push(root);
    const inspectReady = path.join(root, "inspect-ready");
    const inspectRelease = path.join(root, "inspect-release");
    const log = path.join(root, "commands.log");
    const fixture = await realVerificationFixture({
      root,
      behavior: { log, volumeInspectReady: inspectReady, volumeInspectRelease: inspectRelease },
    });

    const running = run(fixture.container, fixture);
    await waitForPath(inspectReady);
    const reconciling = new VerificationContainer(fixture.config).reconcilePending();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const beforeRelease = await readFile(log, "utf8");
    const concurrentInspections = beforeRelease.split("\n").filter((line) => line.startsWith("volume inspect ")).length;
    await writeFile(inspectRelease, "release\n", "utf8");
    await Promise.all([running, reconciling]);

    expect(concurrentInspections).toBe(1);
  });

  it("does not unlink or overwrite a record changed after its reconciliation snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-cas-"));
    directories.push(root);
    const createCommitted = path.join(root, "create-committed");
    const inspectReady = path.join(root, "inspect-ready");
    const inspectRelease = path.join(root, "inspect-release");
    const fixture = await realVerificationFixture({
      root,
      behavior: {
        createCommitMarker: createCommitted,
        createDaemonDelayMs: 150,
        createTransportExitsBeforeDaemonCommit: true,
        volumeInspectReady: inspectReady,
        volumeInspectReadyAttempt: 2,
        volumeInspectRelease: inspectRelease,
      },
    });
    await expect(run(fixture.container, fixture)).rejects.toMatchObject({
      code: "verification_container_absence_unproven",
    });
    await waitForPath(createCommitted);

    const reconciling = new VerificationContainer(fixture.config).reconcilePending();
    await waitForPath(inspectReady);
    const [recordPath] = await reconciliationRecordPaths(fixture.config.dataDirectory);
    expect(recordPath).toBeDefined();
    const snapshot = JSON.parse(await readFile(recordPath!, "utf8")) as Record<string, unknown>;
    const replacement = {
      ...snapshot,
      revision: typeof snapshot.revision === "number" ? snapshot.revision + 1 : 2,
      ownerToken: "f".repeat(64),
    };
    const replacementBytes = JSON.stringify(replacement) + "\n";
    const temporary = recordPath! + ".replacement";
    await writeFile(temporary, replacementBytes, { mode: 0o600 });
    await rename(temporary, recordPath!);
    await writeFile(inspectRelease, "release\n", "utf8");

    await expect(reconciling).resolves.toEqual({ pending: 1, removed: 0 });
    await expect(readFile(recordPath!, "utf8")).resolves.toBe(replacementBytes);
  });

  it.skipIf(!POSIX_PROCESS_GROUPS_SUPPORTED)("fails closed and preserves the lease while its exact process owner is alive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-lease-"));
    directories.push(root);
    const fixture = await prepareRecoveryFixture(root);
    let holder: ReconcilerProcess | undefined;
    try {
      holder = startReconciler(fixture.config);
      await waitForPath(fixture.inspectReady);
      const leaseBytes = await readFile(fixture.leasePath);
      const lease = JSON.parse(leaseBytes.toString("utf8")) as Record<string, unknown>;

      await expect(new VerificationContainer(fixture.config).reconcilePending()).rejects.toMatchObject({
        code: "verification_reconciliation_authority_unavailable",
      });
      expect(lease).toMatchObject({
        schemaVersion: 3,
        pid: holder.child.pid,
        ownerToken: expect.stringMatching(/^[0-9a-f]{64}$/),
        processStartIdentity: expect.any(String),
        machineIdentity: expect.any(String),
        bootIdentity: expect.any(String),
      });
      await expect(readFile(fixture.leasePath)).resolves.toEqual(leaseBytes);
      const inspections = (await readFile(fixture.log, "utf8")).split("\n")
        .filter((line) => line.startsWith("volume inspect "));
      expect(inspections).toHaveLength(1);
    } finally {
      await cleanupReconcilerAndExactEngines(holder, fixture);
    }
  });

  it.skipIf(!POSIX_PROCESS_GROUPS_SUPPORTED)("keeps a live owner blocked when mutable hostname evidence changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-hostname-change-"));
    directories.push(root);
    const fixture = await prepareRecoveryFixture(root);
    let holder: ReconcilerProcess | undefined;
    try {
      holder = startReconciler(fixture.config);
      await waitForPath(fixture.inspectReady);
      const original = JSON.parse(await readFile(fixture.leasePath, "utf8")) as Record<string, unknown>;
      const changed = original.schemaVersion === 2
        ? {
            ...original,
            bootIdentity: String(original.bootIdentity).replace(/^([^:]+):[^:]+:/, "$1:renamed-host:"),
          }
        : { ...original, hostname: "renamed-host" };
      const changedBytes = Buffer.from(JSON.stringify(changed) + "\n", "utf8");
      const temporary = fixture.leasePath + ".hostname-change";
      await writeFile(temporary, changedBytes, { mode: 0o600 });
      await rename(temporary, fixture.leasePath);

      await expect(new VerificationContainer(fixture.config).reconcilePending()).rejects.toMatchObject({
        code: "verification_reconciliation_authority_unavailable",
      });
      await expect(readFile(fixture.leasePath)).resolves.toEqual(changedBytes);
      await expect(access(fixture.recordPath)).resolves.toBeUndefined();
    } finally {
      await cleanupReconcilerAndExactEngines(holder, fixture);
    }
  });

  it.skipIf(!POSIX_PROCESS_GROUPS_SUPPORTED)("holds a deterministic loopback lock until process death releases it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-os-lock-"));
    directories.push(root);
    const fixture = await prepareRecoveryFixture(root);
    let holder: ReconcilerProcess | undefined;
    try {
      holder = startReconciler(fixture.config);
      await waitForPath(fixture.inspectReady);
      const port = await reconciliationLockPort(fixture.config.dataDirectory);
      await expect(loopbackPortAvailable(port)).resolves.toBe(false);
      await cleanupReconcilerAndExactEngines(holder, fixture);
      await expect(loopbackPortAvailable(port)).resolves.toBe(true);
    } finally {
      await cleanupReconcilerAndExactEngines(holder, fixture);
    }
  });

  it.skipIf(!POSIX_PROCESS_GROUPS_SUPPORTED)("cleans the detached engine command after crashing the reconciliation manager", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-crash-group-"));
    directories.push(root);
    const fixture = await prepareRecoveryFixture(root);
    let holder: ReconcilerProcess | undefined;
    try {
      holder = startReconciler(fixture.config);
      await waitForPath(fixture.inspectReady);
      const enginePid = Number((await readFile(fixture.enginePidPath, "utf8")).trim());
      expect(Number.isSafeInteger(enginePid) && enginePid > 1).toBe(true);
      await cleanupReconcilerAndExactEngines(holder, fixture);
      await expect(exactFakeEngineProcesses(fixture.config.containerEngine)).resolves.toEqual([]);
    } finally {
      await cleanupReconcilerAndExactEngines(holder, fixture);
    }
  });

  it.skipIf(!POSIX_PROCESS_GROUPS_SUPPORTED)(
    "cleans an exact detached engine when setup fails before its PID marker is published",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-late-marker-"));
      directories.push(root);
      const fixture = await prepareRecoveryFixture(root, { volumeInspectPidDelaySeconds: 3 });
      let holder: ReconcilerProcess | undefined;
      let additionalEngine: ChildProcess | undefined;
      let additionalEngineResult: Promise<void> | undefined;

      await expect((async () => {
        try {
          holder = startReconciler(fixture.config);
          await waitForPath(fixture.inspectReady);
          additionalEngine = spawn(fixture.config.containerEngine, [
            "volume",
            "inspect",
            "--format",
            "{{json .}}",
            "second-exact-test-volume",
          ], { detached: true, stdio: "ignore" });
          additionalEngineResult = new Promise<void>((resolve, reject) => {
            additionalEngine!.once("error", reject);
            additionalEngine!.once("exit", () => resolve());
          });
          await expect.poll(
            async () => (await exactFakeEngineProcesses(fixture.config.containerEngine)).length,
            { timeout: 2_000 },
          ).toBeGreaterThanOrEqual(2);
          await expect(access(fixture.enginePidPath)).rejects.toMatchObject({ code: "ENOENT" });
          throw new Error("injected setup failure before the PID marker");
        } finally {
          await cleanupReconcilerAndExactEngines(holder, fixture);
          if (additionalEngineResult !== undefined) {
            await bounded(additionalEngineResult, PROCESS_CLEANUP_TIMEOUT_MS, "additional exact fake engine did not exit");
          }
        }
      })()).rejects.toThrow("injected setup failure before the PID marker");

      await expect.poll(
        async () => (await exactFakeEngineProcesses(fixture.config.containerEngine)).length,
        { timeout: 2_000 },
      ).toBe(0);
    },
  );

  it.skipIf(!POSIX_PROCESS_GROUPS_SUPPORTED)("reclaims a lease left by a crashed real manager and reconciles its exact record", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-owner-death-"));
    directories.push(root);
    const fixture = await prepareRecoveryFixture(root);
    await crashLeaseOwner(fixture);

    await expect(new VerificationContainer(fixture.config).reconcilePending()).resolves.toEqual({
      pending: 0,
      removed: 1,
    });
    await expect(access(fixture.recordPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(fixture.leasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(!POSIX_PROCESS_GROUPS_SUPPORTED)("fails closed and retains foreign-machine audit state after the local OS lock is free", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-foreign-host-"));
    directories.push(root);
    const fixture = await prepareRecoveryFixture(root);
    const staleBytes = await crashLeaseOwner(fixture);
    const stale = JSON.parse(staleBytes.toString("utf8")) as Record<string, unknown>;
    const foreign = stale.schemaVersion === 2
      ? {
          ...stale,
          bootIdentity: String(stale.bootIdentity).replace(/^([^:]+):[^:]+:/, "$1:foreign-host:"),
        }
      : { ...stale, machineIdentity: "foreign-machine-identity" };
    const foreignBytes = Buffer.from(JSON.stringify(foreign) + "\n", "utf8");
    const temporary = fixture.leasePath + ".foreign-host";
    await writeFile(temporary, foreignBytes, { mode: 0o600 });
    await rename(temporary, fixture.leasePath);

    await expect(new VerificationContainer(fixture.config).reconcilePending()).rejects.toMatchObject({
      code: "verification_reconciliation_authority_unavailable",
    });
    await expect(readFile(fixture.leasePath)).resolves.toEqual(foreignBytes);
    await expect(access(fixture.recordPath)).resolves.toBeUndefined();
  });

  it("fails closed before state or engine access when the OS lock cannot bind", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-lock-unsupported-"));
    directories.push(root);
    const fixture = await prepareRecoveryFixture(root);
    const manager = withHooks(fixture.config, {
      reconciliationLockHostForTest: "203.0.113.1",
    });

    await expect(manager.reconcilePending()).rejects.toMatchObject({
      code: "verification_reconciliation_authority_unavailable",
    });
    await expect(access(fixture.log)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(fixture.recordPath)).resolves.toBeUndefined();
  });

  it.skipIf(!POSIX_PROCESS_GROUPS_SUPPORTED)("allows exactly one cross-process winner while two managers concurrently reclaim a dead lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-reclaim-race-"));
    directories.push(root);
    const fixture = await prepareRecoveryFixture(root);
    await crashLeaseOwner(fixture);
    await Promise.all([
      rm(fixture.inspectReady, { force: true }),
      writeFile(path.join(root, "volume-inspect-count"), "0\n", "utf8"),
    ]);

    const contenders: ReconcilerProcess[] = [];
    try {
      contenders.push(startReconciler(fixture.config), startReconciler(fixture.config));
      await waitForPath(fixture.inspectReady);
      await expect.poll(
        () => contenders.filter((contender) => contender.child.exitCode !== null).length,
        { timeout: 5_000 },
      ).toBe(1);
      await writeFile(fixture.inspectRelease, "release\n", "utf8");
      const results = await Promise.all(contenders.map((contender) => contender.result));
      const parsed = results.map((result) => parseReconcilerResult(result.stdout));

      expect(parsed.filter((result) => result.kind === "result")).toEqual([
        { kind: "result", result: { pending: 0, removed: 1 } },
      ]);
      expect(parsed.filter((result) => result.kind === "error")).toEqual([
        expect.objectContaining({ kind: "error", code: "verification_reconciliation_authority_unavailable" }),
      ]);
    } finally {
      await cleanupReconcilerAndExactEngines(contenders, fixture);
    }
  });

  it.skipIf(!POSIX_PROCESS_GROUPS_SUPPORTED)("does not mistake a reused live PID with a different process start identity for the dead owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-pid-reuse-"));
    directories.push(root);
    const fixture = await prepareRecoveryFixture(root);
    const staleBytes = await crashLeaseOwner(fixture);
    const stale = JSON.parse(staleBytes.toString("utf8")) as Record<string, unknown>;
    const replacement = Buffer.from(JSON.stringify({ ...stale, pid: process.pid }) + "\n", "utf8");
    const temporary = fixture.leasePath + ".pid-reuse";
    await writeFile(temporary, replacement, { mode: 0o600 });
    await rename(temporary, fixture.leasePath);

    await expect(new VerificationContainer(fixture.config).reconcilePending()).resolves.toEqual({
      pending: 0,
      removed: 1,
    });
  });

  it.skipIf(!POSIX_PROCESS_GROUPS_SUPPORTED)("never quarantines a live replacement that appears after dead-owner validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-lease-replacement-"));
    const liveRoot = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-live-owner-"));
    directories.push(root, liveRoot);
    const fixture = await prepareRecoveryFixture(root);
    const liveFixture = await prepareRecoveryFixture(liveRoot);
    await crashLeaseOwner(fixture);
    let liveHolder: ReconcilerProcess | undefined;
    try {
      liveHolder = startReconciler(liveFixture.config);
      await waitForPath(liveFixture.inspectReady);
      const liveLease = await readFile(liveFixture.leasePath);
      let replaced = false;
      const manager = withHooks(fixture.config, {
        async afterDeadReconciliationLeaseObservedForTest(leasePath) {
          if (replaced) return;
          replaced = true;
          const temporary = leasePath + ".live-replacement";
          await writeFile(temporary, liveLease, { mode: 0o600 });
          await rename(temporary, leasePath);
        },
      });

      await expect(manager.reconcilePending()).rejects.toMatchObject({
        code: "verification_reconciliation_authority_unavailable",
      });
      expect(replaced).toBe(true);
      await expect(readFile(fixture.leasePath)).resolves.toEqual(liveLease);
      await expect(access(fixture.recordPath)).resolves.toBeUndefined();
    } finally {
      await cleanupReconcilerAndExactEngines(liveHolder, liveFixture);
    }
  });

  it.skipIf(!POSIX_PROCESS_GROUPS_SUPPORTED)("restores the exact replacement moved in the final verify-to-rename window", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-final-window-"));
    const liveRoot = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-final-window-live-"));
    directories.push(root, liveRoot);
    const fixture = await prepareRecoveryFixture(root);
    const liveFixture = await prepareRecoveryFixture(liveRoot);
    await crashLeaseOwner(fixture);
    let liveHolder: ReconcilerProcess | undefined;
    try {
      liveHolder = startReconciler(liveFixture.config);
      await waitForPath(liveFixture.inspectReady);
      const liveLease = await readFile(liveFixture.leasePath);
      let replaced = false;
      const manager = withHooks(fixture.config, {
        async beforeReconciliationLeaseQuarantineForTest(leasePath, purpose) {
          if (purpose !== "reclaim" || replaced) return;
          replaced = true;
          const temporary = leasePath + ".final-window-replacement";
          await writeFile(temporary, liveLease, { mode: 0o600 });
          await rename(temporary, leasePath);
        },
      });

      await expect(manager.reconcilePending()).rejects.toMatchObject({
        code: "verification_reconciliation_authority_unavailable",
      });
      expect(replaced).toBe(true);
      await expect(readFile(fixture.leasePath)).resolves.toEqual(liveLease);
      await expect(access(fixture.recordPath)).resolves.toBeUndefined();
    } finally {
      await cleanupReconcilerAndExactEngines(liveHolder, liveFixture);
    }
  });

  it.each([
    { phase: "volume create", expectedState: "volume_create_pending" },
    { phase: "container create", expectedState: "container_create_pending" },
  ])("preserves absence-unproven after an engine error emitted post-spawn during $phase", async ({ phase, expectedState }) => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-post-spawn-"));
    directories.push(root);
    const fixture = await realVerificationFixture({
      root,
      behavior: {
        createDelaySeconds: phase === "container create" ? 1 : 0,
        volumeCreateDelaySeconds: phase === "volume create" ? 1 : 0,
      },
    });
    let injected = false;
    const container = withHooks(fixture.config, {
      afterEngineSpawnForTest(args, child) {
        const target = phase === "volume create"
          ? args[0] === "volume" && args[1] === "create"
          : args[0] === "create";
        if (injected || !target) return;
        injected = true;
        queueMicrotask(() => child.emit("error", new Error("injected post-spawn transport error")));
      },
    });

    await expect(run(container, fixture)).rejects.toMatchObject({
      code: "verification_container_absence_unproven",
    });
    const [recordPath] = await reconciliationRecordPaths(fixture.config.dataDirectory);
    const record = JSON.parse(await readFile(recordPath!, "utf8")) as Record<string, unknown>;
    expect(injected).toBe(true);
    expect(record).toMatchObject({ schemaVersion: 2, state: expectedState });
  });

  it("leaves a durable record for restart when interrupted after rename and before directory fsync", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-fsync-"));
    directories.push(root);
    const fixture = await realVerificationFixture({ root });
    let interrupted = false;
    const container = withHooks(fixture.config, {
      afterReconciliationRecordRenameForTest() {
        if (interrupted) return;
        interrupted = true;
        throw new Error("injected crash before reconciliation directory fsync");
      },
    });

    await expect(run(container, fixture)).resolves.toMatchObject({ kind: "authority_failure" });
    const [recordPath] = await reconciliationRecordPaths(fixture.config.dataDirectory);
    expect(interrupted).toBe(true);
    await expect(readFile(recordPath!, "utf8")).resolves.toMatch(/"schemaVersion":2/);
    await expect(new VerificationContainer(fixture.config).reconcilePending()).resolves.toEqual({
      pending: 0,
      removed: 1,
    });
    await expect(reconciliationRecordPaths(fixture.config.dataDirectory)).resolves.toEqual([]);
  });

  it("detects replacement of the pinned authority directory before any later state operation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-directory-"));
    directories.push(root);
    const inspectReady = path.join(root, "inspect-ready");
    const inspectRelease = path.join(root, "inspect-release");
    const log = path.join(root, "commands.log");
    const fixture = await realVerificationFixture({
      root,
      behavior: { log, volumeInspectReady: inspectReady, volumeInspectRelease: inspectRelease },
    });
    const captured = run(fixture.container, fixture).then(
      (value) => value,
      (error: unknown) => error,
    );
    await waitForPath(inspectReady);
    const directory = reconciliationDirectory(fixture.config.dataDirectory);
    const original = directory + ".original";
    const entries = await readdir(directory);
    const recordName = entries.find((entry) => entry.endsWith(".json"));
    expect(recordName).toBeDefined();
    const [recordBytes, leaseBytes] = await Promise.all([
      readFile(path.join(directory, recordName!)),
      readFile(path.join(directory, LEASE_NAME)),
    ]);
    await rename(directory, original);
    await mkdir(directory, { mode: 0o700 });
    await Promise.all([
      writeFile(path.join(directory, recordName!), recordBytes, { mode: 0o600 }),
      writeFile(path.join(directory, LEASE_NAME), leaseBytes, { mode: 0o600 }),
    ]);
    const sentinel = path.join(directory, "sentinel");
    await writeFile(sentinel, "preserve\n", "utf8");
    await writeFile(inspectRelease, "release\n", "utf8");

    await expect(captured).resolves.toMatchObject({ code: "verification_container_absence_unproven" });
    const commands = await readFile(log, "utf8");
    expect(commands).not.toContain("start --attach");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve\n");
    await expect(readdir(original)).resolves.toEqual(expect.arrayContaining([LEASE_NAME]));
  });

  it.each(["missing", "replaced", "unlabelled", "auto_created"] as const)(
    "never starts when the exact completion volume is %s immediately before start",
    async (volumeInspectMutation) => {
      const root = await mkdtemp(path.join(tmpdir(), "launchpad-reconciliation-volume-"));
      directories.push(root);
      const log = path.join(root, "commands.log");
      const fixture = await realVerificationFixture({
        root,
        behavior: { log, volumeInspectMutation, volumeInspectMutationAt: 2 },
      });

      await run(fixture.container, fixture).catch(() => undefined);
      const commands = await readFile(log, "utf8");
      expect(commands).not.toContain("start --attach");
    },
  );
});
