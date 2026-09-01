import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { GitClient, type GitWorktreeInfo } from "./git-client.js";
import type {
  AttemptWorkspaceRecord,
  ContributionRecord,
  IntegrationRecord,
  ProjectRunRecord,
} from "./types.js";

export type AttemptRecovery =
  | { action: "removed"; attemptId: string }
  | { action: "preserved"; attemptId: string; reason: PreservationReason };

type PreservationReason = "changed" | "committed" | "conflicted" | "unverifiable";

export type AttemptWorkspaceErrorCode =
  | "attempt_workspace_busy"
  | "attempt_workspace_conflict"
  | "attempt_workspace_unverifiable";

export class AttemptWorkspaceError extends Error {
  readonly name = "AttemptWorkspaceError";
  readonly cause?: unknown;

  constructor(
    readonly code: AttemptWorkspaceErrorCode,
    message: string,
    readonly reason: PreservationReason = "unverifiable",
    cause?: unknown,
  ) {
    super(message);
    Object.defineProperty(this, "cause", { value: cause, enumerable: false, configurable: true });
  }
}

class ReadyDurabilityError extends AttemptWorkspaceError {}

interface DirectoryIdentity {
  readonly logicalPath: string;
  readonly realPath: string;
  readonly dev: number;
  readonly ino: number;
}

interface Paths {
  readonly run: string;
  readonly canonical: string;
  readonly attempts: string;
  readonly attemptsIdentity: DirectoryIdentity;
  readonly runId: string;
  readonly common: string;
  readonly head: string;
}

interface SidecarBase {
  readonly version: 1;
  readonly runId: string;
  readonly sourceFingerprint: string;
  readonly attemptId: string;
  readonly revision: number;
  readonly subtaskId: string;
  readonly baseCommit: string;
  readonly pathHash: string;
  readonly commonHash: string;
  readonly ownerToken: string;
  readonly kind: "task" | "repair";
  readonly checkpointId: string | null;
  readonly checkpointHash?: string;
  readonly sourceOwnerFingerprint?: string;
}

interface AttemptCreateInput {
  readonly runId: string;
  readonly project: ProjectRunRecord;
  readonly attemptId: string;
  readonly revision: number;
  readonly subtaskId: string;
  readonly baseCommit: string;
  readonly kind: "task" | "repair";
  readonly checkpointId: string | null;
  readonly checkpointHash?: string;
  readonly sourceOwnerFingerprint?: string;
  readonly sourceWorkspace?: string;
  readonly expectedHead: string;
}

interface CreatingSidecar extends SidecarBase { readonly state: "creating" }

interface ReadySidecar extends SidecarBase {
  readonly state: "ready";
  readonly attemptsDev: number;
  readonly attemptsIno: number;
  readonly workspaceDev: number;
  readonly workspaceIno: number;
}

type AttemptSidecar = CreatingSidecar | ReadySidecar;
type SidecarRead = { state: "missing" } | { state: "invalid" } | { state: "valid"; value: AttemptSidecar };

type WorkspaceInspection =
  | { state: "absent" }
  | { state: "exact"; info: GitWorktreeInfo; parent: DirectoryIdentity; workspace: DirectoryIdentity }
  | { state: "preserved"; reason: PreservationReason };

/** @internal Deterministic, non-reentrant fault hooks. Never populate these from request input. */
export interface AttemptWorkspaceManagerHooks {
  afterReadyPublishedForTest?(): Promise<void>;
  beforeReadyPublishForTest?(): Promise<void>;
  beforeFinalRemovalFenceForTest?(): Promise<void>;
}

/** @internal Small durable-I/O seam used only for deterministic fault injection. */
export interface AttemptWorkspaceManagerDependencies {
  writeDurableTemp(target: string, content: string): Promise<void>;
  rename(source: string, target: string): Promise<void>;
  unlink(target: string): Promise<void>;
  syncDirectory(directory: string, expected: Pick<DirectoryIdentity, "dev" | "ino">): Promise<void>;
}

export const defaultAttemptWorkspaceManagerDependencies: AttemptWorkspaceManagerDependencies = {
  writeDurableTemp,
  rename,
  unlink,
  syncDirectory,
};

interface LockEntry { readonly turn: Promise<void> }
const attemptLocks = new Map<string, LockEntry>();
let activeAttemptLocks = 0;
let queuedAttemptLocks = 0;
let peakAttemptLockKeys = 0;
let peakAttemptLockPending = 0;

/** @internal Pull-only diagnostics for deterministic lock-serialization tests. */
export function attemptWorkspaceLockSnapshotForTest(): Readonly<{
  active: number;
  queued: number;
  keys: number;
  peakKeys: number;
  peakPending: number;
}> {
  return Object.freeze({
    active: activeAttemptLocks,
    queued: queuedAttemptLocks,
    keys: attemptLocks.size,
    peakKeys: peakAttemptLockKeys,
    peakPending: peakAttemptLockPending,
  });
}

async function withAttemptLock<T>(
  key: string,
  operation: (contended: boolean) => Promise<T>,
): Promise<T> {
  const predecessor = attemptLocks.get(key);
  const contended = predecessor !== undefined;
  let release!: () => void;
  const entry: LockEntry = { turn: new Promise<void>((resolve) => { release = resolve; }) };
  attemptLocks.set(key, entry);
  if (contended) queuedAttemptLocks += 1;
  else activeAttemptLocks += 1;
  peakAttemptLockKeys = Math.max(peakAttemptLockKeys, attemptLocks.size);
  peakAttemptLockPending = Math.max(peakAttemptLockPending, activeAttemptLocks + queuedAttemptLocks);
  if (predecessor) {
    await predecessor.turn;
    queuedAttemptLocks -= 1;
    activeAttemptLocks += 1;
  }
  try {
    return await operation(contended);
  } finally {
    activeAttemptLocks -= 1;
    release();
    if (attemptLocks.get(key) === entry) attemptLocks.delete(key);
  }
}

