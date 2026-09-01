import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient } from "../src/git-client.js";
import { ProjectRepositoryManager } from "../src/project-repository-manager.js";

const directories: string[] = [];
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function snapshotRefs(git: GitClient, repository: string): Promise<{
  head: string;
  status: string;
  refs: string;
  branch: string;
}> {
  return {
    head: await git.head(repository),
    status: await git.run(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
    refs: await git.run(repository, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    branch: await git.run(repository, ["branch", "--show-current"]),
  };
}

async function makeLinkedCloneFixture(git: GitClient): Promise<{
  allowedRoot: string;
  workspaceRoot: string;
  root: string;
  linked: string;
  clone: string;
}> {
  const fixtureRoot = await temporaryDirectory("launchpad-project-repo-");
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

  return { allowedRoot, workspaceRoot, root, linked, clone };
}

describe("ProjectRepositoryManager", () => {
  it("groups linked worktrees but not separate clones", async () => {
    const git = new GitClient(5_000);
    const { allowedRoot, workspaceRoot, root, linked, clone } = await makeLinkedCloneFixture(git);
    const manager = new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git);

    const rootIdentity = await manager.openExternal(root, "HEAD");
    const linkedIdentity = await manager.openExternal(linked, "HEAD");
    const clonedIdentity = await manager.openExternal(clone, "HEAD");
    expect(linkedIdentity.identity.gitCommonRealPath).toBe(rootIdentity.identity.gitCommonRealPath);
    expect(clonedIdentity.identity.gitCommonRealPath).not.toBe(rootIdentity.identity.gitCommonRealPath);
  });

  it("admits one compare-and-swap baseline winner", async () => {
    const git = new GitClient(5_000);
    const { allowedRoot, workspaceRoot, root } = await makeLinkedCloneFixture(git);
    const manager = new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git);
    const repo = root;
    const branch = "launchpad/project/" + PROJECT_ID;
    const base = await git.head(repo);
    await manager.ensureBaseline(repo, PROJECT_ID, base);

    await writeFile(path.join(repo, "next-a.txt"), "a\n", "utf8");
    await git.run(repo, ["add", "--", "next-a.txt"]);
    await git.run(repo, ["commit", "-m", "next a"]);
    const nextA = await git.head(repo);
    await git.resetHard(repo, base);

    await writeFile(path.join(repo, "next-b.txt"), "b\n", "utf8");
    await git.run(repo, ["add", "--", "next-b.txt"]);
    await git.run(repo, ["commit", "-m", "next b"]);
    const nextB = await git.head(repo);
    await git.resetHard(repo, base);

    const [first, second] = await Promise.allSettled([
      manager.compareAndSwapBaseline(repo, branch, base, nextA),
      manager.compareAndSwapBaseline(repo, branch, base, nextB),
    ]);
    expect([first, second].filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await git.resolveCommit(repo, branch)).toMatch(new RegExp(`^(${nextA}|${nextB})$`));
    expect(await git.head(repo)).toBe(base);
    expect(await git.run(repo, ["branch", "--show-current"])).toBe("main");
  });

  it("creates a managed seed repository under workspaces/managed-projects without mutating an external source", async () => {
    const git = new GitClient(5_000);
    const { allowedRoot, workspaceRoot, root } = await makeLinkedCloneFixture(git);
    const manager = new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git);
    const before = await snapshotRefs(git, root);

    const prepared = await manager.createManaged(PROJECT_ID, "Demo App");

    expect(path.basename(path.dirname(prepared.repositoryPath))).toBe("managed-projects");
    expect(await realpath(path.dirname(prepared.repositoryPath))).toBe(
      await realpath(path.join(workspaceRoot, "managed-projects")),
    );
    expect(prepared.repositoryPath).toContain(path.join("workspaces", "managed-projects"));
    expect(path.basename(prepared.repositoryPath)).toMatch(/^demo-app(?:-[0-9]+)?$/);
    expect(prepared.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.head(prepared.repositoryPath)).toBe(prepared.baseCommit);
    expect(await git.isClean(prepared.repositoryPath)).toBe(true);
    expect(prepared.identity.repositoryRealPath).toBe(await realpath(prepared.repositoryPath));
    expect(prepared.identity.gitCommonRealPath).toBe(
      await realpath(await git.commonGitDirectory(prepared.repositoryPath)),
    );
    expect(await snapshotRefs(git, root)).toEqual(before);
  });

  it("retries managed slug publication when the first slug is occupied", async () => {
    const git = new GitClient(5_000);
    const { allowedRoot, workspaceRoot } = await makeLinkedCloneFixture(git);
    const manager = new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git);

    const first = await manager.createManaged(PROJECT_ID, "Demo App");
    const second = await manager.createManaged("55555555-5555-4555-8555-555555555555", "Demo App");

    const firstSlug = path.basename(first.repositoryPath);
    const secondSlug = path.basename(second.repositoryPath);
    expect(firstSlug).toBe("demo-app");
    expect(secondSlug).toBe("demo-app-2");
    expect(firstSlug).not.toBe(secondSlug);
    expect(await realpath(path.dirname(first.repositoryPath))).toBe(
      await realpath(path.join(workspaceRoot, "managed-projects")),
    );
    expect(await realpath(path.dirname(second.repositoryPath))).toBe(
      await realpath(path.join(workspaceRoot, "managed-projects")),
    );
  });

  it("can remove legacy managed repositories that still live under workspaces/projects", async () => {
    const git = new GitClient(5_000);
    const { workspaceRoot } = await makeLinkedCloneFixture(git);
    const legacyRoot = path.join(workspaceRoot, "projects");
    const legacyRepository = path.join(legacyRoot, "old-app");
    await mkdir(legacyRepository, { recursive: true });
    await git.run(legacyRepository, ["init", "-b", "seed"]);
    await writeFile(path.join(legacyRepository, "README.md"), "# Old App\n", "utf8");
    await git.run(legacyRepository, ["add", "--", "README.md"]);
    await git.run(legacyRepository, ["commit", "-m", "seed"]);
    const manager = new ProjectRepositoryManager(workspaceRoot, [], git);
    const identity = await manager.inspectIdentity(legacyRepository);

    expect(await manager.removeOwnedManaged(legacyRepository, identity)).toBe(true);
    await expect(realpath(legacyRepository)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a just-published managed slug only when identity still matches", async () => {
    const git = new GitClient(5_000);
    const { allowedRoot, workspaceRoot } = await makeLinkedCloneFixture(git);
    const manager = new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git);
    const prepared = await manager.createManaged(PROJECT_ID, "Owned Slug");

    expect(await manager.removeOwnedManaged(prepared.repositoryPath, prepared.identity)).toBe(true);
    await expect(realpath(prepared.repositoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not delete a replaced repository at the published slug", async () => {
    const git = new GitClient(5_000);
    const { allowedRoot, workspaceRoot } = await makeLinkedCloneFixture(git);
    const manager = new ProjectRepositoryManager(workspaceRoot, [allowedRoot], git);
    const prepared = await manager.createManaged(PROJECT_ID, "Replaced Slug");
    await replaceGitRepository(git, prepared.repositoryPath);

    expect(await manager.removeOwnedManaged(prepared.repositoryPath, prepared.identity)).toBe(false);
    expect(await git.head(prepared.repositoryPath)).toMatch(/^[0-9a-f]{40}$/);
    const current = await manager.inspectIdentity(prepared.repositoryPath);
    expect(current.gitCommonIno).not.toBe(prepared.identity.gitCommonIno);
  });
});

async function replaceGitRepository(git: GitClient, repository: string): Promise<void> {
  await rm(repository, { recursive: true, force: true });
  await git.run(path.dirname(repository), ["init", "-b", "main", "--", repository]);
  await writeFile(path.join(repository, "README.md"), "replaced\n", "utf8");
  await git.run(repository, ["add", "--", "README.md"]);
  await git.run(repository, ["commit", "-m", "replaced"]);
}
