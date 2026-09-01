import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient } from "../src/git-client.js";
import { baselineCandidate, orderProjects, ProjectRegistry } from "../src/project-registry.js";
import { ProjectRepositoryManager } from "../src/project-repository-manager.js";
import { JsonStore } from "../src/store.js";
import type {
  AgentRun,
  Database,
  IntegrationRecord,
  OrchestrationState,
  ProjectRunRecord,
  TaskOutcome,
} from "../src/types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function makeLinkedCloneFixture(git: GitClient): Promise<{
  allowedRoot: string;
  workspaceRoot: string;
  store: JsonStore;
  registry: ProjectRegistry;
  root: string;
  linked: string;
  clone: string;
}> {
  const fixtureRoot = await temporaryDirectory("launchpad-project-registry-");
  const allowedRoot = path.join(fixtureRoot, "allowed");
  const workspaceRoot = path.join(fixtureRoot, "workspaces");
  await mkdir(allowedRoot, { recursive: true });
  const origin = path.join(allowedRoot, "origin.git");
  const root = path.join(allowedRoot, "root");
  const clone = path.join(allowedRoot, "clone");
  const linked = path.join(allowedRoot, "linked");

  await git.run(allowedRoot, ["init", "-b", "main", "--bare", "--", origin]);
  await git.run(allowedRoot, ["clone", origin, root]);
  await writeFile(path.join(root, "README.md"), "initial\n", "utf8");
  await git.run(root, ["add", "--", "README.md"]);
  await git.run(root, ["commit", "-m", "initial"]);
  await git.run(root, ["push", "-u", "origin", "HEAD:main"]);
  await git.run(allowedRoot, ["clone", origin, clone]);
  await git.run(root, ["worktree", "add", "--detach", "--", linked, "HEAD"]);

  const store = new JsonStore(path.join(fixtureRoot, "db.json"));
  await store.initialize();
  const manager = new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git);
  const registry = new ProjectRegistry(store, manager, git);
  return { allowedRoot, workspaceRoot, store, registry, root, linked, clone };
}

