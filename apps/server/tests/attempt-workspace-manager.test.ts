import { access, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttemptWorkspaceManager,
  attemptWorkspaceLockSnapshotForTest,
  defaultAttemptWorkspaceManagerDependencies,
} from "../src/attempt-workspace-manager.js";
import { GitClient } from "../src/git-client.js";
import { ContributionCollector } from "../src/contribution-collector.js";
import type { ProjectRunRecord } from "../src/types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function fixture(): Promise<{ git: GitClient; manager: AttemptWorkspaceManager; project: ProjectRunRecord; base: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-attempt-workspace-"));
  directories.push(root);
  const canonical = path.join(root, ".runs", "run-1", "canonical");
  await mkdir(canonical, { recursive: true });
  const git = new GitClient(5_000);
  await git.run(canonical, ["init", "-b", "main"]);
  await writeFile(path.join(canonical, "README.md"), "initial\n", "utf8");
  await git.run(canonical, ["add", "--", "README.md"]);
  await git.run(canonical, ["commit", "-m", "initial"]);
  const base = await git.head(canonical);
  return {
    git,
    manager: new AttemptWorkspaceManager(git),
    project: {
      source: {
        mode: "new_project",
        repositoryPath: canonical,
        requestedRevision: "seed",
        baseCommit: base,
        sourceFingerprint: "f".repeat(64),
      },
      runBranch: "main",
      canonicalWorkspacePath: canonical,
      headCommit: base,
      state: "ready",
      attempts: [],
      integrations: [],
    },
    base,
  };
}

function persist(project: ProjectRunRecord, attempt: import("../src/types.js").AttemptWorkspaceRecord): void {
  project.attempts.push({ ...attempt });
}

function sidecarPath(project: ProjectRunRecord, attemptId: string, revision = 1): string {
  return path.join(path.dirname(project.canonicalWorkspacePath), "attempts", `.attempt-${attemptId}-r${revision}.json`);
}

function createInput(project: ProjectRunRecord, baseCommit: string, attemptId: string, revision = 1) {
  return { runId: "run-1", project, attemptId, revision, subtaskId: "build-api", baseCommit };
}

