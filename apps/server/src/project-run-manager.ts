import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitClient } from "./git-client.js";
import type {
  CanonicalWorkspaceAuthority,
  ProjectRunRecord,
  WorkspaceSourceRequest,
} from "./types.js";

export type ProjectPreflightErrorCode =
  | "workspace_source_outside_allowed_roots"
  | "workspace_source_dirty"
  | "workspace_source_not_git_repository"
  | "workspace_source_invalid_revision"
  | "workspace_source_duplicate_run"
  | "workspace_source_invalid_run_id"
  | "workspace_source_invalid_project_name"
  | "workspace_source_git_common_dir_outside_allowed_roots"
  | "workspace_source_changed"
  | "workspace_source_preparation_failed"
  | "workspace_source_cleanup_failed";

export class ProjectPreflightError extends Error {
  readonly name = "ProjectPreflightError";
  readonly cause?: unknown;
  readonly details: Readonly<Record<string, string>> | undefined;
  readonly cleanupCause?: unknown;

  constructor(
    readonly code: ProjectPreflightErrorCode,
    message: string,
    cause?: unknown,
    details?: Readonly<Record<string, string>>,
    cleanupCause?: unknown,
  ) {
    super(message);
    this.details = sanitizePreflightDetails(details);
    Object.defineProperty(this, "cause", {
      value: cause,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(this, "cleanupCause", {
      value: cleanupCause,
      enumerable: false,
      configurable: true,
    });
  }
}

function sanitizePreflightDetails(
  details: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!details) return undefined;
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ? key : "detail",
      /^[A-Za-z0-9_.:-]{1,120}$/.test(value) ? value : "redacted",
    ]),
  );
}

export interface DirectoryIdentity {
  readonly path: string;
  readonly realPath: string;
  readonly dev: number;
  readonly ino: number;
}

interface RunReservation {
  readonly ownerToken: string;
  readonly candidatePath: string;
  readonly markerPath: string;
  readonly markerToken: string;
  runDirectory?: DirectoryIdentity;
  openedDirectory: OpenRunDirectory | null;
  markerWritten: boolean;
  readonly runsDirectory: DirectoryIdentity;
  readonly workspaceDirectory: DirectoryIdentity;
  state: "initializing" | "ready";
}

export interface OpenRunDirectory {
  readonly identity: DirectoryIdentity;
  stat(): Promise<{ readonly dev: number; readonly ino: number; isDirectory(): boolean }>;
  close(): Promise<void>;
}

/** @internal Minimal file-handle surface used to deterministically test close failures. */
export interface RunDirectoryHandle {
  stat(): Promise<{ readonly dev: number; readonly ino: number; isDirectory(): boolean }>;
  close(): Promise<void>;
}

interface ExistingRepository {
  readonly repositoryRoot: string;
  readonly repositoryDirectory: DirectoryIdentity;
  readonly commonDirectory: DirectoryIdentity;
  readonly allowedRoots: readonly string[];
}

interface WorktreeRegistration {
  readonly repository: ExistingRepository;
  readonly canonicalWorkspacePath: string;
  readonly runBranch: string;
  readonly branchCommit: string;
}

interface PreparedOwnership {
  readonly ownerToken: string;
  readonly record: ProjectRunRecord;
  readonly reservation: RunReservation;
  readonly registration?: WorktreeRegistration;
}

/** @internal Deterministic, non-reentrant test fault hooks. Do not wire these to request input. */
export interface ProjectRunManagerHooks {
  afterReservationCreated?(): Promise<void>;
  beforeRunDirectoryMkdirForTest?(): Promise<void>;
  beforeReservationPublishForTest?(): Promise<void>;
  afterRunDirectoryCreated?(): Promise<void>;
}

/** @internal Injectable reservation I/O used by deterministic fault tests. */
export interface ProjectRunManagerDependencies {
  openRunDirectory(directory: string): Promise<OpenRunDirectory>;
  writeReservationMarker(markerPath: string, markerToken: string): Promise<void>;
  finalizeRunDirectoryIdentity(directory: string, opened: OpenRunDirectory): Promise<DirectoryIdentity>;
}

/** @internal Real Node filesystem implementation; exported only so tests can wrap one operation. */
export const defaultProjectRunManagerDependencies: ProjectRunManagerDependencies = {
  openRunDirectory,
  writeReservationMarker,
  finalizeRunDirectoryIdentity,
};

