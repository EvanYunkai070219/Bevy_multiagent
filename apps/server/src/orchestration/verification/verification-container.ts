import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  rm,
  unlink,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import {
  CONTAINER_OWNER_LABEL,
  createContainerAuthority,
  inspectOwnedVolumeIdentity,
  inspectOwnedContainerById,
  prepareContainerAuthority,
  removeOwnedContainer,
  removeOwnedVolume,
  resolveOwnedContainerId,
  type ContainerAuthority,
  type ContainerEngineCommand,
  type InspectedContainer,
  type OwnedVolumeIdentity,
} from "../../runtime/container-authority.js";
import { RunControl, RunTerminalError } from "../run-control.js";
import type { AuthorityGate, AuthorityMutant } from "./verification-profile.js";

const WRAPPER_GATE_SUCCEEDED = 200;
const WRAPPER_GATE_FAILED = 201;
const WRAPPER_AUTHORITY_FAILED = 202;
const COMPLETION_DIRECTORY_NAME = "completion";
const COMPLETION_REQUEST_NAME = "request.json";
const COMPLETION_ARTIFACT_NAME = "completion.json";
const COMPLETION_TEMPORARY_NAME = ".completion.tmp";
const CONTAINER_COMPLETION_DIRECTORY = "/run/launchpad-result";
const ARTIFACT_PATH_IN_CONTAINER = CONTAINER_COMPLETION_DIRECTORY + "/" + COMPLETION_ARTIFACT_NAME;
const RECONCILIATION_DIRECTORY_NAME = "verification-reconciliation";
const RECONCILIATION_LEASE_NAME = ".authority-lease";
const RECONCILIATION_LEASE_MAX_BYTES = 2_048;
const RECONCILIATION_RECORD_MAX_BYTES = 4_096;
const VERIFICATION_COMPLETION_VOLUME_PREFIX = "launchpad-verifier-completion-";
const STREAM_CLOSE_GRACE_MS = 500;
const TERM_TO_KILL_ESCALATION_MS = 50;
const JOINED_TERM_TO_KILL_ESCALATION_MS = 1;
const GATE_WRAPPER_SOURCE = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const GATE_SUCCEEDED = ${WRAPPER_GATE_SUCCEEDED};
const GATE_FAILED = ${WRAPPER_GATE_FAILED};
const AUTHORITY_FAILED = ${WRAPPER_AUTHORITY_FAILED};
const RESULT_DIRECTORY = ${JSON.stringify(CONTAINER_COMPLETION_DIRECTORY)};
const REQUEST_PATH = path.join(RESULT_DIRECTORY, ${JSON.stringify(COMPLETION_REQUEST_NAME)});
const ARTIFACT_PATH = path.join(RESULT_DIRECTORY, ${JSON.stringify(COMPLETION_ARTIFACT_NAME)});
const TEMPORARY_PATH = path.join(RESULT_DIRECTORY, ${JSON.stringify(COMPLETION_TEMPORARY_NAME)});
const [gateUidValue, gateGidValue, command, ...args] = process.argv.slice(1);
const gateUid = Number(gateUidValue);
const gateGid = Number(gateGidValue);
let started = false;
let settled = false;
let child;
let resultDirectoryIdentity;
let completionNonce;
const mode = (info) => info.mode & 0o777;
const sameIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
  left.gid === right.gid && mode(left) === mode(right);
const sameFileIdentity = (left, right) =>
  sameIdentity(left, right) && left.nlink === right.nlink && left.size === right.size &&
  left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
