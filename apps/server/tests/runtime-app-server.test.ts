/** Protocol details that only surface against a real codex app-server. */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUIRED_METHODS,
  assertCapabilities,
  initializeParams,
  readThreadId,
  readTurnId,
  threadStartParams,
} from "../src/runtime/app-server-protocol.js";

const processGroups: number[] = [];

afterEach(() => {
  for (const pid of processGroups.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already quiesced */ }
  }
});

describe("app-server protocol", () => {
  // Measured: omitting this yields
  // "thread/start.persistFullHistory requires experimentalApi capability".
  it("declares experimentalApi during initialize", () => {
    expect(initializeParams("launchpad")).toMatchObject({
      capabilities: { experimentalApi: true },
    });
  });

  it("asks for extended history so a thread can be resumed later", () => {
    expect(threadStartParams("/workspace", "danger-full-access")).toMatchObject({
      persistExtendedHistory: true,
      approvalPolicy: "never",
    });
  });

  // Measured: the notification carries `params.turn.id`; `params.turnId` is
  // undefined, and turn/steer rejects a mismatched expectedTurnId.
  it("reads the turn id from params.turn.id", () => {
    expect(readTurnId({ method: "turn/started", params: { turn: { id: "u1" } } })).toBe("u1");
    expect(readTurnId({ method: "turn/started", params: { turnId: "u1" } })).toBeNull();
  });

  it("reads the thread id from result.thread.id", () => {
    expect(readThreadId({ thread: { id: "t1" } })).toBe("t1");
    expect(readThreadId({ threadId: "t1" })).toBeNull();
  });

  // Experimental surface: a missing method must stop the run before a worker
  // starts, not turn into a message that silently never arrives.
  it("fails loud when a required method is missing", () => {
    expect(() => assertCapabilities(REQUIRED_METHODS, ["thread/start", "turn/start"])).toThrow(
      /RUNTIME_CAPABILITY_UNAVAILABLE.*turn\/steer/,
    );
    expect(() => assertCapabilities(REQUIRED_METHODS, [...REQUIRED_METHODS])).not.toThrow();
  });
});

describe("app-server runtime delivery", () => {
  const message = (id: string, delivery: "quiet" | "wakeup" = "quiet") => ({
    id,
    parentRunId: "leader-1",
    fromWorkerRunId: "w-other",
    toWorkerRunId: "w-self",
    delivery,
    content: "note " + id,
    workspaceRefs: [],
    createdAt: "2026-08-27T00:00:00.000Z",
  });

  const runtime = async () => {
    const { CodexAppServerRuntime } = await import("../src/runtime/app-server-runtime.js");
    return new CodexAppServerRuntime(
      { command: "true", args: [], env: {}, cwd: "/tmp" },
      { arkApiKey: "k", codexSandboxMode: "danger-full-access" },
    );
  };

  it("declares live_steer, unlike the one-shot backend", async () => {
    expect((await runtime()).capability()).toBe("live_steer");
  });

  // A quiet note must never cost a turn of its own; it waits for one.
  it("accepts quiet without starting a turn", async () => {
    const r = await runtime();
    const result = await r.inject(message("m1"));
    expect(result.state).toBe("delivered");
    expect(result.via).toBe("pending_quiet");
    expect(r.snapshot().state).toBe("not_started");
    expect(r.undeliveredQuiet().map((m) => m.id)).toEqual(["m1"]);
  });

  it("refuses delivery to a closed worker rather than dropping it", async () => {
    const r = await runtime();
    await r.close("done");
    expect((await r.inject(message("m1"))).state).toBe("undeliverable");
    expect((await r.wake(message("m2", "wakeup"))).reason).toBe("TARGET_CLOSED");
  });

  it("quiesces the child before returning and rejects every late wake", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-quiesce-"));
    const marker = path.join(root, "late.txt");
    const background = [
      "const fs=require('fs')",
      "fs.writeFileSync(process.argv[1],'started\\n')",
      "process.on('SIGTERM',()=>setTimeout(()=>{fs.appendFileSync(process.argv[1],'settled\\n');process.exit(0)},75))",
      "setInterval(()=>fs.appendFileSync(process.argv[1],'background\\n'),20)",
    ].join(";");
    const child = spawn(process.execPath, ["-e", [
      "const {spawn}=require('child_process')",
      "const fs=require('fs')",
      `spawn(process.execPath,['-e',${JSON.stringify(background)},process.argv[1]],{stdio:'ignore'})`,
      "const ready=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(ready);process.stdout.write('ready\\n')}},5)",
      "setInterval(()=>{},1000)",
    ].join(";"), marker], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    if (child.pid !== undefined) processGroups.push(child.pid);
    await once(child.stdout!, "data");
    const r = await runtime();
    (r as unknown as { child: ChildProcess }).child = child;

    await r.quiesce("collection");
    const atBarrier = await readFile(marker, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await readFile(marker, "utf8")).toBe(atBarrier);
    expect((await r.wake(message("late", "wakeup"))).reason).toBe("TARGET_CLOSED");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await rm(root, { recursive: true });
  });

  it("refuses a wakeup before the thread exists", async () => {
    const r = await runtime();
    expect((await r.wake(message("m1", "wakeup"))).reason).toBe("TARGET_NOT_STARTED");
  });

  it("queues a wakeup while app-server startup is creating the thread", async () => {
    const r = await runtime();
    (r as unknown as { state: string }).state = "active";
    expect(await r.wake(message("m1", "wakeup"))).toEqual({
      state: "delivered",
      via: "pending_quiet",
    });
    expect(r.undeliveredQuiet().map((m) => m.id)).toEqual(["m1"]);
  });
});