describe("ProjectRegistry", () => {
  it("renames only project presentation metadata and survives a store reload", async () => {
    const git = new GitClient(5_000);
    const { allowedRoot, store, registry, workspaceRoot } = await makeLinkedCloneFixture(git);
    const project = await registry.createManaged({ displayName: "Before" });
    await store.mutate((database) => {
      database.projects[0]!.updatedAt = "2020-01-01T00:00:00.000Z";
    });
    const before = structuredClone(store.snapshot().projects[0]!);
    const checkout = await snapshotCheckout(git, project.repositoryPath);

    const renamed = await registry.rename(project.id, "  After  ");

    expect(renamed.displayName).toBe("After");
    expect(renamed.updatedAt).not.toBe(before.updatedAt);
    const persisted = store.snapshot().projects[0]!;
    expect({ ...persisted, displayName: before.displayName, updatedAt: before.updatedAt }).toEqual(before);
    expect(await snapshotCheckout(git, project.repositoryPath)).toEqual(checkout);

    const reloadedStore = new JsonStore(path.join(path.dirname(allowedRoot), "db.json"));
    await reloadedStore.initialize();
    const reloaded = new ProjectRegistry(
      reloadedStore,
      new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git),
      git,
    );
    expect(reloaded.get(project.id).displayName).toBe("After");
  });

  it("allows duplicate project display names", async () => {
    const git = new GitClient(5_000);
    const { registry } = await makeLinkedCloneFixture(git);
    const first = await registry.createManaged({ displayName: "Shared" });
    const second = await registry.createManaged({ displayName: "Other" });

    await expect(registry.rename(second.id, "Shared")).resolves.toMatchObject({
      id: second.id,
      displayName: "Shared",
    });
    expect(registry.get(first.id).displayName).toBe("Shared");
  });

  it("rejects an unknown project without mutating the store", async () => {
    const git = new GitClient(5_000);
    const { store, registry } = await makeLinkedCloneFixture(git);
    const project = await registry.createManaged({ displayName: "Known" });
    const before = store.snapshot();

    await expect(registry.rename("missing", "New name")).rejects.toMatchObject({
      name: "ProjectRenameError",
      code: "project_not_found",
    });
    expect(store.snapshot()).toEqual(before);
    expect(registry.get(project.id).displayName).toBe("Known");
  });

  it.each(["   ", "line\nbreak", "line\rbreak", "x".repeat(81)])(
    "rejects invalid project rename input without mutating: %j",
    async (displayName) => {
      const git = new GitClient(5_000);
      const { store, registry } = await makeLinkedCloneFixture(git);
      const project = await registry.createManaged({ displayName: "Known" });
      const before = store.snapshot();

      await expect(registry.rename(project.id, displayName)).rejects.toMatchObject({
        name: "ProjectRenameError",
        code: "invalid_project_name",
      });
      expect(store.snapshot()).toEqual(before);
    },
  );

  it("dedupes linked worktrees, leaves clones separate, and does not rename on reopen", async () => {
    const git = new GitClient(5_000);
    const { store, registry, root, linked, clone } = await makeLinkedCloneFixture(git);

    const first = await registry.openExternal({
      displayName: "CodeJam",
      repositoryPath: root,
      revision: "HEAD",
    });
    const second = await registry.openExternal({
      displayName: "Alias",
      repositoryPath: linked,
      revision: "HEAD",
    });
    expect(second.id).toBe(first.id);
    expect(store.snapshot().projects).toHaveLength(1);
    expect(registry.get(first.id).displayName).toBe("CodeJam");

    const cloned = await registry.openExternal({
      displayName: "Clone",
      repositoryPath: clone,
      revision: "HEAD",
    });
    expect(cloned.id).not.toBe(first.id);
    expect(store.snapshot().projects).toHaveLength(2);
  });

  it("deletes a managed project and the repository it created", async () => {
    const git = new GitClient(5_000);
    const { registry, store } = await makeLinkedCloneFixture(git);
    const project = await registry.createManaged({ displayName: "Disposable" });

    await expect(stat(project.repositoryPath)).resolves.toBeTruthy();
    expect(await registry.delete(project.id)).toEqual({ removedRepository: true });

    expect(registry.list()).toHaveLength(0);
    expect(store.snapshot().projects).toHaveLength(0);
    await expect(stat(project.repositoryPath)).rejects.toThrow();
  });

  it("deletes an external project without touching the operator's repository", async () => {
    const git = new GitClient(5_000);
    const { registry, root } = await makeLinkedCloneFixture(git);
    const project = await registry.openExternal({
      displayName: "CodeJam",
      repositoryPath: root,
      revision: "HEAD",
    });

    expect(await registry.delete(project.id)).toEqual({ removedRepository: false });

    expect(registry.list()).toHaveLength(0);
    // The whole point: opening somebody's checkout must not be a way to lose it.
    await expect(stat(path.join(root, "README.md"))).resolves.toBeTruthy();
    await expect(stat(path.join(root, ".git"))).resolves.toBeTruthy();
  });

  it("refuses to delete a project that is not there", async () => {
    const git = new GitClient(5_000);
    const { registry } = await makeLinkedCloneFixture(git);
    await expect(registry.delete("missing")).rejects.toThrow(/not found/i);
  });

  it("leaves the other projects alone", async () => {
    const git = new GitClient(5_000);
    const { registry } = await makeLinkedCloneFixture(git);
    const doomed = await registry.createManaged({ displayName: "Doomed" });
    const kept = await registry.createManaged({ displayName: "Kept" });

    await registry.delete(doomed.id);

    expect(registry.list().map((item) => item.id)).toEqual([kept.id]);
    await expect(stat(kept.repositoryPath)).resolves.toBeTruthy();
  });

  it("publishes collision-safe managed slugs", async () => {
    const git = new GitClient(5_000);
    const { registry } = await makeLinkedCloneFixture(git);

    const first = await registry.createManaged({ displayName: "Demo App" });
    const second = await registry.createManaged({ displayName: "Demo App" });

    expect(path.basename(first.repositoryPath)).toBe("demo-app");
    expect(path.basename(second.repositoryPath)).toBe("demo-app-2");
    expect(first.id).not.toBe(second.id);
    expect(registry.list()).toHaveLength(2);
  });

  it("returns immutable snapshots without baseline transition authority", async () => {
    const git = new GitClient(5_000);
    const { store, registry, root } = await makeLinkedCloneFixture(git);
    const created = await registry.openExternal({
      displayName: "CodeJam",
      repositoryPath: root,
      revision: "HEAD",
    });

    created.displayName = "mutated";
    created.state = "unavailable";
    const listed = registry.list();
    listed[0]!.displayName = "listed-mutation";
    expect(registry.get(created.id).displayName).toBe("CodeJam");
    expect(registry.get(created.id).state).toBe("ready");

    await store.mutate((database) => {
      database.projects[0]!.baselineTransition = {
        runId: "11111111-1111-4111-8111-111111111111",
        expectedCommit: database.projects[0]!.baselineCommit,
        nextCommit: "b".repeat(40),
        state: "prepared",
      };
    });
    expect(registry.get(created.id).baselineTransition).toBeUndefined();
    expect(registry.list()[0]?.baselineTransition).toBeUndefined();
    expect(store.snapshot().projects[0]?.baselineTransition?.state).toBe("prepared");
  });

  it("marks a missing repository unavailable without dropping the record", async () => {
    const git = new GitClient(5_000);
    const fixtureRoot = await temporaryDirectory("launchpad-project-unavailable-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspaces");
    const repository = path.join(allowedRoot, "solo");
    await mkdir(allowedRoot, { recursive: true });
    await git.run(allowedRoot, ["init", "-b", "main", "--", repository]);
    await writeFile(path.join(repository, "README.md"), "solo\n", "utf8");
    await git.run(repository, ["add", "--", "README.md"]);
    await git.run(repository, ["commit", "-m", "initial"]);

    const store = new JsonStore(path.join(fixtureRoot, "db.json"));
    await store.initialize();
    const registry = new ProjectRegistry(
      store,
      new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git),
      git,
    );
    const project = await registry.openExternal({
      displayName: "Solo",
      repositoryPath: repository,
      revision: "HEAD",
    });
    await rm(repository, { recursive: true, force: true });

    await registry.recoverBaselineTransitions();

    const recovered = registry.get(project.id);
    expect(recovered.state).toBe("unavailable");
    expect(recovered.lastError).not.toBeNull();
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.id).toBe(project.id);
  });

  it("derives runSource from the persisted baseline for managed and external projects", async () => {
    const git = new GitClient(5_000);
    const { registry, root } = await makeLinkedCloneFixture(git);

    const managed = await registry.createManaged({ displayName: "Managed" });
    const external = await registry.openExternal({
      displayName: "CodeJam",
      repositoryPath: root,
      revision: "HEAD",
    });

    expect(registry.runSource(managed.id)).toEqual({
      mode: "existing_repository",
      repositoryPath: managed.repositoryPath,
      revision: managed.baselineCommit,
    });
    expect(registry.runSource(external.id)).toEqual({
      mode: "existing_repository",
      repositoryPath: external.repositoryPath,
      revision: external.baselineCommit,
    });
    expect(managed.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(external.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(path.basename(path.dirname(managed.repositoryPath))).toBe("managed-projects");
  });

  it("advances a managed baseline by exact CAS without touching checkout state", async () => {
    const git = new GitClient(5_000);
    const { registry } = await makeLinkedCloneFixture(git);
    const project = await registry.createManaged({ displayName: "Advance" });
    const before = await snapshotCheckout(git, project.repositoryPath);
    const next = await commitThenRestore(git, project.repositoryPath, "integrated.txt", "done\n");
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    await registry.advanceBaseline({
      projectId: project.id,
      runId,
      expectedCommit: project.baselineCommit,
      nextCommit: next,
    });

    expect(registry.get(project.id).baselineCommit).toBe(next);
    expect(await git.resolveCommit(project.repositoryPath, project.baselineBranch)).toBe(next);
    const after = await snapshotCheckout(git, project.repositoryPath);
    expect(after.head).toBe(before.head);
    expect(after.status).toBe(before.status);
    expect(after.branch).toBe(before.branch);
    expect(nonLaunchpadRefs(after.refs)).toBe(nonLaunchpadRefs(before.refs));
  });

  it("creates the missing Launchpad ref on an external Project before CAS", async () => {
    const git = new GitClient(5_000);
    const { registry, root } = await makeLinkedCloneFixture(git);
    const project = await registry.openExternal({
      displayName: "External",
      repositoryPath: root,
      revision: "HEAD",
    });
    const before = await snapshotCheckout(git, root);
    expect(before.refs).not.toContain("refs/heads/" + project.baselineBranch);
    const next = await commitThenRestore(git, root, "landed.txt", "landed\n");

    await registry.advanceBaseline({
      projectId: project.id,
      runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expectedCommit: project.baselineCommit,
      nextCommit: next,
    });

    expect(registry.get(project.id).baselineCommit).toBe(next);
    expect(await git.resolveCommit(root, project.baselineBranch)).toBe(next);
    const after = await snapshotCheckout(git, root);
    expect(after.head).toBe(before.head);
    expect(after.status).toBe(before.status);
    expect(after.branch).toBe(before.branch);
    expect(nonLaunchpadRefs(after.refs)).toBe(nonLaunchpadRefs(before.refs));
  });

  it("rejects a stale expected commit and admits one concurrent winner", async () => {
    const git = new GitClient(5_000);
    const { registry } = await makeLinkedCloneFixture(git);
    const project = await registry.createManaged({ displayName: "Race" });
    const base = project.baselineCommit;
    const before = await snapshotCheckout(git, project.repositoryPath);
    const nextA = await commitThenRestore(git, project.repositoryPath, "a.txt", "a\n");
    const nextB = await commitThenRestore(git, project.repositoryPath, "b.txt", "b\n");
    await git.updateBranchIfAt(
      project.repositoryPath,
      project.baselineBranch,
      base,
      nextA,
    );

    await expect(
      registry.advanceBaseline({
        projectId: project.id,
        runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        expectedCommit: base,
        nextCommit: nextB,
      }),
    ).rejects.toThrow();
    expect(await git.resolveCommit(project.repositoryPath, project.baselineBranch)).toBe(nextA);
    expect(registry.get(project.id).baselineCommit).toBe(base);

    await git.updateBranchIfAt(
      project.repositoryPath,
      project.baselineBranch,
      nextA,
      base,
    );
    const [first, second] = await Promise.allSettled([
      registry.advanceBaseline({
        projectId: project.id,
        runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        expectedCommit: base,
        nextCommit: nextA,
      }),
      registry.advanceBaseline({
        projectId: project.id,
        runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        expectedCommit: base,
        nextCommit: nextB,
      }),
    ]);
    expect([first, second].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = await git.resolveCommit(project.repositoryPath, project.baselineBranch);
    expect(winner).toMatch(new RegExp("^(" + nextA + "|" + nextB + ")$"));
    expect(registry.get(project.id).baselineCommit).toBe(winner);
    const after = await snapshotCheckout(git, project.repositoryPath);
    expect(after.head).toBe(before.head);
    expect(after.status).toBe(before.status);
    expect(after.branch).toBe(before.branch);
  });

  it("recovers a persist-failed ref update on restart without rerunning an agent", async () => {
    const git = new GitClient(5_000);
    const fixtureRoot = await temporaryDirectory("launchpad-project-recover-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspaces");
    await mkdir(allowedRoot, { recursive: true });
    const store = new FailBaselineFinalizeStore(path.join(fixtureRoot, "db.json"));
    await store.initialize();
    const manager = new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git);
    const registry = new ProjectRegistry(store, manager, git);
    const project = await registry.createManaged({ displayName: "Recover" });
    const next = await commitThenRestore(git, project.repositoryPath, "next.txt", "next\n");

    await expect(
      registry.advanceBaseline({
        projectId: project.id,
        runId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        expectedCommit: project.baselineCommit,
        nextCommit: next,
      }),
    ).rejects.toThrow(/injected baseline persist failure/);
    expect(registry.get(project.id).baselineCommit).toBe(project.baselineCommit);
    expect(store.snapshot().projects[0]?.baselineTransition).toMatchObject({
      state: "prepared",
      expectedCommit: project.baselineCommit,
      nextCommit: next,
    });
    expect(await git.resolveCommit(project.repositoryPath, project.baselineBranch)).toBe(next);

    const restarted = new ProjectRegistry(store, manager, git);
    await restarted.recoverBaselineTransitions();
    expect(restarted.get(project.id).baselineCommit).toBe(next);
    expect(store.snapshot().projects[0]?.baselineTransition).toBeUndefined();
    expect(store.snapshot().projects[0]?.state).toBe("ready");
  });

  it("clears a non-applied prepared intent and marks a diverged ref unavailable", async () => {
    const git = new GitClient(5_000);
    const { store, registry } = await makeLinkedCloneFixture(git);
    const project = await registry.createManaged({ displayName: "Intent" });
    const next = await commitThenRestore(git, project.repositoryPath, "held.txt", "held\n");
    const third = await commitThenRestore(git, project.repositoryPath, "other.txt", "other\n");

    await store.mutate((database) => {
      database.projects[0]!.baselineTransition = {
        runId: "12121212-1212-4121-8121-121212121212",
        expectedCommit: project.baselineCommit,
        nextCommit: next,
        state: "prepared",
      };
    });
    await registry.recoverBaselineTransitions();
    expect(registry.get(project.id).baselineCommit).toBe(project.baselineCommit);
    expect(store.snapshot().projects[0]?.baselineTransition).toBeUndefined();

    await store.mutate((database) => {
      database.projects[0]!.baselineTransition = {
        runId: "13131313-1313-4131-8131-131313131313",
        expectedCommit: project.baselineCommit,
        nextCommit: next,
        state: "prepared",
      };
    });
    await git.updateBranchIfAt(
      project.repositoryPath,
      project.baselineBranch,
      project.baselineCommit,
      third,
    );
    await registry.recoverBaselineTransitions();
    const diverged = store.snapshot().projects[0]!;
    expect(diverged.state).toBe("unavailable");
    expect(diverged.baselineCommit).toBe(project.baselineCommit);
    expect(diverged.baselineTransition).toMatchObject({
      expectedCommit: project.baselineCommit,
      nextCommit: next,
    });
  });

  it("marks a replaced repository at the same path unavailable", async () => {
    const git = new GitClient(5_000);
    const { store, registry } = await makeLinkedCloneFixture(git);
    const project = await registry.createManaged({ displayName: "Replaced" });
    const stored = store.snapshot().projects[0]!;
    await replaceGitRepository(git, project.repositoryPath);

    await registry.recoverBaselineTransitions();

    const recovered = store.snapshot().projects[0]!;
    expect(recovered.id).toBe(project.id);
    expect(recovered.state).toBe("unavailable");
    expect(recovered.lastError).toMatch(/identity/i);
    expect(recovered.repositoryRealPath).toBe(stored.repositoryRealPath);
    expect(recovered.gitCommonIno).toBe(stored.gitCommonIno);
    await expect(registry.admit(project.id)).rejects.toMatchObject({
      name: "ProjectUnavailableError",
      code: "project_identity_mismatch",
    });
  });

  it("restores ready when an unavailable Project's identity and HEAD still match", async () => {
    const git = new GitClient(5_000);
    const { store, registry } = await makeLinkedCloneFixture(git);
    const project = await registry.createManaged({ displayName: "Restored" });
    await store.mutate((database) => {
      database.projects[0]!.state = "unavailable";
      database.projects[0]!.lastError = "temporary outage";
    });

    await registry.recoverBaselineTransitions();

    const recovered = registry.get(project.id);
    expect(recovered.state).toBe("ready");
    expect(recovered.lastError).toBeNull();
    expect(store.snapshot().projects[0]?.state).toBe("ready");
  });

  it("stays unavailable when identity checks fail after a previous outage", async () => {
    const git = new GitClient(5_000);
    const { store, registry } = await makeLinkedCloneFixture(git);
    const project = await registry.createManaged({ displayName: "Still Gone" });
    await store.mutate((database) => {
      database.projects[0]!.state = "unavailable";
      database.projects[0]!.lastError = "temporary outage";
    });
    await rm(project.repositoryPath, { recursive: true, force: true });

    await registry.recoverBaselineTransitions();

    const recovered = store.snapshot().projects[0]!;
    expect(recovered.state).toBe("unavailable");
    expect(recovered.lastError).not.toBeNull();
    expect(recovered.lastError).not.toBe("temporary outage");
  });

  it("does not leave an unregistered published folder when persist fails after create", async () => {
    const git = new GitClient(5_000);
    const fixtureRoot = await temporaryDirectory("launchpad-project-create-persist-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspaces");
    await mkdir(allowedRoot, { recursive: true });
    const store = new FailManagedPersistStore(path.join(fixtureRoot, "db.json"));
    await store.initialize();
    const registry = new ProjectRegistry(
      store,
      new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git),
      git,
    );

    await expect(registry.createManaged({ displayName: "Orphan App" })).rejects.toThrow(
      /injected managed persist failure/,
    );
    expect(store.snapshot().projects).toHaveLength(0);
    const leftover = await readdir(path.join(workspaceRoot, "managed-projects")).catch(() => [] as string[]);
    expect(leftover.filter((name) => !name.startsWith("."))).toEqual([]);

    const created = await registry.createManaged({ displayName: "Orphan App" });
    expect(path.basename(created.repositoryPath)).toBe("orphan-app");
    expect(registry.list()).toHaveLength(1);
    const second = await registry.createManaged({ displayName: "Orphan App" });
    expect(path.basename(second.repositoryPath)).toBe("orphan-app-2");
  });
});

