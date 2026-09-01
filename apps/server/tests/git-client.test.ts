import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient } from "../src/git-client.js";
import { RepositoryTrajectoryObserver } from "../src/orchestration/workers/repository-trajectory.js";

const directories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeRepository(): Promise<{ git: GitClient; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-git-client-"));
  directories.push(root);
  const git = new GitClient(5_000);
  await git.run(root, ["init", "-b", "main"]);
  await git.run(root, ["config", "user.name", "Test"]);
  await git.run(root, ["config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(root, "README.md"), "initial\n", "utf8");
  await git.run(root, ["add", "--", "README.md"]);
  await git.run(root, ["commit", "-m", "initial"]);
  return { git, root };
}

describe("GitClient", () => {
  it("kills mutation: replace the last valid Git fingerprint with a fallback hash", async () => {
    const values = ["trusted-fingerprint", new Error("bounded git timeout")];
    const observer = new RepositoryTrajectoryObserver({
      trajectoryFingerprint: async () => {
        const value = values.shift();
        if (value instanceof Error) throw value;
        return value ?? "unexpected-fallback";
      },
    });

    expect(await observer.capture()).toBe("trusted-fingerprint");
    expect(await observer.capture()).toBe("trusted-fingerprint");
  });

  it("returns a clean head and NUL-safe changed paths", async () => {
    const { git, root } = await makeRepository();
    const base = await git.head(root);
    const newlinePath = "line\nbreak.txt";
    await writeFile(path.join(root, newlinePath), "content\n", "utf8");
    await git.run(root, ["add", "--", newlinePath]);
    await git.run(root, ["commit", "-m", "add newline path"]);
    const head = await git.head(root);

    expect(await git.changedPaths(root, base, head)).toEqual([newlinePath]);
    expect(await git.isClean(root)).toBe(true);
  });

  it("maps a bounded command timeout to a typed error", async () => {
    let invocation: { file: string; args: readonly string[]; options: Record<string, unknown> } | null = null;
    const timedOut = new GitClient(1_234, async (file, args, options) => {
      invocation = { file, args, options: options as Record<string, unknown> };
      const error = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
      throw error;
    });
    const { root } = await makeRepository();

    await expect(timedOut.run(root, ["status"])).rejects.toMatchObject({ code: "git_timeout" });
    expect(invocation).toMatchObject({
      file: "git",
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        root,
        "status",
      ],
      options: {
        timeout: 1_234,
        maxBuffer: 4 * 1024 * 1024,
        env: expect.objectContaining({
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_AUTHOR_NAME: "Launchpad Runtime",
          GIT_AUTHOR_EMAIL: "launchpad@example.invalid",
          GIT_COMMITTER_NAME: "Launchpad Runtime",
          GIT_COMMITTER_EMAIL: "launchpad@example.invalid",
        }),
      },
    });
    const invokedEnvironment = (invocation as unknown as { options: { env: NodeJS.ProcessEnv } }).options.env;
    expect(invokedEnvironment).not.toHaveProperty("GIT_DIR");
    expect(invokedEnvironment).not.toHaveProperty("GIT_WORK_TREE");
    expect(invokedEnvironment).not.toHaveProperty("GIT_CONFIG_COUNT");
  });

  it("ignores hostile inherited Git repository and config injection", async () => {
    const { root } = await makeRepository();
    const hostileRoot = await mkdtemp(path.join(tmpdir(), "launchpad-hostile-git-"));
    directories.push(hostileRoot);
    const globalConfig = path.join(hostileRoot, "global.gitconfig");
    await writeFile(globalConfig, "[core]\n\thooksPath = /tmp/hostile-hooks\n", "utf8");
    const git = new GitClient(5_000, execFileAsync, {
      environment: {
        ...process.env,
        GIT_DIR: path.join(hostileRoot, "not-a-repository"),
        GIT_WORK_TREE: hostileRoot,
        GIT_INDEX_FILE: path.join(hostileRoot, "index"),
        GIT_OBJECT_DIRECTORY: path.join(hostileRoot, "objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(hostileRoot, "alternate"),
        GIT_REPLACE_REF_BASE: "refs/hostile/",
        GIT_SHALLOW_FILE: path.join(hostileRoot, "shallow"),
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.bare",
        GIT_CONFIG_VALUE_0: "true",
      },
    });

    await expect(git.head(root)).resolves.toMatch(/^[0-9a-f]{40}$/);
    await expect(git.run(root, ["config", "--global", "--get", "core.hooksPath"]))
      .rejects.toMatchObject({ exitCode: 1 });
  });

  it("requests both binary patch and full object-index diff modes", async () => {
    let args: readonly string[] = [];
    const git = new GitClient(1_000, async (_file, invocationArgs) => {
      args = invocationArgs;
      return { stdout: Buffer.from(""), stderr: Buffer.alloc(0) };
    });

    await git.binaryDiff("/repository", "a".repeat(40), "b".repeat(40));

    expect(args).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-C",
      "/repository",
      "diff",
      "--binary",
      "--full-index",
      "--end-of-options",
      "a".repeat(40),
      "b".repeat(40),
    ]);
  });

  it("keeps revision strings after the Git option boundary", async () => {
    const { git, root } = await makeRepository();

    await expect(git.resolveCommit(root, "--help;touch escaped")).rejects.toMatchObject({
      code: "git_failed",
    });
  });

  it("removes a detached worktree idempotently", async () => {
    const { git, root } = await makeRepository();
    const detachedPath = path.join(root, "detached-worktree");
    await git.worktreeAdd(root, detachedPath, await git.head(root));

    await expect(git.worktreeRemove(root, detachedPath)).resolves.toBeUndefined();
    await expect(git.worktreeRemove(root, detachedPath)).resolves.toBeUndefined();
  });

  it("inspects exact worktree registration and never force-removes a dirty worktree", async () => {
    const { git, root } = await makeRepository();
    const target = path.join(root, "dirty-detached-worktree");
    const base = await git.head(root);
    await git.worktreeAdd(root, target, base);
    expect(await git.worktreeInfo(root, target)).toMatchObject({ path: target, head: base, detached: true });
    await writeFile(path.join(target, "unfinished.txt"), "keep\n", "utf8");

    await expect(git.worktreeRemoveClean(root, target)).rejects.toMatchObject({ code: "git_failed" });
    expect(await git.worktreeInfo(root, target)).not.toBeNull();
  });

  it("creates a self-contained no-origin detached checkout for unbranched attempts", async () => {
    const { git, root } = await makeRepository();
    const target = path.join(root, "isolated-attempt");
    const base = await git.head(root);
    await git.worktreeAdd(root, target, base);

    expect(await realpath(await git.commonGitDirectory(target))).toBe(
      await realpath(path.join(target, ".git")),
    );
    expect(await git.run(target, ["remote"])).toBe("");
    expect(await git.run(root, ["worktree", "list", "--porcelain"])).not.toContain(target);
    await expect(access(path.join(target, ".git", "objects", "info", "alternates")))
      .rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(path.join(target, "candidate.txt"), "candidate\n", "utf8");
    await git.run(target, ["add", "--", "candidate.txt"]);
    await git.run(target, ["commit", "-m", "candidate"]);
    const candidate = await git.head(target);
    await git.run(target, ["update-ref", "refs/heads/main", candidate]);
    expect(await git.head(root)).toBe(base);
    await expect(git.run(target, ["push", "origin", "main"])).rejects.toMatchObject({
      code: "git_failed",
    });
    expect(await git.head(root)).toBe(base);
  });

  it("admits local Codex commit identity without treating it as metadata tampering", async () => {
    const { git, root } = await makeRepository();
    const target = path.join(root, "codex-identity-attempt");
    const base = await git.head(root);
    await git.worktreeAdd(root, target, base);
    await git.run(target, ["config", "user.name", "Codex"]);
    await git.run(target, ["config", "user.email", "codex@openai.com"]);
    await writeFile(path.join(target, "todo.md"), "# todos\n", "utf8");
    await git.run(target, ["add", "--", "todo.md"]);
    await git.run(target, ["commit", "-m", "add todo app"]);

    await expect(git.validateStandaloneAttempt(target, base)).resolves.toBeUndefined();
  });

  it("creates a shallow exact-base attempt without unrelated repository history", async () => {
    const { git, root } = await makeRepository();
    const unreachable = await git.head(root);
    for (let index = 0; index < 12; index += 1) {
      await writeFile(path.join(root, "README.md"), `history ${index}\n`, "utf8");
      await git.run(root, ["add", "--", "README.md"]);
      await git.run(root, ["commit", "-m", `history ${index}`]);
    }
    const base = await git.head(root);
    const target = path.join(root, "bounded-attempt");

    await git.worktreeAdd(root, target, base);

    expect(await git.run(target, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    await expect(git.resolveCommit(target, unreachable)).rejects.toMatchObject({ code: "git_failed" });
    expect(await git.run(target, ["remote"])).toBe("");
    await expect(access(path.join(target, ".git", "FETCH_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("imports one exact attempt commit without changing canonical refs, head, or status", async () => {
    const { git, root } = await makeRepository();
    const base = await git.head(root);
    const target = path.join(root, "transfer-attempt");
    await git.worktreeAdd(root, target, base);
    await writeFile(path.join(target, "candidate.txt"), "candidate\n", "utf8");
    await git.run(target, ["add", "--", "candidate.txt"]);
    await git.run(target, ["commit", "-m", "candidate"]);
    const head = await git.head(target);
    const beforeRefs = await git.run(root, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const beforeStatus = await git.run(root, ["status", "--porcelain=v1", "--untracked-files=all"]);

    await git.importExactCommit(root, target, base, head);

    expect(await git.resolveCommit(root, head)).toBe(head);
    expect(await git.isAncestor(root, base, head)).toBe(true);
    expect(await git.head(root)).toBe(base);
    expect(await git.run(root, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(beforeRefs);
    expect(await git.run(root, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(beforeStatus);
    await expect(access(path.join(root, ".git", "FETCH_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects standalone attempt metadata tampering before reading contribution history", async () => {
    const mutations = [
      async (git: GitClient, target: string, base: string) =>
        git.run(target, ["update-ref", "refs/replace/" + base, base]),
      async (git: GitClient, target: string, base: string) =>
        git.run(target, ["update-ref", "refs/heads/worker-controlled", base]),
      async (git: GitClient, target: string) =>
        git.run(target, ["remote", "add", "origin", "file:///tmp/untrusted"]),
      async (git: GitClient, target: string) =>
        git.run(target, ["config", "url.file:///tmp/untrusted.insteadOf", "https://safe.invalid/"]),
      async (_git: GitClient, target: string) =>
        writeFile(path.join(target, ".git", "objects", "info", "alternates"), "/tmp/untrusted\n"),
      async (_git: GitClient, target: string) =>
        writeFile(path.join(target, ".git", "shallow"), "f".repeat(40) + "\n"),
      async (_git: GitClient, target: string) =>
        writeFile(path.join(target, ".git", "hooks", "post-commit"), "#!/bin/sh\nexit 0\n"),
    ];
    for (const mutate of mutations) {
      const { git, root } = await makeRepository();
      const base = await git.head(root);
      const target = path.join(root, "tampered-attempt");
      await git.worktreeAdd(root, target, base);
      await mutate(git, target, base);
      await expect(git.validateStandaloneAttempt(target, base)).rejects.toMatchObject({
        code: "git_metadata_tampered",
      });
    }
  }, 30_000);

  it("uses full strict fsck and rejects an unreachable corrupt object", async () => {
    const { git, root } = await makeRepository();
    const base = await git.head(root);
    const target = path.join(root, "corrupt-attempt");
    await git.worktreeAdd(root, target, base);
    const objectId = "a".repeat(40);
    const objectDirectory = path.join(target, ".git", "objects", objectId.slice(0, 2));
    await mkdir(objectDirectory, { recursive: true });
    const objectPath = path.join(objectDirectory, objectId.slice(2));
    await writeFile(objectPath, "corrupt-object", "utf8");

    await expect(git.validateStandaloneAttempt(target, base)).rejects.toMatchObject({
      code: "git_metadata_tampered",
    });
  }, 15_000);

  it("preserves a replaced quarantine and never imports its replacement", async () => {
    const { git: setupGit, root } = await makeRepository();
    const base = await setupGit.head(root);
    const target = path.join(root, "replacement-attempt");
    await setupGit.worktreeAdd(root, target, base);
    await writeFile(path.join(target, "candidate.txt"), "candidate\n", "utf8");
    await setupGit.run(target, ["add", "--", "candidate.txt"]);
    await setupGit.run(target, ["commit", "-m", "candidate"]);
    const head = await setupGit.head(target);
    let replacementPath = "";
    const git = new GitClient(5_000, execFileAsync, {
      beforeQuarantineTransferForTest: async (quarantine) => {
        replacementPath = quarantine;
        await rename(quarantine, quarantine + ".original");
        await mkdir(quarantine, { mode: 0o700 });
      },
    });

    await expect(git.importExactCommit(root, target, base, head)).rejects.toMatchObject({
      code: "git_metadata_tampered",
    });
    await expect(setupGit.resolveCommit(root, head)).rejects.toMatchObject({ code: "git_failed" });
    await expect(access(replacementPath)).resolves.toBeUndefined();
  });

  it("leaves a rejected worker object absent from canonical storage", async () => {
    const { git, root } = await makeRepository();
    const base = await git.head(root);
    const target = path.join(root, "rejected-transfer-attempt");
    await git.worktreeAdd(root, target, base);
    await writeFile(path.join(target, "candidate.txt"), "candidate\n", "utf8");
    await git.run(target, ["add", "--", "candidate.txt"]);
    await git.run(target, ["commit", "-m", "candidate"]);
    const head = await git.head(target);
    await git.run(target, ["config", "protocol.file.allow", "always"]);

    await expect(git.importExactCommit(root, target, base, head)).rejects.toMatchObject({
      code: "git_metadata_tampered",
    });
    await expect(git.resolveCommit(root, head)).rejects.toMatchObject({ code: "git_failed" });
  }, 15_000);

  it("propagates non-missing canonical-path errors instead of treating registration as absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-git-client-loop-"));
    directories.push(root);
    const loop = path.join(root, "loop");
    const target = path.join(root, "target");
    await symlink("loop", loop);
    const head = "a".repeat(40);
    const git = new GitClient(1_000, async () => ({
      stdout: Buffer.from(`worktree ${loop}\0HEAD ${head}\0detached\0`),
      stderr: Buffer.alloc(0),
    }));

    await expect(git.worktreeInfo(root, target)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("does not hide a missing canonical repository as idempotent cleanup", async () => {
    const { git, root } = await makeRepository();
    const missingRepository = path.join(root, "missing-repository");
    const target = path.join(root, "missing-worktree");

    await expect(git.worktreeRemove(missingRepository, target)).rejects.toMatchObject({
      code: "git_failed",
    });
  });

  it("creates a named worktree branch from the requested commit", async () => {
    const { git, root } = await makeRepository();
    const base = await git.head(root);
    const target = path.join(root, "branch-worktree");

    await git.worktreeAdd(root, target, base, "repair-branch");

    expect(await git.head(target)).toBe(base);
    expect(await git.run(target, ["branch", "--show-current"])).toBe("repair-branch");
    await git.worktreeRemove(root, target);
  });

  it("compare-deletes an explicitly named branch only at its expected commit", async () => {
    const { git, root } = await makeRepository();
    const target = path.join(root, "branch-cleanup-worktree");
    const branch = "launchpad/run/cleanup";
    const expected = await git.head(root);
    await git.worktreeAdd(root, target, expected, branch);

    await git.worktreeRemove(root, target);
    await git.branchDeleteIfAt(root, branch, expected);

    await expect(git.run(root, ["show-ref", "--verify", "--quiet", "refs/heads/" + branch])).rejects.toMatchObject({
      code: "git_failed",
    });
  });

  it("does not delete a branch repointed after its expected commit was recorded", async () => {
    const { git, root } = await makeRepository();
    const expected = await git.head(root);
    await git.run(root, ["branch", "launchpad/run/moved", expected]);
    await writeFile(path.join(root, "moved.txt"), "new head\n", "utf8");
    await git.run(root, ["add", "--", "moved.txt"]);
    await git.run(root, ["commit", "-m", "new head"]);
    const moved = await git.head(root);
    await git.run(root, ["update-ref", "refs/heads/launchpad/run/moved", moved]);

    await expect(git.branchDeleteIfAt(root, "launchpad/run/moved", expected)).rejects.toMatchObject({ code: "git_failed" });
    expect(await git.resolveCommit(root, "launchpad/run/moved")).toBe(moved);
  });

  it("creates a launchpad project branch only when missing at the exact commit", async () => {
    const { git, root } = await makeRepository();
    const commit = await git.head(root);
    const branch = "launchpad/project/22222222-2222-4222-8222-222222222222";
    const beforeStatus = await git.run(root, ["status", "--porcelain=v1", "--untracked-files=all"]);

    await git.createBranchIfMissingAt(root, branch, commit);
    await git.createBranchIfMissingAt(root, branch, commit);

    expect(await git.resolveCommit(root, branch)).toBe(commit);
    expect(await git.head(root)).toBe(commit);
    expect(await git.run(root, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(beforeStatus);
    expect(await git.run(root, ["branch", "--show-current"])).toBe("main");
  });

  it("does not move an existing launchpad project branch with createBranchIfMissingAt", async () => {
    const { git, root } = await makeRepository();
    const expected = await git.head(root);
    const branch = "launchpad/project/33333333-3333-4333-8333-333333333333";
    await git.createBranchIfMissingAt(root, branch, expected);
    await writeFile(path.join(root, "moved.txt"), "new head\n", "utf8");
    await git.run(root, ["add", "--", "moved.txt"]);
    await git.run(root, ["commit", "-m", "new head"]);
    const moved = await git.head(root);

    await expect(git.createBranchIfMissingAt(root, branch, moved)).rejects.toMatchObject({ code: "git_failed" });
    expect(await git.resolveCommit(root, branch)).toBe(expected);
    expect(await git.head(root)).toBe(moved);
  });

  it("kills mutation: remove expected-commit compare-and-swap from the project baseline ref", async () => {
    const { git, root } = await makeRepository();
    const expected = await git.head(root);
    const branch = "launchpad/project/44444444-4444-4444-8444-444444444444";
    await git.createBranchIfMissingAt(root, branch, expected);
    await writeFile(path.join(root, "next.txt"), "next\n", "utf8");
    await git.run(root, ["add", "--", "next.txt"]);
    await git.run(root, ["commit", "-m", "next"]);
    const next = await git.head(root);

    await git.updateBranchIfAt(root, branch, expected, next);
    expect(await git.resolveCommit(root, branch)).toBe(next);

    await expect(git.updateBranchIfAt(root, branch, expected, expected)).rejects.toMatchObject({
      code: "git_failed",
    });
    expect(await git.resolveCommit(root, branch)).toBe(next);
    expect(await git.head(root)).toBe(next);
    expect(await git.run(root, ["branch", "--show-current"])).toBe("main");
  });

  it("rejects non-project branches and unresolved commits for baseline ref updates", async () => {
    const { git, root } = await makeRepository();
    const commit = await git.head(root);
    const next = "b".repeat(40);

    await expect(git.createBranchIfMissingAt(root, "main", commit)).rejects.toThrow(/launchpad\/project/i);
    await expect(git.createBranchIfMissingAt(root, "launchpad/run/cleanup", commit)).rejects.toThrow(
      /launchpad\/project/i,
    );
    await expect(
      git.createBranchIfMissingAt(root, "launchpad/project/22222222-2222-4222-8222-222222222222", "HEAD"),
    ).rejects.toThrow(/40-character/i);
    await expect(git.updateBranchIfAt(root, "main", commit, next)).rejects.toThrow(/launchpad\/project/i);
    await expect(
      git.updateBranchIfAt(root, "launchpad/project/22222222-2222-4222-8222-222222222222", "HEAD", next),
    ).rejects.toThrow(/40-character/i);
  });

  it("returns history and diff evidence, then resets to a resolved commit", async () => {
    const { git, root } = await makeRepository();
    const base = await git.head(root);
    await writeFile(path.join(root, "change.txt"), "content\n", "utf8");
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 255, 1, 128, 0, 2]));
    await git.run(root, ["add", "--", "change.txt"]);
    await git.run(root, ["add", "--", "binary.bin"]);
    await git.run(root, ["commit", "-m", "change"]);
    const head = await git.head(root);

    expect(await git.isAncestor(root, base, head)).toBe(true);
    expect(await git.isAncestor(root, head, base)).toBe(false);
    expect(await git.commitCount(root, base, head)).toBe(1);
    const binaryDiff = (await git.binaryDiff(root, base, head)).toString("utf8");
    expect(binaryDiff).toContain("GIT binary patch");
    expect(binaryDiff.slice(binaryDiff.indexOf("diff --git a/binary.bin"))).toMatch(
      /index [0-9a-f]{40}\.\.[0-9a-f]{40}\nGIT binary patch/,
    );
    expect(await git.diffCheck(root, base, head)).toEqual([]);

    await writeFile(path.join(root, "trailing.txt"), "trailing space \n", "utf8");
    await git.run(root, ["add", "--", "trailing.txt"]);
    await git.run(root, ["commit", "-m", "trailing whitespace"]);
    expect(await git.diffCheck(root, head, await git.head(root))).toEqual(
      expect.arrayContaining([expect.stringMatching(/trailing whitespace/)]),
    );

    await git.resetHard(root, base);
    expect(await git.head(root)).toBe(base);
  });

  it("uses the runtime identity instead of fixture or global Git identity", async () => {
    const { git, root } = await makeRepository();

    expect(await git.run(root, ["show", "-s", "--format=%an <%ae>|%cn <%ce>", "HEAD"])).toBe(
      "Launchpad Runtime <launchpad@example.invalid>|Launchpad Runtime <launchpad@example.invalid>",
    );
  });

  it("aborts a conflicting cherry-pick without changing the checked-out commit", async () => {
    const { git, root } = await makeRepository();
    const base = await git.head(root);

    await writeFile(path.join(root, "README.md"), "main change\n", "utf8");
    await git.run(root, ["commit", "-am", "main change"]);
    const headBeforeConflict = await git.head(root);
    await git.run(root, ["checkout", "-b", "incoming", base]);
    await writeFile(path.join(root, "README.md"), "incoming change\n", "utf8");
    await git.run(root, ["commit", "-am", "incoming change"]);
    const incoming = await git.head(root);
    await git.run(root, ["checkout", "main"]);

    await expect(git.cherryPick(root, incoming)).rejects.toMatchObject({ code: "git_failed" });
    await git.abortCherryPick(root);
    expect(await git.head(root)).toBe(headBeforeConflict);
  });

  it("rejects unsafe worktree paths and non-resolved reset revisions", async () => {
    const { git, root } = await makeRepository();

    await expect(git.worktreeRemove(root, "relative-worktree")).rejects.toThrow(/absolute/i);
    await expect(git.resetHard(root, "HEAD")).rejects.toThrow(/40-character/i);
  });

  it("captures a trajectory fingerprint without mutating index, HEAD, config, refs, or worktree", async () => {
    const { git, root } = await makeRepository();
    await writeFile(path.join(root, "README.md"), "dirty\n", "utf8");
    await git.run(root, ["add", "--", "README.md"]);
    await writeFile(path.join(root, "untracked.bin"), Buffer.from([0, 1, 2, 255]));
    const before = {
      head: await git.head(root),
      staged: await git.run(root, ["diff", "--cached", "--name-only"]),
      status: await git.run(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
      refs: await git.run(root, ["for-each-ref", "--format=%(refname) %(objectname)"]),
      config: await git.run(root, ["config", "--local", "--list"]),
    };

    const fingerprint = await git.trajectoryFingerprint(root, 5_000);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await git.head(root)).toBe(before.head);
    expect(await git.run(root, ["diff", "--cached", "--name-only"])).toBe(before.staged);
    expect(await git.run(root, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(before.status);
    expect(await git.run(root, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(before.refs);
    expect(await git.run(root, ["config", "--local", "--list"])).toBe(before.config);
  });

  it("uses a bounded sanitized Git environment and never git-add for trajectory fingerprints", async () => {
    const invocations: string[][] = [];
    const git = new GitClient(5_000, async (_file, args, options) => {
      invocations.push([...args]);
      expect(options).toMatchObject({
        env: expect.objectContaining({
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_OPTIONAL_LOCKS: "0",
        }),
      });
      const invokedEnvironment = (options as { env: NodeJS.ProcessEnv }).env;
      expect(invokedEnvironment).not.toHaveProperty("GIT_INDEX_FILE");
      if (args.includes("status")) {
        return { stdout: Buffer.from("1 .M N... 100644 100644 100644 0 0 README.md\0"), stderr: Buffer.alloc(0) };
      }
      if (args.includes("diff")) {
        return { stdout: Buffer.from("binary-diff"), stderr: Buffer.alloc(0) };
      }
      return { stdout: Buffer.from(""), stderr: Buffer.alloc(0) };
    });

    await git.trajectoryFingerprint("/repository", 1_234);
    expect(invocations.some((args) => args.includes("add"))).toBe(false);
    expect(invocations.some((args) => args.includes("--porcelain=v2"))).toBe(true);
    expect(invocations.some((args) => args.includes("--binary"))).toBe(true);
    expect(invocations.some((args) => args.includes("--no-optional-locks"))).toBe(true);
    const statusArgs = invocations.find((args) => args.includes("status"));
    const diffArgs = invocations.find((args) => args.includes("diff"));
    expect(statusArgs).toContain("--no-optional-locks");
    expect(diffArgs).toContain("--no-optional-locks");
  });

  it("snapshots a dirty worktree through a private index without mutating the live index", async () => {
    const { git, root } = await makeRepository();
    const base = await git.head(root);
    await writeFile(path.join(root, "README.md"), "tracked\n", "utf8");
    await writeFile(path.join(root, "staged.txt"), "staged\n", "utf8");
    await git.run(root, ["add", "--", "staged.txt"]);
    await writeFile(path.join(root, "loose.txt"), "untracked\n", "utf8");
    const indexPath = path.join(root, ".git", "index");
    const beforeIndex = await readFile(indexPath);
    const beforeStaged = await git.run(root, ["diff", "--cached", "--name-only", "-z"]);
    const beforeStatus = await git.run(root, ["status", "--porcelain=v1", "--untracked-files=all"]);

    const snapshot = await git.snapshotWorkingTree(root, base);

    expect(snapshot.treeHash).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.run(root, ["rev-parse", snapshot.commit + "^"])).toBe(base);
    expect(await git.run(root, ["ls-tree", "-r", "--name-only", snapshot.treeHash])).toContain("loose.txt");
    expect(await git.run(root, ["ls-tree", "-r", "--name-only", snapshot.treeHash])).toContain("staged.txt");
    expect(await readFile(indexPath)).toEqual(beforeIndex);
    expect(await git.run(root, ["diff", "--cached", "--name-only", "-z"])).toBe(beforeStaged);
    expect(await git.run(root, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(beforeStatus);
    expect(await git.head(root)).toBe(base);
  });

  it("clones exact base and checkpoint objects into an isolated checkout without mutating the source", async () => {
    const { git, root } = await makeRepository();
    const base = await git.head(root);
    await writeFile(path.join(root, "next.txt"), "next\n", "utf8");
    await git.run(root, ["add", "--", "next.txt"]);
    await git.run(root, ["commit", "-m", "checkpoint"]);
    const checkpoint = await git.head(root);
    const beforeRefs = await git.run(root, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const target = path.join(root, "repair-candidate");

    await git.createIsolatedCheckout(root, target, base, checkpoint);

    expect(await git.head(target)).toBe(checkpoint);
    expect(await git.isAncestor(target, base, checkpoint)).toBe(true);
    expect(await realpath(await git.commonGitDirectory(target))).toBe(await realpath(path.join(target, ".git")));
    expect(await git.run(target, ["remote"])).toBe("");
    await expect(access(path.join(target, ".git", "FETCH_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(target, ".git", "objects", "info", "alternates"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await git.run(root, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(beforeRefs);
    expect(await git.head(root)).toBe(checkpoint);
  });
});

/**
 * Verifying a contribution must not depend on history the verifier was never
 * sent.
 *
 * `importExactCommit` fetches one commit into a throwaway bare repository and
 * checks it is exactly one commit on top of its base. It asked that question
 * with `merge-base --is-ancestor`, which walks past the base -- and the pack a
 * fetch produces is not guaranteed to carry the base's own ancestors. When it
 * does not, git cannot read a grandparent, exits 1, and a perfectly good
 * contribution is rejected as "failed ancestry verification". In the DAG
 * acceptance run that rejected roughly one integration in three.
 *
 * The question the check actually wants to ask needs only the commit itself:
 * is its parent the base?
 */
describe("verifying a commit sits directly on a base", () => {
  async function truncatedMirror(git: GitClient, source: string, head: string): Promise<string> {
    const mirror = await mkdtemp(path.join(tmpdir(), "launchpad-git-truncated-"));
    directories.push(mirror);
    await git.run(mirror, ["init", "--bare"]);
    await git.run(mirror, [
      "-c",
      "protocol.file.allow=always",
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--depth=2",
      "--",
      source,
      head,
    ]);
    // Depth alone is not the shape seen in the wild: a shallow repository has a
    // recorded boundary and git walks happily up to it. Dropping the marker
    // leaves what the failing imports actually held -- an ordinary repository
    // whose objects simply stop, with a parent link pointing at nothing.
    await rm(path.join(mirror, "shallow"), { force: true });
    return mirror;
  }

  async function threeCommits(): Promise<{ git: GitClient; root: string; commits: string[] }> {
    const { git, root } = await makeRepository();
    const commits = [await git.head(root)];
    for (const name of ["second", "third"]) {
      await writeFile(path.join(root, name + ".txt"), name + "\n", "utf8");
      await git.run(root, ["add", "--", name + ".txt"]);
      await git.run(root, ["commit", "-m", name]);
      commits.push(await git.head(root));
    }
    return { git, root, commits };
  }

  it("names the parents of a commit", async () => {
    const { git, root, commits } = await threeCommits();
    expect(await git.commitParents(root, commits[2]!)).toEqual([commits[1]!]);
  });

  it("reports no parents for a root commit", async () => {
    const { git, root, commits } = await threeCommits();
    expect(await git.commitParents(root, commits[0]!)).toEqual([]);
  });

  it("answers from the commit alone, where the history stops short", async () => {
    const { git, root, commits } = await threeCommits();
    const mirror = await truncatedMirror(git, root, commits[2]!);

    // The grandparent really is absent -- this is the shape a fetch can leave
    // behind, and the reason a walk past the base cannot be relied on. Whether
    // `merge-base` notices depends on how far git chooses to walk before it
    // prunes, which is why the walk is not what gets asserted.
    await expect(git.run(mirror, ["cat-file", "-e", commits[0]!])).rejects.toThrow();
    // The parent relationship needs only the commit's own object, so it holds.
    expect(await git.commitParents(mirror, commits[2]!)).toEqual([commits[1]!]);
  });

  it("names both parents of a merge, so a merge cannot pass as one commit", async () => {
    const { git, root, commits } = await threeCommits();
    await git.run(root, ["checkout", "-b", "side", commits[0]!]);
    await writeFile(path.join(root, "side.txt"), "side\n", "utf8");
    await git.run(root, ["add", "--", "side.txt"]);
    await git.run(root, ["commit", "-m", "side"]);
    const side = await git.head(root);
    await git.run(root, ["checkout", "main"]);
    await git.run(root, ["merge", "--no-ff", "-m", "merge", side]);

    expect(await git.commitParents(root, await git.head(root))).toEqual([commits[2]!, side]);
  });
});
