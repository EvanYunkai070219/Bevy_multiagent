import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";
import { serverDataPaths } from "../storage-layout.js";

const execFileAsync = promisify(execFile);
export const CONTAINER_OWNER_LABEL = "io.codejam.owner-id";

export interface ContainerEngineCommandResult {
  stdout: string;
  stderr: string;
}

export type ContainerEngineCommand = (
  args: string[],
) => Promise<ContainerEngineCommandResult>;

export interface ContainerAuthority {
  ownerId: string;
  name: string;
  cidFile: string;
}

export function createContainerAuthority(
  agentId: string,
  config: Pick<AppConfig, "dataDirectory">,
): ContainerAuthority {
  const ownerId = randomBytes(32).toString("hex");
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  return {
    ownerId,
    name: `launchpad-${safeAgent}-${ownerId}`,
    cidFile: path.join(serverDataPaths(config.dataDirectory).containerAuthority, `${ownerId}.cid`),
  };
}

export async function prepareContainerAuthority(authority: ContainerAuthority): Promise<void> {
  await mkdir(path.dirname(authority.cidFile), { recursive: true, mode: 0o700 });
  await rm(authority.cidFile, { force: true });
}

export interface InspectedContainer {
  Id?: unknown;
  Config?: { Labels?: Record<string, unknown> | null } | null;
  State?: {
    Status?: unknown;
    Running?: unknown;
    ExitCode?: unknown;
  } | null;
  Mounts?: unknown;
}

export interface InspectedVolume {
  Name?: unknown;
  Driver?: unknown;
  Mountpoint?: unknown;
  CreatedAt?: unknown;
  Scope?: unknown;
  Labels?: Record<string, unknown> | null;
  Options?: Record<string, unknown> | null;
}

export interface OwnedVolumeIdentity {
  name: string;
  ownerId: string;
  fingerprint: string;
}

/**
 * Resolve the container created for one Runtime invocation. The cidfile is the
 * primary authority. A name lookup is only a recovery path and still has to
 * prove the immutable owner label before it can authorize removal.
 */