export class AttemptWorkspaceManager {
  private readonly dependencies: AttemptWorkspaceManagerDependencies;

  constructor(
    private readonly git: GitClient,
    private readonly hooks: AttemptWorkspaceManagerHooks = {},
    dependencies: Partial<AttemptWorkspaceManagerDependencies> = {},
  ) {
    this.dependencies = { ...defaultAttemptWorkspaceManagerDependencies, ...dependencies };
  }

  async create(input: {
    runId: string;
    project: ProjectRunRecord;
    attemptId: string;
    revision?: number;
    subtaskId: string;
    baseCommit: string;
    kind?: "task" | "repair";
    checkpointId?: string | null;
    checkpointHash?: string;
    sourceOwnerFingerprint?: string;
    sourceWorkspace?: string;
    expectedHead?: string;
  }): Promise<AttemptWorkspaceRecord> {
    const kind = input.kind ?? "task";
    const normalized: AttemptCreateInput = {
      ...input,
      revision: input.revision ?? 1,
      kind,
      checkpointId: kind === "repair" ? input.checkpointId ?? null : null,
      expectedHead: input.expectedHead ?? input.baseCommit,
    };
    for (const [value, label] of [
      [input.runId, "run ID"],
      [input.attemptId, "attempt ID"],
      [input.subtaskId, "subtask ID"],
    ] as const) assertComponent(value, label);
    assertCommit(input.baseCommit, "base commit");
    if (!Number.isSafeInteger(normalized.revision) || normalized.revision < 1) {
      throw new Error("Attempt revision must be a positive safe integer");
    }
    if (kind === "repair") {
      if (
        !normalized.checkpointId ||
        !normalized.checkpointHash ||
        !normalized.sourceOwnerFingerprint ||
        !normalized.sourceWorkspace
      ) {
        throw new Error("Repair candidate creation is missing checkpoint ownership");
      }
      assertComponent(normalized.checkpointId, "checkpoint ID");
      assertCommit(normalized.checkpointHash, "checkpoint hash");
      assertCommit(normalized.expectedHead, "checkpoint commit");
    }
    const lockKey = await this.attemptLockKey(input.project, input.attemptId);
    return withAttemptLock(lockKey, (contended) => this.createLocked(normalized, contended));
  }

  async removeClean(project: ProjectRunRecord, attempt: AttemptWorkspaceRecord): Promise<void> {
    const lockKey = await this.attemptLockKey(project, attempt.attemptId);
    await withAttemptLock(lockKey, () => this.recoverLocked(project, attempt));
  }

  async recover(project: ProjectRunRecord, attempt: AttemptWorkspaceRecord): Promise<AttemptRecovery> {
    try {
      const lockKey = await this.attemptLockKey(project, attempt.attemptId);
      return await withAttemptLock(lockKey, () => this.recoverLocked(project, attempt));
    } catch {
      return preserved(attempt.attemptId, "unverifiable");
    }
  }

  async assertExactOwner(project: ProjectRunRecord, attempt: AttemptWorkspaceRecord): Promise<void> {
    const paths = await this.projectPaths(project);
    if (!hasExactMember(project, attempt) || !this.ownedPath(paths, attempt)) {
      throw unverifiable("Attempt is not the exact recorded owner");
    }
    const workspace = await directoryIdentity(attempt.workspacePath);
    const sidecarRead = await this.readSidecar(paths, attempt.attemptId, attempt.revision);
    if (
      sidecarRead.state !== "valid" ||
      sidecarRead.value.state !== "ready" ||
      !this.sidecarMatches(paths, project, attempt, sidecarRead.value)
    ) {
      throw unverifiable("Attempt sidecar does not match the recorded owner");
    }
    const parent = await directoryIdentity(paths.attempts);
    if (
      !sameDirectory(parent, paths.attemptsIdentity) ||
      !readyIdentityMatches(sidecarRead.value, {
        state: "exact",
        info: { path: attempt.workspacePath, head: null, detached: true, branch: null },
        parent,
        workspace,
      }) ||
      (await realpath(await this.git.commonGitDirectory(attempt.workspacePath))) !==
        (await realpath(path.join(attempt.workspacePath, ".git")))
    ) {
      throw unverifiable("Attempt workspace identity does not match the recorded owner");
    }
  }

  /**
   * Task 8 cleanup authority. Unlike ordinary recovery this may remove a clean
   * one-commit attempt, but only after binding every persisted integration and
   * contribution field back to the internal attempt owner.
   */
  async removeIntegrated(
    project: ProjectRunRecord,
    attempt: AttemptWorkspaceRecord,
    contribution: ContributionRecord,
    integration: IntegrationRecord,
  ): Promise<AttemptRecovery> {
    try {
      const lockKey = await this.attemptLockKey(project, attempt.attemptId);
      return await withAttemptLock(lockKey, () =>
        this.removeIntegratedLocked(project, attempt, contribution, integration));
    } catch {
      return preserved(attempt.attemptId, "unverifiable");
    }
  }

