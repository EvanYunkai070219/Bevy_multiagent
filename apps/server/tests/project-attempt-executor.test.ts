import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttemptWorkspaceManager } from "../src/attempt-workspace-manager.js";
import { ContributionCollector } from "../src/contribution-collector.js";
import { GitClient } from "../src/git-client.js";
import {
  ProjectAttemptExecutor,
  type ProjectAttemptPersistence,
} from "../src/project-attempt-executor.js";
import { ToolCallProtocolError } from "../src/tool-call-protocol.js";
import { detectFault } from "../src/orchestration/healing/fault-detector.js";
import type { AttemptWorkspaceRecord, ProjectRunRecord } from "../src/types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-attempt-executor-"));
  directories.push(root);
  const canonical = path.join(root, ".runs", "run-1", "canonical");
  await mkdir(canonical, { recursive: true });
  const git = new GitClient(5_000);
  await git.run(canonical, ["init", "-b", "main"]);
  await writeFile(path.join(canonical, "README.md"), "initial\n", "utf8");
  await git.run(canonical, ["add", "--", "README.md"]);
  await git.run(canonical, ["commit", "-m", "initial"]);
  const base = await git.head(canonical);
  const project: ProjectRunRecord = {
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
  };
  const gitClient = new GitClient(5_000);
  const persistence = memoryPersistence(project);
  const executor = new ProjectAttemptExecutor(
    new AttemptWorkspaceManager(gitClient),
    new ContributionCollector(gitClient),
    persistence,
  );
  return { root, git: gitClient, project, base, executor, persistence };
}

function memoryPersistence(project: ProjectRunRecord): ProjectAttemptPersistence & {
  failures: AttemptWorkspaceRecord[];
} {
  const failures: AttemptWorkspaceRecord[] = [];
  return {
    failures,
    async persistAttemptStarted(_runId, _expected, attempt) {
      project.attempts.push(structuredClone(attempt));
    },
    async persistContributionReady(_runId, expected, headCommit) {
      const attempt = project.attempts.find((item) =>
        item.attemptId === expected.attemptId && item.revision === expected.revision
      );
      if (!attempt) throw new Error("attempt_completion_stale");
      attempt.state = "contribution_ready";
      attempt.headCommit = headCommit;
      attempt.reason = null;
    },
    async persistAttemptFailure(_runId, expected, state, reason) {
      const attempt = project.attempts.find((item) =>
        item.attemptId === expected.attemptId && item.revision === expected.revision
      );
      if (!attempt) throw new Error("attempt_failure_stale");
      attempt.state = state;
      attempt.cleanup = "preserved";
      attempt.reason = reason;
      failures.push(structuredClone(attempt));
    },
    async persistCompensationEvidence(_runId, attempt, reason) {
      project.attempts.push({
        ...structuredClone(attempt),
        state: "failed",
        cleanup: "preserved",
        reason: "attempt_start_persistence_failed: " + reason,
      });
    },
    async persistAttemptRecoveryEvidence(_runId, expected) {
      const attempt = project.attempts.find((item) =>
        item.attemptId === expected.attemptId && item.revision === expected.revision
      );
      if (attempt) {
        attempt.cleanup = "preserved";
        attempt.reason = "attempt_failure_persistence_failed";
      }
    },
    loadProject() {
      return project;
    },
    async withAuthorityLock(_runId, operation) {
      return operation();
    },
  };
}

async function commitTodo(git: GitClient, workspacePath: string): Promise<string> {
  await writeFile(path.join(workspacePath, "todo.md"), "# todos\n", "utf8");
  await git.run(workspacePath, ["add", "--", "todo.md"]);
  await git.run(workspacePath, ["commit", "-m", "add todo app"]);
  return git.head(workspacePath);
}