class AsyncMutex {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((done) => (release = done));
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class ProjectRunManager {
  private readonly preparedRunOwners = new Map<string, string>();
  private readonly preparedOwnership = new Map<string, PreparedOwnership>();
  private peakPreparedOwnershipCount = 0;
  private readonly operationMutex = new AsyncMutex();
  private readonly dependencies: ProjectRunManagerDependencies;

  constructor(
    private readonly workspaceRoot: string,
    private readonly allowedSourceRoots: string[],
    private readonly git: GitClient,
    private readonly hooks: ProjectRunManagerHooks = {},
    dependencies: Partial<ProjectRunManagerDependencies> = {},
  ) {
    this.dependencies = { ...defaultProjectRunManagerDependencies, ...dependencies };
  }

  preflightRecord(runId: string, source: WorkspaceSourceRequest): ProjectRunRecord {
    return createProjectPreflightRecord(this.workspaceRoot, runId, source);
  }

  /** @internal Pull-only diagnostics for deterministic ownership-retention tests. */
  preparedOwnershipSnapshotForTest(): Readonly<{ current: number; peak: number }> {
    return Object.freeze({
      current: this.preparedOwnership.size,
      peak: this.peakPreparedOwnershipCount,
    });
  }

  async prepare(runId: string, source: WorkspaceSourceRequest): Promise<ProjectRunRecord> {
    if (!isSafeRunId(runId)) {
      throw new ProjectPreflightError("workspace_source_invalid_run_id", "Run id is not a valid Git branch suffix");
    }
    const ownerToken = randomUUID();
    if (this.preparedRunOwners.has(runId)) {
      throw new ProjectPreflightError("workspace_source_duplicate_run", "Run source has already been prepared");
    }
    this.preparedRunOwners.set(runId, ownerToken);
    return this.operationMutex.run(() => this.prepareOwned(runId, source, ownerToken));
  }

  async abortPrepared(runId: string): Promise<void> {
    await this.operationMutex.run(async () => {
      const ownership = this.preparedOwnership.get(runId);
      if (!ownership) return;
      const cleanupError = await this.cleanupFailedPreparation(
        ownership.reservation,
        ownership.registration,
      );
      if (cleanupError) {
        throw new ProjectPreflightError(
          "workspace_source_cleanup_failed",
          "Prepared project rollback could not safely complete",
          cleanupError.cause ?? cleanupError,
          {
            originalCode: "prepared_project_abort",
            cleanupCode: cleanupError.details?.cleanupCode ?? cleanupError.code,
          },
          cleanupError.cleanupCause,
        );
      }
      this.preparedOwnership.delete(runId);
      this.releaseRunOwner(runId, ownership.ownerToken);
    });
  }

  async acknowledgePrepared(runId: string, project: ProjectRunRecord): Promise<void> {
    await this.operationMutex.run(async () => {
      const ownership = this.preparedOwnership.get(runId);
      if (!ownership) return;
      if (
        ownership.record !== project ||
        this.preparedRunOwners.get(runId) !== ownership.ownerToken
      ) {
        throw new ProjectPreflightError(
          "workspace_source_changed",
          "Prepared project acknowledgement does not match its owner",
        );
      }
      this.preparedOwnership.delete(runId);
      this.releaseRunOwner(runId, ownership.ownerToken);
    });
  }

  private async prepareOwned(runId: string, source: WorkspaceSourceRequest, ownerToken: string): Promise<ProjectRunRecord> {
    let reservation: RunReservation | undefined;
    let registration: WorktreeRegistration | undefined;
    try {
      if (source.mode === "new_project" && !isSafeProjectName(source.projectName)) {
        throw new ProjectPreflightError("workspace_source_invalid_project_name", "Project name must be a bounded single line");
      }
      reservation = await this.reserveRunDirectory(runId, ownerToken, (created) => {
        reservation = created;
      });
      await this.hooks.afterReservationCreated?.();
      let record: ProjectRunRecord;
      if (source.mode === "ephemeral_research") {
        record = await this.prepareEphemeralResearch(runId, reservation);
      } else if (source.mode === "new_project") {
        record = await this.prepareNewProject(runId, source.projectName, reservation);
      } else {
        record = await this.prepareExistingRepository(runId, source, reservation, (created) => {
          registration = created;
        });
      }
      this.preparedOwnership.set(runId, {
        ownerToken,
        record,
        reservation,
        ...(registration === undefined ? {} : { registration }),
      });
      this.peakPreparedOwnershipCount = Math.max(
        this.peakPreparedOwnershipCount,
        this.preparedOwnership.size,
      );
      return record;
    } catch (error) {
      const original = asPreflightError(error);
      const cleanupError = await this.cleanupFailedPreparation(reservation, registration);
      this.releaseRunOwner(runId, ownerToken);
      if (cleanupError) {
        throw new ProjectPreflightError(
          "workspace_source_cleanup_failed",
          "Project source preparation failed and safe cleanup could not complete",
          original,
          {
            cleanupCode:
              cleanupError.details?.cleanupCode ?? cleanupError.code,
            originalCode: original.code,
          },
          cleanupError.cleanupCause ?? cleanupError.cause ?? cleanupError,
        );
      }
      throw original;
    }
  }

  private async reserveRunDirectory(
    runId: string,
    ownerToken: string,
    onCreated: (reservation: RunReservation) => void,
  ): Promise<RunReservation> {
    const workspaceDirectory = await establishPrivateDirectory(this.workspaceRoot);
    await assertPrivateDirectoryIdentity(workspaceDirectory);
    const runsDirectory = await establishPrivateDirectory(path.join(workspaceDirectory.realPath, ".runs"));
    if (!isContained(workspaceDirectory.realPath, runsDirectory.realPath)) {
      throw new ProjectPreflightError("workspace_source_preparation_failed", "Run workspace escapes the configured root");
    }
    const candidate = path.join(runsDirectory.realPath, runId);
    if (!isContained(runsDirectory.realPath, candidate)) {
      throw new ProjectPreflightError("workspace_source_invalid_run_id", "Run id escapes the workspace root");
    }
    await assertPrivateDirectoryIdentity(workspaceDirectory);
    await assertPrivateDirectoryIdentity(runsDirectory);
    await this.hooks.beforeRunDirectoryMkdirForTest?.();
    try {
      await mkdir(candidate, { mode: 0o700 });
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new ProjectPreflightError("workspace_source_duplicate_run", "Run source has already been prepared", error);
      }
      throw error;
    }
    const markerToken = randomUUID();
    // `mkdir` is the collision-safe publication step. Under the private-root and
    // manager-mutex trust boundary, publish this provisional record immediately
    // so any following I/O failure is cleaned by the outer preparation boundary.
    const reservation: RunReservation = {
      ownerToken,
      candidatePath: candidate,
      markerPath: path.join(candidate, ".launchpad-reservation"),
      markerToken,
      openedDirectory: null,
      markerWritten: false,
      runsDirectory,
      workspaceDirectory,
      state: "initializing",
    };
    onCreated(reservation);
    const opened = await this.dependencies.openRunDirectory(candidate);
    reservation.openedDirectory = opened;
    await this.dependencies.writeReservationMarker(reservation.markerPath, markerToken);
    await assertReservationMarker(reservation.markerPath, markerToken);
    reservation.markerWritten = true;
    await this.hooks.beforeReservationPublishForTest?.();
    const finalized = await this.dependencies.finalizeRunDirectoryIdentity(candidate, opened);
    if (!sameDirectoryObject(opened.identity, finalized)) {
      throw new ProjectPreflightError("workspace_source_preparation_failed", "Run directory changed during initialization");
    }
    reservation.runDirectory = finalized;
    reservation.state = "ready";
    await opened.close();
    reservation.openedDirectory = null;
    await this.hooks.afterRunDirectoryCreated?.();
    return reservation;
  }