  async importContribution(
    project: ProjectRunRecord,
    attempt: AttemptWorkspaceRecord,
    contribution: ContributionRecord,
  ): Promise<void> {
    const lockKey = await this.attemptLockKey(project, attempt.attemptId);
    await withAttemptLock(lockKey, async () => {
      const paths = await this.projectPaths(project);
      const sidecarRead = await this.readSidecar(paths, attempt.attemptId, attempt.revision);
      if (
        !hasExactMember(project, attempt) ||
        !this.ownedPath(paths, attempt) ||
        attempt.state !== "contribution_ready" ||
        attempt.cleanup !== "active" ||
        contribution.attemptId !== attempt.attemptId ||
        contribution.attemptRevision !== attempt.revision ||
        contribution.ownerFingerprint !== hash(attempt.ownerToken) ||
        contribution.subtaskId !== attempt.subtaskId ||
        contribution.baseCommit !== attempt.baseCommit ||
        contribution.headCommit !== attempt.headCommit ||
        sidecarRead.state !== "valid" ||
        sidecarRead.value.state !== "ready" ||
        !this.sidecarMatches(paths, project, attempt, sidecarRead.value)
      ) throw new Error("Contribution import authority does not match the exact attempt owner");
      const workspace = await directoryIdentity(attempt.workspacePath);
      const parent = await directoryIdentity(paths.attempts);
      const info = await this.git.worktreeInfo(paths.canonical, attempt.workspacePath);
      if (
        !sameDirectory(parent, paths.attemptsIdentity) ||
        !isContained(parent.realPath, workspace.realPath) ||
        !info?.detached ||
        info.head !== contribution.headCommit ||
        (await realpath(await this.git.commonGitDirectory(attempt.workspacePath))) !==
          (await realpath(path.join(attempt.workspacePath, ".git"))) ||
        !readyIdentityMatches(sidecarRead.value, {
          state: "exact",
          info,
          parent,
          workspace,
        })
      ) throw new Error("Contribution import attempt identity changed");
      await this.git.importExactCommit(
        paths.canonical,
        attempt.workspacePath,
        attempt.baseCommit,
        contribution.headCommit,
        contribution.diffHash,
      );
    });
  }

  async compensateUnpersisted(
    project: ProjectRunRecord,
    attempt: AttemptWorkspaceRecord,
  ): Promise<AttemptRecovery> {
    if (project.attempts.some((item) =>
      item.attemptId === attempt.attemptId && item.revision === attempt.revision
    )) return preserved(attempt.attemptId, "unverifiable");
    try {
      const lockKey = await this.attemptLockKey(project, attempt.attemptId);
      return await withAttemptLock(lockKey, () => this.recoverLocked({
        ...project,
        attempts: [...project.attempts, attempt],
      }, attempt));
    } catch {
      return preserved(attempt.attemptId, "unverifiable");
    }
  }

  private async createLocked(
    input: AttemptCreateInput,
    contended: boolean,
  ): Promise<AttemptWorkspaceRecord> {
    const paths = await this.projectPaths(input.project, input.runId);
    if (input.project.attempts.some((attempt) =>
      attempt.attemptId === input.attemptId && attempt.revision >= input.revision
    )) {
      throw new AttemptWorkspaceError(
        "attempt_workspace_busy",
        "Attempt revision is not newer than the persisted owner",
      );
    }
    if (input.kind !== "repair" && input.baseCommit !== paths.head) {
      throw new Error("Attempt base commit must match the recorded project head");
    }
    if ((await this.git.resolveCommit(paths.canonical, input.baseCommit)) !== input.baseCommit) {
      throw new Error("Attempt base commit is unavailable");
    }
    const target = this.workspacePath(paths, input.attemptId, input.revision);
    const recovered = await this.reconcileCreateEntry(paths, input.project, input, target);
    if (recovered) {
      if (contended) {
        throw new AttemptWorkspaceError(
          "attempt_workspace_busy",
          "A concurrent create already owns this attempt",
        );
      }
      return recovered;
    }

    const creating = this.creatingSidecar(paths, input.project, input);
    await this.publishCreating(paths, creating);
    let record: AttemptWorkspaceRecord | null = null;
    let createError: unknown;
    try {
      if (input.kind === "repair") {
        await this.git.createIsolatedCheckout(
          input.sourceWorkspace!,
          target,
          input.baseCommit,
          input.expectedHead,
        );
      } else {
        await this.git.worktreeAdd(paths.canonical, target, input.baseCommit);
      }
      await this.hooks.beforeReadyPublishForTest?.();
      record = await this.finalizeCreating(paths, input.project, input, creating);
    } catch (error) {
      createError = error;
      record = await this.reconcileCreateFailure(paths, input.project, input, creating, error);
    }
    if (!record) throw createError;
    await this.hooks.afterReadyPublishedForTest?.();
    return record;
  }

  private async recoverLocked(
    project: ProjectRunRecord,
    attempt: AttemptWorkspaceRecord,
  ): Promise<AttemptRecovery> {
    try {
      const paths = await this.projectPaths(project);
      if (!hasExactMember(project, attempt) || !this.ownedPath(paths, attempt)) {
        return preserved(attempt.attemptId, "unverifiable");
      }
      const targetPresence = await presence(attempt.workspacePath);
      const registered = await this.git.worktreeInfo(paths.canonical, attempt.workspacePath);
      if (targetPresence === "missing") {
        if (registered) return preserved(attempt.attemptId, "unverifiable");
        await this.cleanupAbsentSidecar(paths, project, attempt);
        return { action: "removed", attemptId: attempt.attemptId };
      }

      const sidecarRead = await this.readSidecar(paths, attempt.attemptId, attempt.revision);
      if (
        sidecarRead.state !== "valid" ||
        sidecarRead.value.state !== "ready" ||
        !this.sidecarMatches(paths, project, attempt, sidecarRead.value)
      ) {
        return preserved(attempt.attemptId, "unverifiable");
      }
      const initial = await this.inspectWorkspace(paths, attempt.attemptId, attempt.revision, attempt.baseCommit);
      if (initial.state === "preserved") return preserved(attempt.attemptId, initial.reason);
      if (initial.state !== "exact" || !readyIdentityMatches(sidecarRead.value, initial)) {
        return preserved(attempt.attemptId, "unverifiable");
      }

      await this.hooks.beforeFinalRemovalFenceForTest?.();
      if (!(await this.finalDeletionFence(paths, project, attempt, sidecarRead.value))) {
        return preserved(attempt.attemptId, "unverifiable");
      }
      try {
        await this.git.worktreeRemoveClean(paths.canonical, attempt.workspacePath);
      } catch {
        // A transport/reporting error may follow a successful Git removal.
        // The physical and registration postcondition below is authoritative.
      }
      if (!(await this.removalComplete(paths, attempt.workspacePath))) {
        return preserved(attempt.attemptId, "unverifiable");
      }
      await this.removeExactSidecar(paths, sidecarRead.value).catch(() => undefined);
      return { action: "removed", attemptId: attempt.attemptId };
    } catch {
      return preserved(attempt.attemptId, "unverifiable");
    }
  }

