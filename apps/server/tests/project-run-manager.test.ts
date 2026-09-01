import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { GitClient } from "../src/git-client.js";
import {
  createOpenRunDirectory,
  defaultProjectRunManagerDependencies,
  ProjectPreflightError,
  ProjectRunManager,
  type ProjectRunManagerDependencies,
  type ProjectRunManagerHooks,
} from "../src/project-run-manager.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function makeRepository(parent: string, name = "repository"): Promise<{ git: GitClient; root: string; head: string }> {
  const root = path.join(parent, name);
  const git = new GitClient(5_000);
  await mkdir(parent, { recursive: true });
  await git.run(parent, ["init", "-b", "main", "--", root]);
  await writeFile(path.join(root, "README.md"), "initial\n", "utf8");
  await git.run(root, ["add", "--", "README.md"]);
  await git.run(root, ["commit", "-m", "initial"]);
  return { git, root, head: await git.head(root) };
}

function manager(
  workspaceRoot: string,
  allowedSourceRoots: string[],
  git: GitClient,
  hooks?: ProjectRunManagerHooks,
  dependencies?: ProjectRunManagerDependencies,
): ProjectRunManager {
  return new ProjectRunManager(workspaceRoot, allowedSourceRoots, git, hooks, dependencies);
}

function throwingOwnershipObserver(throwOnCall: number): ProjectRunManagerHooks {
  let calls = 0;
  return {
    onPreparedOwnershipCountChangedForTest: () => {
      calls += 1;
      if (calls === throwOnCall) throw new Error("test ownership observer failed");
    },
  } as ProjectRunManagerHooks;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => (resolve = done)), resolve };
}

async function branchExists(git: GitClient, repository: string, branch: string): Promise<boolean> {
  try {
    await git.run(repository, ["show-ref", "--verify", "--quiet", "refs/heads/" + branch]);
    return true;
  } catch {
    return false;
  }
}

