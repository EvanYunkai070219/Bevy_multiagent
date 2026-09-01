import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitClient, GitCommandError } from "../src/git-client.js";
import {
  TrajectoryMonitor,
  type EvidenceSnapshot,
} from "../src/orchestration/workers/trajectory.js";
import { RepositoryTrajectoryObserver } from "../src/orchestration/workers/repository-trajectory.js";
import type { RunEventDraft, RunEventSink } from "../src/run-events.js";
import type { SubtaskContract, VerificationResult } from "../src/types.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) =>
      import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })),
    ),
  );
});

function draft(partial: Partial<RunEventDraft> & Pick<RunEventDraft, "kind" | "name">): RunEventDraft {
  return {
    spanId: partial.spanId ?? "span-1",
    parentSpanId: "run",
    status: partial.status ?? "ok",
    startedAt: partial.startedAt ?? "2026-08-29T00:00:00.000Z",
    endedAt: partial.endedAt === undefined ? "2026-08-29T00:00:01.000Z" : partial.endedAt,
    durationMs: partial.durationMs === undefined ? 1_000 : partial.durationMs,
    input: partial.input ?? {},
    output: partial.output ?? {},
    error: partial.error === undefined ? null : partial.error,
    attributes: partial.attributes ?? {},
    usage: partial.usage ?? null,
    ...partial,
  };
}

function failedTest(text: string, extra: Partial<RunEventDraft> = {}): RunEventDraft {
  return draft({
    kind: "command",
    name: "bash",
    status: "error",
    input: { command: "npm test" },
    output: { exitCode: 1, text },
    error: { message: text, code: "1" },
    ...extra,
  });
}

function fileChange(paths: string[], extra: Partial<RunEventDraft> = {}): RunEventDraft {
  return draft({
    kind: "file_change",
    name: "apply_patch",
    input: { paths },
    output: { changedFiles: paths },
    ...extra,
  });
}

function contract(overrides: Partial<SubtaskContract> = {}): SubtaskContract {
  return {
    subtaskId: "worker-1",
    revision: 1,
    contractKey: "demo",
    inputs: [],
    outputs: ["src/app.ts"],
    dependencyIds: [],
    downstreamConsumers: ["tester"],
    allowedMutationPaths: ["src/"],
    protectedPaths: ["package-lock.json", ".github/workflows/ci.yml"],
    artifactSchemaIds: [],
    targetedGateIds: ["targeted"],
    contractGateIds: ["contract"],
    consumerGateIds: ["consumer"],
    regressionGateIds: ["regression"],
    authorizedTools: ["bash"],
    ...overrides,
  };
}

function monitor(options: ConstructorParameters<typeof TrajectoryMonitor>[0] = {}) {
  return new TrajectoryMonitor({
    attemptId: "attempt-1",
    checkpointMs: 60_000,
    maxSteps: 20,
    repeatedSignatureLimit: 3,
    ...options,
  });
}