  private async removeIntegratedLocked(
    project: ProjectRunRecord,
    attempt: AttemptWorkspaceRecord,
    contribution: ContributionRecord,
    integration: IntegrationRecord,
  ): Promise<AttemptRecovery> {
    const paths = await this.projectPaths(project);
    const expectedOwner = hash(attempt.ownerToken);
    const exactIntegration = project.integrations.some((item) =>
      item.contributionId === integration.contributionId &&
      item.subtaskId === integration.subtaskId &&
      item.canonicalHeadBefore === integration.canonicalHeadBefore &&
      item.canonicalHeadAfter === integration.canonicalHeadAfter &&
      item.state === integration.state &&
      item.structuralDecision === integration.structuralDecision &&
      item.reason === integration.reason
    );
    if (
      !hasExactMember(project, attempt) ||
      !this.ownedPath(paths, attempt) ||
      attempt.state !== "integrated" ||
      attempt.cleanup !== "active" ||
      contribution.attemptId !== attempt.attemptId ||
      contribution.attemptRevision !== attempt.revision ||
      contribution.ownerFingerprint !== expectedOwner ||
      contribution.subtaskId !== attempt.subtaskId ||
      contribution.baseCommit !== attempt.baseCommit ||
      contribution.headCommit !== attempt.headCommit ||
      integration.contributionId !== contribution.contributionId ||
      integration.subtaskId !== attempt.subtaskId ||
      integration.state !== "integrated" ||
      integration.structuralDecision !== "passed" ||
      integration.canonicalHeadAfter !== project.headCommit ||
      !exactIntegration
    ) return preserved(attempt.attemptId, "unverifiable");

    const sidecarRead = await this.readSidecar(paths, attempt.attemptId, attempt.revision);
    if (
      sidecarRead.state !== "valid" ||
      sidecarRead.value.state !== "ready" ||
      !this.sidecarMatches(paths, project, attempt, sidecarRead.value)
    ) return preserved(attempt.attemptId, "unverifiable");

    const target = attempt.workspacePath;
    await this.git.validateStandaloneAttempt(target, attempt.baseCommit);
    const parent = await directoryIdentity(paths.attempts);
    const workspace = await directoryIdentity(target);
    const info = await this.git.worktreeInfo(paths.canonical, target);
    if (
      !sameDirectory(parent, paths.attemptsIdentity) ||
      !isContained(parent.realPath, workspace.realPath) ||
      workspace.realPath !== path.join(parent.realPath, this.workspaceName(attempt.attemptId, attempt.revision)) ||
      !info?.detached ||
      info.head !== contribution.headCommit ||
      (await realpath(await this.git.commonGitDirectory(target))) !== (await realpath(path.join(target, ".git"))) ||
      !(await this.git.isClean(target)) ||
      (await this.git.commitCount(target, attempt.baseCommit, contribution.headCommit)) !== 1 ||
      !(await this.git.isAncestor(target, attempt.baseCommit, contribution.headCommit))
    ) return preserved(attempt.attemptId, "unverifiable");
    const changedPaths = await this.git.changedPaths(target, attempt.baseCommit, contribution.headCommit);
    const diffHash = createHash("sha256")
      .update(await this.git.binaryDiff(target, attempt.baseCommit, contribution.headCommit))
      .digest("hex");
    if (
      diffHash !== contribution.diffHash ||
      changedPaths.length !== contribution.changedPaths.length ||
      changedPaths.some((item, index) => item !== contribution.changedPaths[index]) ||
      !readyIdentityMatches(sidecarRead.value, { state: "exact", info, parent, workspace }) ||
      !(await this.finalIdentityFence(paths, attempt.attemptId, attempt.revision, sidecarRead.value))
    ) return preserved(attempt.attemptId, "unverifiable");

    await this.git.worktreeRemoveClean(paths.canonical, target);
    if (!(await this.removalComplete(paths, target))) return preserved(attempt.attemptId, "unverifiable");
    await this.removeExactSidecar(paths, sidecarRead.value).catch(() => undefined);
    return { action: "removed", attemptId: attempt.attemptId };
  }

  private async reconcileCreateEntry(
    paths: Paths,
    project: ProjectRunRecord,
    input: AttemptCreateInput,
    target: string,
  ): Promise<AttemptWorkspaceRecord | null> {
    const sidecarRead = await this.readSidecar(paths, input.attemptId, input.revision);
    const inspection = await this.inspectWorkspace(paths, input.attemptId, input.revision, input.expectedHead);
    if (inspection.state === "absent") {
      if (sidecarRead.state === "invalid") throw unverifiable("Attempt sidecar cannot be verified");
      if (sidecarRead.state === "valid") {
        if (!this.sidecarMatches(paths, project, input, sidecarRead.value)) {
          throw unverifiable("Attempt sidecar belongs to different work");
        }
        await this.removeExactSidecar(paths, sidecarRead.value);
      }
      return null;
    }
    if (inspection.state === "preserved") {
      throw conflictFor(inspection.reason, "Existing attempt workspace must be preserved");
    }
    if (
      sidecarRead.state !== "valid" ||
      !this.sidecarMatches(paths, project, input, sidecarRead.value)
    ) {
      throw unverifiable("Existing attempt has no exact ownership sidecar");
    }
    if (sidecarRead.value.state === "ready") {
      if (!readyIdentityMatches(sidecarRead.value, inspection)) {
        throw unverifiable("Ready attempt identity changed");
      }
      await this.confirmReadyDurability(paths, sidecarRead.value);
      return attemptRecord(input, target, sidecarRead.value.ownerToken);
    }
    return this.finalizeCreating(paths, project, input, sidecarRead.value, inspection);
  }

