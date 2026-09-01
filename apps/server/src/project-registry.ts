import { randomUUID } from "node:crypto";
import { GitClient } from "./git-client.js";
import {
  ProjectRepositoryManager,
  type ProjectRepositoryIdentity,
} from "./project-repository-manager.js";
import { JsonStore } from "./store.js";
import type {
  AgentRun,
  IntegrationRecord,
  ProjectBaselineTransition,
  ProjectRecord,
  WorkspaceSourceRequest,
} from "./types.js";

const now = () => new Date().toISOString();
const RESOLVED_COMMIT = /^[0-9a-f]{40}$/;

export class BaselineAdvanceError extends Error {
  readonly name = "BaselineAdvanceError";
  constructor(message: string) {
    super(message);
  }
}

export class ProjectUnavailableError extends Error {
  readonly name = "ProjectUnavailableError";
  readonly code: "project_identity_mismatch" | "project_repository_unavailable";

  constructor(
    code: "project_identity_mismatch" | "project_repository_unavailable",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

export class ProjectRenameError extends Error {
  readonly name = "ProjectRenameError";
  readonly code: "invalid_project_name" | "project_not_found";

  constructor(code: "invalid_project_name" | "project_not_found") {
    super(code);
    this.code = code;
  }
}

export function baselineCandidate(run: AgentRun): { expected: string; next: string } | null {
  if (!run.projectId) return null;
  if (run.status === "cancelled" || run.status === "failed") return null;
  if (run.orchestration?.outcome?.value !== "succeeded") return null;
  const project = run.project;
  if (!project) return null;
  const passed = project.integrations.filter(
    (record): record is IntegrationRecord & { canonicalHeadAfter: string } =>
      record.state === "integrated" &&
      record.structuralDecision === "passed" &&
      typeof record.canonicalHeadAfter === "string" &&
      RESOLVED_COMMIT.test(record.canonicalHeadAfter),
  );
  if (passed.length === 0) return null;
  const next = passed[passed.length - 1]!.canonicalHeadAfter;
  const expected = project.source.baseCommit;
  if (!expected || !RESOLVED_COMMIT.test(expected)) return null;
  if (project.headCommit !== next || next === expected) return null;
  return { expected, next };
}

export class ProjectRegistry {
  constructor(
    private readonly store: JsonStore,
    private readonly repositories: ProjectRepositoryManager,
    private readonly git: GitClient,
  ) {}

  list(): ProjectRecord[] {
    return this.store.snapshot().projects.map(publicProject);
  }

  get(projectId: string): ProjectRecord {
    const project = this.store.snapshot().projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error("Project not found");
    }
    return publicProject(project);
  }

  async rename(projectId: string, displayName: string): Promise<ProjectRecord> {
    const normalized = displayName.trim();
    if (normalized.length === 0 || normalized.length > 80 || /[\r\n]/u.test(normalized)) {
      throw new ProjectRenameError("invalid_project_name");
    }
    return this.store.mutate((database) => {
      const project = database.projects.find((item) => item.id === projectId);
      if (!project) throw new ProjectRenameError("project_not_found");
      project.displayName = normalized;
      project.updatedAt = now();
      return publicProject(project);
    });
  }

  async createManaged(input: { displayName: string }): Promise<ProjectRecord> {
    const id = randomUUID();
    const prepared = await this.repositories.createManaged(id, input.displayName);
    try {
      const baselineBranch = await this.repositories.ensureBaseline(
        prepared.repositoryPath,
        id,
        prepared.baseCommit,
      );
      return await this.persistNew("managed", id, input.displayName, prepared, baselineBranch);
    } catch (error) {
      if (!this.store.snapshot().projects.some((project) => project.id === id)) {
        await this.repositories
          .removeOwnedManaged(prepared.repositoryPath, prepared.identity)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async admit(projectId: string): Promise<ProjectRecord> {
    const project = this.store.snapshot().projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error("Project not found");
    }
    await this.recoverOneProject(project);
    const current = this.store.snapshot().projects.find((item) => item.id === projectId);
    if (!current) {
      throw new Error("Project not found");
    }
    if (current.state !== "ready") {
      throw new ProjectUnavailableError(
        current.lastError?.includes("identity")
          ? "project_identity_mismatch"
          : "project_repository_unavailable",
        current.lastError ?? "Project is unavailable",
      );
    }
    return publicProject(current);
  }

  async openExternal(input: {
    displayName: string;
    repositoryPath: string;
    revision: string;
  }): Promise<ProjectRecord> {
    const prepared = await this.inspectExternal(input.repositoryPath, input.revision);
    const existing = this.findByIdentity(prepared.identity);
    if (existing) return publicProject(existing);

    const id = randomUUID();
    return this.store.mutate((database) => {
      const duplicate = database.projects.find((project) =>
        sameProjectIdentity(project, prepared.identity),
      );
      if (duplicate) return publicProject(duplicate);
      const record = this.buildRecord(
        "external",
        id,
        input.displayName,
        prepared,
        "launchpad/project/" + id,
      );
      database.projects.push(record);
      return publicProject(record);
    });
  }

  async inspectExternal(repositoryPath: string, revision: string) {
    return this.repositories.openExternal(repositoryPath, revision);
  }

  /**
   * Forget a project, and delete a repository only when this system made it.
   *
   * An external project is a pointer at somebody's own checkout, so removing it
   * from the launchpad has to leave that checkout exactly where it was. Only a
   * managed repository is ours to delete, and `removeOwnedManaged` still
   * re-verifies the recorded git identity and containment inside the managed
   * root before removing anything -- a stored path on its own is not grounds to
   * delete a directory tree.
   *
   * The record goes first. If the removal then fails we have leaked a
   * directory, which is recoverable by hand; the other order leaves a listed
   * project pointing at a repository that is no longer there.
   */
  async delete(projectId: string): Promise<{ removedRepository: boolean }> {
    const project = this.store.snapshot().projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error("Project not found");
    }

    await this.store.mutate((database) => {
      database.projects = database.projects.filter((item) => item.id !== projectId);
    });

    if (project.sourceKind !== "managed") return { removedRepository: false };
    const removed = await this.repositories
      .removeOwnedManaged(project.repositoryPath, {
        repositoryRealPath: project.repositoryRealPath,
        gitCommonRealPath: project.gitCommonRealPath,
        gitCommonDev: project.gitCommonDev,
        gitCommonIno: project.gitCommonIno,
      })
      .catch(() => false);
    return { removedRepository: removed };
  }

  runSource(projectId: string): WorkspaceSourceRequest {
    const project = this.get(projectId);
    return {
      mode: "existing_repository",
      repositoryPath: project.repositoryPath,
      revision: project.baselineCommit,
    };
  }

  async advanceBaseline(input: {
    projectId: string;
    runId: string;
    expectedCommit: string;
    nextCommit: string;
  }): Promise<ProjectRecord> {
    const prepared = await this.prepareTransition(input);
    try {
      await this.repositories.ensureBaseline(
        prepared.repositoryPath,
        prepared.projectId,
        input.expectedCommit,
      );
      await this.repositories.compareAndSwapBaseline(
        prepared.repositoryPath,
        prepared.baselineBranch,
        input.expectedCommit,
        input.nextCommit,
      );
    } catch (error) {
      await this.clearPreparedTransition(input);
      throw error instanceof BaselineAdvanceError
        ? error
        : new BaselineAdvanceError(
            error instanceof Error ? error.message : "Project baseline compare-and-swap failed",
          );
    }
    return this.finalizeTransition(input);
  }

  async recoverBaselineTransitions(): Promise<void> {
    for (const project of this.store.snapshot().projects) {
      await this.recoverOneProject(project);
    }
  }

  private async recoverOneProject(project: ProjectRecord): Promise<void> {
    try {
      await this.assertCurrentIdentity(project);
      await this.git.head(project.repositoryPath);
      if (project.baselineTransition) {
        await this.recoverOneTransition(project);
      }
      const current = this.store.snapshot().projects.find((item) => item.id === project.id);
      if (current?.baselineTransition) return;
      await this.restoreReady(project.id);
    } catch (error) {
      const message =
        error instanceof ProjectUnavailableError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Project repository is unavailable";
      await this.markUnavailable(project.id, message);
    }
  }

  private async assertCurrentIdentity(project: ProjectRecord): Promise<void> {
    let current: ProjectRepositoryIdentity;
    try {
      current = await this.repositories.inspectIdentity(project.repositoryPath);
    } catch (error) {
      throw new ProjectUnavailableError(
        "project_repository_unavailable",
        error instanceof Error ? error.message : "Project repository is unavailable",
      );
    }
    if (!matchesStoredIdentity(project, current)) {
      throw new ProjectUnavailableError(
        "project_identity_mismatch",
        "Project repository identity no longer matches the registered Project",
      );
    }
  }

  private async restoreReady(projectId: string): Promise<void> {
    const existing = this.store.snapshot().projects.find((item) => item.id === projectId);
    if (!existing || existing.baselineTransition) return;
    if (existing.state === "ready" && existing.lastError === null) return;
    await this.store.mutate((database) => {
      const current = database.projects.find((item) => item.id === projectId);
      if (!current || current.baselineTransition) return;
      if (current.state === "ready" && current.lastError === null) return;
      current.state = "ready";
      current.lastError = null;
      current.updatedAt = now();
    });
  }

  private async markUnavailable(projectId: string, message: string): Promise<void> {
    await this.store.mutate((database) => {
      const current = database.projects.find((item) => item.id === projectId);
      if (!current) return;
      current.state = "unavailable";
      current.lastError = message;
      current.updatedAt = now();
    });
  }

  private async recoverOneTransition(project: ProjectRecord): Promise<void> {
    const transition = project.baselineTransition;
    if (!transition) return;
    const refCommit = await this.git.resolveCommit(project.repositoryPath, project.baselineBranch);
    if (refCommit === transition.nextCommit) {
      await this.finalizeTransition({
        projectId: project.id,
        runId: transition.runId,
        expectedCommit: transition.expectedCommit,
        nextCommit: transition.nextCommit,
      });
      return;
    }
    if (refCommit === transition.expectedCommit) {
      await this.clearPreparedTransition({
        projectId: project.id,
        runId: transition.runId,
        expectedCommit: transition.expectedCommit,
        nextCommit: transition.nextCommit,
      });
      return;
    }
    await this.store.mutate((database) => {
      const current = database.projects.find((item) => item.id === project.id);
      if (!current || !identicalTransition(current.baselineTransition, transition)) return;
      current.state = "unavailable";
      current.lastError = "Baseline ref diverged from the prepared transition";
      current.updatedAt = now();
    });
  }

  private async prepareTransition(input: {
    projectId: string;
    runId: string;
    expectedCommit: string;
    nextCommit: string;
  }): Promise<{
    projectId: string;
    repositoryPath: string;
    baselineBranch: string;
  }> {
    return this.store.mutate((database) => {
      const project = database.projects.find((item) => item.id === input.projectId);
      if (!project) throw new BaselineAdvanceError("Project not found");
      if (project.state !== "ready") throw new BaselineAdvanceError("Project is unavailable");
      if (project.baselineCommit !== input.expectedCommit) {
        throw new BaselineAdvanceError("Project baseline does not match the expected commit");
      }
      if (project.baselineTransition) {
        throw new BaselineAdvanceError("A baseline transition is already in progress");
      }
      if (input.expectedCommit === input.nextCommit) {
        throw new BaselineAdvanceError("Baseline next commit must differ from expected");
      }
      project.baselineTransition = {
        runId: input.runId,
        expectedCommit: input.expectedCommit,
        nextCommit: input.nextCommit,
        state: "prepared",
      };
      project.updatedAt = now();
      return {
        projectId: project.id,
        repositoryPath: project.repositoryPath,
        baselineBranch: project.baselineBranch,
      };
    });
  }

  private async finalizeTransition(input: {
    projectId: string;
    runId: string;
    expectedCommit: string;
    nextCommit: string;
  }): Promise<ProjectRecord> {
    return this.store.mutate((database) => {
      const project = database.projects.find((item) => item.id === input.projectId);
      if (!project) throw new BaselineAdvanceError("Project not found");
      const transition = project.baselineTransition;
      if (!identicalTransition(transition, {
        runId: input.runId,
        expectedCommit: input.expectedCommit,
        nextCommit: input.nextCommit,
        state: "prepared",
      })) {
        throw new BaselineAdvanceError("Baseline transition mismatch");
      }
      transition.state = "ref_updated";
      project.baselineCommit = input.nextCommit;
      delete project.baselineTransition;
      project.lastError = null;
      project.updatedAt = now();
      return publicProject(project);
    });
  }

  private async clearPreparedTransition(input: {
    projectId: string;
    runId: string;
    expectedCommit: string;
    nextCommit: string;
  }): Promise<void> {
    await this.store.mutate((database) => {
      const project = database.projects.find((item) => item.id === input.projectId);
      if (!identicalTransition(project?.baselineTransition, {
        runId: input.runId,
        expectedCommit: input.expectedCommit,
        nextCommit: input.nextCommit,
        state: "prepared",
      })) return;
      delete project!.baselineTransition;
      project!.updatedAt = now();
    });
  }

  private async persistNew(
    sourceKind: ProjectRecord["sourceKind"],
    id: string,
    displayName: string,
    prepared: Awaited<ReturnType<ProjectRepositoryManager["createManaged"]>>,
    baselineBranch: string,
  ): Promise<ProjectRecord> {
    const record = this.buildRecord(sourceKind, id, displayName, prepared, baselineBranch);
    await this.store.mutate((database) => {
      database.projects.push(record);
    });
    return publicProject(record);
  }

  private buildRecord(
    sourceKind: ProjectRecord["sourceKind"],
    id: string,
    displayName: string,
    prepared: Awaited<ReturnType<ProjectRepositoryManager["createManaged"]>>,
    baselineBranch: string,
  ): ProjectRecord {
    const timestamp = now();
    return {
      id,
      displayName,
      sourceKind,
      repositoryPath: prepared.repositoryPath,
      repositoryRealPath: prepared.identity.repositoryRealPath,
      gitCommonRealPath: prepared.identity.gitCommonRealPath,
      gitCommonDev: prepared.identity.gitCommonDev,
      gitCommonIno: prepared.identity.gitCommonIno,
      baselineBranch,
      baselineCommit: prepared.baseCommit,
      state: "ready",
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private findByIdentity(identity: ProjectRepositoryIdentity): ProjectRecord | undefined {
    return this.store.snapshot().projects.find((project) => sameProjectIdentity(project, identity));
  }
}

function identicalTransition(
  actual: ProjectBaselineTransition | undefined,
  expected: ProjectBaselineTransition,
): actual is ProjectBaselineTransition {
  return (
    actual !== undefined &&
    actual.runId === expected.runId &&
    actual.expectedCommit === expected.expectedCommit &&
    actual.nextCommit === expected.nextCommit &&
    actual.state === expected.state
  );
}

function publicProject(project: ProjectRecord): ProjectRecord {
  const copy = structuredClone(project);
  delete copy.baselineTransition;
  return copy;
}

function sameProjectIdentity(
  project: Pick<ProjectRecord, "gitCommonDev" | "gitCommonIno">,
  identity: Pick<ProjectRepositoryIdentity, "gitCommonDev" | "gitCommonIno">,
): boolean {
  return project.gitCommonDev === identity.gitCommonDev && project.gitCommonIno === identity.gitCommonIno;
}

function matchesStoredIdentity(
  project: Pick<
    ProjectRecord,
    "repositoryRealPath" | "gitCommonRealPath" | "gitCommonDev" | "gitCommonIno"
  >,
  identity: ProjectRepositoryIdentity,
): boolean {
  return (
    project.repositoryRealPath === identity.repositoryRealPath &&
    project.gitCommonRealPath === identity.gitCommonRealPath &&
    project.gitCommonDev === identity.gitCommonDev &&
    project.gitCommonIno === identity.gitCommonIno
  );
}

/**
 * Projects newest first, as a total order.
 *
 * Sorting on `createdAt` alone is not enough: two projects opened in the same
 * millisecond tie, and a stable sort then leaves them in insertion order --
 * oldest first -- so the head of a "newest first" list depended on clock
 * granularity. Reversing before the sort makes ties resolve by which was
 * actually recorded later, which is what "newest" means to whoever opened them.
 */
export function orderProjects<T extends { createdAt: string }>(projects: readonly T[]): T[] {
  return [...projects]
    .reverse()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
