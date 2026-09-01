import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

type GitCommandCode = "git_timeout" | "git_failed";

export interface GitWorktreeInfo {
  readonly path: string;
  readonly head: string | null;
  readonly detached: boolean;
  readonly branch: string | null;
}

interface WorktreeScratch { path?: string; head?: string | null; detached?: boolean; branch?: string | null }

export interface GitClientOptions {
  environment?: NodeJS.ProcessEnv;
  /** @internal Deterministic quarantine replacement test hook. */
  beforeQuarantineTransferForTest?(quarantine: string): Promise<void>;
}

interface DirectoryIdentity {
  realPath: string;
  dev: number;
  ino: number;
}

type CommandFailure = Error & {
  code?: number | string;
  killed?: boolean;
  signal?: string | null;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
};

export class GitCommandError extends Error {
  readonly name = "GitCommandError";

  private constructor(
    readonly code: GitCommandCode,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly output: string,
  ) {
    super(
      code === "git_timeout"
        ? "Git command timed out: git " + args.join(" ")
        : "Git command failed: git " + args.join(" "),
    );
  }

  static from(error: unknown, args: readonly string[]): GitCommandError {
    const failure = error as CommandFailure;
    const timedOut = failure?.killed === true || failure?.code === "ETIMEDOUT";
    const output = [failure?.stdout, failure?.stderr]
      .filter((value): value is string | Buffer => value !== undefined && value !== "")
      .map((value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value))
      .join("\n")
      .trim();
    return new GitCommandError(
      timedOut ? "git_timeout" : "git_failed",
      [...args],
      typeof failure?.code === "number" ? failure.code : null,
      output,
    );
  }
}

export class GitMetadataError extends Error {
  readonly name = "GitMetadataError";
  readonly code = "git_metadata_tampered";

  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

export class GitClient {
  private readonly environment: NodeJS.ProcessEnv;

  constructor(
    private readonly timeoutMs: number,
    private readonly execute: typeof execFileAsync = execFileAsync,
    private readonly options: GitClientOptions = {},
  ) {
    this.environment = sanitizedGitEnvironment(options.environment ?? process.env);
  }

  async run(cwd: string, args: string[]): Promise<string> {
    return (await this.runRaw(cwd, args)).toString("utf8").trim();
  }

  async head(cwd: string): Promise<string> {
    return this.resolveCommit(cwd, "HEAD");
  }

  async isClean(cwd: string): Promise<boolean> {
    return (await this.run(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])).length === 0;
  }