describe("TrajectoryMonitor evidence progression", () => {
  it("warns on the second identical checkpoint and stops on the third", () => {
    const guard = monitor();
    const first = failedTest("FAIL  tests/demo.test.ts");
    const sameSecond = failedTest("FAIL  tests/demo.test.ts", { spanId: "span-2", durationMs: 2_000 });
    const sameThird = failedTest("FAIL  tests/demo.test.ts", { spanId: "span-3", durationMs: 3_000 });
    expect(guard.observe(first).action).toBe("continue");
    expect(guard.observe(sameSecond).action).toBe("warn");
    expect(guard.observe(sameThird)).toMatchObject({ action: "stop", reason: "no_evidence_progress" });
  });

  it("continues when trusted failure counts improve", () => {
    const guard = monitor();
    expect(guard.observe(failedTest("Tests: 5 failed, 0 passed")).action).toBe("continue");
    expect(guard.observe(failedTest("Tests: 3 failed, 2 passed")).action).toBe("continue");
    expect(guard.observe(failedTest("Tests: 1 failed, 4 passed")).action).toBe("continue");
    expect(guard.progress().state).toBe("progressing");
  });

  it("stops after three identical normalized commands despite volatile ids and durations", () => {
    const guard = monitor();
    const first = draft({
      kind: "command",
      name: "bash",
      status: "error",
      spanId: "11111111-1111-4111-8111-111111111111",
      durationMs: 12_345,
      startedAt: "2026-08-29T00:00:01.000Z",
      input: { command: "python3 compile.py" },
      output: { exitCode: 1, text: "failed in 1.23s at 2026-08-29T00:00:01.000Z" },
      error: { message: "compile failed", code: "1" },
    });
    const second = draft({
      kind: "command",
      name: "bash",
      status: "error",
      spanId: "22222222-2222-4222-8222-222222222222",
      durationMs: 99_000,
      startedAt: "2026-08-29T00:05:00.000Z",
      input: { command: "python3 compile.py" },
      output: { exitCode: 1, text: "failed in 9.87s at 2026-08-29T00:05:00.000Z" },
      error: { message: "compile failed", code: "1" },
    });
    const third = { ...second, spanId: "33333333-3333-4333-8333-333333333333" };
    expect(guard.observe(first).action).toBe("continue");
    expect(guard.observe(second).action).toBe("warn");
    expect(guard.observe(third)).toMatchObject({ action: "stop", reason: "repeated_signature" });
    expect(guard.snapshots().length).toBeGreaterThan(0);
  });

  it("stops after three identical tool failures and three identical model failures", () => {
    const tools = monitor();
    const tool = (span: string): RunEventDraft =>
      draft({
        kind: "mcp_tool",
        name: "launchpad.read_file",
        status: "error",
        spanId: span,
        input: { tool: "launchpad.read_file", text: '{"path":"src/app.ts"}' },
        error: { message: "ENOENT", code: "ENOENT" },
      });
    expect(tools.observe(tool("a")).action).toBe("continue");
    expect(tools.observe(tool("b")).action).toBe("warn");
    expect(tools.observe(tool("c"))).toMatchObject({ action: "stop", reason: "repeated_signature" });
    expect(tools.snapshots().length).toBeGreaterThan(0);

    const models = monitor();
    const turn = (span: string): RunEventDraft =>
      draft({
        kind: "turn",
        name: "turn",
        status: "error",
        spanId: span,
        error: { message: "Codex turn failed", code: "turn_failed" },
      });
    expect(models.observe(turn("t1")).action).toBe("continue");
    expect(models.observe(turn("t2")).action).toBe("warn");
    expect(models.observe(turn("t3"))).toMatchObject({ action: "stop", reason: "repeated_signature" });
    expect(models.snapshots().length).toBeGreaterThan(0);
  });

  it("normalizes volatile job ids and output offsets while retaining command fingerprints", () => {
    const guard = monitor();
    const job = (id: string, offset: number, span: string): RunEventDraft =>
      draft({
        kind: "mcp_tool",
        name: "launchpad.read_job_output",
        status: "ok",
        spanId: span,
        input: {
          tool: "launchpad.read_job_output",
          text: JSON.stringify({ job_id: id, stdout_offset: offset, stderr_offset: offset }),
        },
        output: { text: "still compiling chunk at offset " + offset },
      });
    expect(guard.observe(job("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 0, "j1")).action).toBe("continue");
    expect(guard.observe(job("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 4096, "j2")).action).toBe("warn");
    expect(guard.observe(job("cccccccc-cccc-4ccc-8ccc-cccccccccccc", 8192, "j3"))).toMatchObject({
      action: "stop",
      reason: "repeated_signature",
    });
  });

  it("expands one batch_tool_call into nested steps so batching cannot hide a loop", () => {
    const guard = monitor({ maxSteps: 20 });
    const nestedFail = {
      tool_name: "read_file",
      arguments: { path: "src/app.ts" },
    };
    const batch = (span: string): RunEventDraft =>
      draft({
        kind: "mcp_tool",
        name: "batch_tool_call",
        status: "error",
        spanId: span,
        input: {
          tool: "batch_tool_call",
          text: JSON.stringify({ calls: [nestedFail, nestedFail, nestedFail] }),
        },
        attributes: { calls: [nestedFail, nestedFail, nestedFail] },
        error: { message: "nested read failed", code: "ENOENT" },
      });
    expect(guard.observe(batch("b1")).action).toBe("stop");
    expect(guard.observe(batch("b1"))).toMatchObject({ action: "stop", reason: "repeated_signature" });
  });

  it("counts each nested batch operation toward the 20-step cap even when signatures change", () => {
    const guard = monitor({ maxSteps: 20 });
    const calls = Array.from({ length: 8 }, (_, index) => ({
      tool_name: "read_file",
      arguments: { path: "src/file-" + index + ".ts" },
    }));
    const batch = (seq: number): RunEventDraft =>
      draft({
        kind: "mcp_tool",
        name: "batch_tool_call",
        spanId: "batch-" + seq,
        input: { tool: "batch_tool_call", text: JSON.stringify({ calls }) },
        attributes: { calls },
      });
    expect(guard.observe(batch(1)).action).toBe("continue");
    expect(guard.observe(batch(2)).action).toBe("continue");
    expect(guard.observe(batch(3))).toMatchObject({ action: "stop", reason: "runtime_step_limit" });
  });

  it("does not count in_progress halves, run lifecycle, or file_change events toward the step cap", () => {
    const guard = monitor({ maxSteps: 3 });
    for (let index = 0; index < 8; index += 1) {
      expect(
        guard.observe(
          draft({
            kind: "run",
            name: "started",
            status: "in_progress",
            spanId: "run-" + index,
            endedAt: null,
            durationMs: null,
          }),
        ).action,
      ).toBe("continue");
      expect(
        guard.observe(
          draft({
            kind: "command",
            name: "bash",
            status: "in_progress",
            spanId: "cmd-" + index,
            endedAt: null,
            durationMs: null,
            input: { command: "echo " + index },
          }),
        ).action,
      ).toBe("continue");
      expect(guard.observe(fileChange(["src/file-" + index + ".ts"], { spanId: "file-" + index })).action).toBe(
        "continue",
      );
    }
    expect(guard.progress().state).not.toBe("terminal");
  });

  it("lets a 50-event progressing trace continue under the 20-step cap", () => {
    const guard = monitor({ maxSteps: 20 });
    for (let index = 0; index < 50; index += 1) {
      const result = guard.observe(fileChange(["src/prog-" + index + ".ts"], { spanId: "p-" + index }));
      expect(result.action).not.toBe("stop");
    }
    expect(guard.progress().state).toBe("progressing");
  });

  it("stops after three timer checkpoints with no event, file, or test progress", async () => {
    let timer: (() => void) | null = null;
    let now = 0;
    const guard = monitor({
      checkpointMs: 60_000,
      clock: {
        now: () => now,
        setTimeout: (handler) => {
          timer = handler;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: () => {
          timer = null;
        },
      },
    });
    const sink: RunEventSink = { emit: vi.fn() };
    const wrapped = guard.wrapSink(sink);
    wrapped.emit(draft({ kind: "run", name: "started", status: "in_progress", endedAt: null, durationMs: null }));
    for (let i = 0; i < 3; i += 1) {
      now += 60_000;
      timer?.();
    }
    await expect(guard.terminal()).resolves.toMatchObject({ reason: "no_evidence_progress" });
    expect(guard.snapshots()).toHaveLength(3);
    expect(guard.progress().state).toBe("terminal");
  });

  it("stops on git fingerprint oscillation a → b → a", async () => {
    const fingerprints = ["tree-a", "tree-b", "tree-a"];
    const git = {
      async trajectoryFingerprint() {
        const next = fingerprints.shift();
        if (!next) throw new Error("exhausted");
        return next;
      },
    };
    const guard = monitor({ git, workspacePath: "/tmp/attempt" });
    const wrapped = guard.wrapSink({ emit() {} });
    wrapped.emit(fileChange(["src/a.ts"], { spanId: "f1" }));
    await guard.drain();
    wrapped.emit(fileChange(["src/b.ts"], { spanId: "f2" }));
    await guard.drain();
    wrapped.emit(fileChange(["src/a.ts"], { spanId: "f3" }));
    await guard.drain();
    await expect(guard.terminal()).resolves.toMatchObject({ reason: "state_oscillation" });
  });

  it("does not treat growing in-scope patches as scope_drift", () => {
    const guard = monitor({ contract: contract({ allowedMutationPaths: ["src/"] }) });
    expect(guard.observe(fileChange(["src/a.ts"])).action).toBe("continue");
    expect(guard.observe(fileChange(["src/a.ts", "src/b.ts"])).action).toBe("continue");
    expect(guard.observe(fileChange(["src/a.ts", "src/b.ts", "src/c.ts"])).action).toBe("continue");
  });

  it("stops on monotonically increasing out-of-scope mutation risk", () => {
    const guard = monitor({ contract: contract({ allowedMutationPaths: ["src/"] }) });
    expect(guard.observe(fileChange(["docs/a.md"])).action).toBe("continue");
    expect(guard.observe(fileChange(["docs/a.md", "docs/b.md"])).action).toBe("continue");
    expect(guard.observe(fileChange(["docs/a.md", "docs/b.md", "docs/c.md"]))).toMatchObject({
      action: "stop",
      reason: "scope_drift",
    });
  });

  it("stops on a protected-path regression", () => {
    const guard = monitor({ contract: contract() });
    expect(
      guard.observe(fileChange(["package-lock.json"])),
    ).toMatchObject({ action: "stop", reason: "protected_violation" });
  });

  it("stops on a consumer regression", async () => {
    const guard = monitor({ contract: contract() });
    await guard.observeVerification({
      id: "v1",
      subjectType: "contribution",
      subjectId: "c1",
      stage: "candidate",
      authorityManifestHash: "abc",
      gates: [
        { gateId: "consumer", tier: "consumer", passed: false, evidenceRef: "e1", failureFingerprint: "consumer-broke" },
      ],
      failureKind: "deterministic_gate_failure",
      mandatoryPassed: false,
      hardProgress: 0,
      regressionCount: 1,
      modelCalls: 0,
      reservedTokens: 0,
      actualInputTokens: 0,
      actualOutputTokens: 0,
      elapsedMs: 10,
      verifiedAt: "2026-08-29T00:00:00.000Z",
    } satisfies VerificationResult);
    expect(guard.progress().state).toBe("terminal");
    await expect(guard.terminal()).resolves.toMatchObject({ reason: "consumer_incompatibility" });
  });

  it("continues a changing progressive trace", () => {
    const guard = monitor();
    expect(guard.observe(fileChange(["src/a.ts"])).action).toBe("continue");
    expect(guard.observe(failedTest("Tests: 5 failed")).action).toBe("continue");
    expect(guard.observe(failedTest("Tests: 3 failed")).action).toBe("continue");
    expect(guard.observe(fileChange(["src/a.ts", "src/lib.ts"])).action).toBe("continue");
    expect(guard.observe(failedTest("Tests: 1 failed")).action).toBe("continue");
    expect(guard.progress().state).toBe("progressing");
  });

  it("forwards each event immediately while serializing git observations", async () => {
    let release!: (value: string) => void;
    let calls = 0;
    const git = {
      trajectoryFingerprint: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            calls += 1;
            if (calls === 1) release = resolve;
            else resolve("tree-b");
          }),
      ),
    };
    const guard = monitor({ git, workspacePath: "/tmp/attempt" });
    const emitted: RunEventDraft[] = [];
    const wrapped = guard.wrapSink({ emit: (event) => emitted.push(event) });
    const first = fileChange(["src/a.ts"], { spanId: "one" });
    const second = fileChange(["src/b.ts"], { spanId: "two" });
    wrapped.emit(first);
    wrapped.emit(second);
    expect(emitted).toEqual([first, second]);
    release("tree-a");
    await guard.drain();
    expect(git.trajectoryFingerprint).toHaveBeenCalledTimes(2);
  });

  it("does not reset signature or step history when progress() is read for a lease", () => {
    const guard = monitor();
    const first = failedTest("FAIL  tests/demo.test.ts");
    const second = failedTest("FAIL  tests/demo.test.ts", { spanId: "span-2" });
    expect(guard.observe(first).action).toBe("continue");
    expect(guard.progress().state).toBe("unchanged");
    expect(guard.observe(second).action).toBe("warn");
    expect(guard.progress().checkpointId).toBeTruthy();
    expect(guard.observe(failedTest("FAIL  tests/demo.test.ts", { spanId: "span-3" }))).toMatchObject({
      action: "stop",
      reason: "no_evidence_progress",
    });
  });

  it("treats a sleep signature as monitor-owned on the third identical poll", () => {
    const guard = monitor();
    const sleep = (span: string): RunEventDraft =>
      draft({
        kind: "command",
        name: "bash",
        status: "in_progress",
        spanId: span,
        endedAt: null,
        durationMs: null,
        input: { command: "sleep 45" },
      });
    expect(guard.observe(sleep("s1")).action).toBe("continue");
    expect(guard.observe(sleep("s2")).action).toBe("warn");
    expect(guard.observe(sleep("s3"))).toMatchObject({ action: "stop", reason: "repeated_signature" });
  });
});

describe("RepositoryTrajectoryObserver", () => {
  it("retains the last valid fingerprint across timeout and unavailable captures", async () => {
    const results: Array<string | Error> = [
      "tree-a",
      GitCommandError.from(Object.assign(new Error("timed out"), { killed: true }), ["status"]),
      "tree-a",
    ];
    const git = {
      async trajectoryFingerprint() {
        const next = results.shift();
        if (next instanceof Error) throw next;
        if (typeof next !== "string") throw new Error("exhausted");
        return next;
      },
    };
    const observer = new RepositoryTrajectoryObserver(git, { cwd: "/tmp/attempt", timeoutMs: 1_000 });
    expect(await observer.capture()).toBe("tree-a");
    expect(await observer.capture()).toBe("tree-a");
    expect(await observer.capture()).toBe("tree-a");
    expect(observer.fingerprints()).toEqual(["tree-a"]);
  });

  it("records genuine oscillation when valid fingerprints actually change", async () => {
    const results = ["tree-a", "tree-b", "tree-a"];
    const git = {
      async trajectoryFingerprint() {
        const next = results.shift();
        if (!next) throw new Error("exhausted");
        return next;
      },
    };
    const observer = new RepositoryTrajectoryObserver(git, { cwd: "/tmp/attempt" });
    expect(await observer.capture()).toBe("tree-a");
    expect(await observer.capture()).toBe("tree-b");
    expect(await observer.capture()).toBe("tree-a");
    expect(observer.oscillating()).toBe(true);
    expect(observer.fingerprints()).toEqual(["tree-a", "tree-b", "tree-a"]);
  });
});

describe("Git fingerprint capture is read-only", () => {
  it("does not change attempt index, staged set, HEAD, config, refs, or worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-fingerprint-"));
    directories.push(root);
    const git = new GitClient(5_000);
    await git.run(root, ["init", "-b", "main"]);
    await git.run(root, ["config", "user.name", "Test"]);
    await git.run(root, ["config", "user.email", "test@example.invalid"]);
    await writeFile(path.join(root, "README.md"), "initial\n", "utf8");
    await git.run(root, ["add", "--", "README.md"]);
    await git.run(root, ["commit", "-m", "initial"]);
    await writeFile(path.join(root, "README.md"), "staged\n", "utf8");
    await git.run(root, ["add", "--", "README.md"]);
    await writeFile(path.join(root, "scratch.txt"), "untracked\n", "utf8");
    const snapshot = async () => ({
      head: await git.head(root),
      status: await git.run(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
      staged: await git.run(root, ["diff", "--cached", "--name-only"]),
      refs: await git.run(root, ["for-each-ref", "--format=%(refname) %(objectname)"]),
      config: await git.run(root, ["config", "--local", "--list"]),
      worktree: await git.run(root, ["status", "--porcelain=v2", "--untracked-files=all"]),
    });
    const before = await snapshot();
    const fingerprint = await git.trajectoryFingerprint(root, 5_000);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await snapshot()).toEqual(before);
  });
});

describe("EvidenceSnapshot shape", () => {
  it("records immutable checkpoint fields from runtime events", () => {
    const guard = monitor();
    guard.observe(failedTest("Tests: 2 failed"));
    const snapshots: EvidenceSnapshot[] = guard.snapshots();
    expect(snapshots[0]).toMatchObject({
      attemptId: "attempt-1",
      sequence: 1,
      source: "runtime",
      mandatoryFailures: 2,
    });
    expect(snapshots[0]?.id).toBeTruthy();
    expect(snapshots[0]?.stateFingerprint).toBeTruthy();
    expect(snapshots[0]?.contentHash).toMatch(/^[a-f0-9]+$/);
  });
});