describe("ProjectAttemptExecutor", () => {
  it("creates a persisted isolated attempt before invoking run", async () => {
    const { executor, project, git } = await fixture();
    let seenPath = "";
    let persistedAtStart = false;
    const executed = await executor.execute({
      runId: "run-1",
      project,
      attemptId: "leader-attempt",
      revision: 1,
      subtaskId: "leader",
      baseCommit: project.headCommit!,
      authorityEpoch: 0,
      throwIfCancelled() {},
      run: async (workspacePath, attempt) => {
        seenPath = workspacePath;
        persistedAtStart = project.attempts.some((item) =>
          item.attemptId === attempt.attemptId && item.state === "running"
        );
        const head = await commitTodo(git, workspacePath);
        return { output: "done\nLAUNCHPAD_COMMIT=" + head, threadId: null, usage: null };
      },
      quiesce: async () => {},
    });
    expect(persistedAtStart).toBe(true);
    expect(seenPath).toContain(path.join(".runs", "run-1", "attempts"));
    expect(executed.workerResult.status).toBe("contribution_ready");
    expect(executed.workerResult.contribution?.changedPaths).toEqual(["todo.md"]);
    expect(project.attempts[0]).toMatchObject({ state: "contribution_ready", subtaskId: "leader" });
  });

  it("awaits quiesce before Git inspection so a late write cannot enter evidence", async () => {
    const { executor, project, git } = await fixture();
    let releaseQuiesce!: () => void;
    const held = new Promise<void>((resolve) => { releaseQuiesce = resolve; });
    let quiesceEntered = false;
    const executePromise = executor.execute({
      runId: "run-1",
      project,
      attemptId: "late-write",
      revision: 1,
      subtaskId: "leader",
      baseCommit: project.headCommit!,
      authorityEpoch: 0,
      throwIfCancelled() {},
      run: async (workspacePath) => {
        const head = await commitTodo(git, workspacePath);
        return { output: "done\nLAUNCHPAD_COMMIT=" + head, threadId: null, usage: null };
      },
      quiesce: async () => {
        quiesceEntered = true;
        const workspacePath = project.attempts[0]?.workspacePath;
        if (!workspacePath) throw new Error("attempt workspace missing at quiesce");
        await writeFile(path.join(workspacePath, "late.txt"), "late mutation\n", "utf8");
        await held;
      },
    });

    await expect.poll(() => quiesceEntered, { timeout: 15_000 }).toBe(true);
    releaseQuiesce();
    const executed = await executePromise;
    expect(executed.workerResult.status).toBe("failed");
    expect(executed.workerResult.error).toContain("contribution_worktree_dirty");
    expect(executed.workerResult.contribution).toBeUndefined();
    expect(project.attempts[0]).toMatchObject({ state: "failed", cleanup: "preserved" });
  });

  it("classifies an unproven runtime absence as non-repairable infrastructure failure", async () => {
    const { executor, project, git } = await fixture();
    const executed = await executor.execute({
      runId: "run-1",
      project,
      attemptId: "absence-unproven",
      revision: 1,
      subtaskId: "leader",
      baseCommit: project.headCommit!,
      authorityEpoch: 0,
      throwIfCancelled() {},
      run: async (workspacePath) => {
        const head = await commitTodo(git, workspacePath);
        return { output: "done\nLAUNCHPAD_COMMIT=" + head, threadId: null, usage: null };
      },
      quiesce: async () => {
        throw new Error("runtime absence could not be proven");
      },
    });
    expect(executed.workerResult).toMatchObject({
      status: "failed",
      error: "infrastructure_failure",
    });
    expect(executed.workerResult.contribution).toBeUndefined();
    expect(project.attempts[0]).toMatchObject({ state: "failed", cleanup: "preserved" });
    expect(detectFault({ result: executed.workerResult })).toMatchObject({
      class: "infrastructure_failure",
      repairable: false,
    });
  });

  it("keeps combined absence and failure-persistence errors non-repairable", async () => {
    const { executor, project, git, persistence } = await fixture();
    persistence.persistAttemptFailure = async () => {
      throw new Error("attempt failure store unavailable");
    };
    const executed = await executor.execute({
      runId: "run-1",
      project,
      attemptId: "absence-and-persistence",
      revision: 1,
      subtaskId: "leader",
      baseCommit: project.headCommit!,
      authorityEpoch: 0,
      throwIfCancelled() {},
      run: async (workspacePath) => {
        const head = await commitTodo(git, workspacePath);
        return { output: "done\nLAUNCHPAD_COMMIT=" + head, threadId: null, usage: null };
      },
      quiesce: async () => {
        throw new Error("runtime absence could not be proven");
      },
    });
    expect(executed.workerResult.error).toBe(
      "infrastructure_failure; attempt_failure_persistence_failed",
    );
    expect(detectFault({ result: executed.workerResult })).toMatchObject({
      class: "infrastructure_failure",
      reasonCode: "infrastructure_failure",
      repairable: false,
    });
  });

  it("publishes one failed attempt when the commit marker is missing", async () => {
    const { executor, project } = await fixture();
    const executed = await executor.execute({
      runId: "run-1",
      project,
      attemptId: "no-marker",
      revision: 1,
      subtaskId: "leader",
      baseCommit: project.headCommit!,
      authorityEpoch: 0,
      throwIfCancelled() {},
      run: async () => ({ output: "the todo app is complete", threadId: null, usage: null }),
      quiesce: async () => {},
    });
    expect(executed.workerResult.status).toBe("failed");
    expect(executed.workerResult.error).toContain("contribution_marker_invalid");
    expect(project.attempts).toHaveLength(1);
    expect(project.attempts[0]).toMatchObject({
      state: "failed",
      cleanup: "preserved",
      subtaskId: "leader",
    });
  });

  it("repairs one invalid commit marker before quiesce and Git collection", async () => {
    const { executor, project, git } = await fixture();
    let repairCalls = 0;
    let committedHead = "";
    const order: string[] = [];
    const executed = await executor.execute({
      runId: "run-1",
      project,
      attemptId: "repair-marker",
      revision: 1,
      subtaskId: "leader",
      baseCommit: project.headCommit!,
      authorityEpoch: 0,
      throwIfCancelled() {},
      run: async (workspacePath) => {
        const head = await commitTodo(git, workspacePath);
        committedHead = head;
        order.push("run");
        return {
          output: "done\nLAUNCHPAD_COMMIT=<no commit made>",
          threadId: "worker-thread",
          usage: null,
        };
      },
      repairCommitMarker: async ({ runnerResult }) => {
        repairCalls += 1;
        order.push("repair");
        return {
          output: "done after repair\nLAUNCHPAD_COMMIT=" + committedHead,
          threadId: runnerResult.threadId,
          usage: runnerResult.usage,
        };
      },
      quiesce: async () => {
        order.push("quiesce");
      },
      afterQuiesce: async () => {
        order.push("afterQuiesce");
      },
    });

    expect(repairCalls).toBe(1);
    expect(order).toEqual(["run", "repair", "quiesce", "afterQuiesce"]);
    expect(executed.workerResult.status).toBe("contribution_ready");
    expect(executed.workerResult.output).toContain("done after repair");
    expect(project.attempts[0]).toMatchObject({ state: "contribution_ready" });
  });

  it("does not run contribution repair when the model emitted tool markup as text", async () => {
    const { executor, project } = await fixture();
    let repairCalls = 0;
    const executed = await executor.execute({
      runId: "run-1",
      project,
      attemptId: "tool-protocol-failed",
      revision: 1,
      subtaskId: "leader",
      baseCommit: project.headCommit!,
      authorityEpoch: 0,
      throwIfCancelled() {},
      run: async () => ({
        output:
          "I'll inspect the workspace.\n\n" +
          '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="exec_command">\n' +
          '<｜DSML｜parameter name="cmd" string="true">git status</｜DSML｜parameter>\n' +
          "</｜DSML｜invoke>\n</｜DSML｜tool_calls>",
        threadId: "worker-thread",
        usage: null,
      }),
      repairCommitMarker: async () => {
        repairCalls += 1;
        return null;
      },
      quiesce: async () => {},
    });

    expect(repairCalls).toBe(0);
    expect(executed.workerResult.status).toBe("failed");
    expect(executed.workerResult.error).toContain("contribution_tool_protocol_failed");
    expect(project.attempts[0]).toMatchObject({ state: "failed", cleanup: "preserved" });
  });

  it("does not run contribution repair when the runtime aborts tool-call protocol recovery", async () => {
    const { executor, project } = await fixture();
    let repairCalls = 0;
    const executed = await executor.execute({
      runId: "run-1",
      project,
      attemptId: "tool-protocol-thrown",
      revision: 1,
      subtaskId: "leader",
      baseCommit: project.headCommit!,
      authorityEpoch: 0,
      throwIfCancelled() {},
      run: async () => {
        throw new ToolCallProtocolError("Model repeatedly emitted tool-call markup");
      },
      repairCommitMarker: async () => {
        repairCalls += 1;
        return null;
      },
      quiesce: async () => {},
    });

    expect(repairCalls).toBe(0);
    expect(executed.workerResult.status).toBe("failed");
    expect(executed.workerResult.error).toContain("Model repeatedly emitted tool-call markup");
    expect(project.attempts[0]).toMatchObject({ state: "failed", cleanup: "preserved" });
  });

  it("runs afterQuiesce after quiesce and before Git collection", async () => {
    const { executor, project, git } = await fixture();
    const order: string[] = [];
    const executed = await executor.execute({
      runId: "run-1",
      project,
      attemptId: "after-quiesce",
      revision: 1,
      subtaskId: "leader",
      baseCommit: project.headCommit!,
      authorityEpoch: 0,
      throwIfCancelled() {},
      run: async (workspacePath) => {
        const head = await commitTodo(git, workspacePath);
        order.push("run");
        return { output: "done\nLAUNCHPAD_COMMIT=" + head, threadId: null, usage: null };
      },
      quiesce: async () => {
        order.push("quiesce");
      },
      afterQuiesce: async () => {
        order.push("afterQuiesce");
      },
    });
    expect(order).toEqual(["run", "quiesce", "afterQuiesce"]);
    expect(executed.workerResult.status).toBe("contribution_ready");
  });

  it("fails the attempt when afterQuiesce rejects without collecting Git evidence", async () => {
    const { executor, project, git } = await fixture();
    const executed = await executor.execute({
      runId: "run-1",
      project,
      attemptId: "protocol-invalid",
      revision: 1,
      subtaskId: "leader",
      baseCommit: project.headCommit!,
      authorityEpoch: 0,
      throwIfCancelled() {},
      run: async (workspacePath) => {
        const head = await commitTodo(git, workspacePath);
        return { output: "done\nLAUNCHPAD_COMMIT=" + head, threadId: null, usage: null };
      },
      quiesce: async () => {},
      afterQuiesce: async () => {
        throw new Error("Deterministic protocol failure: OPEN_TOOL_CALL.");
      },
    });
    expect(executed.workerResult.status).toBe("failed");
    expect(executed.workerResult.error).toContain("OPEN_TOOL_CALL");
    expect(executed.workerResult.contribution).toBeUndefined();
    expect(project.attempts[0]).toMatchObject({ state: "failed", cleanup: "preserved" });
  });
});
