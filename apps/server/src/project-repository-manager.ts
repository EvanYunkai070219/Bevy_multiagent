import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitClient } from "./git-client.js";

export interface ProjectRepositoryIdentity {
  repositoryRealPath: string;
  gitCommonRealPath: string;
  gitCommonDev: number;
  gitCommonIno: number;
}

export interface PreparedProjectRepository {
  repositoryPath: string;
  identity: ProjectRepositoryIdentity;
  baseCommit: string;
}

const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOLVED_COMMIT = /^[0-9a-f]{40}$/;
const MANAGED_PROJECTS_DIRECTORY = "managed-projects";
const LEGACY_MANAGED_PROJECTS_DIRECTORY = "projects";

export class ProjectRepositoryManager {
  constructor(
    private readonly workspaceRoot: string,
    private readonly workspaceSourceRoots: readonly string[],
    private readonly git: GitClient,
  ) {}

  async createManaged(projectId: string, displayName: string): Promise<PreparedProjectRepository> {
    assertProjectId(projectId);
    assertDisplayName(displayName);
    const projectsRoot = await this.ensureProjectsRoot();
    const staging = await mkdtemp(path.join(projectsRoot, ".creating-"));
    let published: string | undefined;
    try {
      if (!isContained(projectsRoot, staging)) {
        throw new Error("Managed project staging directory escaped the projects root");
      }
      await this.writeSeedRepository(staging, displayName);
      await fsyncDirectory(staging);
      await fsyncDirectory(path.join(staging, ".git"));
      published = await this.publishManagedRepository(projectsRoot, staging, displayName);
      const identity = await this.captureIdentity(published);
      const baseCommit = await this.git.head(published);
      if (!RESOLVED_COMMIT.test(baseCommit) || !(await this.git.isClean(published))) {
        throw new Error("Managed project repository is not a clean seed");
      }
      return { repositoryPath: published, identity, baseCommit };
    } catch (error) {
      if (published) {
        await rm(published, { recursive: true, force: true }).catch(() => undefined);
      } else {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  async inspectIdentity(repositoryPath: string): Promise<ProjectRepositoryIdentity> {
    return this.captureIdentity(await realpath(repositoryPath));
  }

  async removeOwnedManaged(
    repositoryPath: string,
    expected: ProjectRepositoryIdentity,
  ): Promise<boolean> {
    const projectsRoot = await this.ensureProjectsRoot();
    const legacyProjectsRoot = await this.legacyProjectsRoot();
    let current: ProjectRepositoryIdentity;
    try {
      current = await this.inspectIdentity(repositoryPath);
    } catch {
      return false;
    }
    if (!sameIdentity(current, expected)) return false;
    if (
      !isContained(projectsRoot, current.repositoryRealPath) &&
      !(legacyProjectsRoot && isContained(legacyProjectsRoot, current.repositoryRealPath))
    ) return false;
    await rm(current.repositoryRealPath, { recursive: true, force: true });
    return true;
  }

  async openExternal(repositoryPath: string, revision: string): Promise<PreparedProjectRepository> {
    const before = await this.resolveExternal(repositoryPath);
    const beforeState = await this.sourceState(before.repositoryRealPath);
    if (beforeState.status.length > 0) {
      throw new Error("Existing repository must be clean");
    }
    let baseCommit: string;
    try {
      baseCommit = await this.git.resolveCommit(before.repositoryRealPath, revision);
    } catch (error) {
      throw new Error("Requested revision cannot be resolved to a commit", { cause: error });
    }
    if (!RESOLVED_COMMIT.test(baseCommit)) {
      throw new Error("Resolved revision is not a 40-character commit");
    }
    const after = await this.resolveExternal(repositoryPath);
    if (!sameIdentity(before, after)) {
      throw new Error("Source repository identity changed during open");
    }
    const afterState = await this.sourceState(after.repositoryRealPath);
    if (
      afterState.head !== beforeState.head ||
      afterState.status !== beforeState.status ||
      afterState.refs !== beforeState.refs
    ) {
      throw new Error("Opening an external repository mutated source Git state");
    }
    return {
      repositoryPath: after.repositoryRealPath,
      identity: after,
      baseCommit,
    };
  }

  async ensureBaseline(repositoryPath: string, projectId: string, commit: string): Promise<string> {
    assertProjectId(projectId);
    const branch = "launchpad/project/" + projectId;
    await this.git.createBranchIfMissingAt(repositoryPath, branch, commit);
    return branch;
  }

  async compareAndSwapBaseline(
    repositoryPath: string,
    branch: string,
    expected: string,
    next: string,
  ): Promise<void> {
    await this.git.updateBranchIfAt(repositoryPath, branch, expected, next);
  }

  private async ensureProjectsRoot(): Promise<string> {
    const workspaceRoot = path.resolve(this.workspaceRoot);
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    const projects = path.join(await realpath(workspaceRoot), MANAGED_PROJECTS_DIRECTORY);
    await mkdir(projects, { recursive: true, mode: 0o700 });
    const projectsRoot = await realpath(projects);
    if (!isContained(await realpath(workspaceRoot), projectsRoot)) {
      throw new Error("Managed projects directory escaped the workspace root");
    }
    return projectsRoot;
  }

  private async legacyProjectsRoot(): Promise<string | null> {
    const workspaceRoot = path.resolve(this.workspaceRoot);
    let workspaceRealPath: string;
    try {
      workspaceRealPath = await realpath(workspaceRoot);
    } catch {
      return null;
    }
    try {
      const legacy = await realpath(path.join(workspaceRealPath, LEGACY_MANAGED_PROJECTS_DIRECTORY));
      return isContained(workspaceRealPath, legacy) ? legacy : null;
    } catch {
      return null;
    }
  }

  private async writeSeedRepository(staging: string, displayName: string): Promise<void> {
    await this.git.run(staging, ["init", "-b", "seed"]);
    await writeFile(path.join(staging, "README.md"), "# " + displayName + "\n", "utf8");
    await writeFile(path.join(staging, ".gitignore"), "node_modules/\n", "utf8");
    await this.git.run(staging, ["add", "--", "README.md", ".gitignore"]);
    await this.git.run(staging, ["commit", "-m", "Seed project"]);
  }

  private async publishManagedRepository(
    projectsRoot: string,
    staging: string,
    displayName: string,
  ): Promise<string> {
    const baseSlug = collisionSafeSlug(displayName);
    for (let attempt = 1; attempt <= 64; attempt += 1) {
      const slug = attempt === 1 ? baseSlug : baseSlug + "-" + attempt;
      const target = path.join(projectsRoot, slug);
      if (!isContained(projectsRoot, target) || slug.startsWith(".")) {
        throw new Error("Managed project slug escapes the projects root");
      }
      try {
        await rename(staging, target);
        await fsyncDirectory(projectsRoot);
        return target;
      } catch (error) {
        if (!isOccupiedSlug(error)) throw error;
      }
    }
    throw new Error("Unable to publish a collision-safe managed project slug");
  }

  private async resolveExternal(candidatePath: string): Promise<ProjectRepositoryIdentity> {
    let candidateRoot: string;
    try {
      candidateRoot = await realpath(candidatePath);
    } catch (error) {
      throw new Error("Existing source path does not exist", { cause: error });
    }
    const allowedRoots = (await Promise.all(this.workspaceSourceRoots.map(resolveExistingPath))).filter(
      (root): root is string => root !== null,
    );
    if (!isAllowed(allowedRoots, candidateRoot)) {
      throw new Error("Existing source is outside the configured allowed roots");
    }
    let repositoryRoot: string;
    try {
      repositoryRoot = await realpath(await this.git.run(candidateRoot, ["rev-parse", "--show-toplevel"]));
    } catch (error) {
      throw new Error("Existing source is not a Git repository", { cause: error });
    }
    if (!isAllowed(allowedRoots, repositoryRoot)) {
      throw new Error("Existing repository is outside the configured allowed roots");
    }
    return this.captureIdentity(repositoryRoot, allowedRoots);
  }

  private async captureIdentity(
    repositoryRoot: string,
    allowedRoots?: readonly string[],
  ): Promise<ProjectRepositoryIdentity> {
    const repositoryRealPath = await realpath(repositoryRoot);
    const gitCommonRealPath = await this.gitCommonIdentityPath(repositoryRealPath);
    const common = await lstat(gitCommonRealPath);
    if (common.isSymbolicLink() || (!common.isDirectory() && !common.isFile())) {
      throw new Error("Git common directory cannot be resolved");
    }
    if (allowedRoots && !isAllowed(allowedRoots, gitCommonRealPath)) {
      throw new Error("Git common directory is outside the configured allowed roots");
    }
    return {
      repositoryRealPath,
      gitCommonRealPath,
      gitCommonDev: common.dev,
      gitCommonIno: common.ino,
    };
  }

  private async gitCommonIdentityPath(repositoryRoot: string): Promise<string> {
    return realpath(await this.git.commonGitDirectory(repositoryRoot));
  }

  private async sourceState(repositoryRoot: string): Promise<{ head: string; status: string; refs: string }> {
    const [head, status, refs] = await Promise.all([
      this.git.head(repositoryRoot),
      this.git.run(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
      this.git.run(repositoryRoot, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    ]);
    return { head, status, refs };
  }
}

function collisionSafeSlug(displayName: string): string {
  const slug = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "project";
}

function assertProjectId(projectId: string): void {
  if (!PROJECT_ID.test(projectId)) {
    throw new Error("Project id must be a UUID");
  }
}

function assertDisplayName(displayName: string): void {
  if (displayName.length === 0 || displayName.length > 120 || /[\r\n]/.test(displayName)) {
    throw new Error("Project display name is invalid");
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function resolveExistingPath(directory: string): Promise<string | null> {
  try {
    return await realpath(directory);
  } catch {
    return null;
  }
}

function isAllowed(allowedRoots: readonly string[], candidate: string): boolean {
  return allowedRoots.some((allowedRoot) => isContained(allowedRoot, candidate));
}

function isContained(allowedRoot: string, candidateRoot: string): boolean {
  const relative = path.relative(allowedRoot, candidateRoot);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function sameIdentity(left: ProjectRepositoryIdentity, right: ProjectRepositoryIdentity): boolean {
  return (
    left.repositoryRealPath === right.repositoryRealPath &&
    left.gitCommonRealPath === right.gitCommonRealPath &&
    left.gitCommonDev === right.gitCommonDev &&
    left.gitCommonIno === right.gitCommonIno
  );
}

function isOccupiedSlug(error: unknown): error is NodeJS.ErrnoException {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
}