  private releaseRunOwner(runId: string, ownerToken: string): void {
    if (this.preparedRunOwners.get(runId) === ownerToken) this.preparedRunOwners.delete(runId);
  }

  private async prepareExistingRepository(
    runId: string,
    source: Extract<WorkspaceSourceRequest, { mode: "existing_repository" }>,
    reservation: RunReservation,
    registered: (registration: WorktreeRegistration) => void,
  ): Promise<ProjectRunRecord> {
    const repository = await this.resolveExistingRepository(source.repositoryPath);
    if (!(await this.git.isClean(repository.repositoryRoot))) {
      throw new ProjectPreflightError("workspace_source_dirty", "Existing repository must be clean before a run starts");
    }
    let baseCommit: string;
    try {
      baseCommit = await this.git.resolveCommit(repository.repositoryRoot, source.revision);
    } catch (error) {
      throw new ProjectPreflightError("workspace_source_invalid_revision", "Requested revision cannot be resolved to a commit", error);
    }

    await assertPrivateDirectoryIdentity(reservation.workspaceDirectory);
    await assertPrivateDirectoryIdentity(reservation.runsDirectory);
    await assertPrivateDirectoryIdentity(requireReadyRunDirectory(reservation));
    const revalidated = await this.resolveExistingRepository(source.repositoryPath);
    if (
      repository.repositoryRoot !== revalidated.repositoryRoot ||
      !sameDirectory(repository.repositoryDirectory, revalidated.repositoryDirectory) ||
      !sameDirectory(repository.commonDirectory, revalidated.commonDirectory)
    ) {
      throw new ProjectPreflightError("workspace_source_changed", "Source repository changed during preflight");
    }
    if (!(await this.git.isClean(revalidated.repositoryRoot))) {
      throw new ProjectPreflightError("workspace_source_dirty", "Existing repository changed during preflight");
    }
    await assertDirectoryIdentity(revalidated.commonDirectory);
    const immediatelyBeforeWorktree = await this.resolveExistingRepository(source.repositoryPath);
    if (
      immediatelyBeforeWorktree.repositoryRoot !== revalidated.repositoryRoot ||
      !sameDirectory(immediatelyBeforeWorktree.repositoryDirectory, revalidated.repositoryDirectory) ||
      !sameDirectory(immediatelyBeforeWorktree.commonDirectory, revalidated.commonDirectory)
    ) {
      throw new ProjectPreflightError("workspace_source_changed", "Source repository changed before worktree registration");
    }

    const canonicalWorkspacePath = path.join(requireReadyRunDirectory(reservation).realPath, "canonical");
    const runBranch = "launchpad/run/" + runId;
    await this.git.worktreeAdd(immediatelyBeforeWorktree.repositoryRoot, canonicalWorkspacePath, baseCommit, runBranch);
    registered({ repository: revalidated, canonicalWorkspacePath, runBranch, branchCommit: baseCommit });
    const afterWorktree = await this.resolveExistingRepository(source.repositoryPath);
    if (
      afterWorktree.repositoryRoot !== revalidated.repositoryRoot ||
      !sameDirectory(afterWorktree.repositoryDirectory, revalidated.repositoryDirectory) ||
      !sameDirectory(afterWorktree.commonDirectory, revalidated.commonDirectory)
    ) {
      throw new ProjectPreflightError("workspace_source_changed", "Source repository changed during worktree registration");
    }
    const sourceFingerprint = await this.gitFingerprint(revalidated, baseCommit);
    const record = projectRecord({
      source: {
        mode: "existing_repository",
        repositoryPath: revalidated.repositoryRoot,
        requestedRevision: source.revision,
        baseCommit,
        sourceFingerprint,
      },
      runBranch,
      canonicalWorkspacePath,
      headCommit: baseCommit,
    });
    record.canonicalAuthority = await captureCanonicalWorkspaceAuthority(this.git, record);
    return record;
  }