describe("ProjectRunManager", () => {
  it("does not let a throwing ownership observer change successful preparation", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git, root } = await makeRepository(allowedRoot);
    const projectRunManager = manager(
      workspaceRoot,
      [allowedRoot],
      git,
      throwingOwnershipObserver(1),
    );

    const prepared = await projectRunManager.prepare("observer-prepare", {
      mode: "existing_repository",
      repositoryPath: root,
      revision: "HEAD",
    });

    expect(await branchExists(git, root, "launchpad/run/observer-prepare")).toBe(true);
    await expect(stat(prepared.canonicalWorkspacePath)).resolves.toMatchObject({});
  });

  it("does not let a throwing ownership observer change successful acknowledgement", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git, root } = await makeRepository(allowedRoot);
    const projectRunManager = manager(
      workspaceRoot,
      [allowedRoot],
      git,
      throwingOwnershipObserver(2),
    );
    const prepared = await projectRunManager.prepare("observer-ack", {
      mode: "existing_repository",
      repositoryPath: root,
      revision: "HEAD",
    });

    await projectRunManager.acknowledgePrepared("observer-ack", prepared);
    await projectRunManager.abortPrepared("observer-ack");

    expect(await branchExists(git, root, "launchpad/run/observer-ack")).toBe(true);
    await expect(stat(prepared.canonicalWorkspacePath)).resolves.toMatchObject({});
  });

  it("does not let a throwing ownership observer misreport successful abort cleanup", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git, root } = await makeRepository(allowedRoot);
    const projectRunManager = manager(
      workspaceRoot,
      [allowedRoot],
      git,
      throwingOwnershipObserver(2),
    );
    const prepared = await projectRunManager.prepare("observer-abort", {
      mode: "existing_repository",
      repositoryPath: root,
      revision: "HEAD",
    });

    await projectRunManager.abortPrepared("observer-abort");

    expect(await branchExists(git, root, "launchpad/run/observer-abort")).toBe(false);
    await expect(stat(prepared.canonicalWorkspacePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(workspaceRoot, ".runs"))).resolves.toEqual([]);
  });

  it("hands off only the exact prepared project and retains no destructive abort authority", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git, root } = await makeRepository(allowedRoot);
    const projectRunManager = manager(workspaceRoot, [allowedRoot], git);
    const first = await projectRunManager.prepare("ack-first", {
      mode: "existing_repository",
      repositoryPath: root,
      revision: "HEAD",
    });
    const second = await projectRunManager.prepare("ack-second", {
      mode: "existing_repository",
      repositoryPath: root,
      revision: "HEAD",
    });

    await expect(
      projectRunManager.acknowledgePrepared("ack-first", structuredClone(first)),
    ).rejects.toMatchObject({ code: "workspace_source_changed" });
    await expect(
      projectRunManager.acknowledgePrepared("ack-first", second),
    ).rejects.toMatchObject({ code: "workspace_source_changed" });
    const retained = projectRunManager.preparedOwnershipSnapshotForTest();
    expect(retained).toEqual({ current: 2, peak: 2 });
    expect(Object.isFrozen(retained)).toBe(true);
    expect(() => {
      (retained as { current: number }).current = 999;
    }).toThrow(TypeError);
    expect(projectRunManager.preparedOwnershipSnapshotForTest()).toEqual({
      current: 2,
      peak: 2,
    });

    await projectRunManager.acknowledgePrepared("ack-first", first);
    await projectRunManager.acknowledgePrepared("ack-first", first);
    await projectRunManager.abortPrepared("ack-first");

    expect(projectRunManager.preparedOwnershipSnapshotForTest()).toEqual({
      current: 1,
      peak: 2,
    });
    expect(await branchExists(git, root, "launchpad/run/ack-first")).toBe(true);
    await expect(stat(first.canonicalWorkspacePath)).resolves.toMatchObject({});

    await projectRunManager.acknowledgePrepared("ack-second", second);
    expect(projectRunManager.preparedOwnershipSnapshotForTest()).toEqual({
      current: 0,
      peak: 2,
    });
  });

  it("aborts only its prepared worktree, branch, and run directory and permits an idempotent retry", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git, root, head } = await makeRepository(allowedRoot);
    const projectRunManager = manager(workspaceRoot, [allowedRoot], git);

    const prepared = await projectRunManager.prepare("abort-owned", {
      mode: "existing_repository",
      repositoryPath: root,
      revision: "HEAD",
    });
    expect(await branchExists(git, root, "launchpad/run/abort-owned")).toBe(true);

    await projectRunManager.abortPrepared("abort-owned");

    expect(await git.head(root)).toBe(head);
    expect(await git.isClean(root)).toBe(true);
    expect(await branchExists(git, root, "launchpad/run/abort-owned")).toBe(false);
    expect(await git.run(root, ["worktree", "list", "--porcelain"])).not.toContain(
      prepared.canonicalWorkspacePath,
    );
    await expect(readdir(path.join(workspaceRoot, ".runs"))).resolves.toEqual([]);
    await expect(projectRunManager.abortPrepared("abort-owned")).resolves.toBeUndefined();

    await expect(
      projectRunManager.prepare("abort-owned", {
        mode: "existing_repository",
        repositoryPath: root,
        revision: "HEAD",
      }),
    ).resolves.toMatchObject({ runBranch: "launchpad/run/abort-owned" });
    await projectRunManager.abortPrepared("abort-owned");
  });

  it("keeps raw initiating and cleanup causes non-enumerable", () => {
    const secret = "fixture-secret-token";
    const rawCause = Object.assign(new Error("raw failure at /private/source"), {
      path: "/private/source",
      token: secret,
      secret,
    });
    const error = new ProjectPreflightError(
      "workspace_source_cleanup_failed",
      "Safe cleanup could not complete",
      rawCause,
      {
        originalCode: "project_record_persistence_failed",
        cleanupCode: "workspace_source_cleanup_failed",
      },
      rawCause,
    );

    expect(error.cause).toBe(rawCause);
    expect(error.cleanupCause).toBe(rawCause);
    expect(Object.keys(error)).not.toContain("cause");
    expect(Object.keys(error)).not.toContain("cleanupCause");
    const serialized = JSON.stringify(error);
    expect(serialized).toContain("project_record_persistence_failed");
    expect(serialized).not.toContain("/private/source");
    expect(serialized).not.toContain(secret);
  });

  it("creates a clean canonical run branch from a clean, resolved repository commit", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git, root, head } = await makeRepository(allowedRoot);
    await mkdir(workspaceRoot, { recursive: true });
    const realWorkspaceRoot = await realpath(workspaceRoot);
    const realRepositoryRoot = await realpath(root);

    const prepared = await manager(workspaceRoot, [allowedRoot], git).prepare("run-1", {
      mode: "existing_repository",
      repositoryPath: root,
      revision: "HEAD",
    });

    expect(prepared).toMatchObject({
      source: {
        mode: "existing_repository",
        repositoryPath: realRepositoryRoot,
        requestedRevision: "HEAD",
        baseCommit: head,
        sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      runBranch: "launchpad/run/run-1",
      canonicalWorkspacePath: path.join(realWorkspaceRoot, ".runs", "run-1", "canonical"),
      headCommit: head,
      state: "ready",
      attempts: [],
      integrations: [],
    });
    expect(await git.head(prepared.canonicalWorkspacePath)).toBe(head);
    expect(await git.run(prepared.canonicalWorkspacePath, ["branch", "--show-current"])).toBe(
      "launchpad/run/run-1",
    );
    expect(await git.isClean(prepared.canonicalWorkspacePath)).toBe(true);
    expect(await git.head(root)).toBe(head);
    expect(await git.isClean(root)).toBe(true);
    const commonDirectory = await realpath(
      await git.run(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    const gitVersion = await git.run(root, ["--version"]);
    expect(prepared.source.sourceFingerprint).toBe(
      createHash("sha256").update(commonDirectory + "\0" + head + "\0" + gitVersion).digest("hex"),
    );
  });

  it("admits a managed Project under AGENT_WORKSPACE_ROOT when WORKSPACE_SOURCE_ROOTS is disjoint", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspaces");
    const externalAllowed = path.join(fixtureRoot, "allowed");
    await mkdir(externalAllowed, { recursive: true });
    const { git, root, head } = await makeRepository(path.join(workspaceRoot, "projects"), "todo-flow");
    const config = loadConfig({
      NODE_ENV: "test",
      AGENT_WORKSPACE_ROOT: workspaceRoot,
      WORKSPACE_SOURCE_ROOTS: externalAllowed,
    });

    const prepared = await manager(config.workspaceRoot, [...config.workspaceSourceRoots], git).prepare(
      "managed-todo",
      {
        mode: "existing_repository",
        repositoryPath: root,
        revision: head,
      },
    );

    expect(prepared.state).toBe("ready");
    expect(prepared.source.repositoryPath).toBe(await realpath(root));
  });

  it("rejects an existing repository outside all allowed real roots", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const outsideRoot = path.join(fixtureRoot, "outside");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git, root } = await makeRepository(outsideRoot);
    await mkdir(allowedRoot, { recursive: true });

    await expect(
      manager(workspaceRoot, [allowedRoot], git).prepare("outside", {
        mode: "existing_repository",
        repositoryPath: root,
        revision: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "workspace_source_outside_allowed_roots" });
  });

  it("rejects a symlink that enters an allowed lexical path but resolves outside it", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const outsideRoot = path.join(fixtureRoot, "outside");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git, root } = await makeRepository(outsideRoot);
    await mkdir(allowedRoot, { recursive: true });
    await symlink(root, path.join(allowedRoot, "escaped-repository"));

    await expect(
      manager(workspaceRoot, [allowedRoot], git).prepare("symlink", {
        mode: "existing_repository",
        repositoryPath: path.join(allowedRoot, "escaped-repository"),
        revision: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "workspace_source_outside_allowed_roots" });
  });

  it("rejects a tracked source modification before registering a canonical worktree", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git, root } = await makeRepository(allowedRoot);
    await writeFile(path.join(root, "README.md"), "modified\n", "utf8");

    await expect(
      manager(workspaceRoot, [allowedRoot], git).prepare("dirty", {
        mode: "existing_repository",
        repositoryPath: root,
        revision: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "workspace_source_dirty" });
    await expect(readFile(path.join(root, "README.md"), "utf8")).resolves.toBe("modified\n");
    await expect(git.run(root, ["worktree", "list", "--porcelain"])).resolves.not.toContain("canonical");
  });

  it("rejects an untracked source file before registering a canonical worktree", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git, root } = await makeRepository(allowedRoot);
    await writeFile(path.join(root, "untracked.txt"), "untracked\n", "utf8");

    await expect(
      manager(workspaceRoot, [allowedRoot], git).prepare("untracked", {
        mode: "existing_repository",
        repositoryPath: root,
        revision: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "workspace_source_dirty" });
    await expect(readFile(path.join(root, "untracked.txt"), "utf8")).resolves.toBe("untracked\n");
  });

  it("rejects a non-Git source and an invalid revision with distinct typed failures", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const git = new GitClient(5_000);
    const plainDirectory = path.join(allowedRoot, "plain");
    await mkdir(plainDirectory, { recursive: true });
    await writeFile(path.join(plainDirectory, "note.txt"), "not a repository\n", "utf8");
    const { root } = await makeRepository(allowedRoot, "repository");

    await expect(
      manager(workspaceRoot, [allowedRoot], git).prepare("not-git", {
        mode: "existing_repository",
        repositoryPath: plainDirectory,
        revision: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "workspace_source_not_git_repository" });
    await expect(
      manager(workspaceRoot, [allowedRoot], git).prepare("bad-revision", {
        mode: "existing_repository",
        repositoryPath: root,
        revision: "missing-revision",
      }),
    ).rejects.toMatchObject({ code: "workspace_source_invalid_revision" });
  });

  it("rejects duplicate preparation without modifying the first canonical branch", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git, root, head } = await makeRepository(allowedRoot);
    const projectRunManager = manager(workspaceRoot, [allowedRoot], git);
    const first = await projectRunManager.prepare("duplicate", {
      mode: "existing_repository",
      repositoryPath: root,
      revision: "HEAD",
    });

    await expect(
      projectRunManager.prepare("duplicate", {
        mode: "existing_repository",
        repositoryPath: root,
        revision: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "workspace_source_duplicate_run" });
    expect(await git.head(first.canonicalWorkspacePath)).toBe(head);
  });

  it("does not replace an existing final run directory when claiming a run id", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const candidate = path.join(workspaceRoot, ".runs", "existing-final");
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, "owned.txt"), "keep me\n", "utf8");

    await expect(
      manager(workspaceRoot, [], new GitClient(5_000)).prepare("existing-final", { mode: "ephemeral_research" }),
    ).rejects.toMatchObject({ code: "workspace_source_duplicate_run" });
    await expect(readFile(path.join(candidate, "owned.txt"), "utf8")).resolves.toBe("keep me\n");
  });

  it("does not replace a symlink at the final run path when claiming a run id", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const runsRoot = path.join(workspaceRoot, ".runs");
    const target = path.join(fixtureRoot, "symlink-target");
    const candidate = path.join(runsRoot, "symlink-final");
    await mkdir(runsRoot, { recursive: true });
    await mkdir(target);
    await writeFile(path.join(target, "owned.txt"), "keep target\n", "utf8");
    await symlink(target, candidate);

    await expect(
      manager(workspaceRoot, [], new GitClient(5_000)).prepare("symlink-final", { mode: "ephemeral_research" }),
    ).rejects.toMatchObject({ code: "workspace_source_duplicate_run" });
    await expect(realpath(candidate)).resolves.toBe(await realpath(target));
    await expect(readFile(path.join(target, "owned.txt"), "utf8")).resolves.toBe("keep target\n");
  });

  it("removes only its run-owned worktree when post-registration fingerprinting fails", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git: repositoryGit, root, head } = await makeRepository(allowedRoot);
    class FailingFingerprintGitClient extends GitClient {
      override async run(cwd: string, args: string[]): Promise<string> {
        if (args[0] === "--version") throw new Error("fingerprint unavailable");
        return super.run(cwd, args);
      }
    }
    const git = new FailingFingerprintGitClient(5_000);

    await expect(
      manager(workspaceRoot, [allowedRoot], git).prepare("cleanup", {
        mode: "existing_repository",
        repositoryPath: root,
        revision: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "workspace_source_preparation_failed" });
    await expect(readdir(path.join(workspaceRoot, ".runs", "cleanup"))).rejects.toThrow();
    expect(await repositoryGit.head(root)).toBe(head);
    expect(await repositoryGit.isClean(root)).toBe(true);
    await expect(repositoryGit.run(root, ["worktree", "list", "--porcelain"])).resolves.not.toContain("cleanup/canonical");
  });

  it("removes its named branch after a post-registration failure so retry can succeed", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git: repositoryGit, root } = await makeRepository(allowedRoot);
    class FailingOnceFingerprintGitClient extends GitClient {
      private failed = false;

      override async run(cwd: string, args: string[]): Promise<string> {
        if (args[0] === "--version" && !this.failed) {
          this.failed = true;
          throw new Error("fingerprint unavailable once");
        }
        return super.run(cwd, args);
      }
    }
    const git = new FailingOnceFingerprintGitClient(5_000);
    const projectRunManager = manager(workspaceRoot, [allowedRoot], git);
    const branch = "launchpad/run/retry";

    await expect(
      projectRunManager.prepare("retry", { mode: "existing_repository", repositoryPath: root, revision: "HEAD" }),
    ).rejects.toMatchObject({ code: "workspace_source_preparation_failed" });
    expect(await branchExists(repositoryGit, root, branch)).toBe(false);
    await expect(
      projectRunManager.prepare("retry", { mode: "existing_repository", repositoryPath: root, revision: "HEAD" }),
    ).resolves.toMatchObject({ runBranch: branch });
  });

  it("fails cleanup safely when another process repoints the owned branch before compare-delete", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git: repositoryGit, root, head: expected } = await makeRepository(allowedRoot);
    await writeFile(path.join(root, "later.txt"), "later\n", "utf8");
    await repositoryGit.run(root, ["add", "--", "later.txt"]);
    await repositoryGit.run(root, ["commit", "-m", "later"]);
    const moved = await repositoryGit.head(root);
    class RepointingCleanupGitClient extends GitClient {
      private branch: string | null = null;

      override async worktreeAdd(repository: string, target: string, commit: string, branch?: string): Promise<void> {
        this.branch = branch ?? null;
        await super.worktreeAdd(repository, target, commit, branch);
      }

      override async run(cwd: string, args: string[]): Promise<string> {
        if (args[0] === "--version") throw new Error("trigger cleanup");
        return super.run(cwd, args);
      }

      override async worktreeRemove(repository: string, target: string): Promise<void> {
        await super.worktreeRemove(repository, target);
        await super.run(repository, ["update-ref", "refs/heads/" + this.branch, moved]);
      }
    }
    const git = new RepointingCleanupGitClient(5_000);
    const branch = "launchpad/run/repointed";

    await expect(
      manager(workspaceRoot, [allowedRoot], git).prepare("repointed", {
        mode: "existing_repository",
        repositoryPath: root,
        revision: expected,
      }),
    ).rejects.toMatchObject({ code: "workspace_source_cleanup_failed" });
    expect(await repositoryGit.resolveCommit(root, branch)).toBe(moved);
  });

  it("reports cleanup uncertainty without deleting a run directory replaced after worktree registration", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { root } = await makeRepository(allowedRoot);
    class ReplacingFingerprintGitClient extends GitClient {
      private target: string | null = null;

      override async worktreeAdd(repository: string, target: string, commit: string, branch?: string): Promise<void> {
        await super.worktreeAdd(repository, target, commit, branch);
        this.target = target;
      }

      override async run(cwd: string, args: string[]): Promise<string> {
        if (args[0] === "--version" && this.target) {
          const runDirectory = path.dirname(this.target);
          await rename(runDirectory, runDirectory + ".original");
          await mkdir(runDirectory);
          await writeFile(path.join(runDirectory, "replacement.txt"), "do not delete\n", "utf8");
          throw new Error("fingerprint unavailable after replacement");
        }
        return super.run(cwd, args);
      }
    }
    const git = new ReplacingFingerprintGitClient(5_000);

    await expect(
      manager(workspaceRoot, [allowedRoot], git).prepare("replacement", {
        mode: "existing_repository",
        repositoryPath: root,
        revision: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "workspace_source_cleanup_failed" });
    await expect(readFile(path.join(workspaceRoot, ".runs", "replacement", "replacement.txt"), "utf8")).resolves.toBe(
      "do not delete\n",
    );
  });

  it("detects replacement of the source checkout at the same path even when its Git common directory is unchanged", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const root = path.join(allowedRoot, "source");
    const commonDirectory = path.join(allowedRoot, "common-git");
    const replacement = path.join(allowedRoot, "replacement-worktree");
    const git = new GitClient(5_000);
    await mkdir(allowedRoot, { recursive: true });
    await git.run(allowedRoot, ["init", "-b", "main", "--separate-git-dir=" + commonDirectory, "--", root]);
    await writeFile(path.join(root, "README.md"), "initial\n", "utf8");
    await git.run(root, ["add", "--", "README.md"]);
    await git.run(root, ["commit", "-m", "initial"]);
    const base = await git.head(root);
    await git.run(root, ["worktree", "add", "--detach", "--", replacement, base]);
    class ReplacingSourceGitClient extends GitClient {
      private swapped = false;

      override async worktreeAdd(repository: string, target: string, commit: string, branch?: string): Promise<void> {
        await super.worktreeAdd(repository, target, commit, branch);
        if (!this.swapped) {
          this.swapped = true;
          await rename(repository, repository + ".original");
          await rename(replacement, repository);
        }
      }
    }
    const replacingGit = new ReplacingSourceGitClient(5_000);

    const projectRunManager = manager(workspaceRoot, [allowedRoot], replacingGit);
    const branch = "launchpad/run/source-replaced";
    await expect(
      projectRunManager.prepare("source-replaced", {
        mode: "existing_repository",
        repositoryPath: root,
        revision: base,
      }),
    ).rejects.toMatchObject({ code: "workspace_source_changed" });
    await expect(git.run(root, ["worktree", "list", "--porcelain"])).resolves.not.toContain("source-replaced/canonical");
    expect(await branchExists(git, root, branch)).toBe(false);
    await expect(readdir(path.join(workspaceRoot, ".runs", "source-replaced"))).rejects.toThrow();
    await rename(root, replacement);
    await rename(root + ".original", root);
    await expect(
      projectRunManager.prepare("source-replaced", {
        mode: "existing_repository",
        repositoryPath: root,
        revision: base,
      }),
    ).resolves.toMatchObject({ runBranch: branch });
  });

  it("classifies a raw workspace mkdir failure and does not poison a later retry", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace-file");
    const git = new GitClient(5_000);
    await writeFile(workspaceRoot, "not a directory\n", "utf8");
    const projectRunManager = manager(workspaceRoot, [], git);

    await expect(projectRunManager.prepare("raw-failure", { mode: "ephemeral_research" })).rejects.toMatchObject({
      code: "workspace_source_preparation_failed",
      cause: expect.objectContaining({ code: "EEXIST" }),
    });
    await rm(workspaceRoot);
    await expect(projectRunManager.prepare("raw-failure", { mode: "ephemeral_research" })).resolves.toMatchObject({
      runBranch: null,
    });
  });

  it("keeps a paused winning reservation claimed after multiple rejected duplicates", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const winnerPaused = deferred();
    const winnerReachedPause = deferred();
    const projectRunManager = manager(workspaceRoot, [], new GitClient(5_000), {
      afterReservationCreated: async () => {
        winnerReachedPause.resolve();
        await winnerPaused.promise;
      },
    });

    const winner = projectRunManager.prepare("concurrent", { mode: "ephemeral_research" });
    await winnerReachedPause.promise;
    await expect(projectRunManager.prepare("concurrent", { mode: "ephemeral_research" })).rejects.toMatchObject({
      code: "workspace_source_duplicate_run",
    });
    await expect(projectRunManager.prepare("concurrent", { mode: "ephemeral_research" })).rejects.toMatchObject({
      code: "workspace_source_duplicate_run",
    });
    winnerPaused.resolve();
    await expect(winner).resolves.toMatchObject({ runBranch: null });
    await expect(projectRunManager.prepare("concurrent", { mode: "ephemeral_research" })).rejects.toMatchObject({
      code: "workspace_source_duplicate_run",
    });
  });

  it("cleans an owned post-mkdir reservation failure so the same id can retry", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    let failOnce = true;
    const projectRunManager = manager(workspaceRoot, [], new GitClient(5_000), {
      afterRunDirectoryCreated: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("injected post-mkdir failure");
        }
      },
    });

    await expect(projectRunManager.prepare("post-mkdir", { mode: "ephemeral_research" })).rejects.toMatchObject({
      code: "workspace_source_preparation_failed",
    });
    await expect(readdir(path.join(workspaceRoot, ".runs"))).resolves.toEqual([]);
    await expect(projectRunManager.prepare("post-mkdir", { mode: "ephemeral_research" })).resolves.toMatchObject({
      runBranch: null,
    });
  });

  it("cleans a marker-backed reservation fault injected before final identity confirmation", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    let failOnce = true;
    const projectRunManager = manager(workspaceRoot, [], new GitClient(5_000), {
      beforeReservationPublishForTest: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("injected before final identity confirmation");
        }
      },
    });

    await expect(projectRunManager.prepare("pre-identity", { mode: "ephemeral_research" })).rejects.toMatchObject({
      code: "workspace_source_preparation_failed",
    });
    await expect(readdir(path.join(workspaceRoot, ".runs"))).resolves.toEqual([]);
    await expect(projectRunManager.prepare("pre-identity", { mode: "ephemeral_research" })).resolves.toMatchObject({
      runBranch: null,
    });
  });

  it("cleans an exclusive final directory when directory open or fstat fails and permits retry", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    let calls = 0;
    const dependencies: ProjectRunManagerDependencies = {
      ...defaultProjectRunManagerDependencies,
      openRunDirectory: async (directory) => {
        calls += 1;
        expect(directory).toBe(path.join(await realpath(workspaceRoot), ".runs", "open-failure"));
        if (calls === 1) throw new Error("injected directory open/fstat failure");
        return defaultProjectRunManagerDependencies.openRunDirectory(directory);
      },
    };
    const projectRunManager = manager(workspaceRoot, [], new GitClient(5_000), {}, dependencies);

    await expect(projectRunManager.prepare("open-failure", { mode: "ephemeral_research" })).rejects.toMatchObject({
      code: "workspace_source_preparation_failed",
      cause: expect.objectContaining({ message: "injected directory open/fstat failure" }),
    });
    await expect(readdir(path.join(workspaceRoot, ".runs"))).resolves.toEqual([]);
    await expect(projectRunManager.prepare("open-failure", { mode: "ephemeral_research" })).resolves.toMatchObject({
      runBranch: null,
    });
    expect(calls).toBe(2);
  });

  it("preserves a post-open validation fault while one bounded close retry releases the real handle", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const initiatingCause = new Error("injected fstat validation failure");
    const transientCloseCause = new Error("injected transient close failure");
    let openCalls = 0;
    let closeCalls = 0;
    const dependencies: ProjectRunManagerDependencies = {
      ...defaultProjectRunManagerDependencies,
      openRunDirectory: async (directory) => {
        openCalls += 1;
        if (openCalls !== 1) return defaultProjectRunManagerDependencies.openRunDirectory(directory);
        const realHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        return createOpenRunDirectory(directory, async () => ({
          stat: async () => {
            throw initiatingCause;
          },
          close: async () => {
            closeCalls += 1;
            if (closeCalls === 1) throw transientCloseCause;
            await realHandle.close();
          },
        }));
      },
    };
    const projectRunManager = manager(workspaceRoot, [], new GitClient(5_000), {}, dependencies);

    const failure = await projectRunManager
      .prepare("real-handle-fstat-failure", { mode: "ephemeral_research" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "workspace_source_preparation_failed",
      cause: initiatingCause,
    });
    expect(closeCalls).toBe(2);
    expect(JSON.stringify(failure)).not.toContain(workspaceRoot);
    expect(JSON.stringify(failure)).not.toContain("launchpad-reservation");
    await expect(readdir(path.join(workspaceRoot, ".runs"))).resolves.toEqual([]);
    await expect(
      projectRunManager.prepare("real-handle-fstat-failure", { mode: "ephemeral_research" }),
    ).resolves.toMatchObject({ runBranch: null });
    expect(openCalls).toBe(2);
  });

  it("retains validation and cleanup causes when a real handle cannot be closed after two attempts", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const initiatingCause = new Error("injected fstat validation failure");
    const cleanupCause = new Error("injected permanent close failure");
    let closeCalls = 0;
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    const realHandle = await open(
      workspaceRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );

    try {
      const failure = await createOpenRunDirectory(workspaceRoot, async () => ({
        stat: async () => {
          throw initiatingCause;
        },
        close: async () => {
          closeCalls += 1;
          throw cleanupCause;
        },
      })).catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: "workspace_source_cleanup_failed",
        cause: initiatingCause,
        cleanupCause,
        details: {
          originalCode: "workspace_source_preparation_failed",
          cleanupCode: "directory_handle_close_failed",
        },
      });
      expect(closeCalls).toBe(2);
      expect(JSON.stringify(failure)).not.toContain(workspaceRoot);
    } finally {
      await realHandle.close();
    }
  });

  it("does not mark an opened directory wrapper closed until the real handle close succeeds", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const directory = path.join(fixtureRoot, "opened-directory");
    await mkdir(directory, { mode: 0o700 });
    const realHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const transientCloseCause = new Error("injected transient close failure");
    let closeCalls = 0;
    const opened = await createOpenRunDirectory(directory, async () => ({
      stat: () => realHandle.stat(),
      close: async () => {
        closeCalls += 1;
        if (closeCalls === 1) throw transientCloseCause;
        await realHandle.close();
      },
    }));

    try {
      await expect(opened.close()).rejects.toBe(transientCloseCause);
      await expect(opened.close()).resolves.toBeUndefined();
      await expect(opened.close()).resolves.toBeUndefined();
      expect(closeCalls).toBe(2);
    } finally {
      await realHandle.close().catch(() => undefined);
    }
  });

  it("retains both wrapper-close causes without leaking cleanup text when both bounded attempts fail", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const firstCloseCause = new Error("injected first close failure");
    const cleanupSecret = "fixture-secret-token";
    const cleanupCloseCause = new Error("cleanup failed at " + workspaceRoot + " with " + cleanupSecret);
    let closeCalls = 0;
    let realHandle: Awaited<ReturnType<typeof open>> | undefined;
    const dependencies: ProjectRunManagerDependencies = {
      ...defaultProjectRunManagerDependencies,
      openRunDirectory: async (directory) => {
        realHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        return createOpenRunDirectory(directory, async () => ({
          stat: () => realHandle!.stat(),
          close: async () => {
            closeCalls += 1;
            throw closeCalls === 1 ? firstCloseCause : cleanupCloseCause;
          },
        }));
      },
    };
    const projectRunManager = manager(workspaceRoot, [], new GitClient(5_000), {}, dependencies);

    try {
      const failure = await projectRunManager
        .prepare("wrapper-close-failure", { mode: "ephemeral_research" })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({
        code: "workspace_source_cleanup_failed",
        cause: expect.objectContaining({ cause: firstCloseCause }),
        cleanupCause: cleanupCloseCause,
        details: {
          originalCode: "workspace_source_preparation_failed",
          cleanupCode: "directory_handle_close_failed",
        },
      });
      expect(closeCalls).toBe(2);
      expect(JSON.stringify(failure)).not.toContain(workspaceRoot);
      expect(JSON.stringify(failure)).not.toContain(cleanupSecret);
    } finally {
      await realHandle?.close();
    }
  });

  it("cleans an exclusive final directory when the actual marker write fails and permits retry", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    let calls = 0;
    const dependencies: ProjectRunManagerDependencies = {
      ...defaultProjectRunManagerDependencies,
      writeReservationMarker: async (markerPath, markerToken) => {
        calls += 1;
        if (calls === 1) throw new Error("injected marker write failure");
        return defaultProjectRunManagerDependencies.writeReservationMarker(markerPath, markerToken);
      },
    };
    const projectRunManager = manager(workspaceRoot, [], new GitClient(5_000), {}, dependencies);

    await expect(projectRunManager.prepare("marker-write-failure", { mode: "ephemeral_research" })).rejects.toMatchObject({
      code: "workspace_source_preparation_failed",
      cause: expect.objectContaining({ message: "injected marker write failure" }),
    });
    await expect(readdir(path.join(workspaceRoot, ".runs"))).resolves.toEqual([]);
    await expect(projectRunManager.prepare("marker-write-failure", { mode: "ephemeral_research" })).resolves.toMatchObject({
      runBranch: null,
    });
    expect(calls).toBe(2);
  });

  it("cleans an exclusive final directory when post-marker identity finalization fails and permits retry", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    let calls = 0;
    const dependencies: ProjectRunManagerDependencies = {
      ...defaultProjectRunManagerDependencies,
      finalizeRunDirectoryIdentity: async (directory, opened) => {
        calls += 1;
        if (calls === 1) {
          await expect(readFile(path.join(directory, ".launchpad-reservation"), "utf8")).resolves.toMatch(/^[0-9a-f-]+\n$/);
          throw new Error("injected final identity failure");
        }
        return defaultProjectRunManagerDependencies.finalizeRunDirectoryIdentity(directory, opened);
      },
    };
    const projectRunManager = manager(workspaceRoot, [], new GitClient(5_000), {}, dependencies);

    await expect(projectRunManager.prepare("finalize-failure", { mode: "ephemeral_research" })).rejects.toMatchObject({
      code: "workspace_source_preparation_failed",
      cause: expect.objectContaining({ message: "injected final identity failure" }),
    });
    await expect(readdir(path.join(workspaceRoot, ".runs"))).resolves.toEqual([]);
    await expect(projectRunManager.prepare("finalize-failure", { mode: "ephemeral_research" })).resolves.toMatchObject({
      runBranch: null,
    });
    expect(calls).toBe(2);
  });

  it("preserves a quarantined directory when marker evidence contradicts ownership and releases the run id", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    let calls = 0;
    const dependencies: ProjectRunManagerDependencies = {
      ...defaultProjectRunManagerDependencies,
      writeReservationMarker: async (markerPath, markerToken) => {
        calls += 1;
        if (calls === 1) {
          await writeFile(markerPath, "contradictory-owner\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
          return;
        }
        return defaultProjectRunManagerDependencies.writeReservationMarker(markerPath, markerToken);
      },
    };
    const projectRunManager = manager(workspaceRoot, [], new GitClient(5_000), {}, dependencies);

    await expect(projectRunManager.prepare("marker-mismatch", { mode: "ephemeral_research" })).rejects.toMatchObject({
      code: "workspace_source_cleanup_failed",
      details: { originalCode: "workspace_source_preparation_failed" },
    });
    const preserved = await readdir(path.join(workspaceRoot, ".runs"));
    expect(preserved).toHaveLength(1);
    expect(preserved[0]).toMatch(/^\.quarantine-/);
    await expect(
      readFile(path.join(workspaceRoot, ".runs", preserved[0]!, ".launchpad-reservation"), "utf8"),
    ).resolves.toBe("contradictory-owner\n");
    await expect(projectRunManager.prepare("marker-mismatch", { mode: "ephemeral_research" })).resolves.toMatchObject({
      runBranch: null,
    });
    expect(calls).toBe(2);
  });

  it("never replaces a candidate created during reservation publication", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const candidate = path.join(workspaceRoot, ".runs", "collision");
    const target = path.join(fixtureRoot, "collision-target");
    await mkdir(target);
    await writeFile(path.join(target, "keep.txt"), "keep\n", "utf8");
    const projectRunManager = manager(workspaceRoot, [], new GitClient(5_000), {
      beforeRunDirectoryMkdirForTest: async () => {
        await symlink(target, candidate, "dir");
      },
    });

    await expect(projectRunManager.prepare("collision", { mode: "ephemeral_research" })).rejects.toMatchObject({
      code: "workspace_source_duplicate_run",
    });
    expect(await readFile(path.join(candidate, "keep.txt"), "utf8")).toBe("keep\n");
    expect((await lstat(candidate)).isSymbolicLink()).toBe(true);
  });

  it.each(["a..b", "a.lock", "a.", "x".repeat(121)])("rejects Git-invalid run id %s before Git worktree creation", async (runId) => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const { git, root } = await makeRepository(allowedRoot);

    await expect(
      manager(workspaceRoot, [allowedRoot], git).prepare(runId, {
        mode: "existing_repository",
        repositoryPath: root,
        revision: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "workspace_source_invalid_run_id" });
    expect(await git.run(root, ["worktree", "list", "--porcelain"])).not.toContain("canonical");
  });

  it("rejects a source whose real Git common directory is outside the allowed roots", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const allowedRoot = path.join(fixtureRoot, "allowed");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const separateGitDirectory = path.join(fixtureRoot, "outside-git-directory");
    const root = path.join(allowedRoot, "repository");
    const git = new GitClient(5_000);
    await mkdir(allowedRoot, { recursive: true });
    await git.run(allowedRoot, ["init", "-b", "main", "--separate-git-dir=" + separateGitDirectory, "--", root]);
    await writeFile(path.join(root, "README.md"), "initial\n", "utf8");
    await git.run(root, ["add", "--", "README.md"]);
    await git.run(root, ["commit", "-m", "initial"]);

    await expect(
      manager(workspaceRoot, [allowedRoot], git).prepare("separate-git", {
        mode: "existing_repository",
        repositoryPath: root,
        revision: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "workspace_source_git_common_dir_outside_allowed_roots" });
  });

  it("rejects a nested candidate when its resolved Git top-level lies outside the allowed root", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const outerRoot = path.join(fixtureRoot, "outer-repository");
    const allowedRoot = path.join(outerRoot, "allowed-child");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const git = new GitClient(5_000);
    await mkdir(allowedRoot, { recursive: true });
    await git.run(fixtureRoot, [
      "init",
      "-b",
      "main",
      "--separate-git-dir=" + path.join(allowedRoot, "common-git-directory"),
      "--",
      outerRoot,
    ]);
    await writeFile(path.join(outerRoot, "README.md"), "initial\n", "utf8");
    await git.run(outerRoot, ["add", "--", "README.md"]);
    await git.run(outerRoot, ["commit", "-m", "initial"]);
    await mkdir(path.join(allowedRoot, "candidate"), { recursive: true });

    await expect(
      manager(workspaceRoot, [allowedRoot], git).prepare("nested", {
        mode: "existing_repository",
        repositoryPath: path.join(allowedRoot, "candidate"),
        revision: "HEAD",
      }),
    ).rejects.toMatchObject({ code: "workspace_source_outside_allowed_roots" });
  });

  it("creates a new-project seed containing only README.md and .gitignore", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const git = new GitClient(5_000);

    const prepared = await manager(workspaceRoot, [], git).prepare("new-project", {
      mode: "new_project",
      projectName: "Todo",
    });

    expect(prepared.runBranch).toBe("launchpad/run/new-project");
    expect(prepared.source).toMatchObject({
      mode: "new_project",
      repositoryPath: prepared.canonicalWorkspacePath,
      requestedRevision: "seed",
      baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(prepared.headCommit).toBe(prepared.source.baseCommit);
    expect((await readdir(prepared.canonicalWorkspacePath)).sort()).toEqual([".git", ".gitignore", "README.md"]);
    expect(await readFile(path.join(prepared.canonicalWorkspacePath, "README.md"), "utf8")).toBe("# Todo\n");
    expect(await readFile(path.join(prepared.canonicalWorkspacePath, ".gitignore"), "utf8")).toBe("node_modules/\n");
    await expect(readFile(path.join(prepared.canonicalWorkspacePath, "AGENTS.md"), "utf8")).rejects.toThrow();
    expect(await git.isClean(prepared.canonicalWorkspacePath)).toBe(true);
  });

  it.each(["", "Todo\n# injected instructions", "x".repeat(121)])("rejects an invalid project name before writing seed content", async (projectName) => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");

    await expect(
      manager(workspaceRoot, [], new GitClient(5_000)).prepare("bad-project", {
        mode: "new_project",
        projectName,
      }),
    ).rejects.toMatchObject({ code: "workspace_source_invalid_project_name" });
  });

  it("prepares ephemeral research without a Git branch and keeps its fingerprint domain-separated", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const git = new GitClient(5_000);
    await mkdir(workspaceRoot, { recursive: true });
    const realWorkspaceRoot = await realpath(workspaceRoot);

    const first = await manager(workspaceRoot, [], git).prepare("research-1", { mode: "ephemeral_research" });
    const second = await manager(workspaceRoot, [], git).prepare("research-2", { mode: "ephemeral_research" });

    expect(first).toMatchObject({
      source: {
        mode: "ephemeral_research",
        repositoryPath: null,
        requestedRevision: null,
        baseCommit: null,
        sourceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      runBranch: null,
      canonicalWorkspacePath: path.join(realWorkspaceRoot, ".runs", "research-1", "research"),
      headCommit: null,
      state: "ready",
      attempts: [],
      integrations: [],
    });
    expect(first.source.sourceFingerprint).not.toBe(second.source.sourceFingerprint);
    expect(await readdir(first.canonicalWorkspacePath)).toEqual([]);
  });

  it("establishes private workspace and run-root boundaries owned by the current process", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    await manager(workspaceRoot, [], new GitClient(5_000)).prepare("private-boundary", { mode: "ephemeral_research" });

    for (const directory of [workspaceRoot, path.join(workspaceRoot, ".runs")]) {
      const info = await stat(directory);
      expect(info.mode & 0o077).toBe(0);
      if (typeof process.getuid === "function") expect(info.uid).toBe(process.getuid());
    }
  });

  it("rejects a .runs symlink that would escape the configured workspace root", async () => {
    const fixtureRoot = await temporaryDirectory("launchpad-project-run-");
    const workspaceRoot = path.join(fixtureRoot, "workspace");
    const escapedRunsRoot = path.join(fixtureRoot, "escaped-runs");
    const git = new GitClient(5_000);
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(escapedRunsRoot, { recursive: true });
    const escapedModeBefore = (await stat(escapedRunsRoot)).mode & 0o777;
    await symlink(escapedRunsRoot, path.join(workspaceRoot, ".runs"));

    await expect(manager(workspaceRoot, [], git).prepare("escaped", { mode: "ephemeral_research" })).rejects.toMatchObject({
      code: "workspace_source_preparation_failed",
    });
    expect(await readdir(escapedRunsRoot)).toEqual([]);
    expect((await stat(escapedRunsRoot)).mode & 0o777).toBe(escapedModeBefore);
  });
});