describe("baselineCandidate", () => {
  it("returns expected/next only for a succeeded integrated head that moved", () => {
    const run = candidateRun();
    expect(baselineCandidate(run)).toEqual({
      expected: COMMIT_A,
      next: COMMIT_B,
    });
  });

  it.each([
    ["zero integrations", { integrations: [] }],
    ["unknown outcome", { outcome: "unknown" as const }],
    ["partial outcome", { outcome: "partial" as const }],
    ["failed outcome", { outcome: "failed" as const }],
    ["cancelled run", { status: "cancelled" as const, outcome: "unknown" as const }],
    ["conflicted integration", { integrations: [integration("conflicted", "failed")] }],
    ["failed structural decision", { integrations: [integration("integrated", "failed")] }],
    ["head mismatch", { headCommit: "c".repeat(40) }],
    ["unchanged head", { headCommit: COMMIT_A, integrations: [integration("integrated", "passed", COMMIT_A)] }],
    ["missing projectId", { projectId: null }],
  ] as const)("denies %s", (_label, overrides) => {
    expect(baselineCandidate(candidateRun(overrides))).toBeNull();
  });
});

const COMMIT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

class FailBaselineFinalizeStore extends JsonStore {
  private failNextAdvance = true;

  override async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    const before = this.snapshot();
    const probe = structuredClone(before);
    await mutation(probe);
    const advancing = probe.projects.some((project) => {
      const previous = before.projects.find((item) => item.id === project.id);
      return previous !== undefined && previous.baselineCommit !== project.baselineCommit;
    });
    if (advancing && this.failNextAdvance) {
      this.failNextAdvance = false;
      throw new Error("injected baseline persist failure");
    }
    return super.mutate(mutation);
  }
}