  private async prepareNewProject(
    runId: string,
    projectName: string,
    reservation: RunReservation,
  ): Promise<ProjectRunRecord> {
    const runDirectory = requireReadyRunDirectory(reservation);
    await assertPrivateDirectoryIdentity(runDirectory);
    const canonicalWorkspacePath = path.join(runDirectory.realPath, "canonical");
    const runBranch = "launchpad/run/" + runId;
    await mkdir(canonicalWorkspacePath, { mode: 0o700 });
    await this.git.run(canonicalWorkspacePath, ["init", "-b", "seed"]);
    await writeFile(path.join(canonicalWorkspacePath, "README.md"), "# " + projectName + "\n", "utf8");
    await writeFile(path.join(canonicalWorkspacePath, ".gitignore"), "node_modules/\n", "utf8");
    await this.git.run(canonicalWorkspacePath, ["add", "--", "README.md", ".gitignore"]);
    await this.git.run(canonicalWorkspacePath, ["commit", "-m", "Seed project"]);
    const baseCommit = await this.git.head(canonicalWorkspacePath);
    await this.git.run(canonicalWorkspacePath, ["checkout", "-b", runBranch, baseCommit]);
    const sourceFingerprint = await this.gitFingerprint(
      {
        repositoryRoot: canonicalWorkspacePath,
        repositoryDirectory: await directoryIdentity(canonicalWorkspacePath),
        commonDirectory: await directoryIdentity(await gitCommonDirectory(this.git, canonicalWorkspacePath)),
        allowedRoots: [],
      },
      baseCommit,
    );
    const record = projectRecord({
      source: {
        mode: "new_project",
        repositoryPath: canonicalWorkspacePath,
        requestedRevision: "seed",
        baseCommit,
        sourceFingerprint,
      },
      runBranch,
      canonicalWorkspacePath,
      headCommit: baseCommit,
    });
    record.canonicalAuthority = await captureCanonicalWorkspaceAuthority(this.git, record);
    return record;
  }