async function waitForAttemptLock(
  predicate: (snapshot: ReturnType<typeof attemptWorkspaceLockSnapshotForTest>) => boolean,
): Promise<ReturnType<typeof attemptWorkspaceLockSnapshotForTest>> {
  for (let check = 0; check < 200; check += 1) {
    const snapshot = attemptWorkspaceLockSnapshotForTest();
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Attempt lock did not reach the expected state");
}

describe("AttemptWorkspaceManager", () => {
  it("imports only the exact contribution bound to the persisted attempt owner", async () => {
    const { git, manager, project, base } = await fixture();
    const attempt = await manager.create(createInput(project, base, "owned-transfer"));
    await writeFile(path.join(attempt.workspacePath, "candidate.txt"), "candidate\n", "utf8");
    await git.run(attempt.workspacePath, ["add", "--", "candidate.txt"]);
    await git.run(attempt.workspacePath, ["commit", "-m", "candidate"]);
    const candidateHead = await git.head(attempt.workspacePath);
    const contribution = await new ContributionCollector(git).collect({
      attempt,
      subtaskId: attempt.subtaskId,
      workerOutput: "LAUNCHPAD_COMMIT=" + candidateHead,
    });
    const readyAttempt = { ...attempt, state: "contribution_ready" as const, headCommit: candidateHead };
    persist(project, readyAttempt);

    await expect(manager.importContribution(project, readyAttempt, {
      ...contribution,
      ownerFingerprint: "0".repeat(64),
    })).rejects.toThrow(/authority/);
    await expect(git.resolveCommit(project.canonicalWorkspacePath, candidateHead)).rejects.toMatchObject({ code: "git_failed" });

    await manager.importContribution(project, readyAttempt, contribution);
    expect(await git.resolveCommit(project.canonicalWorkspacePath, candidateHead)).toBe(candidateHead);
    expect(await git.head(project.canonicalWorkspacePath)).toBe(base);
  });

  it("removes a committed attempt only with exact integrated contribution authority", async () => {
    const { git, manager, project, base } = await fixture();
    const attempt = await manager.create(createInput(project, base, "integrated-cleanup"));
    persist(project, attempt);
    await writeFile(path.join(attempt.workspacePath, "candidate.txt"), "candidate\n", "utf8");
    await git.run(attempt.workspacePath, ["add", "--", "candidate.txt"]);
    await git.run(attempt.workspacePath, ["commit", "-m", "candidate"]);
    const candidateHead = await git.head(attempt.workspacePath);
    const contribution = await new ContributionCollector(git).collect({
      attempt,
      subtaskId: attempt.subtaskId,
      workerOutput: "LAUNCHPAD_COMMIT=" + candidateHead,
    });
    await git.importExactCommit(project.canonicalWorkspacePath, attempt.workspacePath, base, candidateHead);
    await git.cherryPick(project.canonicalWorkspacePath, candidateHead);
    const canonicalHead = await git.head(project.canonicalWorkspacePath);
    project.headCommit = canonicalHead;
    project.attempts[0] = {
      ...attempt,
      state: "integrated",
      headCommit: candidateHead,
    };
    const integratedAttempt = project.attempts[0]!;
    const integration = {
      contributionId: contribution.contributionId,
      subtaskId: attempt.subtaskId,
      canonicalHeadBefore: base,
      canonicalHeadAfter: canonicalHead,
      state: "integrated" as const,
      structuralDecision: "passed" as const,
      reason: null,
    };
    project.integrations.push(integration);

    await expect(manager.removeIntegrated(project, integratedAttempt, {
      ...contribution,
      ownerFingerprint: "0".repeat(64),
    }, integration)).resolves.toEqual({
      action: "preserved",
      attemptId: attempt.attemptId,
      reason: "unverifiable",
    });
    expect(await fileExists(attempt.workspacePath)).toBe(true);

    await expect(manager.removeIntegrated(project, integratedAttempt, contribution, integration)).resolves.toEqual({
      action: "removed",
      attemptId: attempt.attemptId,
    });
    expect(await fileExists(attempt.workspacePath)).toBe(false);
  });

  it("compensates an unpersisted clean attempt but preserves changed recovery evidence", async () => {
    const { manager, project, base } = await fixture();
    const clean = await manager.create(createInput(project, base, "unpersisted-clean"));
    await expect(manager.compensateUnpersisted(project, clean)).resolves.toEqual({
      action: "removed",
      attemptId: clean.attemptId,
    });
    expect(await fileExists(clean.workspacePath)).toBe(false);

    const changed = await manager.create(createInput(project, base, "unpersisted-changed"));
    await writeFile(path.join(changed.workspacePath, "evidence.txt"), "keep\n", "utf8");
    await expect(manager.compensateUnpersisted(project, changed)).resolves.toEqual({
      action: "preserved",
      attemptId: changed.attemptId,
      reason: "changed",
    });
    expect(await fileExists(changed.workspacePath)).toBe(true);
  });

  it("recreates one stable attempt ID only at a higher revision with a new owner", async () => {
    const { manager, project, base } = await fixture();
    const first = await manager.create(createInput(project, base, "stable-attempt", 1));
    persist(project, first);

    await expect(manager.create(createInput(project, base, "stable-attempt", 1)))
      .rejects.toMatchObject({ code: "attempt_workspace_busy" });
    const second = await manager.create(createInput(project, base, "stable-attempt", 2));

    expect(first).toMatchObject({ revision: 1, ownerToken: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
    expect(second).toMatchObject({ revision: 2, ownerToken: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
    expect(second.ownerToken).not.toBe(first.ownerToken);
    expect(second.workspacePath).not.toBe(first.workspacePath);
  });
  it("creates detached attempts from the project head without changing the canonical repository", async () => {
    const { git, manager, project, base } = await fixture();
    const branchBefore = await git.run(project.canonicalWorkspacePath, ["branch", "--show-current"]);
    const statusBefore = await git.run(project.canonicalWorkspacePath, ["status", "--porcelain=v1", "--untracked-files=all"]);

    const first = await manager.create({
      runId: "run-1", project, attemptId: "attempt-a", subtaskId: "build-api", baseCommit: base,
    });
    const second = await manager.create({
      runId: "run-1", project, attemptId: "attempt-b", subtaskId: "build-api", baseCommit: base,
    });

    expect(await git.head(first.workspacePath)).toBe(base);
    expect(await git.head(second.workspacePath)).toBe(base);
    expect(first.workspacePath).not.toBe(second.workspacePath);
    expect(await git.run(first.workspacePath, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).not.toBe(
      await git.run(second.workspacePath, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
    );
    expect(await git.run(first.workspacePath, ["branch", "--show-current"])).toBe("");
    expect(await fileExists(path.join(first.workspacePath, "AGENTS.md"))).toBe(false);
    expect(await fileExists(path.join(first.workspacePath, "CLAUDE.md"))).toBe(false);
    expect(await git.run(project.canonicalWorkspacePath, ["branch", "--show-current"])).toBe(branchBefore);
    expect(await git.run(project.canonicalWorkspacePath, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(statusBefore);
    expect(first).toMatchObject({ kind: "task", checkpointId: null });
    expect(second).toMatchObject({ kind: "task", checkpointId: null });
    const sidecar = JSON.parse(await readFile(sidecarPath(project, "attempt-a"), "utf8")) as Record<string, unknown>;
    expect(sidecar.kind).toBe("task");
    expect(sidecar.checkpointId).toBeNull();
    expect(sidecar).not.toHaveProperty("sourceOwnerFingerprint");
  });

  it("removes an unchanged owned attempt idempotently", async () => {
    const { manager, project, base } = await fixture();
    const attempt = await manager.create({
      runId: "run-1", project, attemptId: "clean-attempt", subtaskId: "build-api", baseCommit: base,
    });
    persist(project, attempt);

    await expect(manager.removeClean(project, attempt)).resolves.toBeUndefined();
    await expect(manager.removeClean(project, attempt)).resolves.toBeUndefined();
    expect(await fileExists(attempt.workspacePath)).toBe(false);
  });

  it("preserves changed attempts instead of resetting them for cleanup", async () => {
    const { manager, project, base } = await fixture();
    const attempt = await manager.create({
      runId: "run-1", project, attemptId: "dirty-attempt", subtaskId: "build-api", baseCommit: base,
    });
    persist(project, attempt);
    await writeFile(path.join(attempt.workspacePath, "unfinished.txt"), "keep me\n", "utf8");

    await expect(manager.recover(project, attempt)).resolves.toEqual({
      action: "preserved", attemptId: "dirty-attempt", reason: "changed",
    });
    expect(await fileExists(path.join(attempt.workspacePath, "unfinished.txt"))).toBe(true);
  });

  it("preserves a committed detached attempt that has not been integrated", async () => {
    const { git, manager, project, base } = await fixture();
    const attempt = await manager.create({
      runId: "run-1", project, attemptId: "committed-attempt", subtaskId: "build-api", baseCommit: base,
    });
    persist(project, attempt);
    await writeFile(path.join(attempt.workspacePath, "completed.txt"), "candidate\n", "utf8");
    await git.run(attempt.workspacePath, ["add", "--", "completed.txt"]);
    await git.run(attempt.workspacePath, ["commit", "-m", "candidate"]);

    await expect(manager.recover(project, attempt)).resolves.toEqual({
      action: "preserved", attemptId: "committed-attempt", reason: "committed",
    });
    expect(await fileExists(attempt.workspacePath)).toBe(true);
  });

  it("preserves a conflicted attempt rather than deleting conflict evidence", async () => {
    const { git, manager, project, base } = await fixture();
    const attempt = await manager.create({
      runId: "run-1", project, attemptId: "conflicted-attempt", subtaskId: "build-api", baseCommit: base,
    });
    persist(project, attempt);
    await writeFile(path.join(attempt.workspacePath, "README.md"), "attempt change\n", "utf8");
    await git.run(attempt.workspacePath, ["commit", "-am", "attempt change"]);
    await git.run(project.canonicalWorkspacePath, ["checkout", "-b", "conflict-source", base]);
    await writeFile(path.join(project.canonicalWorkspacePath, "README.md"), "source change\n", "utf8");
    await git.run(project.canonicalWorkspacePath, ["commit", "-am", "source change"]);
    await git.run(project.canonicalWorkspacePath, ["checkout", "main"]);
    await git.run(attempt.workspacePath, ["fetch", "--no-tags", project.canonicalWorkspacePath, "conflict-source"]);
    await git.run(attempt.workspacePath, ["merge", "FETCH_HEAD"] as string[]).catch(() => undefined);

    await expect(manager.recover(project, attempt)).resolves.toEqual({
      action: "preserved", attemptId: "conflicted-attempt", reason: "conflicted",
    });
    expect(await fileExists(attempt.workspacePath)).toBe(true);
  });

  it("preserves an unreadable attempt instead of treating it as clean", async () => {
    const { manager, project, base } = await fixture();
    const attempt = await manager.create({
      runId: "run-1", project, attemptId: "unreadable-attempt", subtaskId: "build-api", baseCommit: base,
    });
    persist(project, attempt);
    await rename(path.join(attempt.workspacePath, ".git"), path.join(attempt.workspacePath, ".git.hidden"));

    await expect(manager.recover(project, attempt)).resolves.toEqual({
      action: "preserved", attemptId: "unreadable-attempt", reason: "unverifiable",
    });
    expect(await fileExists(attempt.workspacePath)).toBe(true);
  });

  it("preserves a path whose run-owned attempt directory has been swapped for a symlink", async () => {
    const { manager, project, base } = await fixture();
    const attempt = await manager.create({
      runId: "run-1", project, attemptId: "swapped-attempt", subtaskId: "build-api", baseCommit: base,
    });
    persist(project, attempt);
    await rm(attempt.workspacePath, { recursive: true, force: true });
    await symlink(project.canonicalWorkspacePath, attempt.workspacePath);

    await expect(manager.recover(project, attempt)).resolves.toEqual({
      action: "preserved", attemptId: "swapped-attempt", reason: "unverifiable",
    });
  });

  it("rejects an attempts-parent symlink and leaves its external target untouched", async () => {
    const { manager, project, base } = await fixture();
    const attempts = path.join(path.dirname(project.canonicalWorkspacePath), "attempts");
    const external = path.join(path.dirname(path.dirname(project.canonicalWorkspacePath)), "external");
    await mkdir(external);
    await symlink(external, attempts);

    await expect(manager.create({
      runId: "run-1", project, attemptId: "escaped-attempt", subtaskId: "build-api", baseCommit: base,
    })).rejects.toThrow(/attempts directory/i);
    expect(await fileExists(path.join(external, "escaped-attempt"))).toBe(false);
  });

  it("preserves a forged or falsely integrated member rather than authorizing committed cleanup", async () => {
    const { git, manager, project, base } = await fixture();
    const attempt = await manager.create({
      runId: "run-1", project, attemptId: "forged-attempt", subtaskId: "build-api", baseCommit: base,
    });
    await writeFile(path.join(attempt.workspacePath, "candidate.txt"), "candidate\n", "utf8");
    await git.run(attempt.workspacePath, ["add", "--", "candidate.txt"]);
    await git.run(attempt.workspacePath, ["commit", "-m", "candidate"]);
    const head = await git.head(attempt.workspacePath);
    project.attempts.push({ ...attempt, state: "integrated", headCommit: head });
    project.integrations.push({
      contributionId: "unbound", subtaskId: attempt.subtaskId, canonicalHeadBefore: base,
      canonicalHeadAfter: head, state: "integrated", structuralDecision: "passed", reason: null,
    });

    await expect(manager.recover(project, { ...attempt, state: "integrated", headCommit: head })).resolves.toEqual({
      action: "preserved", attemptId: "forged-attempt", reason: "committed",
    });
  });

  it("preserves an existing but unregistered directory and stale registration when the path is missing", async () => {
    const { git, manager, project, base } = await fixture();
    const attempt = await manager.create({
      runId: "run-1", project, attemptId: "drift-attempt", subtaskId: "build-api", baseCommit: base,
    });
    persist(project, attempt);
    await git.worktreeRemove(project.canonicalWorkspacePath, attempt.workspacePath);
    await mkdir(attempt.workspacePath);
    await expect(manager.recover(project, attempt)).resolves.toEqual({
      action: "preserved", attemptId: "drift-attempt", reason: "unverifiable",
    });
  });

  it("uses an exclusive durable claim so concurrent creates cannot share an attempt target", async () => {
    const { git, project, base } = await fixture();
    const firstManager = new AttemptWorkspaceManager(git);
    const secondManager = new AttemptWorkspaceManager(git);
    let releaseAdd!: () => void;
    let signalAdd!: () => void;
    const addStarted = new Promise<void>((resolve) => { signalAdd = resolve; });
    const addMayFinish = new Promise<void>((resolve) => { releaseAdd = resolve; });
    const originalAdd = git.worktreeAdd.bind(git);
    const add = vi.spyOn(git, "worktreeAdd").mockImplementation(async (...args) => {
      signalAdd();
      await addMayFinish;
      await originalAdd(...args);
    });

    const first = firstManager.create(createInput(project, base, "racing-attempt"));
    await addStarted;
    const second = secondManager.create(createInput(project, base, "racing-attempt"));
    expect(await waitForAttemptLock((snapshot) => snapshot.active === 1 && snapshot.queued === 1)).toEqual(
      expect.objectContaining({ active: 1, queued: 1, keys: 1 }),
    );
    releaseAdd();
    const results = await Promise.allSettled([
      first,
      second,
    ]);
    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "attempt_workspace_busy" }),
    });
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(await git.worktreeInfo(project.canonicalWorkspacePath, path.join(
      path.dirname(project.canonicalWorkspacePath), "attempts", "racing-attempt-r1",
    ))).toMatchObject({ detached: true, head: base });
    expect(attemptWorkspaceLockSnapshotForTest()).toEqual(expect.objectContaining({ active: 0, queued: 0, keys: 0 }));
    expect(attemptWorkspaceLockSnapshotForTest().peakPending).toBeGreaterThanOrEqual(2);
  });

  it("serializes create and recovery for the same attempt across manager instances", async () => {
    const { git, project, base } = await fixture();
    let releaseAdd!: () => void;
    let signalAdd!: () => void;
    const addStarted = new Promise<void>((resolve) => { signalAdd = resolve; });
    const addMayFinish = new Promise<void>((resolve) => { releaseAdd = resolve; });
    const originalAdd = git.worktreeAdd.bind(git);
    vi.spyOn(git, "worktreeAdd").mockImplementationOnce(async (...args) => {
      signalAdd();
      await addMayFinish;
      await originalAdd(...args);
    });
    const input = createInput(project, base, "create-then-recover");
    const create = new AttemptWorkspaceManager(git).create(input);
    await addStarted;
    const ownership = JSON.parse(await readFile(sidecarPath(project, input.attemptId), "utf8"));
    const expected = {
      attemptId: input.attemptId,
      revision: input.revision,
      ownerToken: ownership.ownerToken as string,
      subtaskId: input.subtaskId,
      baseCommit: base,
      workspacePath: path.join(path.dirname(project.canonicalWorkspacePath), "attempts", input.attemptId + "-r1"),
      state: "running" as const,
      cleanup: "active" as const,
      headCommit: base,
      reason: null,
    };
    persist(project, expected);
    const recovery = new AttemptWorkspaceManager(git).recover(project, expected);
    expect(await waitForAttemptLock((snapshot) => snapshot.active === 1 && snapshot.queued === 1)).toEqual(
      expect.objectContaining({ active: 1, queued: 1, keys: 1 }),
    );
    releaseAdd();

    await expect(create).resolves.toMatchObject({ attemptId: input.attemptId });
    await expect(recovery).resolves.toEqual({ action: "removed", attemptId: input.attemptId });
    expect(await git.worktreeInfo(project.canonicalWorkspacePath, expected.workspacePath)).toBeNull();
    expect(await fileExists(expected.workspacePath)).toBe(false);
    expect(await fileExists(sidecarPath(project, input.attemptId))).toBe(false);
    expect(attemptWorkspaceLockSnapshotForTest()).toEqual(expect.objectContaining({ active: 0, queued: 0, keys: 0 }));
  });

  it("finalizes and returns the exact worktree when git add succeeds and then reports failure", async () => {
    const { git, project, base } = await fixture();
    const originalAdd = git.worktreeAdd.bind(git);
    vi.spyOn(git, "worktreeAdd").mockImplementationOnce(async (...args) => {
      await originalAdd(...args);
      throw new Error("injected add report failure");
    });

    await expect(new AttemptWorkspaceManager(git).create(
      createInput(project, base, "reported-failure"),
    )).resolves.toMatchObject({ attemptId: "reported-failure", baseCommit: base });
    expect(await git.worktreeInfo(project.canonicalWorkspacePath, path.join(
      path.dirname(project.canonicalWorkspacePath), "attempts", "reported-failure-r1",
    ))).toMatchObject({ detached: true, head: base });
  });

  it("removes an exact creating sidecar after a no-effect add failure so a later create can proceed", async () => {
    const { git, project, base } = await fixture();
    const add = vi.spyOn(git, "worktreeAdd").mockRejectedValueOnce(new Error("injected no-effect add failure"));
    const input = createInput(project, base, "no-effect-failure");

    await expect(new AttemptWorkspaceManager(git).create(input)).rejects.toThrow(/no-effect add failure/);
    add.mockRestore();
    await expect(new AttemptWorkspaceManager(git).create(input)).resolves.toMatchObject({
      attemptId: "no-effect-failure",
    });
  });

  it.each(["write", "rename"] as const)(
    "reconciles a one-shot ready-sidecar %s failure without leaving a poisoned attempt",
    async (operation) => {
      const { git, project, base } = await fixture();
      let injected = false;
      const manager = new AttemptWorkspaceManager(git, {}, {
        writeDurableTemp: async (target, content) => {
          if (!injected && operation === "write" && target.includes(".ready-")) {
            injected = true;
            throw new Error("injected ready write failure");
          }
          await defaultAttemptWorkspaceManagerDependencies.writeDurableTemp(target, content);
        },
        rename: async (source, target) => {
          if (!injected && operation === "rename" && source.includes(".ready-")) {
            injected = true;
            throw new Error("injected ready rename failure");
          }
          await defaultAttemptWorkspaceManagerDependencies.rename(source, target);
        },
      });

      await expect(manager.create(createInput(project, base, `ready-${operation}-failure`))).resolves.toMatchObject({
        attemptId: `ready-${operation}-failure`,
      });
      expect(JSON.parse(await readFile(sidecarPath(project, `ready-${operation}-failure`), "utf8"))).toMatchObject({
        state: "ready",
      });
    },
  );

  it("confirms directory durability when ready rename succeeds and then reports failure", async () => {
    const { git, project, base } = await fixture();
    let syncCalls = 0;
    const manager = new AttemptWorkspaceManager(git, {}, {
      rename: async (source, target) => {
        await defaultAttemptWorkspaceManagerDependencies.rename(source, target);
        if (source.includes(".ready-")) throw new Error("injected rename report failure");
      },
      syncDirectory: async (directory, expected) => {
        syncCalls += 1;
        await defaultAttemptWorkspaceManagerDependencies.syncDirectory(directory, expected);
      },
    });

    await expect(manager.create(createInput(project, base, "rename-published"))).resolves.toMatchObject({
      attemptId: "rename-published",
    });
    expect(syncCalls).toBe(2);
    expect(JSON.parse(await readFile(sidecarPath(project, "rename-published"), "utf8"))).toMatchObject({
      state: "ready",
    });
  });

  it("confirms a ready sidecar after the first parent-directory sync reports failure", async () => {
    const { git, project, base } = await fixture();
    let syncCalls = 0;
    const manager = new AttemptWorkspaceManager(git, {}, {
      syncDirectory: async (directory, expected) => {
        syncCalls += 1;
        if (syncCalls === 2) throw new Error("injected first ready sync failure");
        await defaultAttemptWorkspaceManagerDependencies.syncDirectory(directory, expected);
      },
    });

    await expect(manager.create(createInput(project, base, "sync-confirmed"))).resolves.toMatchObject({
      attemptId: "sync-confirmed",
    });
    expect(syncCalls).toBe(3);
  });

  it("preserves and rejects a ready sidecar when parent-directory durability stays unverifiable", async () => {
    const { git, project, base } = await fixture();
    let syncCalls = 0;
    const attemptId = "sync-unverifiable";
    const manager = new AttemptWorkspaceManager(git, {}, {
      syncDirectory: async (directory, expected) => {
        syncCalls += 1;
        if (syncCalls >= 2) throw new Error("injected persistent ready sync failure");
        await defaultAttemptWorkspaceManagerDependencies.syncDirectory(directory, expected);
      },
    });

    await expect(manager.create(createInput(project, base, attemptId))).rejects.toMatchObject({
      code: "attempt_workspace_unverifiable",
    });
    expect(syncCalls).toBe(3);
    expect(JSON.parse(await readFile(sidecarPath(project, attemptId), "utf8"))).toMatchObject({ state: "ready" });
    const workspacePath = path.join(path.dirname(project.canonicalWorkspacePath), "attempts", attemptId + "-r1");
    expect(await git.worktreeInfo(project.canonicalWorkspacePath, workspacePath)).toMatchObject({
      detached: true,
      head: base,
    });
    expect(await fileExists(workspacePath)).toBe(true);
  });

  it("returns an already-ready exact attempt after a crash between publication and return", async () => {
    const { git, project, base } = await fixture();
    let crash = true;
    const crashing = new AttemptWorkspaceManager(git, {
      afterReadyPublishedForTest: async () => {
        if (crash) {
          crash = false;
          throw new Error("injected crash after ready publication");
        }
      },
    });
    const input = createInput(project, base, "ready-before-return");

    await expect(crashing.create(input)).rejects.toThrow(/crash after ready/);
    const recovered = await new AttemptWorkspaceManager(git).create(input);
    expect(recovered).toMatchObject({ attemptId: "ready-before-return", baseCommit: base });
    expect(await git.worktreeInfo(project.canonicalWorkspacePath, recovered.workspacePath)).toMatchObject({
      detached: true,
      head: base,
    });
  });

  it("does not return an already-ready exact attempt without current-path durability confirmation", async () => {
    const { git, project, base } = await fixture();
    const attemptId = "ready-needs-confirmation";
    const input = createInput(project, base, attemptId);
    await expect(new AttemptWorkspaceManager(git, {
      afterReadyPublishedForTest: async () => { throw new Error("injected crash after ready publication"); },
    }).create(input)).rejects.toThrow(/crash after ready/);
    let confirmationCalls = 0;
    const cannotConfirm = new AttemptWorkspaceManager(git, {}, {
      syncDirectory: async () => {
        confirmationCalls += 1;
        throw new Error("injected recovery sync failure");
      },
    });

    await expect(cannotConfirm.create(input)).rejects.toMatchObject({
      code: "attempt_workspace_unverifiable",
    });
    expect(confirmationCalls).toBe(1);
    expect(JSON.parse(await readFile(sidecarPath(project, attemptId), "utf8"))).toMatchObject({ state: "ready" });
    const workspacePath = path.join(path.dirname(project.canonicalWorkspacePath), "attempts", attemptId + "-r1");
    expect(await git.worktreeInfo(project.canonicalWorkspacePath, workspacePath)).toMatchObject({
      detached: true,
      head: base,
    });
  });

  it("cleans stale creating and ready sidecars only after proving target and registration are absent", async () => {
    const { git, project, base } = await fixture();
    const creatingInput = createInput(project, base, "stale-creating");
    const add = vi.spyOn(git, "worktreeAdd").mockRejectedValueOnce(new Error("injected add failure"));
    const cannotUnlink = new AttemptWorkspaceManager(git, {}, {
      unlink: async () => { throw new Error("injected unlink failure"); },
    });
    await expect(cannotUnlink.create(creatingInput)).rejects.toThrow();
    add.mockRestore();
    expect(await fileExists(sidecarPath(project, "stale-creating"))).toBe(true);
    await expect(new AttemptWorkspaceManager(git).create(creatingInput)).resolves.toMatchObject({
      attemptId: "stale-creating",
    });

    const readyInput = createInput(project, base, "stale-ready");
    const ready = await new AttemptWorkspaceManager(git).create(readyInput);
    const oldOwner = JSON.parse(await readFile(sidecarPath(project, "stale-ready"), "utf8")).ownerToken;
    await git.worktreeRemoveClean(project.canonicalWorkspacePath, ready.workspacePath);
    const recreated = await new AttemptWorkspaceManager(git).create(readyInput);
    const newOwner = JSON.parse(await readFile(sidecarPath(project, "stale-ready"), "utf8")).ownerToken;
    expect(recreated.workspacePath).toBe(ready.workspacePath);
    expect(newOwner).not.toBe(oldOwner);
  });

  it("does not publish ready when the creating owner changes before the transition", async () => {
    const { git, project, base } = await fixture();
    const attemptId = "owner-changed";
    const manager = new AttemptWorkspaceManager(git, {
      beforeReadyPublishForTest: async () => {
        const marker = JSON.parse(await readFile(sidecarPath(project, attemptId), "utf8"));
        await writeFile(
          sidecarPath(project, attemptId),
          JSON.stringify({ ...marker, ownerToken: "00000000-0000-4000-8000-000000000000" }),
          "utf8",
        );
      },
    });

    await expect(manager.create(createInput(project, base, attemptId))).rejects.toMatchObject({
      code: "attempt_workspace_unverifiable",
    });
    expect(JSON.parse(await readFile(sidecarPath(project, attemptId), "utf8"))).toMatchObject({
      state: "creating",
      ownerToken: "00000000-0000-4000-8000-000000000000",
    });
  });

  it("reports removed when Git removes successfully before throwing and when sidecar unlink later fails", async () => {
    const { git, project, base } = await fixture();
    const attempt = await new AttemptWorkspaceManager(git).create(createInput(project, base, "remove-reported-failure"));
    persist(project, attempt);
    const originalRemove = git.worktreeRemoveClean.bind(git);
    vi.spyOn(git, "worktreeRemoveClean").mockImplementationOnce(async (...args) => {
      await originalRemove(...args);
      throw new Error("injected removal report failure");
    });
    const unlinkFailure = new AttemptWorkspaceManager(git, {}, {
      unlink: async () => { throw new Error("injected sidecar unlink failure"); },
    });

    await expect(unlinkFailure.recover(project, attempt)).resolves.toEqual({
      action: "removed",
      attemptId: "remove-reported-failure",
    });
    expect(await fileExists(sidecarPath(project, attempt.attemptId))).toBe(true);
    await expect(new AttemptWorkspaceManager(git).recover(project, attempt)).resolves.toEqual({
      action: "removed",
      attemptId: "remove-reported-failure",
    });
    expect(await fileExists(sidecarPath(project, attempt.attemptId))).toBe(false);
  });

  it("rechecks path identity immediately before deletion and never calls Git removal for a replacement", async () => {
    const { git, project, base } = await fixture();
    const originalManager = new AttemptWorkspaceManager(git);
    const attempt = await originalManager.create(createInput(project, base, "last-fence"));
    persist(project, attempt);
    const moved = attempt.workspacePath + "-moved";
    const remove = vi.spyOn(git, "worktreeRemoveClean");
    const manager = new AttemptWorkspaceManager(git, {
      beforeFinalRemovalFenceForTest: async () => {
        await rename(attempt.workspacePath, moved);
        await mkdir(attempt.workspacePath);
      },
    });

    await expect(manager.recover(project, attempt)).resolves.toEqual({
      action: "preserved",
      attemptId: "last-fence",
      reason: "unverifiable",
    });
    expect(remove).not.toHaveBeenCalled();
    expect(await fileExists(attempt.workspacePath)).toBe(true);
    expect(await fileExists(moved)).toBe(true);
  });

  it("removes an exact sidecar when its standalone checkout is already absent", async () => {
    const { git, project, base } = await fixture();
    const attempt = await new AttemptWorkspaceManager(git).create(createInput(project, base, "missing-registered"));
    persist(project, attempt);
    await rm(attempt.workspacePath, { recursive: true });

    await expect(new AttemptWorkspaceManager(git).recover(project, attempt)).resolves.toEqual({
      action: "removed",
      attemptId: "missing-registered",
    });
  });

  it("rejects a non-ready, mismatched, or unsafe request before creating an attempt", async () => {
    const { manager, project, base } = await fixture();
    const pending = { ...project, state: "preflighting" as const };

    await expect(manager.create({
      runId: "run-1", project: pending, attemptId: "pending-attempt", subtaskId: "build-api", baseCommit: base,
    })).rejects.toThrow(/ready Git-backed/);
    await expect(manager.create({
      runId: "run-1", project, attemptId: "../escape", subtaskId: "build-api", baseCommit: base,
    })).rejects.toThrow(/safe slug/);
    await expect(manager.create({
      runId: "run-1", project, attemptId: "wrong-base", subtaskId: "build-api", baseCommit: "0".repeat(40),
    })).rejects.toThrow(/project head/);
    expect(await fileExists(path.join(path.dirname(project.canonicalWorkspacePath), "attempts", "pending-attempt"))).toBe(false);
  });
});