  private async reconcileCreateFailure(
    paths: Paths,
    project: ProjectRunRecord,
    input: AttemptCreateInput,
    creating: CreatingSidecar,
    original: unknown,
  ): Promise<AttemptWorkspaceRecord | null> {
    const sidecarRead = await this.readSidecar(paths, input.attemptId, input.revision);
    const inspection = await this.inspectWorkspace(paths, input.attemptId, input.revision, input.expectedHead);
    if (sidecarRead.state !== "valid" || !sameOwnerBinding(sidecarRead.value, creating)) {
      throw unverifiable("Attempt ownership changed during creation", original);
    }
    if (inspection.state === "absent") {
      await this.removeExactSidecar(paths, creating);
      return null;
    }
    if (inspection.state === "preserved") {
      throw conflictFor(inspection.reason, "Partial attempt must be preserved", original);
    }
    if (sidecarRead.value.state === "ready") {
      if (!readyIdentityMatches(sidecarRead.value, inspection)) {
        throw unverifiable("Published attempt identity cannot be verified", original);
      }
      if (original instanceof ReadyDurabilityError) throw original;
      await this.confirmReadyDurability(paths, sidecarRead.value, original);
      return attemptRecord(input, this.workspacePath(paths, input.attemptId, input.revision), sidecarRead.value.ownerToken);
    }
    try {
      return await this.finalizeCreating(paths, project, input, sidecarRead.value, inspection);
    } catch (reconciliationError) {
      throw unverifiable("Attempt finalization could not be reconciled", reconciliationError);
    }
  }

  private async finalizeCreating(
    paths: Paths,
    project: ProjectRunRecord,
    input: AttemptCreateInput,
    creating: CreatingSidecar,
    knownInspection?: Extract<WorkspaceInspection, { state: "exact" }>,
  ): Promise<AttemptWorkspaceRecord> {
    const inspection = knownInspection ?? await this.inspectWorkspace(
      paths,
      input.attemptId,
      input.revision,
      input.expectedHead,
    );
    if (inspection.state !== "exact") {
      if (inspection.state === "preserved") {
        throw conflictFor(inspection.reason, "Created attempt workspace is not safely finalizable");
      }
      throw unverifiable("Created attempt workspace is absent");
    }
    const ready: ReadySidecar = {
      ...creating,
      state: "ready",
      attemptsDev: inspection.parent.dev,
      attemptsIno: inspection.parent.ino,
      workspaceDev: inspection.workspace.dev,
      workspaceIno: inspection.workspace.ino,
    };
    await this.publishReady(paths, creating, ready);
    return attemptRecord(input, this.workspacePath(paths, input.attemptId, input.revision), ready.ownerToken);
  }

  private async inspectWorkspace(
    paths: Paths,
    attemptId: string,
    revision: number,
    baseCommit: string,
  ): Promise<WorkspaceInspection> {
    const target = this.workspacePath(paths, attemptId, revision);
    try {
      const targetPresence = await presence(target);
      const registered = await this.git.worktreeInfo(paths.canonical, target);
      if (targetPresence === "missing" && !registered) return { state: "absent" };
      if (targetPresence !== "directory" || !registered || registered.path !== target || !registered.detached) {
        return { state: "preserved", reason: "unverifiable" };
      }
      const parent = await directoryIdentity(paths.attempts);
      const workspace = await directoryIdentity(target);
      if (
        !sameDirectory(parent, paths.attemptsIdentity) ||
        !isContained(parent.realPath, workspace.realPath) ||
        workspace.realPath !== path.join(parent.realPath, this.workspaceName(attemptId, revision)) ||
        (await realpath(await this.git.commonGitDirectory(target))) !==
          (await realpath(path.join(target, ".git")))
      ) {
        return { state: "preserved", reason: "unverifiable" };
      }
      if (!(await this.git.isClean(target))) {
        return { state: "preserved", reason: await this.conflicted(target) ? "conflicted" : "changed" };
      }
      const head = await this.git.head(target);
      if (head !== baseCommit || registered.head !== baseCommit) {
        return { state: "preserved", reason: "committed" };
      }
      return { state: "exact", info: registered, parent, workspace };
    } catch {
      return { state: "preserved", reason: "unverifiable" };
    }
  }

  private async finalDeletionFence(
    paths: Paths,
    project: ProjectRunRecord,
    attempt: AttemptWorkspaceRecord,
    expected: ReadySidecar,
  ): Promise<boolean> {
    try {
      const sidecarRead = await this.readSidecar(paths, attempt.attemptId, attempt.revision);
      if (
        sidecarRead.state !== "valid" ||
        sidecarRead.value.state !== "ready" ||
        !sameOwnerSidecar(sidecarRead.value, expected) ||
        !this.sidecarMatches(paths, project, attempt, sidecarRead.value)
      ) return false;
      const inspection = await this.inspectWorkspace(paths, attempt.attemptId, attempt.revision, attempt.baseCommit);
      if (inspection.state !== "exact" || !readyIdentityMatches(expected, inspection)) return false;
      return await this.finalIdentityFence(paths, attempt.attemptId, attempt.revision, expected);
    } catch {
      return false;
    }
  }

  private async finalIdentityFence(
    paths: Paths,
    attemptId: string,
    revision: number,
    expected: ReadySidecar,
  ): Promise<boolean> {
    const parent = await directoryIdentity(paths.attempts);
    const workspace = await directoryIdentity(this.workspacePath(paths, attemptId, revision));
    return sameDirectory(parent, paths.attemptsIdentity) &&
      parent.dev === expected.attemptsDev &&
      parent.ino === expected.attemptsIno &&
      workspace.dev === expected.workspaceDev &&
      workspace.ino === expected.workspaceIno &&
      isContained(parent.realPath, workspace.realPath) &&
      workspace.realPath === path.join(parent.realPath, this.workspaceName(attemptId, revision));
  }