  private async prepareEphemeralResearch(runId: string, reservation: RunReservation): Promise<ProjectRunRecord> {
    const runDirectory = requireReadyRunDirectory(reservation);
    await assertPrivateDirectoryIdentity(runDirectory);
    const canonicalWorkspacePath = path.join(runDirectory.realPath, "research");
    await mkdir(canonicalWorkspacePath, { mode: 0o700 });
    return projectRecord({
      source: {
        mode: "ephemeral_research",
        repositoryPath: null,
        requestedRevision: null,
        baseCommit: null,
        sourceFingerprint: sha256("ephemeral_research\0" + runId),
      },
      runBranch: null,
      canonicalWorkspacePath,
      headCommit: null,
    });
  }

  private async resolveExistingRepository(candidatePath: string): Promise<ExistingRepository> {
    let candidateRoot: string;
    try {
      candidateRoot = await realpath(candidatePath);
    } catch (error) {
      throw new ProjectPreflightError("workspace_source_not_git_repository", "Existing source path does not exist", error);
    }
    const allowedRoots = (await Promise.all(this.allowedSourceRoots.map(resolveExistingPath))).filter(
      (root): root is string => root !== null,
    );
    if (!isAllowed(allowedRoots, candidateRoot)) {
      throw new ProjectPreflightError("workspace_source_outside_allowed_roots", "Existing source is outside the configured allowed roots");
    }
    let repositoryRoot: string;
    try {
      repositoryRoot = await realpath(await this.git.run(candidateRoot, ["rev-parse", "--show-toplevel"]));
    } catch (error) {
      throw new ProjectPreflightError("workspace_source_not_git_repository", "Existing source is not a Git repository", error);
    }
    if (!isAllowed(allowedRoots, repositoryRoot)) {
      throw new ProjectPreflightError("workspace_source_outside_allowed_roots", "Existing repository is outside the configured allowed roots");
    }
    let commonDirectory: DirectoryIdentity;
    try {
      commonDirectory = await directoryIdentity(await gitCommonDirectory(this.git, repositoryRoot));
    } catch (error) {
      throw new ProjectPreflightError("workspace_source_not_git_repository", "Git common directory cannot be resolved", error);
    }
    if (!isAllowed(allowedRoots, commonDirectory.realPath)) {
      throw new ProjectPreflightError(
        "workspace_source_git_common_dir_outside_allowed_roots",
        "Git common directory is outside the configured allowed roots",
      );
    }
    return { repositoryRoot, repositoryDirectory: await directoryIdentity(repositoryRoot), commonDirectory, allowedRoots };
  }

  private async gitFingerprint(repository: ExistingRepository, baseCommit: string): Promise<string> {
    await assertDirectoryIdentity(repository.commonDirectory);
    const gitVersion = await this.git.run(repository.repositoryRoot, ["--version"]);
    return sha256(repository.commonDirectory.realPath + "\0" + baseCommit + "\0" + gitVersion);
  }

  private async cleanupFailedPreparation(
    reservation: RunReservation | undefined,
    registration: WorktreeRegistration | undefined,
  ): Promise<ProjectPreflightError | null> {
    if (!reservation) return null;
    try {
      await assertPrivateDirectoryIdentity(reservation.workspaceDirectory);
      await assertPrivateDirectoryIdentity(reservation.runsDirectory);
      if (reservation.runDirectory) await assertDirectoryIdentity(reservation.runDirectory);
      if (registration) {
        const revalidated = await this.resolveExistingRepository(registration.repository.repositoryRoot);
        if (
          revalidated.repositoryRoot !== registration.repository.repositoryRoot ||
          !sameDirectory(revalidated.commonDirectory, registration.repository.commonDirectory)
        ) {
          throw new ProjectPreflightError("workspace_source_changed", "Source repository changed before cleanup");
        }
        await this.git.worktreeRemove(registration.repository.repositoryRoot, registration.canonicalWorkspacePath);
        await this.git.branchDeleteIfAt(
          registration.repository.repositoryRoot,
          registration.runBranch,
          registration.branchCommit,
        );
      }
      await quarantineAndRemove(reservation);
      return null;
    } catch (error) {
      return asPreflightError(error);
    }
  }
}