  async resolveCommit(cwd: string, revision: string): Promise<string> {
    return this.run(cwd, ["rev-parse", "--verify", "--end-of-options", revision + "^{commit}"]);
  }

  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.run(cwd, ["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant]);
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1) return false;
      throw error;
    }
  }

  /**
   * The commit's own parents, read from the commit object and nothing else.
   *
   * This exists because `merge-base --is-ancestor` walks history, and the pack
   * a `git fetch` produces is not guaranteed to carry a commit's grandparents.
   * A verifier that only ever received two commits cannot complete that walk;
   * git reports `Could not read <sha>` and exits 1, which is indistinguishable
   * from a genuine "not an ancestor". Asking for the parent list needs only the
   * object that was definitely sent.
   */
  async commitParents(cwd: string, commit: string): Promise<string[]> {
    const output = await this.run(cwd, [
      "rev-list",
      "--parents",
      "--no-walk",
      "--end-of-options",
      commit,
    ]);
    const [self, ...parents] = output.trim().split(/\s+/).filter((value) => value.length > 0);
    if (self === undefined) throw new Error("Git returned no commit for " + commit);
    return parents;
  }

  async commitCount(cwd: string, base: string, head: string): Promise<number> {
    const output = await this.run(cwd, ["rev-list", "--count", "--end-of-options", base + ".." + head]);
    const count = Number(output);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Git returned an invalid commit count");
    }
    return count;
  }

  async changedPaths(cwd: string, base: string, head: string): Promise<string[]> {
    const output = await this.runRaw(cwd, ["diff", "--name-only", "-z", "--end-of-options", base, head]);
    return output
      .toString("utf8")
      .split("\0")
      .filter((entry) => entry.length > 0);
  }

  async binaryDiff(cwd: string, base: string, head: string): Promise<Buffer> {
    return this.runRaw(cwd, ["diff", "--binary", "--full-index", "--end-of-options", base, head]);
  }

  /** Validates the worker-owned repository before trusting any object or history evidence. */
  async validateStandaloneAttempt(cwd: string, base: string): Promise<void> {
    try {
      const gitDirectory = path.join(cwd, ".git");
      const [workspaceStat, gitStat] = await Promise.all([lstat(cwd), lstat(gitDirectory)]);
      if (
        !workspaceStat.isDirectory() || workspaceStat.isSymbolicLink() ||
        !gitStat.isDirectory() || gitStat.isSymbolicLink()
      ) throw new Error("Attempt repository boundary is not standalone");
      if ((await realpath(await this.commonGitDirectory(cwd))) !== (await realpath(gitDirectory))) {
        throw new Error("Attempt common Git directory escaped the workspace");
      }
      if ((await this.run(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"])) !== "") {
        throw new Error("Attempt repository contains worker-controlled refs");
      }
      if ((await this.run(cwd, ["remote"])) !== "") {
        throw new Error("Attempt repository contains a remote");
      }
      const alternates = path.join(gitDirectory, "objects", "info", "alternates");
      try {
        if ((await readFile(alternates)).length > 0) throw new Error("Attempt repository contains alternates");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const shallowLines = (await readFile(path.join(gitDirectory, "shallow"), "utf8"))
        .split(/\r?\n/)
        .filter(Boolean);
      if (shallowLines.length !== 1 || shallowLines[0] !== base) {
        throw new Error("Attempt shallow boundary does not match its exact base");
      }
      if ((await this.run(cwd, ["rev-parse", "--is-shallow-repository"])) !== "true") {
        throw new Error("Attempt repository is not shallow");
      }
      await this.validateLocalConfig(cwd);
      await this.validateHooks(gitDirectory);
      await this.run(cwd, ["fsck", "--strict", "--no-reflogs", "--no-progress"]);
    } catch (error) {
      if (error instanceof GitMetadataError) throw error;
      throw new GitMetadataError("Attempt Git metadata failed the standalone manifest", error);
    }
  }

  async diffCheck(cwd: string, base: string, head: string): Promise<string[]> {
    try {
      const output = await this.run(cwd, ["diff", "--check", "--end-of-options", base, head]);
      return output.length === 0 ? [] : output.split(/\r?\n/).filter(Boolean);
    } catch (error) {
      if (error instanceof GitCommandError && isDiffCheckFailure(error)) {
        return error.output.split(/\r?\n/).filter(Boolean);
      }
      throw error;
    }
  }

  async worktreeAdd(repository: string, target: string, commit: string, branch?: string): Promise<void> {
    assertAbsoluteWorktreePath(target);
    if (branch) {
      await this.run(repository, ["worktree", "add", "-b", branch, "--", target, commit]);
      return;
    }
    const resolved = await this.resolveCommit(repository, commit);
    await mkdir(target, { recursive: false, mode: 0o700 });
    await this.run(target, ["init"]);
    await this.run(target, [
      "fetch",
      "--depth=1",
      "--no-tags",
      "--no-write-fetch-head",
      "--",
      pathToFileURL(repository).href,
      resolved,
    ]);
    await this.run(target, ["checkout", "--detach", resolved]);
  }

  /**
   * Captures the current worktree (HEAD + index + untracked) into a commit whose
   * parent is `parent`, using a private GIT_INDEX_FILE so the live index is untouched.
   */
  async snapshotWorkingTree(cwd: string, parent: string): Promise<{ treeHash: string; commit: string }> {
    assertResolvedCommit(parent);
    const indexFile = path.join(cwd, ".git", "index.repair-" + randomUUID());
    try {
      await this.runRaw(cwd, ["read-tree", "HEAD"], this.timeoutMs, { GIT_INDEX_FILE: indexFile });
      await this.runRaw(cwd, ["add", "-A", "--"], this.timeoutMs, { GIT_INDEX_FILE: indexFile });
      const treeHash = (await this.runRaw(cwd, ["write-tree"], this.timeoutMs, { GIT_INDEX_FILE: indexFile }))
        .toString("utf8")
        .trim();
      const commit = (await this.runRaw(cwd, [
        "commit-tree",
        treeHash,
        "-p",
        parent,
        "-m",
        "launchpad repair checkpoint",
      ])).toString("utf8").trim();
      if (!/^[0-9a-f]{40}$/i.test(treeHash) || !/^[0-9a-f]{40}$/i.test(commit)) {
        throw new Error("Repair checkpoint snapshot did not produce object ids");
      }
      return { treeHash, commit };
    } finally {
      await unlink(indexFile).catch(() => undefined);
    }
  }

  async commitTree(cwd: string, tree: string, parent: string, message: string): Promise<string> {
    if (!/^[0-9a-f]{40}$/i.test(tree)) {
      throw new Error("commitTree requires a resolved 40-character tree");
    }
    assertResolvedCommit(parent);
    const commit = await this.run(cwd, ["commit-tree", tree, "-p", parent, "-m", message]);
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      throw new Error("commit-tree did not produce a commit id");
    }
    return commit;
  }

  /**
   * Copies only `base` and `head` into a new standalone repository. Never fetches
   * into the caller-supplied source and never writes remotes, FETCH_HEAD, or extra refs.
   */
  async createIsolatedCheckout(source: string, target: string, base: string, head: string): Promise<void> {
    assertAbsoluteWorktreePath(target);
    assertResolvedCommit(base);
    assertResolvedCommit(head);
    await mkdir(target, { recursive: false, mode: 0o700 });
    await this.run(target, ["init"]);
    const quarantine = await mkdtemp(path.join(path.dirname(target), "launchpad-repair-quarantine-"));
    const quarantineIdentity = await directoryIdentity(quarantine);
    try {
      await this.run(quarantine, ["init", "--bare"]);
      await this.run(quarantine, [
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--depth=2",
        "--no-tags",
        "--no-write-fetch-head",
        "--",
        pathToFileURL(source).href,
        head,
      ]);
      if (
        (await this.resolveCommit(quarantine, head)) !== head ||
        !(await this.isAncestor(quarantine, base, head))
      ) {
        throw new Error("Quarantined repair objects failed ancestry verification");
      }
      await this.run(quarantine, ["fsck", "--strict", "--no-reflogs", "--no-progress"]);
      await this.run(target, [
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--depth=2",
        "--no-tags",
        "--no-write-fetch-head",
        "--",
        pathToFileURL(quarantine).href,
        head,
      ]);
    } finally {
      try {
        await assertDirectoryIdentity(quarantine, quarantineIdentity);
        await rm(quarantine, { recursive: true, force: false });
      } catch (error) {
        throw new GitMetadataError(
          "Repair quarantine identity changed; replacement was preserved",
          error,
        );
      }
    }
    await this.stripCandidateMetadata(target);
    await this.run(target, ["checkout", "--detach", head]);
    await this.stripCandidateMetadata(target);
    await this.validateStandaloneAttempt(target, base);
  }

  /**
   * Imports only one already-verified candidate object graph. No ref, remote,
   * index, worktree or FETCH_HEAD mutation is permitted in the canonical repo.
   */
  async importExactCommit(
    canonical: string,
    attempt: string,
    base: string,
    head: string,
    expectedDiffHash?: string,
  ): Promise<void> {
    const [beforeHead, beforeStatus, beforeRefs] = await Promise.all([
      this.head(canonical),
      this.run(canonical, ["status", "--porcelain=v1", "--untracked-files=all"]),
      this.run(canonical, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    ]);
    await this.validateStandaloneAttempt(attempt, base);
    if ((await this.head(attempt)) !== head || !(await this.isClean(attempt))) {
      throw new Error("Attempt no longer matches the contribution head");
    }
    if (!(await this.isAncestor(attempt, base, head))) {
      throw new Error("Contribution head does not descend from its base");
    }
    const quarantineParent = await realpath(await this.commonGitDirectory(canonical));
    const quarantineParentIdentity = await directoryIdentity(quarantineParent);
    const quarantine = await mkdtemp(path.join(quarantineParent, "launchpad-import-quarantine-"));
    const quarantineIdentity = await directoryIdentity(quarantine);
    try {
      await this.run(quarantine, ["init", "--bare"]);
      await this.run(quarantine, [
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--",
        pathToFileURL(attempt).href,
        head,
      ]);
      // The claim under test is "head is exactly one commit on top of base",
      // and the parent list answers it from head's own object. An ancestry walk
      // does not: the pack a fetch produces is not guaranteed to carry base's
      // ancestors, and against a quarantine that received only two commits
      // `merge-base --is-ancestor` reported `Could not read <grandparent>` and
      // exited 1 -- rejecting sound contributions roughly one time in three.
      // Parent identity is also the stricter statement: it refuses a merge
      // whose second parent happens to be reachable from base, which a commit
      // count of one would have admitted.
      const parents = await this.commitParents(quarantine, head);
      if (
        (await this.resolveCommit(quarantine, head)) !== head ||
        parents.length !== 1 ||
        parents[0] !== base ||
        (await this.commitCount(quarantine, base, head)) !== 1
      ) throw new Error("Quarantined contribution object failed ancestry verification");
      await this.run(quarantine, ["fsck", "--strict", "--no-reflogs", "--no-progress"]);
      if (expectedDiffHash !== undefined) {
        const quarantineHash = createHash("sha256")
          .update(await this.binaryDiff(quarantine, base, head))
          .digest("hex");
        if (quarantineHash !== expectedDiffHash) {
          throw new Error("Quarantined contribution diff did not match recorded evidence");
        }
      }
      await this.options.beforeQuarantineTransferForTest?.(quarantine);
      await assertDirectoryIdentity(quarantineParent, quarantineParentIdentity);
      await assertDirectoryIdentity(quarantine, quarantineIdentity);
      await this.run(canonical, [
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--",
        pathToFileURL(quarantine).href,
        head,
      ]);
    } finally {
      try {
        await assertDirectoryIdentity(quarantineParent, quarantineParentIdentity);
        await assertDirectoryIdentity(quarantine, quarantineIdentity);
        await rm(quarantine, { recursive: true, force: false });
      } catch (error) {
        throw new GitMetadataError(
          "Import quarantine identity changed; replacement was preserved",
          error,
        );
      }
    }
    if ((await this.resolveCommit(canonical, head)) !== head || !(await this.isAncestor(canonical, base, head))) {
      throw new Error("Imported contribution object failed ancestry verification");
    }
    const [afterHead, afterStatus, afterRefs] = await Promise.all([
      this.head(canonical),
      this.run(canonical, ["status", "--porcelain=v1", "--untracked-files=all"]),
      this.run(canonical, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    ]);
    if (afterHead !== beforeHead || afterStatus !== beforeStatus || afterRefs !== beforeRefs) {
      throw new Error("Exact-object import changed canonical state");
    }
  }

  async worktreeRemove(repository: string, target: string): Promise<void> {
    assertAbsoluteWorktreePath(target);
    if (await this.isIsolatedCheckout(target)) {
      await rm(target, { recursive: true });
      return;
    }
    try {
      await this.run(repository, ["worktree", "remove", "--force", "--", target]);
    } catch (error) {
      if (error instanceof GitCommandError) {
        try {
          if (!(await this.isRegisteredWorktree(repository, target))) return;
        } catch {
          // The original removal error is more useful than a follow-up inspection error.
        }
      }
      throw error;
    }
  }

  /** Removes only when Git itself still sees the worktree as clean. */
  async worktreeRemoveClean(repository: string, target: string): Promise<void> {
    assertAbsoluteWorktreePath(target);
    if (await this.isIsolatedCheckout(target)) {
      if (!(await this.isClean(target))) {
        throw GitCommandError.from(
          Object.assign(new Error("Isolated checkout is dirty"), { code: 1 }),
          ["isolated-checkout-remove", target],
        );
      }
      await rm(target, { recursive: true });
      return;
    }
    await this.run(repository, ["worktree", "remove", "--", target]);
  }

  async worktreeInfo(repository: string, target: string): Promise<GitWorktreeInfo | null> {
    assertAbsoluteWorktreePath(target);
    const output = await this.runRaw(repository, ["worktree", "list", "--porcelain", "-z"]);
    const fields = output.toString("utf8").split("\0");
    let current: WorktreeScratch | null = null;
    for (const field of fields) {
      if (field.startsWith("worktree ")) {
        if (current && await sameWorktreePath(current.path, target)) return { ...completeWorktreeInfo(current), path: target };
        current = { path: field.slice("worktree ".length), head: null, detached: false, branch: null };
      } else if (current && field.startsWith("HEAD ")) {
        current.head = field.slice("HEAD ".length);
      } else if (current && field === "detached") {
        current.detached = true;
      } else if (current && field.startsWith("branch ")) {
        current.branch = field.slice("branch ".length);
      }
    }
    if (current && await sameWorktreePath(current.path, target)) {
      return { ...completeWorktreeInfo(current), path: target };
    }
    return this.isolatedCheckoutInfo(target);
  }

  async commonGitDirectory(cwd: string): Promise<string> {
    return this.run(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  }

  async branchDeleteIfAt(repository: string, branch: string, expectedCommit: string): Promise<void> {
    if (!/^launchpad\/run\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branch)) {
      throw new Error("branchDeleteIfAt only accepts managed run branches");
    }
    if (!/^[0-9a-f]{40}$/i.test(expectedCommit)) {
      throw new Error("branchDeleteIfAt requires a resolved 40-character commit");
    }
    await this.run(repository, ["update-ref", "-d", "refs/heads/" + branch, expectedCommit]);
  }

  async createBranchIfMissingAt(cwd: string, branch: string, commit: string): Promise<void> {
    assertProjectBaselineBranch(branch);
    assertResolvedCommit(commit);
    try {
      await this.run(cwd, ["update-ref", "refs/heads/" + branch, commit, ""]);
    } catch (error) {
      try {
        if ((await this.resolveCommit(cwd, branch)) === commit) return;
      } catch {
        // Preserve the original update-ref failure when the ref cannot be read.
      }
      throw error;
    }
  }

  async updateBranchIfAt(cwd: string, branch: string, expected: string, next: string): Promise<void> {
    assertProjectBaselineBranch(branch);
    assertResolvedCommit(expected);
    assertResolvedCommit(next);
    await this.run(cwd, ["update-ref", "refs/heads/" + branch, next, expected]);
  }

  async cherryPick(cwd: string, commit: string): Promise<void> {
    await this.run(cwd, ["cherry-pick", "--no-edit", "--end-of-options", commit]);
  }

  async abortCherryPick(cwd: string): Promise<void> {
    await this.run(cwd, ["cherry-pick", "--abort"]);
  }

  async resetHard(cwd: string, commit: string): Promise<void> {
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      throw new Error("resetHard requires an already resolved 40-character commit");
    }
    await this.run(cwd, ["reset", "--hard", commit]);
  }

  /** Removes all ignored/untracked files only after outer canonical authority validation. */
  async cleanUntracked(cwd: string): Promise<void> {
    await this.run(cwd, ["clean", "-fdx"]);
  }

  async trajectoryFingerprint(cwd: string, timeoutMs: number): Promise<string> {
    const status = await this.runRaw(
      cwd,
      ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all"],
      timeoutMs,
    );
    const tracked = await this.runRaw(
      cwd,
      ["--no-optional-locks", "diff", "--binary", "--full-index", "HEAD"],
      timeoutMs,
    );
    const untracked = await this.hashUntracked(cwd, status.toString("utf8"), timeoutMs);
    return createHash("sha256").update(status).update(tracked).update(untracked).digest("hex");
  }

  private async hashUntracked(cwd: string, porcelain: string, timeoutMs: number): Promise<string> {
    const paths: string[] = [];
    for (const entry of porcelain.split("\0")) {
      if (entry.startsWith("? ")) paths.push(entry.slice(2));
    }
    const hash = createHash("sha256");
    for (const relative of paths.slice(0, 32)) {
      if (relative.includes("\0") || relative.startsWith("-")) continue;
      try {
        const contents = await this.runRaw(
          cwd,
          ["hash-object", "--", relative],
          timeoutMs,
        );
        hash.update(relative).update(contents);
      } catch {
        hash.update(relative).update("unreadable");
      }
    }
    return hash.digest("hex");
  }

  private async runRaw(
    cwd: string,
    args: string[],
    timeoutMs = this.timeoutMs,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<Buffer> {
    try {
      const result = await this.execute("git", [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        cwd,
        ...args,
      ], {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        encoding: "buffer",
        env: extraEnv ? { ...this.environment, ...extraEnv } : this.environment,
      });
      return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
    } catch (error) {
      throw GitCommandError.from(error, args);
    }
  }

  async validateLocalConfig(cwd: string): Promise<void> {
    const output = await this.runRaw(cwd, ["config", "--local", "--null", "--list"]);
    const allowed = new Map<string, RegExp>([
      ["core.repositoryformatversion", /^0$/],
      ["core.filemode", /^(?:true|false)$/],
      ["core.bare", /^false$/],
      ["core.logallrefupdates", /^true$/],
      ["core.ignorecase", /^(?:true|false)$/],
      ["core.precomposeunicode", /^(?:true|false)$/],
      ["user.name", /^.+$/],
      ["user.email", /^.+$/],
    ]);
    for (const item of output.toString("utf8").split("\0").filter(Boolean)) {
      const separator = item.indexOf("\n");
      if (separator <= 0) throw new Error("Attempt local Git config was malformed");
      const key = item.slice(0, separator).toLowerCase();
      const value = item.slice(separator + 1);
      if (!allowed.get(key)?.test(value)) {
        throw new Error("Attempt local Git config contains an unsafe key");
      }
    }
  }

  private async validateHooks(gitDirectory: string): Promise<void> {
    const hooksDirectory = path.join(gitDirectory, "hooks");
    for (const entry of await readdir(hooksDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".sample")) {
        throw new Error("Attempt repository contains an unexpected hook");
      }
    }
  }

  private async stripCandidateMetadata(cwd: string): Promise<void> {
    const remotes = (await this.run(cwd, ["remote"])).split(/\r?\n/).filter(Boolean);
    for (const remote of remotes) {
      await this.run(cwd, ["remote", "remove", remote]);
    }
    const refs = (await this.run(cwd, ["for-each-ref", "--format=%(refname)"])).split(/\r?\n/).filter(Boolean);
    for (const ref of refs) {
      await this.run(cwd, ["update-ref", "-d", ref]);
    }
    await unlink(path.join(cwd, ".git", "FETCH_HEAD")).catch(() => undefined);
    const alternates = path.join(cwd, ".git", "objects", "info", "alternates");
    await unlink(alternates).catch(() => undefined);
  }

  private async isRegisteredWorktree(repository: string, target: string): Promise<boolean> {
    return (await this.worktreeInfo(repository, target)) !== null;
  }

  private async isIsolatedCheckout(target: string): Promise<boolean> {
    return (await this.isolatedCheckoutInfo(target)) !== null;
  }

  private async isolatedCheckoutInfo(target: string): Promise<GitWorktreeInfo | null> {
    try {
      const targetStat = await lstat(target);
      const gitStat = await lstat(path.join(target, ".git"));
      if (
        !targetStat.isDirectory() || targetStat.isSymbolicLink() ||
        !gitStat.isDirectory() || gitStat.isSymbolicLink()
      ) return null;
      const common = await realpath(await this.commonGitDirectory(target));
      if (common !== await realpath(path.join(target, ".git"))) return null;
      const head = await this.head(target);
      const branch = await this.run(target, ["branch", "--show-current"]);
      return { path: target, head, detached: branch.length === 0, branch: branch || null };
    } catch (error) {
      if (isMissingPath(error)) return null;
      throw error;
    }
  }
}

function sanitizedGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "SYSTEMROOT", "WINDIR", "PATHEXT"]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Launchpad Runtime",
    GIT_AUTHOR_EMAIL: "launchpad@example.invalid",
    GIT_COMMITTER_NAME: "Launchpad Runtime",
    GIT_COMMITTER_EMAIL: "launchpad@example.invalid",
  };
}