class FailManagedPersistStore extends JsonStore {
  private failNextCreate = true;

  override async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    const before = this.snapshot();
    const probe = structuredClone(before);
    await mutation(probe);
    const creating = probe.projects.length > before.projects.length;
    if (creating && this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("injected managed persist failure");
    }
    return super.mutate(mutation);
  }
}

async function replaceGitRepository(git: GitClient, repository: string): Promise<void> {
  await rm(repository, { recursive: true, force: true });
  await git.run(path.dirname(repository), ["init", "-b", "main", "--", repository]);
  await writeFile(path.join(repository, "README.md"), "replaced\n", "utf8");
  await git.run(repository, ["add", "--", "README.md"]);
  await git.run(repository, ["commit", "-m", "replaced"]);
}

async function snapshotCheckout(git: GitClient, repository: string) {
  return {
    head: await git.head(repository),
    status: await git.run(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
    branch: await git.run(repository, ["branch", "--show-current"]),
    refs: await git.run(repository, ["for-each-ref", "--format=%(refname) %(objectname)"]),
  };
}

function nonLaunchpadRefs(refs: string): string {
  return refs
    .split("\n")
    .filter((line) => !line.includes("refs/heads/launchpad/"))
    .join("\n");
}

async function commitThenRestore(
  git: GitClient,
  repository: string,
  fileName: string,
  contents: string,
): Promise<string> {
  const base = await git.head(repository);
  await writeFile(path.join(repository, fileName), contents, "utf8");
  await git.run(repository, ["add", "--", fileName]);
  await git.run(repository, ["commit", "-m", fileName]);
  const next = await git.head(repository);
  await git.resetHard(repository, base);
  return next;
}

function integration(
  state: IntegrationRecord["state"],
  structuralDecision: IntegrationRecord["structuralDecision"],
  after: string | null = COMMIT_B,
): IntegrationRecord {
  return {
    contributionId: "c1",
    subtaskId: "s1",
    canonicalHeadBefore: COMMIT_A,
    canonicalHeadAfter: after,
    state,
    structuralDecision,
    reason: state === "integrated" ? null : "blocked",
  };
}

function candidateRun(overrides: {
  projectId?: string | null;
  status?: AgentRun["status"];
  outcome?: TaskOutcome;
  headCommit?: string | null;
  integrations?: IntegrationRecord[];
} = {}): AgentRun {
  const base = COMMIT_A;
  const head = overrides.headCommit === undefined ? COMMIT_B : overrides.headCommit;
  return {
    id: "22222222-2222-4222-8222-222222222222",
    agentId: "11111111-1111-4111-8111-111111111111",
    projectId: overrides.projectId === undefined ? "33333333-3333-4333-8333-333333333333" : overrides.projectId,
    kind: "orchestration",
    parentRunId: null,
    status: overrides.status ?? "running",
    prompt: "build",
    output: null,
    error: null,
    usage: null,
    startedAt: "2026-08-29T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-08-29T00:00:00.000Z",
    orchestration: {
      phase: "completed",
      outcome: {
        value: overrides.outcome ?? "succeeded",
        reason: "ok",
        evidence: [],
        resolvedAt: "2026-08-29T00:00:00.000Z",
      },
    } as OrchestrationState,
    project: {
      source: {
        mode: "existing_repository",
        repositoryPath: "/tmp/repo",
        requestedRevision: base,
        baseCommit: base,
        sourceFingerprint: "fp",
      },
      runBranch: "launchpad/run/x",
      canonicalWorkspacePath: "/tmp/run",
      headCommit: head,
      state: "ready",
      attempts: [],
      integrations: overrides.integrations ?? [integration("integrated", "passed")],
    } as ProjectRunRecord,
  };
}

/**
 * "Projects by newest" has to be a total order.
 *
 * `listProjects` sorted on `createdAt` alone. Two projects opened in the same
 * millisecond therefore tied, and a stable sort leaves ties in insertion order
 * -- oldest first -- so the top of a "newest first" list was whichever way the
 * clock happened to fall. The HTTP acceptance test had been asserting the
 * insertion order it saw, which is why it failed once the ordering changed.
 */
describe("orderProjects", () => {
  const project = (id: string, createdAt: string) => ({ id, createdAt });

  it("lists the most recently created project first", () => {
    const ordered = orderProjects([
      project("old", "2026-08-28T10:00:00.000Z"),
      project("new", "2026-08-30T10:00:00.000Z"),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("puts the later of two projects created in the same millisecond first", () => {
    const stamp = "2026-08-30T10:00:00.000Z";
    const ordered = orderProjects([project("first", stamp), project("second", stamp)]);
    expect(ordered.map((item) => item.id)).toEqual(["second", "first"]);
  });

  it("leaves the caller's array alone", () => {
    const projects = [
      project("old", "2026-08-28T10:00:00.000Z"),
      project("new", "2026-08-30T10:00:00.000Z"),
    ];
    orderProjects(projects);
    expect(projects.map((item) => item.id)).toEqual(["old", "new"]);
  });
});