function projectRecord(input: Pick<ProjectRunRecord, "source" | "runBranch" | "canonicalWorkspacePath" | "headCommit">): ProjectRunRecord {
  return { ...input, state: "ready", attempts: [], integrations: [] };
}

export async function captureCanonicalWorkspaceAuthority(
  git: GitClient,
  project: ProjectRunRecord,
): Promise<CanonicalWorkspaceAuthority> {
  if (!project.runBranch || project.source.mode === "ephemeral_research") {
    throw new Error("canonical_workspace_authority_unavailable");
  }
  const workspace = await directoryIdentity(project.canonicalWorkspacePath);
  const common = await directoryIdentity(await gitCommonDirectory(git, project.canonicalWorkspacePath));
  const branch = await git.run(project.canonicalWorkspacePath, ["branch", "--show-current"]);
  if (branch !== project.runBranch) throw new Error("canonical_workspace_branch_mismatch");
  return {
    workspaceRealPath: workspace.realPath,
    workspaceDev: workspace.dev,
    workspaceIno: workspace.ino,
    gitCommonRealPath: common.realPath,
    gitCommonDev: common.dev,
    gitCommonIno: common.ino,
    runBranch: branch,
  };
}

export async function assertCanonicalWorkspaceAuthority(
  git: GitClient,
  project: ProjectRunRecord,
  expectedHead?: string,
): Promise<void> {
  const authority = project.canonicalAuthority;
  if (!authority || !project.runBranch || authority.runBranch !== project.runBranch) {
    throw new Error("canonical_workspace_authority_unavailable");
  }
  let current: CanonicalWorkspaceAuthority;
  try {
    current = await captureCanonicalWorkspaceAuthority(git, project);
  } catch (error) {
    throw new Error("canonical_workspace_identity_changed", { cause: error });
  }
  if (
    current.workspaceRealPath !== authority.workspaceRealPath ||
    current.workspaceDev !== authority.workspaceDev ||
    current.workspaceIno !== authority.workspaceIno ||
    current.gitCommonRealPath !== authority.gitCommonRealPath ||
    current.gitCommonDev !== authority.gitCommonDev ||
    current.gitCommonIno !== authority.gitCommonIno ||
    current.runBranch !== authority.runBranch
  ) throw new Error("canonical_workspace_identity_changed");
  if (expectedHead !== undefined && await git.head(project.canonicalWorkspacePath) !== expectedHead) {
    throw new Error("canonical_workspace_head_changed");
  }
}

export function createProjectPreflightRecord(
  workspaceRoot: string,
  runId: string,
  source: WorkspaceSourceRequest,
): ProjectRunRecord {
  const coding = source.mode !== "ephemeral_research";
  const canonicalWorkspacePath = path.resolve(
    workspaceRoot,
    ".runs",
    runId,
    coding ? "canonical" : "research",
  );
  const requestedEvidence =
    source.mode === "existing_repository"
      ? source.mode + "\0" + source.repositoryPath + "\0" + source.revision
      : source.mode === "new_project"
        ? source.mode + "\0" + source.projectName
        : source.mode;
  return {
    source: {
      mode: source.mode,
      repositoryPath:
        source.mode === "existing_repository" ? source.repositoryPath : null,
      requestedRevision:
        source.mode === "existing_repository" ? source.revision : null,
      baseCommit: null,
      sourceFingerprint: sha256("workspace_source_request\0" + requestedEvidence),
    },
    runBranch: coding ? "launchpad/run/" + runId : null,
    canonicalWorkspacePath,
    headCommit: null,
    state: "preflighting",
    attempts: [],
    integrations: [],
  };
}

async function establishPrivateDirectory(directory: string): Promise<DirectoryIdentity> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return privatizeDirectory(directory);
}

async function privatizeDirectory(directory: string): Promise<DirectoryIdentity> {
  const logical = await lstat(directory);
  if (!logical.isDirectory() || logical.isSymbolicLink()) {
    throw new ProjectPreflightError("workspace_source_preparation_failed", "Workspace boundary must be a real directory");
  }
  await chmod(directory, 0o700);
  return privateDirectoryIdentity(directory);
}