async function directoryIdentity(target: string): Promise<DirectoryIdentity> {
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Git quarantine boundary was not a real directory");
  }
  return { realPath: await realpath(target), dev: stat.dev, ino: stat.ino };
}

async function assertDirectoryIdentity(target: string, expected: DirectoryIdentity): Promise<void> {
  const actual = await directoryIdentity(target);
  if (
    actual.realPath !== expected.realPath ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) throw new Error("Git quarantine directory identity changed");
}

function completeWorktreeInfo(info: WorktreeScratch): GitWorktreeInfo {
  if (!info.path || info.head === undefined || info.detached === undefined || info.branch === undefined) {
    throw new Error("Git returned malformed worktree registration");
  }
  return { path: info.path, head: info.head, detached: info.detached, branch: info.branch };
}

async function sameWorktreePath(left: string | undefined, right: string): Promise<boolean> {
  if (!left) return false;
  if (left === right) return true;
  return (await canonicalPath(left)) === (await canonicalPath(right));
}

/** Resolves aliases even when the final worktree directory was removed but Git still registers it. */
async function canonicalPath(target: string): Promise<string> {
  const missing: string[] = [];
  let cursor = path.resolve(target);
  for (;;) {
    try { return path.join(await realpath(cursor), ...missing.reverse()); }
    catch (error) {
      if (!isMissingPath(error)) throw error;
      if (path.dirname(cursor) === cursor) throw error;
      missing.push(path.basename(cursor)); cursor = path.dirname(cursor);
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function assertAbsoluteWorktreePath(target: string): void {
  if (!path.isAbsolute(target)) {
    throw new Error("Git worktree paths must be absolute");
  }
}

function isDiffCheckFailure(error: GitCommandError): boolean {
  return (
    (error.exitCode === 1 || error.exitCode === 2) &&
    error.output.split(/\r?\n/).some((line) => /:\d+:\s+(?:trailing whitespace|space before tab)/i.test(line))
  );
}

const PROJECT_BASELINE_BRANCH =
  /^launchpad\/project\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertProjectBaselineBranch(branch: string): void {
  if (!PROJECT_BASELINE_BRANCH.test(branch)) {
    throw new Error("baseline ref updates only accept launchpad/project/<uuid> branches");
  }
}

function assertResolvedCommit(commit: string): void {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("baseline ref updates require a resolved 40-character commit");
  }
}