  private async removalComplete(paths: Paths, target: string): Promise<boolean> {
    try {
      return (await presence(target)) === "missing" && !(await this.git.worktreeInfo(paths.canonical, target));
    } catch {
      return false;
    }
  }

  private creatingSidecar(
    paths: Paths,
    project: ProjectRunRecord,
    input: AttemptCreateInput,
  ): CreatingSidecar {
    const workspacePath = this.workspacePath(paths, input.attemptId, input.revision);
    return {
      version: 1,
      state: "creating",
      runId: paths.runId,
      sourceFingerprint: project.source.sourceFingerprint,
      attemptId: input.attemptId,
      revision: input.revision,
      subtaskId: input.subtaskId,
      baseCommit: input.baseCommit,
      pathHash: hash(workspacePath),
      commonHash: hash(path.join(workspacePath, ".git")),
      ownerToken: randomUUID(),
      kind: input.kind,
      checkpointId: input.checkpointId,
      ...(input.kind === "repair"
        ? {
          checkpointHash: input.checkpointHash,
          sourceOwnerFingerprint: input.sourceOwnerFingerprint,
        }
        : {}),
    };
  }

  private async publishCreating(paths: Paths, creating: CreatingSidecar): Promise<void> {
    const marker = this.markerPath(paths, creating.attemptId, creating.revision);
    const pending = marker + ".creating-" + creating.ownerToken + "-" + randomUUID();
    try {
      await this.dependencies.writeDurableTemp(pending, JSON.stringify(creating));
      if ((await this.readSidecar(paths, creating.attemptId, creating.revision)).state !== "missing") {
        throw new AttemptWorkspaceError("attempt_workspace_busy", "Attempt sidecar already exists");
      }
      await this.dependencies.rename(pending, marker);
      await this.dependencies.syncDirectory(paths.attempts, paths.attemptsIdentity);
    } catch (error) {
      await this.dependencies.unlink(pending).catch(() => undefined);
      throw error;
    }
  }

  private async publishReady(paths: Paths, creating: CreatingSidecar, ready: ReadySidecar): Promise<void> {
    const marker = this.markerPath(paths, ready.attemptId, ready.revision);
    const pending = marker + ".ready-" + ready.ownerToken + "-" + randomUUID();
    let phase: "not_started" | "temp_durable" | "rename_returned" | "directory_synced" = "not_started";
    try {
      await this.dependencies.writeDurableTemp(pending, JSON.stringify(ready));
      phase = "temp_durable";
      const current = await this.readSidecar(paths, ready.attemptId, ready.revision);
      if (
        current.state !== "valid" ||
        current.value.state !== "creating" ||
        !sameOwnerSidecar(current.value, creating)
      ) {
        throw unverifiable("Attempt creating owner changed before ready publication");
      }
      await this.dependencies.rename(pending, marker);
      phase = "rename_returned";
      await this.dependencies.syncDirectory(paths.attempts, paths.attemptsIdentity);
      phase = "directory_synced";
    } catch (error) {
      await this.dependencies.unlink(pending).catch(() => undefined);
      if (phase !== "not_started") {
        const current = await this.readSidecar(paths, ready.attemptId, ready.revision);
        if (
          current.state === "valid" &&
          current.value.state === "ready" &&
          sameOwnerSidecar(current.value, ready)
        ) {
          await this.confirmReadyDurability(paths, ready, error);
          return;
        }
      }
      throw error;
    }
  }

  private async confirmReadyDurability(
    paths: Paths,
    expected: ReadySidecar,
    cause?: unknown,
  ): Promise<void> {
    const current = await this.readSidecar(paths, expected.attemptId, expected.revision);
    if (
      current.state !== "valid" ||
      current.value.state !== "ready" ||
      !sameOwnerSidecar(current.value, expected)
    ) {
      throw new ReadyDurabilityError(
        "attempt_workspace_unverifiable",
        "Published ready sidecar changed before durability confirmation",
        "unverifiable",
        cause,
      );
    }
    try {
      await this.dependencies.syncDirectory(paths.attempts, paths.attemptsIdentity);
    } catch (confirmationError) {
      throw new ReadyDurabilityError(
        "attempt_workspace_unverifiable",
        "Published ready sidecar durability cannot be verified",
        "unverifiable",
        confirmationError,
      );
    }
  }

  private async cleanupAbsentSidecar(
    paths: Paths,
    project: ProjectRunRecord,
    attempt: AttemptWorkspaceRecord,
  ): Promise<void> {
    const sidecarRead = await this.readSidecar(paths, attempt.attemptId, attempt.revision);
    if (
      sidecarRead.state === "valid" &&
      this.sidecarMatches(paths, project, attempt, sidecarRead.value)
    ) {
      await this.removeExactSidecar(paths, sidecarRead.value).catch(() => undefined);
    }
  }

  private async removeExactSidecar(paths: Paths, expected: AttemptSidecar): Promise<void> {
    const current = await this.readSidecar(paths, expected.attemptId, expected.revision);
    if (current.state === "missing") return;
    if (current.state !== "valid" || !sameOwnerSidecar(current.value, expected)) {
      throw unverifiable("Attempt sidecar changed before cleanup");
    }
    await this.dependencies.unlink(this.markerPath(paths, expected.attemptId, expected.revision));
    await this.dependencies.syncDirectory(paths.attempts, paths.attemptsIdentity);
  }

  private async readSidecar(paths: Paths, attemptId: string, revision: number): Promise<SidecarRead> {
    const markerPath = this.markerPath(paths, attemptId, revision);
    try {
      const item = await lstat(markerPath);
      if (!item.isFile() || item.isSymbolicLink()) return { state: "invalid" };
      const parsed = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
      return isSidecar(parsed) ? { state: "valid", value: parsed } : { state: "invalid" };
    } catch (error) {
      return isMissing(error) ? { state: "missing" } : { state: "invalid" };
    }
  }