const exactEntries = (expected) => {
  const actual = fs.readdirSync(RESULT_DIRECTORY).sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw new Error("unexpected completion directory state");
  }
};
const withResultOwner = (operation) => {
  if (process.geteuid() !== 0 || process.getegid() !== 0 || !resultDirectoryIdentity) {
    throw new Error("wrapper did not retain root authority");
  }
  return operation();
};
const assertResultDirectory = () => {
  const current = fs.lstatSync(RESULT_DIRECTORY);
  if (!current.isDirectory() || current.isSymbolicLink() || mode(current) !== 0o700 ||
      !sameIdentity(resultDirectoryIdentity, current)) {
    throw new Error("completion directory identity changed");
  }
};
const readCompletionRequest = () => {
  const initial = fs.lstatSync(RESULT_DIRECTORY);
  if (!initial.isDirectory() || initial.isSymbolicLink() || initial.uid !== 0 || initial.gid !== 0) {
    throw new Error("completion directory was not isolated from the gate");
  }
  fs.chmodSync(RESULT_DIRECTORY, 0o700);
  resultDirectoryIdentity = fs.lstatSync(RESULT_DIRECTORY);
  if (initial.dev !== resultDirectoryIdentity.dev || initial.ino !== resultDirectoryIdentity.ino ||
      initial.uid !== resultDirectoryIdentity.uid || initial.gid !== resultDirectoryIdentity.gid ||
      mode(resultDirectoryIdentity) !== 0o700 ||
      resultDirectoryIdentity.uid === gateUid) {
    throw new Error("completion directory authority could not be pinned");
  }
  return withResultOwner(() => {
    assertResultDirectory();
    exactEntries([${JSON.stringify(COMPLETION_REQUEST_NAME)}]);
    const logical = fs.lstatSync(REQUEST_PATH);
    const descriptor = fs.openSync(REQUEST_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(descriptor);
      if (!logical.isFile() || logical.isSymbolicLink() || logical.nlink !== 1 ||
          mode(logical) !== 0o600 || logical.uid !== 0 || logical.gid !== 0 ||
          !sameFileIdentity(logical, opened)) {
        throw new Error("completion request identity was invalid");
      }
      const encoded = fs.readFileSync(descriptor, "utf8");
      const match = /^\\{"schemaVersion":1,"nonce":"([0-9a-f]{64})"\\}\\n$/.exec(encoded);
      if (!match) throw new Error("completion request was malformed");
      const after = fs.fstatSync(descriptor);
      if (!sameFileIdentity(opened, after)) throw new Error("completion request changed while open");
      fs.unlinkSync(REQUEST_PATH);
      exactEntries([]);
      return match[1];
    } finally {
      fs.closeSync(descriptor);
    }
  });
};
const gateProcessIds = () => fs.readdirSync("/proc")
  .filter((entry) => /^[1-9][0-9]*$/.test(entry))
  .map(Number)
  .filter((pid) => pid !== process.pid)
  .filter((pid) => {
    try {
      return !/^State:\\s+Z\\b/m.test(fs.readFileSync("/proc/" + pid + "/status", "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  });
const terminateGateProcesses = () => {
  const pids = gateProcessIds();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  return pids.length === 0;
};
const waitForGateProcesses = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (terminateGateProcesses()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("gate descendants did not quiesce");
};
const publishCompletion = (exitCode) => withResultOwner(() => {
  assertResultDirectory();
  exactEntries([]);
  const encoded = JSON.stringify({ schemaVersion: 1, nonce: completionNonce, exitCode }) + "\\n";
  const descriptor = fs.openSync(
    TEMPORARY_PATH,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || mode(opened) !== 0o600 ||
        opened.uid !== resultDirectoryIdentity.uid || opened.gid !== resultDirectoryIdentity.gid) {
      throw new Error("completion temporary identity was invalid");
    }
    fs.writeFileSync(descriptor, encoded, "utf8");
    fs.fsyncSync(descriptor);
    const written = fs.fstatSync(descriptor);
    if (!written.isFile() || written.nlink !== 1 || mode(written) !== 0o600 ||
        written.uid !== resultDirectoryIdentity.uid || written.gid !== resultDirectoryIdentity.gid ||
        written.size !== Buffer.byteLength(encoded)) {
      throw new Error("completion temporary changed while writing");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const temporary = fs.lstatSync(TEMPORARY_PATH);
  if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink !== 1 ||
      mode(temporary) !== 0o600 || temporary.uid !== resultDirectoryIdentity.uid ||
      temporary.gid !== resultDirectoryIdentity.gid || temporary.size !== Buffer.byteLength(encoded)) {
    throw new Error("completion temporary changed before publication");
  }
  fs.renameSync(TEMPORARY_PATH, ARTIFACT_PATH);
  const directoryDescriptor = fs.openSync(
    RESULT_DIRECTORY,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
  assertResultDirectory();
  exactEntries([${JSON.stringify(COMPLETION_ARTIFACT_NAME)}]);
  const logical = fs.lstatSync(ARTIFACT_PATH);
  const artifactDescriptor = fs.openSync(
    ARTIFACT_PATH,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(artifactDescriptor);
    if (!logical.isFile() || logical.isSymbolicLink() || logical.nlink !== 1 ||
        mode(logical) !== 0o600 || logical.uid !== resultDirectoryIdentity.uid ||
        logical.gid !== resultDirectoryIdentity.gid || logical.size !== Buffer.byteLength(encoded) ||
        !sameFileIdentity(logical, opened) || fs.readFileSync(artifactDescriptor, "utf8") !== encoded ||
        !sameFileIdentity(opened, fs.fstatSync(artifactDescriptor))) {
      throw new Error("published completion artifact was invalid");
    }
  } finally {
    fs.closeSync(artifactDescriptor);
  }
  return exitCode;
});
const gateEnvironment = {};
for (const name of [
  "LANG", "LC_ALL", "CI", "CANDIDATE", "SCRATCH", "HOME", "TMPDIR", "PATH", "GATE_ID",
]) {
  if (process.env[name] !== undefined) gateEnvironment[name] = process.env[name];
}
const failAuthority = () => {
  if (settled) return;
  settled = true;
  try {
    terminateGateProcesses();
  } catch {}
  process.exit(AUTHORITY_FAILED);
};
for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM", "SIGUSR1", "SIGUSR2"]) {
  process.on(signal, failAuthority);
}
process.on("uncaughtException", failAuthority);
process.on("unhandledRejection", failAuthority);
if (process.pid !== 1 || process.getuid() !== 0 || process.getgid() !== 0 || !command ||
    !Number.isSafeInteger(gateUid) || gateUid <= 0 ||
    !Number.isSafeInteger(gateGid) || gateGid <= 0) failAuthority();
try {
  completionNonce = readCompletionRequest();
  process.setgroups([]);
  child = spawn(command, args, {
    detached: true,
    env: gateEnvironment,
    gid: gateGid,
    stdio: ["ignore", "inherit", "inherit"],
    uid: gateUid,
  });
} catch {
  failAuthority();
}
child.once("spawn", () => {
  started = true;
});
child.once("error", failAuthority);
child.once("close", (exitCode, signal) => void (async () => {
  if (settled) return;
  if (!started || signal !== null || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    failAuthority();
    return;
  }
  try {
    await waitForGateProcesses();
    const normalizedExit = exitCode === 0 ? 0 : 1;
    publishCompletion(normalizedExit);
    settled = true;
    process.exit(normalizedExit === 0 ? GATE_SUCCEEDED : GATE_FAILED);
  } catch {
    failAuthority();
  }
})());
`.trim();

interface VerificationContainerOutput {
  stdout: Uint8Array;
  stderr: Uint8Array;
  elapsedMs: number;
}

interface VerificationExecutionCapture {
  stdout: Buffer[];
  stderr: Buffer[];
  totalBytes: number;
  outputExceeded: boolean;
}

interface VerificationEngineCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputExceeded: boolean;
  cancelled: boolean;
  stdout: Buffer;
  stderr: Buffer;
  spawned: boolean;
  spawnError?: unknown;
}

type VerificationEnginePhase = "work" | "cleanup";

interface ActiveVerificationEngineCommand {
  phase: VerificationEnginePhase;
  terminate(): void;
  settled: Promise<void>;
}

type VerificationReconciliationState =
  | "volume_ready"
  | "volume_create_pending"
  | "container_create_pending"
  | "container_ready";

interface VerificationReconciliationRecordV2 {
  schemaVersion: 2;
  revision: number;
  ownerToken: string;
  ownerId: string;
  containerName: string;
  containerId: string | null;
  volumeName: string;
  volumeIdentity: string | null;
  state: VerificationReconciliationState;
}

interface VerificationReconciliationDirectoryIdentity {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
}

interface VerificationReconciliationAuthority {
  parent: VerificationReconciliationDirectoryIdentity;
  directory: VerificationReconciliationDirectoryIdentity;
  leasePath: string;
  leaseOwnerToken: string;
  leaseEncoded: Buffer;
  leaseIdentity: Stats;
  osLock: VerificationReconciliationOsLock;
}

interface VerificationReconciliationLeaseOwner {
  schemaVersion: 3;
  ownerToken: string;
  pid: number;
  processStartIdentity: string;
  machineIdentity: string;
  bootIdentity: string;
}

interface VerificationReconciliationLeaseFile {
  path: string;
  owner: VerificationReconciliationLeaseOwner;
  encoded: Buffer;
  identity: Stats;
}

interface VerificationReconciliationExactFile {
  path: string;
  encoded: Buffer;
  identity: Stats;
}

interface VerificationReconciliationOsLock {
  server: Server;
  host: string;
  port: number;
}

interface VerificationReconciliationHandle {
  path: string;
  authority: ContainerAuthority;
  reconciliationAuthority: VerificationReconciliationAuthority;
  record: VerificationReconciliationRecordV2;
  encoded: Buffer;
  hooks: VerificationContainerHooks;
}

export interface VerificationContainerHooks {
  afterEngineSpawnForTest?: (args: readonly string[], child: ReturnType<typeof spawn>) => void;
  afterReconciliationRecordRenameForTest?: (recordPath: string) => void | Promise<void>;
  afterDeadReconciliationLeaseObservedForTest?: (leasePath: string) => void | Promise<void>;
  beforeReconciliationLeaseQuarantineForTest?: (
    leasePath: string,
    purpose: "reclaim" | "release",
  ) => void | Promise<void>;
  reconciliationLockHostForTest?: string;
}

class VerificationReconciliationMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

const verificationReconciliationMutex = new VerificationReconciliationMutex();

export type VerificationContainerOutcome =
  | VerificationContainerOutput & {
    kind: "command_exit";
    exitCode: number;
  }
  | VerificationContainerOutput & {
    kind: "authority_failure";
  };

class VerificationEngineLifecycle {
  readonly deadlineAt: number;
  readonly workDeadlineAt: number;
  private readonly workMaxBytes: number;
  private active: ActiveVerificationEngineCommand | undefined;
  private executionCancelled = false;
  private workTimedOut = false;
  private cleanupTimedOut = false;
  private workOutputExceeded = false;
  private totalOutputExceeded = false;
  private cleanupDeadlineAt: number | undefined;

  constructor(
    private readonly engine: string,
    private readonly capture: VerificationExecutionCapture,
    startedAt: number,
    wallMs: number,
    private readonly maxBytes: number,
    private readonly hooks: VerificationContainerHooks = {},
  ) {
    this.deadlineAt = startedAt + wallMs;
    const cleanupReserveMs = Math.min(5_000, Math.max(0, Math.floor(wallMs / 2)), Math.max(0, wallMs - 1));
    this.workDeadlineAt = this.deadlineAt - cleanupReserveMs;
    const cleanupReserveBytes = Math.min(
      Math.max(0, maxBytes - 128),
      Math.max(4_096, Math.floor(maxBytes / 4)),
    );
    this.workMaxBytes = maxBytes - cleanupReserveBytes;
  }

  cancelExecution(): void {
    this.executionCancelled = true;
    if (this.active?.phase === "work") this.active.terminate();
  }

  canAcceptWork(): boolean {
    return !this.executionCancelled &&
      !this.workTimedOut &&
      !this.workOutputExceeded &&
      !this.totalOutputExceeded &&
      Date.now() < this.workDeadlineAt;
  }

  authorityCommand(phase: VerificationEnginePhase): ContainerEngineCommand {
    return async (args) => {
      const result = await this.run({ args, exposeOutput: false, phase });
      if (!verificationEngineCommandSucceeded(result)) {
        const error = new Error("Verification engine authority command failed", {
          cause: result.spawnError,
        }) as Error & { stdout?: string; stderr?: string };
        error.stdout = result.stdout.toString("utf8");
        error.stderr = result.stderr.toString("utf8");
        throw error;
      }
      return {
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
      };
    };
  }

  beginCleanup(): void {
    // Safety cleanup may continue after the authority deadline, but the final
    // deadline assertion prevents that extra cleanup budget from restoring success.
    this.cleanupDeadlineAt = Math.max(this.deadlineAt, Date.now() + 5_000);
  }

  deadlineExceeded(): boolean {
    return Date.now() >= this.deadlineAt;
  }

  run(input: {
    args: string[];
    exposeOutput: boolean;
    phase: VerificationEnginePhase;
    stdin?: Buffer;
  }): Promise<VerificationEngineCommandResult> {
    const phaseDeadlineAt = input.phase === "work"
      ? this.workDeadlineAt
      : (this.cleanupDeadlineAt ?? this.deadlineAt);
    const now = Date.now();
    const cannotStart = this.active !== undefined ||
      (input.phase === "work" && !this.canAcceptWork()) ||
      (input.phase === "cleanup" && (this.totalOutputExceeded || this.cleanupTimedOut)) ||
      now >= phaseDeadlineAt;
    if (cannotStart) {
      if (now >= phaseDeadlineAt) {
        if (input.phase === "work") this.workTimedOut = true;
        else this.cleanupTimedOut = true;
      }
      return Promise.resolve({
        code: null,
        signal: null,
        timedOut: now >= phaseDeadlineAt || this.workTimedOut || this.cleanupTimedOut,
        outputExceeded: this.workOutputExceeded || this.totalOutputExceeded,
        cancelled: this.executionCancelled,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        spawned: false,
      });
    }

    return new Promise((resolve) => {
      const remainingMs = phaseDeadlineAt - now;
      let child;
      try {
        child = spawn(this.engine, input.args, {
          detached: process.platform !== "win32",
          env: hostEngineEnv(),
          stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
      } catch (spawnError) {
        resolve({
          code: null,
          signal: null,
          timedOut: false,
          outputExceeded: false,
          cancelled: this.executionCancelled,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          spawned: false,
          spawnError,
        });
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let commandTimedOut = false;
      let commandOutputExceeded = false;
      let spawnError: unknown;
      let spawned = false;
      let finished = false;
      let identityExited = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let streamCloseTimer: ReturnType<typeof setTimeout> | undefined;
      let settleJoin!: () => void;
      const settled = new Promise<void>((resolveSettled) => {
        settleJoin = resolveSettled;
      });
      const termination = createVerificationEngineTermination(child);
      const terminate = () => {
        void termination.terminate();
      };
      this.active = { phase: input.phase, terminate, settled };
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(commandTimer);
        if (streamCloseTimer !== undefined) clearTimeout(streamCloseTimer);
        termination.settle();
        if (this.active?.settled === settled) this.active = undefined;
        void termination.joined.then(() => {
          settleJoin();
          resolve({
            code,
            signal,
            timedOut: commandTimedOut,
            outputExceeded: commandOutputExceeded,
            cancelled: this.executionCancelled && input.phase === "work",
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            spawned,
            ...(spawnError === undefined ? {} : { spawnError }),
          });
        });
      };
      const consume = (chunk: Buffer, target: Buffer[], exposed: Buffer[]) => {
        const phaseLimit = input.phase === "work" ? this.workMaxBytes : this.maxBytes;
        const remaining = Math.max(0, phaseLimit - this.capture.totalBytes);
        if (chunk.byteLength > remaining) {
          this.capture.totalBytes += Math.min(chunk.byteLength, remaining + 1);
          this.capture.outputExceeded = true;
          commandOutputExceeded = true;
          if (input.phase === "work") this.workOutputExceeded = true;
          else this.totalOutputExceeded = true;
          terminate();
          return;
        }
        this.capture.totalBytes += chunk.byteLength;
        target.push(chunk);
        if (input.exposeOutput) exposed.push(chunk);
      };
      child.stdout?.on("data", (chunk: Buffer) => consume(chunk, stdout, this.capture.stdout));
      child.stderr?.on("data", (chunk: Buffer) => consume(chunk, stderr, this.capture.stderr));
      child.stdin?.on("error", () => undefined);
      if (input.stdin !== undefined) child.stdin?.end(input.stdin);
      const commandTimer = setTimeout(() => {
        commandTimedOut = true;
        if (input.phase === "work") this.workTimedOut = true;
        else this.cleanupTimedOut = true;
        terminate();
        if (identityExited) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(exitCode, exitSignal);
        }
      }, Math.max(1, remainingMs));
      commandTimer.unref();
      child.once("spawn", () => {
        spawned = true;
        this.hooks.afterEngineSpawnForTest?.(input.args, child);
      });
      child.once("error", (error) => {
        spawnError = error;
        if (!spawned) {
          termination.settle();
          finish(null, null);
          return;
        }
        terminate();
      });
      child.once("exit", (code, signal) => {
        identityExited = true;
        exitCode = code;
        exitSignal = signal;
        termination.settle();
        streamCloseTimer = setTimeout(() => {
          commandTimedOut = true;
          if (input.phase === "work") this.workTimedOut = true;
          else this.cleanupTimedOut = true;
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(exitCode, exitSignal);
        }, STREAM_CLOSE_GRACE_MS);
        streamCloseTimer.unref();
      });
      child.once("close", (code, signal) => finish(
        identityExited ? exitCode : code,
        identityExited ? exitSignal : signal,
      ));
    });
  }
}

export interface VerificationCompletionAuthority {
  directoryPath: string;
  requestPath: string;
  artifactPath: string;
  temporaryPath: string;
  nonce: string;
  realPath: string;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
  volumeName: string;
}

interface VerificationGateIdentity {
  uid: number;
  gid: number;
}

export async function prepareVerificationCompletionAuthority(
  authority: ContainerAuthority,
): Promise<VerificationCompletionAuthority> {
  const directoryPath = verificationCompletionDirectoryPath(authority);
  await mkdir(directoryPath, { mode: 0o700 });
  const identity = await captureCompletionDirectoryIdentity(directoryPath);
  const nonce = randomBytes(32).toString("hex");
  const requestPath = path.join(directoryPath, COMPLETION_REQUEST_NAME);
  const artifactPath = path.join(directoryPath, COMPLETION_ARTIFACT_NAME);
  const temporaryPath = path.join(directoryPath, COMPLETION_TEMPORARY_NAME);
  const encoded = `{"schemaVersion":1,"nonce":"${nonce}"}\n`;
  const handle = await open(
    requestPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      permissionMode(info.mode) !== 0o600 ||
      info.uid !== identity.uid ||
      info.gid !== identity.gid
    ) {
      throw new Error("Verification completion request identity was invalid");
    }
  } finally {
    await handle.close();
  }
  const request = await lstat(requestPath);
  if (
    !request.isFile() ||
    request.isSymbolicLink() ||
    request.nlink !== 1 ||
    permissionMode(request.mode) !== 0o600 ||
    request.uid !== identity.uid ||
    request.gid !== identity.gid ||
    (await readFile(requestPath, "utf8")) !== encoded
  ) {
    throw new Error("Verification completion request changed during preparation");
  }
  await assertVerificationCompletionDirectoryIdentity(identity);
  if (!sameStringArray((await readdir(directoryPath)).sort(), [COMPLETION_REQUEST_NAME])) {
    throw new Error("Verification completion directory had unexpected initial state");
  }
  return {
    ...identity,
    requestPath,
    artifactPath,
    temporaryPath,
    nonce,
    volumeName: verificationCompletionVolumeName(authority.ownerId),
  };
}

export async function validateVerificationCompletionArtifact(
  authority: VerificationCompletionAuthority,
  engineExitCode: number | null,
): Promise<number | undefined> {
  const gateExitCode = decodeVerificationWrapperExit(engineExitCode);
  if (gateExitCode === undefined) return undefined;
  try {
    if (!/^[0-9a-f]{64}$/.test(authority.nonce)) return undefined;
    const expected = `{"schemaVersion":1,"nonce":"${authority.nonce}","exitCode":${gateExitCode}}\n`;
    await assertVerificationCompletionDirectoryIdentity(authority);
    const entries = (await readdir(authority.directoryPath)).sort();
    if (!sameStringArray(entries, [COMPLETION_ARTIFACT_NAME])) return undefined;
    const logical = await lstat(authority.artifactPath);
    if (
      !logical.isFile() ||
      logical.isSymbolicLink() ||
      logical.nlink !== 1 ||
      permissionMode(logical.mode) !== 0o600 ||
      logical.uid !== authority.uid ||
      logical.gid !== authority.gid ||
      logical.size !== Buffer.byteLength(expected)
    ) return undefined;
    const resolvedArtifact = await realpath(authority.artifactPath);
    if (resolvedArtifact !== path.join(authority.realPath, COMPLETION_ARTIFACT_NAME)) return undefined;
    const handle = await open(
      authority.artifactPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      if (!sameFileIdentity(logical, opened)) return undefined;
      const encoded = await handle.readFile("utf8");
      const after = await handle.stat();
      if (!sameFileIdentity(opened, after)) return undefined;
      if (encoded !== expected || opened.size !== Buffer.byteLength(expected)) return undefined;
    } finally {
      await handle.close();
    }
    await assertVerificationCompletionDirectoryIdentity(authority);
    return gateExitCode;
  } catch {
    return undefined;
  }
}

export async function removeVerificationCompletionAuthority(
  authority: VerificationCompletionAuthority,
): Promise<void> {
  await assertVerificationCompletionDirectoryIdentity(authority);
  for (const target of [authority.requestPath, authority.temporaryPath, authority.artifactPath]) {
    await unlinkCompletionEntry(target);
    await assertVerificationCompletionDirectoryIdentity(authority);
  }
  if ((await readdir(authority.directoryPath)).length !== 0) {
    throw new Error("Verification completion directory retained unexpected state");
  }
  await assertVerificationCompletionDirectoryIdentity(authority);
  await rmdir(authority.directoryPath);
  await assertPathMissing(authority.directoryPath);
  await assertPathMissing(authority.realPath);
}

export class VerificationContainer {
  constructor(
    private readonly config: AppConfig,
    private readonly hooks: VerificationContainerHooks = {},
  ) {}

  async reconcilePending(): Promise<{ pending: number; removed: number }> {
    return withVerificationReconciliationAuthority(
      this.config.dataDirectory,
      this.hooks,
      async (authority) => this.reconcilePendingWithAuthority(authority),
    );
  }

  private async reconcilePendingWithAuthority(
    authority: VerificationReconciliationAuthority,
  ): Promise<{ pending: number; removed: number }> {
    const loaded = await loadVerificationReconciliationHandles(this.config.dataDirectory, authority);
    if (loaded.length === 0) return { pending: 0, removed: 0 };
    const capture: VerificationExecutionCapture = {
      stdout: [],
      stderr: [],
      totalBytes: 0,
      outputExceeded: false,
    };
    const started = Date.now();
    const lifecycle = new VerificationEngineLifecycle(
      this.config.containerEngine,
      capture,
      started,
      Math.min(5_000, this.config.verifierContainerTimeoutMs),
      this.config.verifierContainerMaxOutputBytes,
      this.hooks,
    );
    lifecycle.beginCleanup();
    let pending = 0;
    let removed = 0;
    for (const handle of loaded) {
      try {
        if (await reconcileVerificationResources(
          this.config.containerEngine,
          handle,
          hostEngineEnv(),
          lifecycle.authorityCommand("cleanup"),
        )) removed += 1;
        else pending += 1;
      } catch {
        pending += 1;
      }
    }
    return { pending, removed };
  }

  async run(input: {
    candidatePath: string;
    authorityRoot: string;
    gate: AuthorityGate | AuthorityMutant;
    control: RunControl;
  }): Promise<VerificationContainerOutcome> {
    input.control.assertActive();
    const authority = createContainerAuthority("verifier", this.config);
    const args = buildVerificationRunArgs({
      candidatePath: path.resolve(input.candidatePath),
      authorityRoot: path.resolve(input.authorityRoot),
      gate: input.gate,
      container: authority,
      config: this.config,
    });
    return withVerificationReconciliationAuthority(this.config.dataDirectory, this.hooks, async (reconciliationAuthority) => {
      await this.reconcilePendingWithAuthority(reconciliationAuthority);
      input.control.assertActive();
    const started = Date.now();
    const wallMs = Math.min(
      this.config.verifierContainerTimeoutMs,
      Math.max(1, input.control.remainingMs()),
    );
    const capture: VerificationExecutionCapture = {
      stdout: [],
      stderr: [],
      totalBytes: 0,
      outputExceeded: false,
    };
    const lifecycle = new VerificationEngineLifecycle(
      this.config.containerEngine,
      capture,
      started,
      wallMs,
      this.config.verifierContainerMaxOutputBytes,
      this.hooks,
    );
    let completion: VerificationCompletionAuthority | undefined;
    let reconciliation: VerificationReconciliationHandle | undefined;
    let result: VerificationContainerOutcome | undefined;
    let executionError: unknown;
    try {
      await prepareContainerAuthority(authority);
      completion = await prepareVerificationCompletionAuthority(authority);
      reconciliation = await prepareVerificationReconciliation(
        reconciliationAuthority,
        authority,
        completion.volumeName,
        this.hooks,
      );
      input.control.assertActive();
      const execution = this.execute(
        authority,
        completion,
        reconciliation,
        args,
        lifecycle,
        capture,
        started,
      );
      const raced = await input.control.raceOutcome(execution, () => lifecycle.cancelExecution());
      let settledExecution:
        | { ok: true; value: VerificationContainerOutcome }
        | { ok: false; error: unknown };
      try {
        settledExecution = { ok: true, value: await execution };
      } catch (error) {
        settledExecution = { ok: false, error };
      }
      if (!raced.ok) executionError = raced.error;
      else if (!settledExecution.ok) executionError = settledExecution.error;
      else result = settledExecution.value;
    } catch (error) {
      executionError = error;
    }
    lifecycle.beginCleanup();
    const cleanupFailures: VerificationContainerError[] = [];
    let containerCleanupError: unknown;
    if (reconciliation !== undefined) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const reconciled = await reconcileVerificationResources(
            this.config.containerEngine,
            reconciliation,
            hostEngineEnv(),
            lifecycle.authorityCommand("cleanup"),
          );
          if (!reconciled) {
            containerCleanupError = new Error(
              "Verification create commitment remains ambiguous; durable exact-owner reconciliation is pending",
            );
            break;
          }
          containerCleanupError = undefined;
          break;
        } catch (error) {
          containerCleanupError = error;
        }
      }
    } else {
      try {
        await assertVerificationReconciliationAuthority(reconciliationAuthority);
        await removeOwnedContainer(
          this.config.containerEngine,
          authority,
          hostEngineEnv(),
          {
            command: lifecycle.authorityCommand("cleanup"),
            removeAnonymousVolumes: true,
          },
        );
        await assertVerificationReconciliationAuthority(reconciliationAuthority);
      } catch (error) {
        containerCleanupError = error;
      }
    }
    if (containerCleanupError !== undefined) {
      cleanupFailures.push(new VerificationContainerError(
        "verification_container_absence_unproven",
        containerCleanupError,
      ));
    }
    if (completion !== undefined) {
      try {
        await removeVerificationCompletionAuthority(completion);
      } catch (error) {
        cleanupFailures.push(new VerificationContainerError(
          "verification_completion_cleanup_unproven",
          error,
        ));
      }
    }
    const deadlineFailure = lifecycle.deadlineExceeded()
      ? new VerificationContainerError(
        "verification_container_deadline_exceeded",
        new Error("Verification container lifecycle deadline elapsed before final authority resolution"),
      )
      : undefined;
    const cleanupFailure = combineCleanupFailures(cleanupFailures);
    const terminalFailure = combineCleanupFailures([
      ...cleanupFailures,
      ...(deadlineFailure === undefined ? [] : [deadlineFailure]),
    ]);
    let currentTerminal: RunTerminalError | undefined;
    try {
      input.control.assertActive();
    } catch (controlError) {
      if (controlError instanceof RunTerminalError) currentTerminal = controlError;
      else throw controlError;
    }
    if (currentTerminal) {
      if (terminalFailure) {
        Object.defineProperty(currentTerminal, "cause", {
          configurable: true,
          value: terminalFailure,
        });
      }
      throw currentTerminal;
    }
    if (cleanupFailure) throw cleanupFailure;
    if (deadlineFailure) {
      return {
        kind: "authority_failure",
        stdout: Buffer.concat(capture.stdout),
        stderr: Buffer.concat(capture.stderr),
        elapsedMs: Date.now() - started,
      };
    }
    if (executionError instanceof RunTerminalError) throw executionError;
    if (executionError !== undefined) {
      return {
        kind: "authority_failure",
        stdout: new Uint8Array(),
        stderr: Buffer.from(executionError instanceof Error ? executionError.message : String(executionError)),
        elapsedMs: Date.now() - started,
      };
    }
    return result!;
    });
  }

  private execute(
    authority: ContainerAuthority,
    completion: VerificationCompletionAuthority,
    reconciliation: VerificationReconciliationHandle,
    args: string[],
    lifecycle: VerificationEngineLifecycle,
    capture: VerificationExecutionCapture,
    started: number,
  ): Promise<VerificationContainerOutcome> {
    const authorityFailure = (): VerificationContainerOutcome => ({
      kind: "authority_failure",
      stdout: Buffer.concat(capture.stdout),
      stderr: Buffer.concat(capture.stderr),
      elapsedMs: Date.now() - started,
    });
    return (async () => {
      if (!lifecycle.canAcceptWork()) return authorityFailure();
      await assertPreparedVerificationCompletionRequest(completion);
      await updateVerificationReconciliation(reconciliation, {
        state: "volume_create_pending",
      });
      if (!lifecycle.canAcceptWork()) {
        await updateVerificationReconciliation(reconciliation, { state: "volume_ready" });
        return authorityFailure();
      }
      const createdVolume = await lifecycle.run({
        args: [
          "volume",
          "create",
          "--label",
          CONTAINER_OWNER_LABEL + "=" + authority.ownerId,
          completion.volumeName,
        ],
        exposeOutput: false,
        phase: "work",
      });
      if (createdVolume.spawnError !== undefined && !createdVolume.spawned) {
        await updateVerificationReconciliation(reconciliation, { state: "volume_ready" });
      }
      if (!verificationEngineCommandSucceeded(createdVolume)) return authorityFailure();
      const createdVolumeIdentity = await inspectOwnedVolumeIdentity(
        this.config.containerEngine,
        authority.ownerId,
        completion.volumeName,
        hostEngineEnv(),
        lifecycle.authorityCommand("work"),
      );
      if (createdVolumeIdentity === null) return authorityFailure();
      await updateVerificationReconciliation(reconciliation, {
        state: "volume_ready",
        volumeIdentity: createdVolumeIdentity.fingerprint,
      });

      if (!lifecycle.canAcceptWork()) return authorityFailure();
      await updateVerificationReconciliation(reconciliation, {
        state: "container_create_pending",
      });
      if (!lifecycle.canAcceptWork()) {
        await updateVerificationReconciliation(reconciliation, { state: "volume_ready" });
        return authorityFailure();
      }
      // Docker exposes no daemon fence for an accepted create whose client
      // transport ends ambiguously. The exact-owner record above is durable
      // before this request, so cancellation can be bounded without claiming
      // absence or ever starting the candidate.
      const created = await lifecycle.run({
        args,
        exposeOutput: false,
        phase: "work",
      });
      if (created.spawnError !== undefined && !created.spawned) {
        await updateVerificationReconciliation(reconciliation, { state: "volume_ready" });
      }
      if (!verificationEngineCommandSucceeded(created)) return authorityFailure();

      const containerId = await resolveOwnedContainerId(
        this.config.containerEngine,
        authority,
        hostEngineEnv(),
        lifecycle.authorityCommand("work"),
      );
      if (containerId === null) return authorityFailure();
      await updateVerificationReconciliation(reconciliation, {
        containerId,
        state: "container_ready",
      });
      const createdInspection = await inspectOwnedContainerById(
        this.config.containerEngine,
        authority,
        containerId,
        hostEngineEnv(),
        lifecycle.authorityCommand("work"),
      );
      const createdVolumeName = assertVerificationContainerInspection(
        createdInspection,
        "created",
        completion.volumeName,
      );
      if (createdVolumeName !== completion.volumeName) return authorityFailure();

      if (!lifecycle.canAcceptWork()) return authorityFailure();
      await assertPreparedVerificationCompletionRequest(completion);
      const copiedRequest = await lifecycle.run({
        args: ["cp", "-", containerId + ":" + CONTAINER_COMPLETION_DIRECTORY],
        exposeOutput: false,
        phase: "work",
        stdin: buildVerificationCompletionRequestArchive(completion),
      });
      if (!verificationEngineCommandSucceeded(copiedRequest)) return authorityFailure();
      await assertPreparedVerificationCompletionRequest(completion);
      await assertVerificationCompletionDirectoryIdentity(completion);
      await unlinkCompletionEntry(completion.requestPath);
      await assertVerificationCompletionDirectoryIdentity(completion);
      if ((await readdir(completion.directoryPath)).length !== 0) return authorityFailure();

      const beforeStart = await inspectOwnedContainerById(
        this.config.containerEngine,
        authority,
        containerId,
        hostEngineEnv(),
        lifecycle.authorityCommand("work"),
      );
      const currentVolume = assertVerificationContainerInspection(
        beforeStart,
        "created",
        completion.volumeName,
      );
      if (currentVolume !== completion.volumeName) return authorityFailure();
      if (!lifecycle.canAcceptWork()) return authorityFailure();
      await assertVerificationReconciliationAuthority(reconciliation.reconciliationAuthority);
      const beforeStartVolume = await inspectOwnedVolumeIdentity(
        this.config.containerEngine,
        authority.ownerId,
        completion.volumeName,
        hostEngineEnv(),
        lifecycle.authorityCommand("work"),
      );
      await assertVerificationReconciliationAuthority(reconciliation.reconciliationAuthority);
      if (
        beforeStartVolume === null ||
        reconciliation.record.volumeIdentity === null ||
        beforeStartVolume.fingerprint !== reconciliation.record.volumeIdentity
      ) return authorityFailure();
      const startedContainer = await lifecycle.run({
        args: ["start", "--attach", containerId],
        exposeOutput: true,
        phase: "work",
      });
      if (startedContainer.timedOut || startedContainer.outputExceeded || startedContainer.signal !== null) {
        return authorityFailure();
      }
      const reservedExit = decodeVerificationWrapperExit(startedContainer.code);
      if (reservedExit === undefined) return authorityFailure();

      const stoppedInspection = await inspectOwnedContainerById(
        this.config.containerEngine,
        authority,
        containerId,
        hostEngineEnv(),
        lifecycle.authorityCommand("work"),
      );
      const stoppedVolume = assertVerificationContainerInspection(
        stoppedInspection,
        "exited",
        completion.volumeName,
        startedContainer.code,
      );
      if (stoppedVolume !== completion.volumeName) return authorityFailure();
      await assertVerificationCompletionDirectoryIdentity(completion);
      if ((await readdir(completion.directoryPath)).length !== 0) return authorityFailure();
      const copiedArtifact = await lifecycle.run({
        args: ["cp", containerId + ":" + ARTIFACT_PATH_IN_CONTAINER, completion.artifactPath],
        exposeOutput: false,
        phase: "work",
      });
      if (!verificationEngineCommandSucceeded(copiedArtifact)) return authorityFailure();
      const gateExitCode = await validateVerificationCompletionArtifact(
        completion,
        startedContainer.code,
      );
      if (gateExitCode === undefined) return authorityFailure();
      if (!lifecycle.canAcceptWork()) return authorityFailure();
      return {
        kind: "command_exit",
        exitCode: gateExitCode,
        stdout: Buffer.concat(capture.stdout),
        stderr: Buffer.concat(capture.stderr),
        elapsedMs: Date.now() - started,
      };
    })();
  }
}

export class VerificationContainerError extends Error {
  readonly name = "VerificationContainerError";

  constructor(
    readonly code:
      | "verification_container_absence_unproven"
      | "verification_completion_cleanup_unproven"
      | "verification_container_deadline_exceeded"
      | "verification_reconciliation_authority_unavailable",
    cause: unknown,
  ) {
    super(code, { cause });
  }
}

export function buildVerificationRunArgs(input: {
  candidatePath: string;
  authorityRoot: string;
  gate: AuthorityGate | AuthorityMutant;
  container: ContainerAuthority;
  config: AppConfig;
}): string[] {
  const gateId = input.gate.id;
  const [interpreter, script, ...rest] = input.gate.command;
  const gateIdentity = parseVerificationGateIdentity(input.config.verifierContainerUser);
  return [
    "create",
    "--name",
    input.container.name,
    "--cidfile",
    input.container.cidFile,
    "--label",
    "io.codejam.launchpad=verifier",
    "--label",
    CONTAINER_OWNER_LABEL + "=" + input.container.ownerId,
    "--network",
    "none",
    "--read-only",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "KILL",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "SETUID",
    "--cpus",
    String(input.config.verifierContainerCpuLimit),
    "--memory",
    input.config.verifierContainerMemoryLimit,
    "--pids-limit",
    String(input.config.verifierContainerPidsLimit),
    "--user",
    "0:0",
    "--env",
    "LANG=C.UTF-8",
    "--env",
    "LC_ALL=C.UTF-8",
    "--env",
    "CI=1",
    "--env",
    "CANDIDATE=/candidate",
    "--env",
    "SCRATCH=/scratch",
    "--env",
    "HOME=/scratch",
    "--env",
    "TMPDIR=/scratch",
    "--env",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "--env",
    "GATE_ID=" + gateId,
    "--mount",
    "type=bind,src=" + input.candidatePath + ",dst=/candidate,readonly",
    "--mount",
    "type=bind,src=" + input.authorityRoot + ",dst=/authority,readonly",
    "--mount",
    "type=volume,src=" + verificationCompletionVolumeName(input.container.ownerId) +
      ",dst=" + CONTAINER_COMPLETION_DIRECTORY + ",volume-nocopy",
    "--tmpfs",
    "/scratch:mode=1777",
    "--workdir",
    "/authority",
    "--entrypoint",
    "node",
    input.config.verifierContainerImage,
    "-e",
    GATE_WRAPPER_SOURCE,
    String(gateIdentity.uid),
    String(gateIdentity.gid),
    interpreter,
    script,
    ...rest,
  ];
}

export function decodeVerificationWrapperExit(code: number | null): number | undefined {
  if (code === WRAPPER_GATE_SUCCEEDED) return 0;
  if (code === WRAPPER_GATE_FAILED) return 1;
  return undefined;
}

function verificationCompletionDirectoryPath(authority: ContainerAuthority): string {
  return path.join(
    path.dirname(authority.cidFile),
    COMPLETION_DIRECTORY_NAME + "-" + authority.ownerId,
  );
}

function verificationCompletionVolumeName(ownerId: string): string {
  if (!/^[0-9a-f]{64}$/.test(ownerId)) {
    throw new Error("Verification volume owner id was not exact");
  }
  return VERIFICATION_COMPLETION_VOLUME_PREFIX + ownerId;
}

function verificationReconciliationDirectory(dataDirectory: string): string {
  return path.join(dataDirectory, "container-authority", RECONCILIATION_DIRECTORY_NAME);
}

function verificationReconciliationParent(dataDirectory: string): string {
  return path.join(dataDirectory, "container-authority");
}

async function withVerificationReconciliationAuthority<T>(
  dataDirectory: string,
  hooks: VerificationContainerHooks,
  operation: (authority: VerificationReconciliationAuthority) => Promise<T>,
): Promise<T> {
  const key = path.resolve(verificationReconciliationDirectory(dataDirectory));
  return verificationReconciliationMutex.runExclusive(key, async () => {
    let authority: VerificationReconciliationAuthority;
    try {
      authority = await acquireVerificationReconciliationAuthority(dataDirectory, hooks);
    } catch (error) {
      if (error instanceof VerificationContainerError) throw error;
      throw new VerificationContainerError("verification_reconciliation_authority_unavailable", error);
    }
    let operationFailure: unknown;
    try {
      return await operation(authority);
    } catch (error) {
      operationFailure = error;
      throw error;
    } finally {
      try {
        await releaseVerificationReconciliationAuthority(authority);
      } catch (error) {
        if (operationFailure === undefined) {
          throw new VerificationContainerError("verification_reconciliation_authority_unavailable", error);
        }
      }
    }
  });
}

async function acquireVerificationReconciliationAuthority(
  dataDirectory: string,
  hooks: VerificationContainerHooks,
): Promise<VerificationReconciliationAuthority> {
  const parentPath = verificationReconciliationParent(dataDirectory);
  const directoryPath = verificationReconciliationDirectory(dataDirectory);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  try {
    await mkdir(directoryPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const parent = await captureVerificationReconciliationDirectory(parentPath);
  const directory = await captureVerificationReconciliationDirectory(directoryPath);
  await syncDirectory(directoryPath);
  await syncDirectory(parentPath);
  await assertVerificationReconciliationDirectoryIdentity(parent);
  await assertVerificationReconciliationDirectoryIdentity(directory);

  const leasePath = path.join(directoryPath, RECONCILIATION_LEASE_NAME);
  const osLock = await acquireVerificationReconciliationOsLock(directory, hooks);
  try {
    await assertVerificationReconciliationDirectoryIdentity(parent);
    await assertVerificationReconciliationDirectoryIdentity(directory);
    const owner = await currentVerificationReconciliationLeaseOwner();
    const existing = await readVerificationReconciliationLeaseIfPresent(leasePath, directory);
    if (existing) {
      if (await verificationReconciliationLeaseOwnerStatus(existing.owner) !== "dead") {
        throw verificationReconciliationAuthorityUnavailable(
          "Verification reconciliation audit owner is live, foreign, or unknown",
        );
      }
      await hooks.afterDeadReconciliationLeaseObservedForTest?.(leasePath);
      await moveExactVerificationReconciliationLeaseToAudit(
        existing,
        directory,
        parent,
        owner.ownerToken,
        hooks,
        "reclaim",
      );
    }
    const created = await createVerificationReconciliationLease(leasePath, owner, directory, parent);
    return verificationReconciliationAuthority(parent, directory, created, osLock);
  } catch (error) {
    try {
      await releaseVerificationReconciliationOsLock(osLock);
    } catch (releaseError) {
      throw verificationReconciliationAuthorityUnavailable(
        `Verification reconciliation OS lock could not be released after acquisition failure: ${String(releaseError)}`,
      );
    }
    throw error;
  }
}

async function releaseVerificationReconciliationAuthority(
  authority: VerificationReconciliationAuthority,
): Promise<void> {
  await assertVerificationReconciliationAuthority(authority);
  const lease: VerificationReconciliationLeaseFile = {
    path: authority.leasePath,
    owner: parseVerificationReconciliationLeaseOwner(authority.leaseEncoded),
    encoded: authority.leaseEncoded,
    identity: authority.leaseIdentity,
  };
  try {
    await moveExactVerificationReconciliationLeaseToAudit(
      lease,
      authority.directory,
      authority.parent,
      authority.leaseOwnerToken,
      {},
      "release",
    );
  } catch (error) {
    if (!(error instanceof VerificationReconciliationLeaseRestoredError)) throw error;
    await releaseVerificationReconciliationOsLock(authority.osLock);
    throw error;
  }
  await releaseVerificationReconciliationOsLock(authority.osLock);
}

function verificationReconciliationAuthority(
  parent: VerificationReconciliationDirectoryIdentity,
  directory: VerificationReconciliationDirectoryIdentity,
  lease: VerificationReconciliationLeaseFile,
  osLock: VerificationReconciliationOsLock,
): VerificationReconciliationAuthority {
  return {
    parent,
    directory,
    leasePath: lease.path,
    leaseOwnerToken: lease.owner.ownerToken,
    leaseEncoded: lease.encoded,
    leaseIdentity: lease.identity,
    osLock,
  };
}

function verificationReconciliationAuthorityUnavailable(message: string): VerificationContainerError {
  return new VerificationContainerError(
    "verification_reconciliation_authority_unavailable",
    new Error(message),
  );
}

class VerificationReconciliationLeaseRestoredError extends Error {}

async function acquireVerificationReconciliationOsLock(
  directory: VerificationReconciliationDirectoryIdentity,
  hooks: VerificationContainerHooks,
): Promise<VerificationReconciliationOsLock> {
  const digest = createHash("sha256")
    .update("launchpad-verification-reconciliation-lock\0")
    .update(directory.realPath)
    .digest();
  const port = 20_000 + (digest.readUInt32BE(0) % 40_000);
  const host = hooks.reconciliationLockHostForTest ?? "127.0.0.1";
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host, port, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.unref();
  await assertVerificationReconciliationDirectoryIdentity(directory);
  return { server, host, port };
}

function assertVerificationReconciliationOsLock(lock: VerificationReconciliationOsLock): void {
  if (!lock.server.listening) {
    throw new Error(`Verification reconciliation OS lock ${lock.host}:${lock.port} was not held`);
  }
}

async function releaseVerificationReconciliationOsLock(lock: VerificationReconciliationOsLock): Promise<void> {
  assertVerificationReconciliationOsLock(lock);
  await new Promise<void>((resolve, reject) => {
    lock.server.close((error) => error ? reject(error) : resolve());
  });
}

async function currentVerificationReconciliationLeaseOwner(): Promise<VerificationReconciliationLeaseOwner> {
  const processStartIdentity = await verificationReconciliationProcessStartIdentity(process.pid);
  if (!processStartIdentity) {
    throw new Error("Could not establish the reconciliation authority process identity");
  }
  const host = await verificationReconciliationHostIdentity();
  return {
    schemaVersion: 3,
    ownerToken: randomBytes(32).toString("hex"),
    pid: process.pid,
    processStartIdentity,
    machineIdentity: host.machineIdentity,
    bootIdentity: host.bootIdentity,
  };
}

interface VerificationReconciliationHostIdentity {
  machineIdentity: string;
  bootIdentity: string;
}

let verificationReconciliationHostIdentityPromise: Promise<VerificationReconciliationHostIdentity> | undefined;

function verificationReconciliationHostIdentity(): Promise<VerificationReconciliationHostIdentity> {
  verificationReconciliationHostIdentityPromise ??= readVerificationReconciliationHostIdentity();
  return verificationReconciliationHostIdentityPromise;
}

async function readVerificationReconciliationHostIdentity(): Promise<VerificationReconciliationHostIdentity> {
  let machine: string | null;
  let boot: string | null;
  if (process.platform === "linux") {
    machine = await readFile("/etc/machine-id", "utf8").then(
      (value) => value.trim(),
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") return null;
        return readFile("/var/lib/dbus/machine-id", "utf8").then((value) => value.trim(), () => null);
      },
    );
    boot = await readFile("/proc/sys/kernel/random/boot_id", "utf8").then(
      (value) => value.trim(),
      () => null,
    );
  } else if (process.platform === "darwin") {
    const platform = await verificationReconciliationCommandOutput(
      "/usr/sbin/ioreg",
      ["-rd1", "-c", "IOPlatformExpertDevice"],
    );
    machine = platform?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null;
    boot = await verificationReconciliationCommandOutput(
      "/usr/sbin/sysctl",
      ["-n", "kern.bootsessionuuid"],
    );
  } else {
    throw new Error(`Unsupported reconciliation authority OS lock identity platform: ${process.platform}`);
  }
  if (
    !machine ||
    !boot ||
    machine.length > 512 ||
    boot.length > 512 ||
    /[\0\r\n]/.test(machine) ||
    /[\0\r\n]/.test(boot)
  ) throw new Error("Could not establish stable reconciliation machine and boot identity");
  return {
    machineIdentity: `${process.platform}-machine:${machine}`,
    bootIdentity: `${process.platform}-boot:${boot}`,
  };
}

async function verificationReconciliationProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    let stat: string;
    try {
      stat = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const commandEnd = stat.lastIndexOf(")");
    const fields = commandEnd < 0 ? [] : stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks || !/^\d+$/.test(startTicks)) {
      throw new Error("Could not parse the reconciliation authority process identity");
    }
    return `linux-proc-start:${startTicks}`;
  }

  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
  const started = await verificationReconciliationCommandOutput(
    process.platform === "darwin" ? "/bin/ps" : "ps",
    ["-o", "lstart=", "-p", String(pid)],
  );
  if (started) return `${process.platform}-ps-start:${started.replace(/\s+/g, " ")}`;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return null;
  }
  throw new Error("Could not establish whether the reconciliation authority process is alive");
}

function verificationReconciliationCommandOutput(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return resolve(null);
      const output = Buffer.concat(chunks).toString("utf8").trim();
      resolve(output || null);
    });
  });
}

async function verificationReconciliationLeaseOwnerStatus(
  owner: VerificationReconciliationLeaseOwner,
): Promise<"alive" | "dead" | "unknown"> {
  const host = await verificationReconciliationHostIdentity();
  if (owner.machineIdentity !== host.machineIdentity) return "unknown";
  if (owner.bootIdentity !== host.bootIdentity) return "dead";
  const currentStartIdentity = await verificationReconciliationProcessStartIdentity(owner.pid);
  return currentStartIdentity === owner.processStartIdentity ? "alive" : "dead";
}

async function createVerificationReconciliationLease(
  leasePath: string,
  owner: VerificationReconciliationLeaseOwner,
  directory: VerificationReconciliationDirectoryIdentity,
  parent: VerificationReconciliationDirectoryIdentity,
): Promise<VerificationReconciliationLeaseFile> {
  await assertVerificationReconciliationDirectoryIdentity(parent);
  await assertVerificationReconciliationDirectoryIdentity(directory);
  const encoded = Buffer.from(JSON.stringify(owner) + "\n", "utf8");
  if (encoded.byteLength > RECONCILIATION_LEASE_MAX_BYTES) {
    throw new Error("Verification reconciliation lease exceeded its bound");
  }
  const descriptor = await open(
    leasePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let identity: Stats;
  try {
    await descriptor.writeFile(encoded);
    await descriptor.sync();
    identity = await descriptor.stat();
    assertVerificationReconciliationLeaseIdentity(identity, directory, encoded.byteLength);
  } finally {
    await descriptor.close();
  }
  await syncDirectory(directory.path);
  await syncDirectory(parent.path);
  const lease = { path: leasePath, owner, encoded, identity };
  const verified = await readVerificationReconciliationLease(leasePath, directory);
  if (!sameExactVerificationReconciliationLease(lease, verified)) {
    throw new Error("Verification reconciliation lease ownership changed after creation");
  }
  return lease;
}

async function readVerificationReconciliationLeaseIfPresent(
  leasePath: string,
  directory: VerificationReconciliationDirectoryIdentity,
): Promise<VerificationReconciliationLeaseFile | null> {
  try {
    return await readVerificationReconciliationLease(leasePath, directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readVerificationReconciliationLease(
  leasePath: string,
  directory: VerificationReconciliationDirectoryIdentity,
): Promise<VerificationReconciliationLeaseFile> {
  const exact = await readExactVerificationReconciliationFile(leasePath, directory);
  return {
    ...exact,
    owner: parseVerificationReconciliationLeaseOwner(exact.encoded),
  };
}

async function readExactVerificationReconciliationFile(
  leasePath: string,
  directory: VerificationReconciliationDirectoryIdentity,
): Promise<VerificationReconciliationExactFile> {
  await assertVerificationReconciliationDirectoryIdentity(directory);
  const logical = await lstat(leasePath);
  assertVerificationReconciliationLeaseIdentity(logical, directory);
  const descriptor = await open(leasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await descriptor.stat();
    const encoded = await descriptor.readFile();
    const after = await descriptor.stat();
    if (
      !sameFileIdentity(logical, opened) ||
      !sameFileIdentity(opened, after) ||
      encoded.byteLength < 1 ||
      encoded.byteLength > RECONCILIATION_LEASE_MAX_BYTES ||
      encoded.byteLength !== after.size
    ) throw new Error("Verification reconciliation lease changed while being read");
    return {
      path: leasePath,
      encoded,
      identity: after,
    };
  } finally {
    await descriptor.close();
  }
}

function parseVerificationReconciliationLeaseOwner(encoded: Buffer): VerificationReconciliationLeaseOwner {
  let value: unknown;
  try {
    value = JSON.parse(encoded.toString("utf8"));
  } catch (error) {
    throw new Error("Verification reconciliation lease was not valid JSON", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Verification reconciliation lease was not an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "bootIdentity",
    "machineIdentity",
    "ownerToken",
    "pid",
    "processStartIdentity",
    "schemaVersion",
  ];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    record.schemaVersion !== 3 ||
    typeof record.ownerToken !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.ownerToken) ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    typeof record.processStartIdentity !== "string" ||
    record.processStartIdentity.length < 1 ||
    record.processStartIdentity.length > 512 ||
    /[\0\r\n]/.test(record.processStartIdentity) ||
    typeof record.machineIdentity !== "string" ||
    record.machineIdentity.length < 1 ||
    record.machineIdentity.length > 512 ||
    /[\0\r\n]/.test(record.machineIdentity) ||
    typeof record.bootIdentity !== "string" ||
    record.bootIdentity.length < 1 ||
    record.bootIdentity.length > 1_024 ||
    /[\0\r\n]/.test(record.bootIdentity)
  ) throw new Error("Verification reconciliation lease schema was invalid");
  return record as unknown as VerificationReconciliationLeaseOwner;
}

function assertVerificationReconciliationLeaseIdentity(
  identity: Stats,
  directory: VerificationReconciliationDirectoryIdentity,
  expectedSize?: number,
): void {
  if (
    !identity.isFile() ||
    identity.isSymbolicLink() ||
    identity.nlink !== 1 ||
    permissionMode(identity.mode) !== 0o600 ||
    identity.uid !== directory.uid ||
    identity.gid !== directory.gid ||
    (expectedSize !== undefined && identity.size !== expectedSize)
  ) throw new Error("Verification reconciliation lease identity was invalid");
}

function sameExactVerificationReconciliationLease(
  expected: VerificationReconciliationLeaseFile,
  actual: VerificationReconciliationLeaseFile,
): boolean {
  return expected.encoded.equals(actual.encoded) && sameFileIdentity(expected.identity, actual.identity);
}

function sameVerificationReconciliationLeaseInode(
  expected: VerificationReconciliationExactFile,
  actual: VerificationReconciliationExactFile,
): boolean {
  return expected.encoded.equals(actual.encoded) &&
    expected.identity.dev === actual.identity.dev &&
    expected.identity.ino === actual.identity.ino &&
    expected.identity.uid === actual.identity.uid &&
    expected.identity.gid === actual.identity.gid &&
    permissionMode(expected.identity.mode) === permissionMode(actual.identity.mode) &&
    expected.identity.nlink === actual.identity.nlink &&
    expected.identity.size === actual.identity.size;
}

async function moveExactVerificationReconciliationLeaseToAudit(
  expected: VerificationReconciliationLeaseFile,
  directory: VerificationReconciliationDirectoryIdentity,
  parent: VerificationReconciliationDirectoryIdentity,
  ownerToken: string,
  hooks: VerificationContainerHooks,
  purpose: "reclaim" | "release",
): Promise<void> {
  const verified = await readVerificationReconciliationLease(expected.path, directory);
  if (!sameExactVerificationReconciliationLease(expected, verified)) {
    throw verificationReconciliationAuthorityUnavailable(
      "Verification reconciliation lease changed before quarantine",
    );
  }
  const quarantinePath = path.join(
    directory.path,
    `.${path.basename(expected.path)}.audit-${ownerToken}-${randomBytes(8).toString("hex")}`,
  );
  if (await verificationReconciliationPathExists(quarantinePath)) {
    throw new Error("Verification reconciliation quarantine path already existed");
  }
  await hooks.beforeReconciliationLeaseQuarantineForTest?.(expected.path, purpose);
  await rename(expected.path, quarantinePath);
  await syncDirectory(directory.path);
  await syncDirectory(parent.path);
  const quarantine = await readExactVerificationReconciliationFile(quarantinePath, directory);
  if (!sameVerificationReconciliationLeaseInode(expected, quarantine)) {
    await restoreVerificationReconciliationLeaseFromAudit(
      quarantine,
      expected.path,
      directory,
      parent,
    );
    throw new VerificationReconciliationLeaseRestoredError(
      "Verification reconciliation lease changed in the final quarantine window and was restored",
    );
  }
}

async function restoreVerificationReconciliationLeaseFromAudit(
  displaced: VerificationReconciliationExactFile,
  leasePath: string,
  directory: VerificationReconciliationDirectoryIdentity,
  parent: VerificationReconciliationDirectoryIdentity,
): Promise<void> {
  if (await verificationReconciliationPathExists(leasePath)) {
    throw new Error("Verification reconciliation lease path was occupied before restore");
  }
  await rename(displaced.path, leasePath);
  await syncDirectory(directory.path);
  await syncDirectory(parent.path);
  const restored = await readExactVerificationReconciliationFile(leasePath, directory);
  if (!sameVerificationReconciliationLeaseInode(displaced, restored)) {
    throw new Error("Verification reconciliation displaced lease could not be restored exactly");
  }
}

async function verificationReconciliationPathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function captureVerificationReconciliationDirectory(
  directoryPath: string,
): Promise<VerificationReconciliationDirectoryIdentity> {
  const info = await lstat(directoryPath);
  if (!info.isDirectory() || info.isSymbolicLink() || permissionMode(info.mode) !== 0o700) {
    throw new Error("Verification reconciliation directory was invalid");
  }
  return {
    path: directoryPath,
    realPath: await realpath(directoryPath),
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    gid: info.gid,
    mode: permissionMode(info.mode),
  };
}

async function assertVerificationReconciliationDirectoryIdentity(
  expected: VerificationReconciliationDirectoryIdentity,
): Promise<void> {
  const info = await lstat(expected.path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== expected.dev ||
    info.ino !== expected.ino ||
    info.uid !== expected.uid ||
    info.gid !== expected.gid ||
    permissionMode(info.mode) !== expected.mode ||
    expected.mode !== 0o700 ||
    await realpath(expected.path) !== expected.realPath
  ) throw new Error("Verification reconciliation directory identity changed");
}

async function assertVerificationReconciliationAuthority(
  authority: VerificationReconciliationAuthority,
): Promise<void> {
  assertVerificationReconciliationOsLock(authority.osLock);
  await assertVerificationReconciliationDirectoryIdentity(authority.parent);
  await assertVerificationReconciliationDirectoryIdentity(authority.directory);
  const logical = await lstat(authority.leasePath);
  if (
    !logical.isFile() ||
    logical.isSymbolicLink() ||
    logical.nlink !== 1 ||
    permissionMode(logical.mode) !== 0o600 ||
    logical.uid !== authority.directory.uid ||
    logical.gid !== authority.directory.gid ||
    !sameFileIdentity(logical, authority.leaseIdentity)
  ) throw new Error("Verification reconciliation lease identity changed");
  const descriptor = await open(authority.leasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await descriptor.stat();
    const encoded = await descriptor.readFile();
    const after = await descriptor.stat();
    if (
      !sameFileIdentity(logical, opened) ||
      !sameFileIdentity(opened, after) ||
      !encoded.equals(authority.leaseEncoded)
    ) throw new Error("Verification reconciliation lease ownership changed");
  } finally {
    await descriptor.close();
  }
}

async function prepareVerificationReconciliation(
  reconciliationAuthority: VerificationReconciliationAuthority,
  authority: ContainerAuthority,
  volumeName: string,
  hooks: VerificationContainerHooks,
): Promise<VerificationReconciliationHandle> {
  const record: VerificationReconciliationRecordV2 = {
    schemaVersion: 2,
    revision: 1,
    ownerToken: randomBytes(32).toString("hex"),
    ownerId: authority.ownerId,
    containerName: authority.name,
    containerId: null,
    volumeName,
    volumeIdentity: null,
    state: "volume_ready",
  };
  assertVerificationReconciliationRecord(record);
  const handle: VerificationReconciliationHandle = {
    path: path.join(reconciliationAuthority.directory.path, authority.ownerId + ".json"),
    authority,
    reconciliationAuthority,
    record,
    encoded: Buffer.alloc(0),
    hooks,
  };
  await persistVerificationReconciliation(handle, record, true);
  return handle;
}

async function updateVerificationReconciliation(
  handle: VerificationReconciliationHandle,
  update: Partial<Pick<VerificationReconciliationRecordV2, "containerId" | "state" | "volumeIdentity">>,
): Promise<void> {
  const next: VerificationReconciliationRecordV2 = {
    ...handle.record,
    ...update,
    revision: handle.record.revision + 1,
  };
  assertVerificationReconciliationRecord(next);
  await persistVerificationReconciliation(handle, next, false);
}

async function persistVerificationReconciliation(
  handle: VerificationReconciliationHandle,
  record: VerificationReconciliationRecordV2,
  create: boolean,
): Promise<void> {
  const directory = handle.reconciliationAuthority.directory.path;
  await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
  const encoded = Buffer.from(JSON.stringify(record) + "\n", "utf8");
  if (encoded.byteLength > RECONCILIATION_RECORD_MAX_BYTES) {
    throw new Error("Verification reconciliation record exceeded its bound");
  }
  const temporary = path.join(
    directory,
    "." + record.ownerId + "." + randomBytes(8).toString("hex") + ".tmp",
  );
  let published = false;
  const descriptor = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await descriptor.writeFile(encoded);
    await descriptor.sync();
    const info = await descriptor.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      permissionMode(info.mode) !== 0o600 ||
      info.uid !== handle.reconciliationAuthority.directory.uid ||
      info.gid !== handle.reconciliationAuthority.directory.gid ||
      info.size !== encoded.byteLength
    ) {
      throw new Error("Verification reconciliation record identity was invalid");
    }
    await descriptor.close();
    if (create) {
      await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
      await link(temporary, handle.path);
      await unlink(temporary);
    } else {
      await assertVerificationReconciliationCas(handle);
      await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
      await assertVerificationReconciliationCas(handle);
      await rename(temporary, handle.path);
    }
    published = true;
    await handle.hooks.afterReconciliationRecordRenameForTest?.(handle.path);
    await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
    await syncDirectory(directory);
    await syncDirectory(handle.reconciliationAuthority.parent.path);
    await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
    handle.record = record;
    handle.encoded = encoded;
  } catch (error) {
    await descriptor.close().catch(() => undefined);
    if (!published) {
      await assertVerificationReconciliationAuthority(handle.reconciliationAuthority)
        .then(() => rm(temporary, { force: true }))
        .catch(() => undefined);
    }
    throw error;
  }
}

async function loadVerificationReconciliationHandles(
  dataDirectory: string,
  authority: VerificationReconciliationAuthority,
): Promise<VerificationReconciliationHandle[]> {
  await assertVerificationReconciliationAuthority(authority);
  const entries = (await readdir(authority.directory.path)).filter((entry) => entry.endsWith(".json")).sort();
  await assertVerificationReconciliationAuthority(authority);
  const handles: VerificationReconciliationHandle[] = [];
  for (const entry of entries) {
    if (!/^[0-9a-f]{64}\.json$/.test(entry)) {
      throw new Error("Verification reconciliation filename was invalid");
    }
    const recordPath = path.join(authority.directory.path, entry);
    const { encoded, record: parsed } = await readVerificationReconciliationRecord(recordPath, authority);
    if (entry !== parsed.ownerId + ".json") {
      throw new Error("Verification reconciliation filename did not match its owner");
    }
    handles.push({
      path: recordPath,
      authority: {
        ownerId: parsed.ownerId,
        name: parsed.containerName,
        cidFile: path.join(dataDirectory, "container-authority", parsed.ownerId + ".cid"),
      },
      reconciliationAuthority: authority,
      record: parsed,
      encoded,
      hooks: {},
    });
  }
  return handles;
}

function assertVerificationReconciliationRecord(
  value: unknown,
): asserts value is VerificationReconciliationRecordV2 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Verification reconciliation record was malformed");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "containerId",
    "containerName",
    "ownerId",
    "ownerToken",
    "revision",
    "schemaVersion",
    "state",
    "volumeIdentity",
    "volumeName",
  ];
  const states: VerificationReconciliationState[] = [
    "volume_ready",
    "volume_create_pending",
    "container_create_pending",
    "container_ready",
  ];
  if (
    !sameStringArray(keys, expectedKeys) ||
    record.schemaVersion !== 2 ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 1 ||
    typeof record.ownerToken !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.ownerToken) ||
    typeof record.ownerId !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.ownerId) ||
    record.containerName !== "launchpad-verifier-" + record.ownerId ||
    (record.containerId !== null && (
      typeof record.containerId !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.containerId)
    )) ||
    record.volumeName !== verificationCompletionVolumeName(record.ownerId) ||
    (record.volumeIdentity !== null && (
      typeof record.volumeIdentity !== "string" ||
      !/^[0-9a-f]{64}$/.test(record.volumeIdentity)
    )) ||
    typeof record.state !== "string" ||
    !states.includes(record.state as VerificationReconciliationState)
  ) {
    throw new Error("Verification reconciliation record was invalid");
  }
}

async function readVerificationReconciliationRecord(
  recordPath: string,
  authority: VerificationReconciliationAuthority,
): Promise<{ encoded: Buffer; record: VerificationReconciliationRecordV2 }> {
  await assertVerificationReconciliationAuthority(authority);
  const info = await lstat(recordPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    permissionMode(info.mode) !== 0o600 ||
    info.uid !== authority.directory.uid ||
    info.gid !== authority.directory.gid ||
    info.size <= 0 ||
    info.size > RECONCILIATION_RECORD_MAX_BYTES
  ) throw new Error("Verification reconciliation record file was invalid");
  const descriptor = await open(recordPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let encoded: Buffer;
  try {
    const opened = await descriptor.stat();
    if (!sameFileIdentity(info, opened)) throw new Error("Verification reconciliation record changed while opening");
    encoded = await descriptor.readFile();
    if (!sameFileIdentity(opened, await descriptor.stat())) {
      throw new Error("Verification reconciliation record changed while reading");
    }
  } finally {
    await descriptor.close();
  }
  const record = JSON.parse(encoded.toString("utf8")) as unknown;
  assertVerificationReconciliationRecord(record);
  await assertVerificationReconciliationAuthority(authority);
  return { encoded, record };
}

async function assertVerificationReconciliationCas(
  handle: VerificationReconciliationHandle,
): Promise<void> {
  const current = await readVerificationReconciliationRecord(handle.path, handle.reconciliationAuthority);
  if (
    !current.encoded.equals(handle.encoded) ||
    current.record.revision !== handle.record.revision ||
    current.record.ownerToken !== handle.record.ownerToken
  ) throw new Error("Verification reconciliation record CAS failed");
}

async function reconcileVerificationResources(
  engine: string,
  handle: VerificationReconciliationHandle,
  env: NodeJS.ProcessEnv,
  command: ContainerEngineCommand,
): Promise<boolean> {
  assertVerificationReconciliationRecord(handle.record);
  await assertVerificationReconciliationCas(handle);
  const { authority } = handle;
  const state = handle.record.state;
  if (state === "volume_create_pending") {
    await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
    const identity = await inspectOwnedVolumeIdentity(
      engine,
      authority.ownerId,
      handle.record.volumeName,
      env,
      command,
    );
    await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
    if (identity === null) return false;
    if (handle.record.volumeIdentity !== null && handle.record.volumeIdentity !== identity.fingerprint) {
      throw new Error("Verification reconciliation volume identity changed");
    }
    if (handle.record.volumeIdentity === null) {
      await updateVerificationReconciliation(handle, { volumeIdentity: identity.fingerprint });
    }
    await removeOwnedVolume(
      engine,
      authority.ownerId,
      handle.record.volumeName,
      env,
      command,
      identity,
    );
    await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
    await completeVerificationReconciliation(handle);
    return true;
  }
  if (state === "volume_ready") {
    await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
    const identity = await inspectOwnedVolumeIdentity(
      engine,
      authority.ownerId,
      handle.record.volumeName,
      env,
      command,
    );
    await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
    if (
      identity !== null &&
      handle.record.volumeIdentity !== null &&
      identity.fingerprint !== handle.record.volumeIdentity
    ) throw new Error("Verification reconciliation volume identity changed");
    if (identity !== null && handle.record.volumeIdentity === null) {
      await updateVerificationReconciliation(handle, { volumeIdentity: identity.fingerprint });
    }
    await removeOwnedVolume(
      engine,
      authority.ownerId,
      handle.record.volumeName,
      env,
      command,
      identity ?? undefined,
    );
    await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
    await completeVerificationReconciliation(handle);
    return true;
  }

  let commitObserved = handle.record.containerId !== null;
  await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
  const cid = await readExactContainerId(authority.cidFile);
  await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
  if (cid !== null) {
    if (handle.record.containerId !== null && handle.record.containerId !== cid) {
      throw new Error("Verification reconciliation cid did not match its durable record");
    }
    commitObserved = true;
  }
  const resolved = await resolveOwnedContainerId(engine, authority, env, command);
  await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
  if (resolved !== null) {
    if (handle.record.containerId !== null && handle.record.containerId !== resolved) {
      throw new Error("Verification reconciliation container id changed");
    }
    if (handle.record.containerId !== resolved || handle.record.state !== "container_ready") {
      await updateVerificationReconciliation(handle, {
        containerId: resolved,
        state: "container_ready",
      });
    }
    commitObserved = true;
  }
  if (!commitObserved) return false;
  await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
  await removeOwnedContainer(engine, authority, env, {
    command,
    removeAnonymousVolumes: true,
  });
  await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
  const identity = await inspectOwnedVolumeIdentity(
    engine,
    authority.ownerId,
    handle.record.volumeName,
    env,
    command,
  );
  await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
  if (
    identity !== null &&
    handle.record.volumeIdentity !== null &&
    identity.fingerprint !== handle.record.volumeIdentity
  ) throw new Error("Verification reconciliation volume identity changed");
  if (identity !== null && handle.record.volumeIdentity === null) {
    await updateVerificationReconciliation(handle, { volumeIdentity: identity.fingerprint });
  }
  await removeOwnedVolume(
    engine,
    authority.ownerId,
    handle.record.volumeName,
    env,
    command,
    identity ?? undefined,
  );
  await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
  await completeVerificationReconciliation(handle);
  return true;
}

async function completeVerificationReconciliation(
  handle: VerificationReconciliationHandle,
): Promise<void> {
  await assertVerificationReconciliationCas(handle);
  await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
  await rm(handle.authority.cidFile, { force: true });
  await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
  await assertVerificationReconciliationCas(handle);
  await unlink(handle.path);
  await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
  await syncDirectory(handle.reconciliationAuthority.directory.path);
  await syncDirectory(handle.reconciliationAuthority.parent.path);
  await assertVerificationReconciliationAuthority(handle.reconciliationAuthority);
}

async function readExactContainerId(cidFile: string): Promise<string | null> {
  try {
    const value = (await readFile(cidFile, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw new Error("Verification reconciliation cidfile was invalid");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const descriptor = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

function buildVerificationCompletionRequestArchive(
  authority: VerificationCompletionAuthority,
): Buffer {
  const contents = Buffer.from(
    `{"schemaVersion":1,"nonce":"${authority.nonce}"}\n`,
    "utf8",
  );
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, COMPLETION_REQUEST_NAME);
  writeTarOctal(header, 100, 8, 0o600);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, contents.byteLength);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  writeTarText(header, 265, 32, "root");
  writeTarText(header, 297, 32, "root");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encodedChecksum = checksum.toString(8).padStart(6, "0") + "\0 ";
  header.write(encodedChecksum, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (contents.byteLength % 512)) % 512);
  return Buffer.concat([header, contents, padding, Buffer.alloc(1024)]);
}

function writeTarText(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const encoded = Buffer.from(value, "ascii");
  if (encoded.byteLength > length) throw new Error("Verification tar field exceeded its bound");
  encoded.copy(target, offset);
}

function writeTarOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
  if (encoded.length !== length) throw new Error("Verification tar number exceeded its bound");
  target.write(encoded, offset, length, "ascii");
}

function parseVerificationGateIdentity(value: string): VerificationGateIdentity {
  const match = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(value);
  if (!match) throw new Error("Verifier container user must be an exact non-root numeric uid:gid");
  const uid = Number(match[1]);
  const gid = Number(match[2]);
  if (
    !Number.isSafeInteger(uid) || uid > 0xffff_fffe ||
    !Number.isSafeInteger(gid) || gid > 0xffff_fffe
  ) {
    throw new Error("Verifier container user must be an exact non-root numeric uid:gid");
  }
  return { uid, gid };
}

async function captureCompletionDirectoryIdentity(
  directoryPath: string,
): Promise<Pick<VerificationCompletionAuthority, "directoryPath" | "realPath" | "dev" | "ino" | "uid" | "gid" | "mode">> {
  const info = await lstat(directoryPath);
  if (!info.isDirectory() || info.isSymbolicLink() || permissionMode(info.mode) !== 0o700) {
    throw new Error("Verification completion directory identity was invalid");
  }
  return {
    directoryPath,
    realPath: await realpath(directoryPath),
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    gid: info.gid,
    mode: permissionMode(info.mode),
  };
}

async function assertVerificationCompletionDirectoryIdentity(
  authority: Pick<VerificationCompletionAuthority, "directoryPath" | "realPath" | "dev" | "ino" | "uid" | "gid" | "mode">,
): Promise<void> {
  const info = await lstat(authority.directoryPath);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev !== authority.dev ||
    info.ino !== authority.ino ||
    info.uid !== authority.uid ||
    info.gid !== authority.gid ||
    permissionMode(info.mode) !== authority.mode ||
    authority.mode !== 0o700 ||
    await realpath(authority.directoryPath) !== authority.realPath
  ) {
    throw new Error("Verification completion directory identity changed");
  }
}

async function assertPreparedVerificationCompletionRequest(
  authority: VerificationCompletionAuthority,
): Promise<void> {
  await assertVerificationCompletionDirectoryIdentity(authority);
  const entries = (await readdir(authority.directoryPath)).sort();
  if (!sameStringArray(entries, [COMPLETION_REQUEST_NAME])) {
    throw new Error("Verification completion request state changed before launch");
  }
  const expected = `{"schemaVersion":1,"nonce":"${authority.nonce}"}\n`;
  const logical = await lstat(authority.requestPath);
  if (
    !logical.isFile() ||
    logical.isSymbolicLink() ||
    logical.nlink !== 1 ||
    permissionMode(logical.mode) !== 0o600 ||
    logical.uid !== authority.uid ||
    logical.gid !== authority.gid ||
    logical.size !== Buffer.byteLength(expected)
  ) {
    throw new Error("Verification completion request identity changed before launch");
  }
  const handle = await open(authority.requestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!sameFileIdentity(logical, opened)) {
      throw new Error("Verification completion request changed while opening");
    }
    const encoded = await handle.readFile("utf8");
    const after = await handle.stat();
    if (encoded !== expected || !sameFileIdentity(opened, after)) {
      throw new Error("Verification completion request contents changed before launch");
    }
  } finally {
    await handle.close();
  }
  await assertVerificationCompletionDirectoryIdentity(authority);
}

function permissionMode(mode: number): number {
  return mode & 0o777;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

async function unlinkCompletionEntry(target: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      throw new Error("Verification completion entry unexpectedly became a directory");
    }
    await unlink(target);
    await assertPathMissing(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertPathMissing(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Verification completion authority remained after cleanup");
}

function combineCleanupFailures(
  failures: VerificationContainerError[],
): VerificationContainerError | undefined {
  const primary = failures[0];
  if (primary !== undefined && failures.length > 1) {
    Object.defineProperty(primary, "cleanupFailures", {
      configurable: true,
      value: failures,
    });
  }
  return primary;
}

function verificationEngineCommandSucceeded(result: VerificationEngineCommandResult): boolean {
  return result.code === 0 &&
    result.signal === null &&
    !result.timedOut &&
    !result.outputExceeded &&
    !result.cancelled &&
    result.spawnError === undefined;
}

function createVerificationEngineTermination(child: ReturnType<typeof spawn>): {
  terminate(): Promise<void>;
  settle(): void;
  joined: Promise<void>;
} {
  const pid = child.pid;
  let requested = false;
  let settled = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let resolveJoined!: () => void;
  const joined = new Promise<void>((resolve) => {
    resolveJoined = resolve;
  });
  const send = (signal: NodeJS.Signals) => {
    // The exit event is the process-identity boundary. Once observed, the
    // numeric process-group ID may be reused and must never be signalled again.
    if (settled) return;
    if (process.platform !== "win32" && typeof pid === "number") {
      try {
        process.kill(-pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          try {
            child.kill(signal);
          } catch {}
        }
        return;
      }
    }
    try {
      child.kill(signal);
    } catch {}
  };
  const complete = () => {
    if (settled) return;
    settled = true;
    if (escalation !== undefined) {
      clearTimeout(escalation);
      escalation = undefined;
    }
    resolveJoined();
  };
  return {
    joined,
    terminate() {
      if (requested) {
        if (!settled && escalation !== undefined) {
          clearTimeout(escalation);
          escalation = setTimeout(() => {
            escalation = undefined;
            send("SIGKILL");
          }, JOINED_TERM_TO_KILL_ESCALATION_MS);
          escalation.unref();
        }
        return joined;
      }
      requested = true;
      if (settled) return joined;
      send("SIGTERM");
      escalation = setTimeout(() => {
        escalation = undefined;
        send("SIGKILL");
      }, TERM_TO_KILL_ESCALATION_MS);
      escalation.unref();
      return joined;
    },
    settle: complete,
  };
}

function assertVerificationContainerInspection(
  inspection: InspectedContainer,
  expectedStatus: "created" | "exited",
  expectedVolumeName: string,
  expectedExitCode?: number | null,
): string {
  const state = inspection.State;
  if (
    state === null ||
    state === undefined ||
    state.Status !== expectedStatus ||
    state.Running !== false ||
    (expectedExitCode !== undefined && state.ExitCode !== expectedExitCode)
  ) {
    throw new Error("Verification container state did not match the required lifecycle stage");
  }
  if (!Array.isArray(inspection.Mounts)) {
    throw new Error("Verification container mounts were not inspectable");
  }
  const resultMounts = inspection.Mounts.filter((value): value is Record<string, unknown> =>
    typeof value === "object" && value !== null &&
    value.Destination === CONTAINER_COMPLETION_DIRECTORY,
  );
  const resultMount = resultMounts[0];
  if (
    resultMounts.length !== 1 ||
    resultMount?.Type !== "volume" ||
    resultMount.RW !== true ||
    resultMount.Name !== expectedVolumeName
  ) {
    throw new Error("Verification completion volume identity was invalid");
  }
  return resultMount.Name;
}

function hostEngineEnv(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  for (const name of ["PATH", "HOME", "TMPDIR", "DOCKER_HOST", "XDG_RUNTIME_DIR"] as const) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}