async function quarantineAndRemove(reservation: RunReservation): Promise<void> {
  let failure: unknown;
  let quarantinePath: string | undefined;
  try {
    await assertPrivateDirectoryIdentity(reservation.workspaceDirectory);
    await assertPrivateDirectoryIdentity(reservation.runsDirectory);
    quarantinePath = path.join(reservation.runsDirectory.realPath, ".quarantine-" + randomUUID());
    await rename(reservation.candidatePath, quarantinePath);

    const moved = await privateDirectoryIdentity(quarantinePath);
    const expected = reservation.runDirectory ?? reservation.openedDirectory?.identity;
    if (expected && !sameDirectoryObject(expected, moved)) {
      throw new ProjectPreflightError("workspace_source_cleanup_failed", "Quarantined run directory ownership changed before deletion");
    }
    if (reservation.openedDirectory) {
      const held = await reservation.openedDirectory.stat();
      if (!held.isDirectory() || held.dev !== moved.dev || held.ino !== moved.ino) {
        throw new ProjectPreflightError("workspace_source_cleanup_failed", "Held run directory identity changed before deletion");
      }
    }

    const marker = await reservationMarkerStatus(quarantinePath, reservation.markerToken);
    if (marker === "mismatch" || (reservation.markerWritten && marker !== "match")) {
      throw new ProjectPreflightError("workspace_source_cleanup_failed", "Run directory marker did not prove ownership");
    }
  } catch (error) {
    failure = error;
  }

  try {
    await reservation.openedDirectory?.close();
    reservation.openedDirectory = null;
  } catch (error) {
    failure = new ProjectPreflightError(
      "workspace_source_cleanup_failed",
      "Run workspace directory handle could not be closed",
      failure,
      { cleanupCode: "directory_handle_close_failed" },
      error,
    );
  }
  if (failure) throw failure;
  if (!quarantinePath) {
    throw new ProjectPreflightError("workspace_source_cleanup_failed", "Run directory was not quarantined");
  }
  await rm(quarantinePath, { recursive: true, force: false });
}

async function reservationMarkerStatus(directory: string, markerToken: string): Promise<"match" | "missing" | "mismatch"> {
  try {
    return (await readFile(path.join(directory, ".launchpad-reservation"), "utf8")) === markerToken + "\n"
      ? "match"
      : "mismatch";
  } catch (error) {
    if (isMissingPath(error)) return "missing";
    throw error;
  }
}

async function assertReservationMarker(markerPath: string, markerToken: string): Promise<void> {
  if ((await readFile(markerPath, "utf8")) !== markerToken + "\n") {
    throw new ProjectPreflightError("workspace_source_preparation_failed", "Run directory marker was not written as requested");
  }
}

function requireReadyRunDirectory(reservation: RunReservation): DirectoryIdentity {
  if (!reservation.runDirectory || reservation.state !== "ready") {
    throw new ProjectPreflightError("workspace_source_preparation_failed", "Run directory was not initialized");
  }
  return reservation.runDirectory;
}

export async function createOpenRunDirectory(
  directory: string,
  openHandle: () => Promise<RunDirectoryHandle> = () =>
    open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
): Promise<OpenRunDirectory> {
  const handle = await openHandle();
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) {
      throw new ProjectPreflightError("workspace_source_preparation_failed", "Run workspace must be a directory");
    }
    const logical = await lstat(directory);
    const resolvedPath = await realpath(directory);
    const resolved = await lstat(resolvedPath);
    if (
      logical.isSymbolicLink() ||
      !logical.isDirectory() ||
      resolved.isSymbolicLink() ||
      !resolved.isDirectory() ||
      info.dev !== resolved.dev ||
      info.ino !== resolved.ino
    ) {
      throw new ProjectPreflightError("workspace_source_preparation_failed", "Run workspace identity changed during initialization");
    }
    let closed = false;
    let closeAttempts = 0;
    let lastCloseError: unknown;
    return {
      identity: { path: directory, realPath: resolvedPath, dev: info.dev, ino: info.ino },
      stat: () => handle.stat(),
      close: async () => {
        if (closed) return;
        if (closeAttempts >= 2) throw lastCloseError;
        closeAttempts += 1;
        try {
          await handle.close();
          closed = true;
        } catch (error) {
          lastCloseError = error;
          throw error;
        }
      },
    };
  } catch (error) {
    const original = asPreflightError(error);
    const cleanupCause = await closeDirectoryHandle(handle);
    if (cleanupCause) {
      throw new ProjectPreflightError(
        "workspace_source_cleanup_failed",
        "Run workspace validation failed and its directory handle could not be closed",
        original.cause ?? original,
        {
          originalCode: original.code,
          cleanupCode: "directory_handle_close_failed",
        },
        cleanupCause,
      );
    }
    throw original;
  }
}