  private sidecarMatches(
    paths: Paths,
    project: ProjectRunRecord,
    attempt: Pick<AttemptWorkspaceRecord, "attemptId" | "revision" | "subtaskId" | "baseCommit"> & {
      ownerToken?: string;
      kind?: "task" | "repair";
      checkpointId?: string | null;
    },
    sidecar: AttemptSidecar,
  ): boolean {
    return sidecar.runId === paths.runId &&
      sidecar.sourceFingerprint === project.source.sourceFingerprint &&
      sidecar.attemptId === attempt.attemptId &&
      sidecar.revision === attempt.revision &&
      sidecar.subtaskId === attempt.subtaskId &&
      sidecar.baseCommit === attempt.baseCommit &&
      sidecar.pathHash === hash(this.workspacePath(paths, attempt.attemptId, attempt.revision)) &&
      sidecar.commonHash === hash(path.join(this.workspacePath(paths, attempt.attemptId, attempt.revision), ".git")) &&
      (sidecar.kind ?? "task") === (attempt.kind ?? "task") &&
      (attempt.checkpointId === undefined || (sidecar.checkpointId ?? null) === attempt.checkpointId) &&
      (attempt.ownerToken === undefined || sidecar.ownerToken === attempt.ownerToken);
  }

  private workspaceName(attemptId: string, revision: number): string {
    return attemptId + "-r" + revision;
  }

  private workspacePath(paths: Paths, attemptId: string, revision: number): string {
    return path.join(paths.attempts, this.workspaceName(attemptId, revision));
  }

  private async projectPaths(project: ProjectRunRecord, expectedRun?: string): Promise<Paths> {
    if (
      project.state !== "ready" ||
      project.source.mode === "ephemeral_research" ||
      !project.headCommit ||
      !project.source.baseCommit ||
      !project.runBranch
    ) throw new Error("Attempts require a ready Git-backed project");
    assertCommit(project.headCommit, "project head");
    assertCommit(project.source.baseCommit, "project base");
    const canonical = path.resolve(project.canonicalWorkspacePath);
    const run = path.dirname(canonical);
    const runs = path.dirname(run);
    const runId = path.basename(run);
    if (path.basename(canonical) !== "canonical" || path.basename(runs) !== ".runs") {
      throw new Error("Project canonical workspace is outside a managed run directory");
    }
    assertComponent(runId, "project run ID");
    if (expectedRun && expectedRun !== runId) throw new Error("Attempt run ID does not match project");
    for (const item of [runs, run, canonical]) await directoryIdentity(item);
    if ((await this.git.run(canonical, ["branch", "--show-current"])) !== project.runBranch) {
      throw new Error("Canonical branch does not match project record");
    }
    if ((await this.git.head(canonical)) !== project.headCommit || !(await this.git.isClean(canonical))) {
      throw new Error("Canonical workspace no longer matches project record");
    }
    if ((await this.git.resolveCommit(canonical, project.source.baseCommit)) !== project.source.baseCommit) {
      throw new Error("Project base is unavailable");
    }
    const attempts = path.join(run, "attempts");
    await mkdir(attempts, { recursive: true, mode: 0o700 });
    let attemptsIdentity: DirectoryIdentity;
    try {
      attemptsIdentity = await directoryIdentity(attempts);
    } catch (error) {
      throw new AttemptWorkspaceError(
        "attempt_workspace_unverifiable",
        "Managed attempts directory identity cannot be verified",
        "unverifiable",
        error,
      );
    }
    const runIdentity = await directoryIdentity(run);
    if (!isContained(runIdentity.realPath, attemptsIdentity.realPath)) {
      throw new Error("Managed attempts directory escapes its run");
    }
    const common = await realpath(await this.git.commonGitDirectory(canonical));
    return { run, canonical, attempts, attemptsIdentity, runId, common, head: project.headCommit };
  }

  private async attemptLockKey(project: ProjectRunRecord, attemptId: string): Promise<string> {
    assertComponent(attemptId, "attempt ID");
    const canonical = path.resolve(project.canonicalWorkspacePath);
    const run = path.dirname(canonical);
    const runs = path.dirname(run);
    if (path.basename(canonical) !== "canonical" || path.basename(runs) !== ".runs") {
      throw new Error("Project canonical workspace is outside a managed run directory");
    }
    const attempts = path.join(run, "attempts");
    let canonicalAttempts: string;
    try {
      canonicalAttempts = await realpath(attempts);
    } catch (error) {
      if (!isMissing(error)) throw error;
      canonicalAttempts = path.join(await realpath(run), "attempts");
    }
    return canonicalAttempts + "\0" + attemptId;
  }

  private ownedPath(paths: Paths, attempt: AttemptWorkspaceRecord): boolean {
    try {
      assertComponent(attempt.attemptId, "attempt ID");
      assertComponent(attempt.subtaskId, "subtask ID");
      assertCommit(attempt.baseCommit, "attempt base");
      return path.resolve(attempt.workspacePath) === this.workspacePath(paths, attempt.attemptId, attempt.revision);
    } catch {
      return false;
    }
  }

  private markerPath(paths: Paths, attemptId: string, revision: number): string {
    return path.join(paths.attempts, ".attempt-" + attemptId + "-r" + revision + ".json");
  }

  private async conflicted(workspace: string): Promise<boolean> {
    return (await this.git.run(workspace, ["diff", "--name-only", "--diff-filter=U"])).length > 0;
  }
}

async function writeDurableTemp(target: string, content: string): Promise<void> {
  const handle = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let failure: unknown;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    await unlink(target).catch(() => undefined);
    throw failure;
  }
}