// A minimal JSON-RPC app-server that records which thread method it received,
// so a test can prove a carried threadId reopens the same thread instead of
// silently starting a new one (which drops the prior conversation).
const FAKE_APP_SERVER = `
const fs = require("fs");
const log = process.argv[2];
let buf = "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const record = (line) => fs.appendFileSync(log, line + "\\n");
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  const lines = buf.split("\\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") { send({ jsonrpc: "2.0", id: msg.id, result: {} }); continue; }
    if (msg.method === "thread/start") {
      record("thread/start");
      send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "thread-fresh" } } });
      continue;
    }
    if (msg.method === "thread/resume") {
      record("thread/resume " + (msg.params && msg.params.threadId));
      if (process.env.RESUME_FAILS === "1") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "thread owned by another process" } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params.threadId } } });
      }
      continue;
    }
    if (msg.method === "turn/start") {
      record("turn/start");
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      send({ jsonrpc: "2.0", method: "codex/event/agent_message", params: { msg: { type: "agent_message", message: "ok" } } });
      send({ jsonrpc: "2.0", method: "turn/completed", params: { usage: {} } });
      continue;
    }
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
`;

describe("app-server thread continuity", () => {
  const spawnFakeRuntime = async (root: string, env: Record<string, string> = {}) => {
    const script = path.join(root, "fake-app-server.cjs");
    const log = path.join(root, "methods.log");
    await writeFile(script, FAKE_APP_SERVER, "utf8");
    const { CodexAppServerRuntime } = await import("../src/runtime/app-server-runtime.js");
    const runtime = new CodexAppServerRuntime(
      {
        command: process.execPath,
        args: [script, log],
        env: { ...process.env, ...env },
        cwd: root,
        workspacePath: "/workspace",
      },
      { arkApiKey: "k", codexSandboxMode: "danger-full-access" },
    );
    return { runtime, log };
  };

  const request = (threadId: string | null) => ({
    runId: "r1",
    agentId: "a1",
    workspacePath: "/workspace",
    prompt: "what was the word",
    threadId,
  });

  it("resumes the carried thread rather than starting a new one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-resume-"));
    const { runtime, log } = await spawnFakeRuntime(root);
    try {
      const result = await runtime.start(request("prev-thread"));
      const methods = await readFile(log, "utf8");
      expect(methods).toContain("thread/resume prev-thread");
      expect(methods).not.toContain("thread/start");
      expect(result.threadId).toBe("prev-thread");
    } finally {
      await runtime.close("test");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts a fresh thread when no threadId is carried", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-fresh-"));
    const { runtime, log } = await spawnFakeRuntime(root);
    try {
      const result = await runtime.start(request(null));
      const methods = await readFile(log, "utf8");
      expect(methods).toContain("thread/start");
      expect(methods).not.toContain("thread/resume");
      expect(result.threadId).toBe("thread-fresh");
    } finally {
      await runtime.close("test");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to a fresh thread when resume is refused rather than failing the run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-resume-fail-"));
    const { runtime, log } = await spawnFakeRuntime(root, { RESUME_FAILS: "1" });
    try {
      const result = await runtime.start(request("gone-thread"));
      const methods = await readFile(log, "utf8");
      expect(methods).toContain("thread/resume gone-thread");
      expect(methods).toContain("thread/start");
      expect(result.threadId).toBe("thread-fresh");
    } finally {
      await runtime.close("test");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs exactly one follow-up turn for an idle wakeup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-wake-once-"));
    const { runtime, log } = await spawnFakeRuntime(root);
    try {
      await runtime.start(request(null));
      const delivered = await runtime.wake({
        id: "wake-1",
        parentRunId: "leader-1",
        fromWorkerRunId: "leader-1",
        toWorkerRunId: "worker-1",
        delivery: "wakeup",
        content: "repair the final commit marker",
        workspaceRefs: [],
        createdAt: "2026-08-30T00:00:00.000Z",
      });

      const methods = await readFile(log, "utf8");
      expect(delivered).toMatchObject({ state: "delivered", via: "follow_up" });
      expect(methods.match(/^turn\/start$/gm)).toHaveLength(2);
    } finally {
      await runtime.close("test");
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("app-server startup failures", () => {
  it("rejects startup with stderr detail when app-server exits before initialize", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-server-exit-"));
    const script = path.join(root, "exit-early.cjs");
    await writeFile(
      script,
      "process.stderr.write('docker: mount source path does not exist\\n'); process.exit(135);",
      "utf8",
    );
    const { CodexAppServerRuntime } = await import("../src/runtime/app-server-runtime.js");
    const runtime = new CodexAppServerRuntime(
      {
        command: process.execPath,
        args: [script],
        env: { ...process.env },
        cwd: root,
        workspacePath: root,
      },
      { arkApiKey: "k", codexSandboxMode: "danger-full-access" },
    );
    try {
      await expect(runtime.start({
        runId: "r1",
        agentId: "a1",
        workspacePath: root,
        prompt: "go",
        threadId: null,
      })).rejects.toThrow(/code 135.*mount source path does not exist/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("app-server protocol recovery", () => {
  it("detects tool-call markup emitted as assistant text", async () => {
    const { looksLikeUnparsedToolCall } = await import("../src/tool-call-protocol.js");
    expect(
      looksLikeUnparsedToolCall(
        '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="mcp__launchpad__bootstrap_context">\n' +
          '<｜DSML｜parameter name="max_entries" string="false">20</｜DSML｜parameter>',
      ),
    ).toBe(true);
    expect(looksLikeUnparsedToolCall("Plain answer about DSML examples.")).toBe(false);
  });

  it("uses a concrete non-DSML recovery prompt", async () => {
    const { protocolRecoveryPrompt } = await import("../src/runtime/app-server-runtime.js");
    const prompt = protocolRecoveryPrompt(2);

    expect(prompt).toContain("Never repeat `<｜DSML｜tool_calls>`");
    expect(prompt).toContain('{"cmd":"pwd && ls -la"}');
    expect(prompt).toContain("bare JSON tool request");
    expect(prompt).toContain("final recovery attempt");
  });
});

describe("turn sandbox policy", () => {
  // workspace-write grants the thread's own cwd and nothing else, so a worker
  // told to hand a file to a sibling through $COMMON_WORKSPACE finds it
  // unwritable — and reports that as the sandbox refusing, which reads like the
  // task being impossible rather than a missing declaration.
  it("names the shared directory as writable under workspace-write", async () => {
    const { turnSandboxPolicy } = await import("../src/runtime/app-server-protocol.js");
    const policy = turnSandboxPolicy("workspace-write", ["/workspace", "/common-workspace"]);
    expect(policy).toMatchObject({
      type: "workspaceWrite",
      writable_roots: ["/workspace", "/common-workspace"],
    });
  });

  it("uses the camelCase tag the turn surface actually accepts", async () => {
    const { turnSandboxPolicy } = await import("../src/runtime/app-server-protocol.js");
    expect(turnSandboxPolicy("danger-full-access", ["/x"])).toEqual({
      type: "dangerFullAccess",
    });
    expect(turnSandboxPolicy("read-only", ["/x"])).toEqual({ type: "readOnly" });
  });

  it("drops empty roots rather than declaring a blank path", async () => {
    const { turnSandboxPolicy } = await import("../src/runtime/app-server-protocol.js");
    const policy = turnSandboxPolicy("workspace-write", ["/workspace", ""]) as {
      writable_roots: string[];
    };
    expect(policy.writable_roots).toEqual(["/workspace"]);
  });
});

describe("sandbox naming across the two surfaces", () => {
  // Measured: sending the CLI spelling to thread/start yields
  // "unknown variant `workspace-write`, expected ... `workspaceWrite`",
  // the turn never starts, and the run produces no events at all — which
  // looks like a hang rather than a rejected request.
  it("uses camelCase for thread/start and kebab-case for the turn policy", async () => {
    const { threadStartParams, turnSandboxPolicy } = await import(
      "../src/runtime/app-server-protocol.js"
    );
    // Measured against Codex 0.111.0. thread/start rejects camelCase with
    // "unknown variant `workspaceWrite`, expected one of `read-only`, ...";
    // turn/start rejects kebab-case with the mirror-image message. The
    // generated bindings claim kebab-case for both and are wrong about the
    // second, so these expectations come from the runtime.
    expect(threadStartParams("/workspace", "workspace-write")).toMatchObject({
      sandbox: "workspace-write",
    });
    expect(threadStartParams("/workspace", "danger-full-access")).toMatchObject({
      sandbox: "danger-full-access",
    });
    expect(turnSandboxPolicy("workspace-write", ["/workspace"])).toMatchObject({
      type: "workspaceWrite",
    });
    expect(turnSandboxPolicy("danger-full-access", [])).toMatchObject({
      type: "dangerFullAccess",
    });
    expect(turnSandboxPolicy("read-only", [])).toMatchObject({ type: "readOnly" });
  });
});

describe("event normalisation across backends", () => {
  // The collector was written for exec's `--json` stream, whose items arrive as
  // {type: "item.completed", item}. app-server sends the same items as
  // `item/completed` notifications with the item under params.item — close
  // enough to look equivalent, different enough that forwarding the raw
  // notification records nothing. Measured: a worker that ran shell commands
  // logged nine model calls and zero commands.
  it("turns an app-server item notification into the same event as exec", async () => {
    const { createEventCollector } = await import("../src/run-events.js");

    const execCollector = createEventCollector({ redact: (v) => v });
    execCollector.consume({
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        command: "echo hi",
        exit_code: 0,
        status: "completed",
      },
    });
    const fromExec = execCollector.drain();

    // The shape the runtime must produce from `item/completed`.
    const sessionCollector = createEventCollector({ redact: (v) => v });
    const notification = {
      method: "item/completed",
      params: {
        item: {
          id: "c1",
          type: "commandExecution",
          command: "echo hi",
          exit_code: 0,
          status: "completed",
        },
      },
    };
    const { normalizeItem } = await import("../src/runtime/app-server-protocol.js");
    sessionCollector.consume({
      type: "item.completed",
      item: normalizeItem(notification.params.item),
    });
    const fromSession = sessionCollector.drain();

    expect(fromSession.map((e) => e.kind)).toEqual(fromExec.map((e) => e.kind));
    expect(fromSession.at(-1)?.kind).toBe("command");
  });
});