async function openRunDirectory(directory: string): Promise<OpenRunDirectory> {
  return createOpenRunDirectory(directory);
}

/** One cleanup attempt plus one idempotent retry; callers must not loop beyond it. */
async function closeDirectoryHandle(handle: RunDirectoryHandle): Promise<unknown | null> {
  try {
    await handle.close();
    return null;
  } catch {
    try {
      await handle.close();
      return null;
    } catch (retryError) {
      return retryError;
    }
  }
}

async function writeReservationMarker(markerPath: string, markerToken: string): Promise<void> {
  await writeFile(markerPath, markerToken + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function finalizeRunDirectoryIdentity(directory: string, opened: OpenRunDirectory): Promise<DirectoryIdentity> {
  const finalized = await privateDirectoryIdentity(directory);
  const held = await opened.stat();
  if (
    !held.isDirectory() ||
    held.dev !== opened.identity.dev ||
    held.ino !== opened.identity.ino ||
    !sameDirectoryObject(opened.identity, finalized)
  ) {
    throw new ProjectPreflightError("workspace_source_preparation_failed", "Run workspace identity changed during finalization");
  }
  return finalized;
}

async function directoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const logical = await lstat(directory);
  if (!logical.isDirectory() || logical.isSymbolicLink()) {
    throw new ProjectPreflightError("workspace_source_preparation_failed", "Workspace boundary must be a real directory");
  }
  const realPath = await realpath(directory);
  const resolved = await lstat(realPath);
  if (!resolved.isDirectory() || resolved.isSymbolicLink()) {
    throw new ProjectPreflightError("workspace_source_preparation_failed", "Workspace boundary must resolve to a directory");
  }
  return { path: directory, realPath, dev: resolved.dev, ino: resolved.ino };
}

async function privateDirectoryIdentity(directory: string): Promise<DirectoryIdentity> {
  const identity = await directoryIdentity(directory);
  const info = await lstat(identity.realPath);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if ((uid !== null && info.uid !== uid) || (info.mode & 0o077) !== 0) {
    throw new ProjectPreflightError("workspace_source_preparation_failed", "Workspace boundary is not privately owned");
  }
  return identity;
}

async function assertDirectoryIdentity(expected: DirectoryIdentity): Promise<void> {
  const current = await directoryIdentity(expected.path);
  if (!sameDirectory(expected, current)) {
    throw new ProjectPreflightError("workspace_source_preparation_failed", "Workspace path ownership changed during preparation");
  }
}

async function assertPrivateDirectoryIdentity(expected: DirectoryIdentity): Promise<void> {
  const current = await privateDirectoryIdentity(expected.path);
  if (!sameDirectory(expected, current)) {
    throw new ProjectPreflightError("workspace_source_preparation_failed", "Workspace path ownership changed during preparation");
  }
}

async function gitCommonDirectory(git: GitClient, repositoryRoot: string): Promise<string> {
  return realpath(await git.run(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
}

async function resolveExistingPath(directory: string): Promise<string | null> {
  try {
    return await realpath(directory);
  } catch {
    return null;
  }
}

function asPreflightError(error: unknown): ProjectPreflightError {
  if (error instanceof ProjectPreflightError) return error;
  return new ProjectPreflightError("workspace_source_preparation_failed", "Unable to prepare the project source", error);
}

function isAllowed(allowedRoots: readonly string[], candidate: string): boolean {
  return allowedRoots.some((allowedRoot) => isContained(allowedRoot, candidate));
}

function isContained(allowedRoot: string, candidateRoot: string): boolean {
  const relative = path.relative(allowedRoot, candidateRoot);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.realPath === right.realPath && left.dev === right.dev && left.ino === right.ino;
}

function sameDirectoryObject(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isSafeRunId(runId: string): boolean {
  return (
    runId.length > 0 &&
    runId.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) &&
    !runId.includes("..") &&
    !runId.endsWith(".") &&
    !runId.endsWith(".lock")
  );
}

function isSafeProjectName(projectName: string): boolean {
  return projectName.length > 0 && projectName.length <= 120 && !/[\r\n]/.test(projectName);
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