export async function resolveOwnedContainerId(
  engine: string,
  authority: ContainerAuthority,
  env: NodeJS.ProcessEnv = process.env,
  command?: ContainerEngineCommand,
): Promise<string | null> {
  let cid: string | null = null;
  try {
    const raw = (await readFile(authority.cidFile, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(raw)) {
      throw new Error("Container cidfile did not contain an exact full container id");
    }
    cid = raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const inspected = await inspectContainer(engine, cid ?? authority.name, env, command);
  if (inspected === null) return null;
  const fullId = inspected.Id;
  const owner = inspected.Config?.Labels?.[CONTAINER_OWNER_LABEL];
  if (typeof fullId !== "string" || !/^[0-9a-f]{64}$/.test(fullId)) {
    throw new Error("Container inspect did not return an exact full id");
  }
  if (cid !== null && fullId !== cid) {
    throw new Error("Container cidfile and inspected id did not match");
  }
  if (owner !== authority.ownerId) {
    throw new Error("Container owner label did not match Runtime authority");
  }
  return fullId;
}

export async function removeOwnedContainer(
  engine: string,
  authority: ContainerAuthority,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    removeAnonymousVolumes?: boolean;
    expectedAnonymousVolumeName?: string;
    command?: ContainerEngineCommand;
  } = {},
): Promise<void> {
  const id = await resolveOwnedContainerId(engine, authority, env, options.command);
  if (id !== null) {
    await executeContainerEngineCommand(
      engine,
      ["rm", "--force", ...(options.removeAnonymousVolumes ? ["--volumes"] : []), id],
      env,
      8_000,
      options.command,
    );
    const after = await inspectContainer(engine, id, env, options.command);
    if (after !== null) throw new Error("Owned Runtime container remained after force removal");
  }
  if (options.expectedAnonymousVolumeName !== undefined) {
    await removeExactAnonymousVolume(
      engine,
      options.expectedAnonymousVolumeName,
      env,
      options.command,
    );
  }
  await rm(authority.cidFile, { force: true });
}

export async function inspectOwnedContainerById(
  engine: string,
  authority: ContainerAuthority,
  expectedId: string,
  env: NodeJS.ProcessEnv = process.env,
  command?: ContainerEngineCommand,
): Promise<InspectedContainer> {
  if (!/^[0-9a-f]{64}$/.test(expectedId)) {
    throw new Error("Expected owned container id was not exact");
  }
  const cid = (await readFile(authority.cidFile, "utf8")).trim();
  if (cid !== expectedId) {
    throw new Error("Container cidfile and expected id did not match");
  }
  const inspected = await inspectContainer(engine, expectedId, env, command);
  if (inspected === null) throw new Error("Expected owned container was absent");
  if (inspected.Id !== expectedId) {
    throw new Error("Inspected container id did not match exact Runtime authority");
  }
  if (inspected.Config?.Labels?.[CONTAINER_OWNER_LABEL] !== authority.ownerId) {
    throw new Error("Container owner label did not match Runtime authority");
  }
  return inspected;
}

export async function inspectOwnedVolume(
  engine: string,
  ownerId: string,
  volumeName: string,
  env: NodeJS.ProcessEnv = process.env,
  command?: ContainerEngineCommand,
): Promise<boolean> {
  assertExactVolumeName(volumeName);
  const inspected = await inspectVolume(engine, volumeName, env, command);
  if (inspected === null) return false;
  if (inspected.Name !== volumeName) {
    throw new Error("Inspected volume name did not match exact Runtime authority");
  }
  if (inspected.Labels?.[CONTAINER_OWNER_LABEL] !== ownerId) {
    throw new Error("Volume owner label did not match Runtime authority");
  }
  return true;
}

export async function inspectOwnedVolumeIdentity(
  engine: string,
  ownerId: string,
  volumeName: string,
  env: NodeJS.ProcessEnv = process.env,
  command?: ContainerEngineCommand,
): Promise<OwnedVolumeIdentity | null> {
  assertExactVolumeName(volumeName);
  const inspected = await inspectVolume(engine, volumeName, env, command);
  if (inspected === null) return null;
  if (inspected.Name !== volumeName) {
    throw new Error("Inspected volume name did not match exact Runtime authority");
  }
  if (inspected.Labels?.[CONTAINER_OWNER_LABEL] !== ownerId) {
    throw new Error("Volume owner label did not match Runtime authority");
  }
  if (
    typeof inspected.Driver !== "string" || inspected.Driver.length === 0 ||
    typeof inspected.Mountpoint !== "string" || inspected.Mountpoint.length === 0 ||
    typeof inspected.CreatedAt !== "string" || inspected.CreatedAt.length === 0 ||
    typeof inspected.Scope !== "string" || inspected.Scope.length === 0 ||
    !isExactStringRecord(inspected.Labels) ||
    (inspected.Options !== null && inspected.Options !== undefined && !isExactStringRecord(inspected.Options))
  ) {
    throw new Error("Owned Runtime volume identity was incomplete");
  }
  const canonical = JSON.stringify({
    CreatedAt: inspected.CreatedAt,
    Driver: inspected.Driver,
    Labels: sortedStringRecord(inspected.Labels),
    Mountpoint: inspected.Mountpoint,
    Name: inspected.Name,
    Options: inspected.Options === null || inspected.Options === undefined
      ? null
      : sortedStringRecord(inspected.Options),
    Scope: inspected.Scope,
  });
  return {
    name: volumeName,
    ownerId,
    fingerprint: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}

export async function removeOwnedVolume(
  engine: string,
  ownerId: string,
  volumeName: string,
  env: NodeJS.ProcessEnv = process.env,
  command?: ContainerEngineCommand,
  expectedIdentity?: OwnedVolumeIdentity,
): Promise<void> {
  if (expectedIdentity === undefined) {
    if (!await inspectOwnedVolume(engine, ownerId, volumeName, env, command)) return;
    await executeContainerEngineCommand(
      engine,
      ["volume", "rm", volumeName],
      env,
      8_000,
      command,
    );
    if (await inspectOwnedVolume(engine, ownerId, volumeName, env, command)) {
      throw new Error("Owned Runtime volume remained after exact removal");
    }
    return;
  }
  const before = await inspectOwnedVolumeIdentity(engine, ownerId, volumeName, env, command);
  if (before === null) return;
  if (
    expectedIdentity !== undefined &&
    (
      expectedIdentity.name !== volumeName ||
      expectedIdentity.ownerId !== ownerId ||
      expectedIdentity.fingerprint !== before.fingerprint
    )
  ) {
    throw new Error("Owned Runtime volume identity changed before removal");
  }
  await executeContainerEngineCommand(
    engine,
    ["volume", "rm", volumeName],
    env,
    8_000,
    command,
  );
  const after = await inspectOwnedVolumeIdentity(engine, ownerId, volumeName, env, command);
  if (after !== null) throw new Error("Owned Runtime volume remained after exact removal");
}

async function inspectContainer(
  engine: string,
  target: string,
  env: NodeJS.ProcessEnv,
  command?: ContainerEngineCommand,
): Promise<InspectedContainer | null> {
  try {
    const { stdout } = await executeContainerEngineCommand(
      engine,
      ["container", "inspect", "--format", "{{json .}}", target],
      env,
      5_000,
      command,
    );
    return JSON.parse(stdout) as InspectedContainer;
  } catch (error) {
    if (isDockerAbsent(error, target)) return null;
    throw new Error("Container ownership or absence could not be verified", { cause: error });
  }
}

function isDockerAbsent(error: unknown, target: string): boolean {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = Buffer.isBuffer(stderr)
    ? stderr.toString("utf8")
    : typeof stderr === "string" ? stderr : "";
  return text.trim().split(/\r?\n/).some((line) => {
    const match = /^(?:Error(?: response from daemon)?: )?No such (?:object|container): (.+)$/i.exec(line);
    return match?.[1] === target;
  });
}

async function removeExactAnonymousVolume(
  engine: string,
  volumeName: string,
  env: NodeJS.ProcessEnv,
  command?: ContainerEngineCommand,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(volumeName)) {
    throw new Error("Anonymous completion volume name was not exact");
  }
  const present = await inspectVolume(engine, volumeName, env, command);
  if (!present) return;
  await executeContainerEngineCommand(
    engine,
    ["volume", "rm", volumeName],
    env,
    8_000,
    command,
  );
  if (await inspectVolume(engine, volumeName, env, command)) {
    throw new Error("Anonymous completion volume remained after exact removal");
  }
}

async function inspectVolume(
  engine: string,
  volumeName: string,
  env: NodeJS.ProcessEnv,
  command?: ContainerEngineCommand,
): Promise<InspectedVolume | null> {
  try {
    const { stdout } = await executeContainerEngineCommand(
      engine,
      ["volume", "inspect", "--format", "{{json .}}", volumeName],
      env,
      5_000,
      command,
    );
    const inspected = JSON.parse(stdout) as InspectedVolume;
    if (inspected.Name !== volumeName) {
      throw new Error("Inspected volume name did not match exact Runtime authority");
    }
    return inspected;
  } catch (error) {
    if (isDockerVolumeAbsent(error, volumeName)) return null;
    throw new Error("Volume ownership or absence could not be verified", {
      cause: error,
    });
  }
}

function assertExactVolumeName(volumeName: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(volumeName)) {
    throw new Error("Owned Runtime volume name was not exact");
  }
}

function isExactStringRecord(value: unknown): value is Record<string, string> {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string");
}

function sortedStringRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

async function executeContainerEngineCommand(
  engine: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout: number,
  command?: ContainerEngineCommand,
): Promise<ContainerEngineCommandResult> {
  if (command !== undefined) return command(args);
  return execFileAsync(engine, args, { timeout, env });
}

function isDockerVolumeAbsent(error: unknown, target: string): boolean {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = Buffer.isBuffer(stderr)
    ? stderr.toString("utf8")
    : typeof stderr === "string" ? stderr : "";
  return text.trim().split(/\r?\n/).some((line) => {
    const direct = /^(?:Error response from daemon: )?No such volume: (.+)$/i.exec(line);
    const daemon = /^(?:Error response from daemon: )?get (.+): no such volume$/i.exec(line);
    return direct?.[1] === target || daemon?.[1] === target;
  });
}