async function syncDirectory(
  directory: string,
  expected: Pick<DirectoryIdentity, "dev" | "ino">,
): Promise<void> {
  const before = await directoryIdentity(directory);
  if (before.dev !== expected.dev || before.ino !== expected.ino) {
    throw unverifiable("Attempt parent changed before durable publication");
  }
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const held = await handle.stat();
    if (!held.isDirectory() || held.dev !== expected.dev || held.ino !== expected.ino) {
      throw unverifiable("Attempt parent handle identity changed");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function directoryIdentity(target: string): Promise<DirectoryIdentity> {
  const logical = await lstat(target);
  if (!logical.isDirectory() || logical.isSymbolicLink()) {
    throw unverifiable("Managed attempt boundary must be a real directory");
  }
  const resolvedPath = await realpath(target);
  const resolved = await lstat(resolvedPath);
  if (
    !resolved.isDirectory() ||
    resolved.isSymbolicLink() ||
    logical.dev !== resolved.dev ||
    logical.ino !== resolved.ino
  ) throw unverifiable("Managed attempt boundary identity cannot be verified");
  return {
    logicalPath: target,
    realPath: resolvedPath,
    dev: logical.dev,
    ino: logical.ino,
  };
}

async function presence(target: string): Promise<"missing" | "directory" | "invalid"> {
  try {
    const item = await lstat(target);
    return item.isDirectory() && !item.isSymbolicLink() ? "directory" : "invalid";
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
}

function isSidecar(value: unknown): value is AttemptSidecar {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const kind = item.kind === undefined || item.kind === "task" ? "task" : item.kind === "repair" ? "repair" : null;
  if (
    kind === null ||
    item.version !== 1 ||
    (item.state !== "creating" && item.state !== "ready") ||
    !isSafeComponent(item.runId) ||
    !isHex(item.sourceFingerprint, 64) ||
    !isSafeComponent(item.attemptId) ||
    !isPositiveInteger(item.revision) ||
    !isSafeComponent(item.subtaskId) ||
    !isHex(item.baseCommit, 40) ||
    !isHex(item.pathHash, 64) ||
    !isHex(item.commonHash, 64) ||
    typeof item.ownerToken !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(item.ownerToken)
  ) return false;
  if (kind === "task") {
    if (item.checkpointId != null) return false;
  } else if (
    !isSafeComponent(item.checkpointId) ||
    !isHex(item.checkpointHash, 40) ||
    !isHex(item.sourceOwnerFingerprint, 64)
  ) return false;
  return item.state === "creating" || (
    isNonNegativeInteger(item.attemptsDev) &&
    isNonNegativeInteger(item.attemptsIno) &&
    isNonNegativeInteger(item.workspaceDev) &&
    isNonNegativeInteger(item.workspaceIno)
  );
}

function sameOwnerSidecar(left: AttemptSidecar, right: AttemptSidecar): boolean {
  return left.state === right.state &&
    sameOwnerBinding(left, right) &&
    (left.state !== "ready" || right.state !== "ready" || (
      left.attemptsDev === right.attemptsDev &&
      left.attemptsIno === right.attemptsIno &&
      left.workspaceDev === right.workspaceDev &&
      left.workspaceIno === right.workspaceIno
    ));
}

function sameOwnerBinding(left: AttemptSidecar, right: AttemptSidecar): boolean {
  return left.version === right.version &&
    left.runId === right.runId &&
    left.sourceFingerprint === right.sourceFingerprint &&
    left.attemptId === right.attemptId &&
    left.revision === right.revision &&
    left.subtaskId === right.subtaskId &&
    left.baseCommit === right.baseCommit &&
    left.pathHash === right.pathHash &&
    left.commonHash === right.commonHash &&
    left.ownerToken === right.ownerToken &&
    (left.kind ?? "task") === (right.kind ?? "task") &&
    (left.checkpointId ?? null) === (right.checkpointId ?? null);
}

function readyIdentityMatches(
  marker: ReadySidecar,
  inspection: Extract<WorkspaceInspection, { state: "exact" }>,
): boolean {
  return marker.attemptsDev === inspection.parent.dev &&
    marker.attemptsIno === inspection.parent.ino &&
    marker.workspaceDev === inspection.workspace.dev &&
    marker.workspaceIno === inspection.workspace.ino;
}

function attemptRecord(
  input: AttemptCreateInput,
  workspacePath: string,
  ownerToken: string,
): AttemptWorkspaceRecord {
  return {
    attemptId: input.attemptId,
    revision: input.revision,
    ownerToken,
    subtaskId: input.subtaskId,
    baseCommit: input.baseCommit,
    workspacePath,
    state: "running",
    cleanup: "active",
    headCommit: input.expectedHead,
    reason: null,
    kind: input.kind,
    checkpointId: input.checkpointId,
  };
}

function hasExactMember(project: ProjectRunRecord, attempt: AttemptWorkspaceRecord): boolean {
  return project.attempts.some((item) =>
    item.attemptId === attempt.attemptId &&
    item.revision === attempt.revision &&
    item.ownerToken === attempt.ownerToken &&
    item.subtaskId === attempt.subtaskId &&
    item.baseCommit === attempt.baseCommit &&
    item.workspacePath === attempt.workspacePath &&
    item.state === attempt.state &&
    item.headCommit === attempt.headCommit &&
    item.cleanup === attempt.cleanup
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function preserved(attemptId: string, reason: PreservationReason): AttemptRecovery {
  return { action: "preserved", attemptId, reason };
}

function conflictFor(reason: PreservationReason, message: string, cause?: unknown): AttemptWorkspaceError {
  return new AttemptWorkspaceError(
    reason === "unverifiable" ? "attempt_workspace_unverifiable" : "attempt_workspace_conflict",
    message,
    reason,
    cause,
  );
}

function unverifiable(message: string, cause?: unknown): AttemptWorkspaceError {
  return new AttemptWorkspaceError("attempt_workspace_unverifiable", message, "unverifiable", cause);
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.realPath === right.realPath && left.dev === right.dev && left.ino === right.ino;
}

function isContained(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function assertComponent(value: string, label: string): void {
  if (!isSafeComponent(value)) throw new Error(label + " must be a safe slug or UUID component");
}

function isSafeComponent(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function assertCommit(value: string, label: string): void {
  if (!isHex(value, 40)) throw new Error(label + " must be a resolved 40-character commit");
}

function isHex(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "i").test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
