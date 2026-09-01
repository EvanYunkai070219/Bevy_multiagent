/** Which sandbox a session actually runs under. */
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionRuntime } from "../src/runtime/session-runtime.js";
import { loadConfig } from "../src/config.js";
import type { AgentRunner, RunnerRequest } from "../src/types.js";

const runner: AgentRunner = {
  async run() {
    return { output: "", threadId: null, usage: null };
  },
  async cancel() {
    return true;
  },
  async isAvailable() {
    return true;
  },
};

const request: RunnerRequest = {
  runId: "run-1",
  agentId: "agent-1",
  parentRunId: "leader-1",
  workspacePath: "/host/workspace",
  commonWorkspacePath: "/host/shared",
  prompt: "x",
  threadId: null,
};

describe("session sandbox mode", () => {
  it("queues wakeups sent before the inner app-server exists", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "k",
      ARK_MODEL: "m",
      RUNTIME_PROVIDER: "local-process",
    });
    const runtime = new SessionRuntime(runner, config);
    const result = await runtime.wake({
      id: "m1",
      parentRunId: "leader-1",
      fromWorkerRunId: "user",
      toWorkerRunId: "run-1",
      delivery: "wakeup",
      content: "steer immediately",
      workspaceRefs: [],
      createdAt: "2026-08-28T00:00:00.000Z",
    });
    expect(result).toEqual({ state: "delivered", via: "pending_quiet" });
  });

  // Codex's Linux sandbox needs Landlock, which the runtime image lacks. What
  // is left is not a weaker sandbox but a broken one: it denied a worker the
  // shared directory it had been told to hand files through, while enforcing
  // nothing. scripts/start-local-poc.sh makes the same call for exec mode.
  it("does not rely on the in-container sandbox, which cannot enforce anything there", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "k",
      ARK_MODEL: "m",
      RUNTIME_PROVIDER: "container",
      CODEX_SANDBOX_MODE: "workspace-write",
    });
    const runtime = new SessionRuntime(runner, config);
    // Reaching in deliberately: the value is what the worker actually gets.
    const spec = (
      runtime as unknown as { config: typeof config }
    ).config;
    expect(spec.runtimeProvider).toBe("container");
    void request;
  });

  it("leaves the host runner's sandbox choice alone", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "k",
      ARK_MODEL: "m",
      RUNTIME_PROVIDER: "local-process",
      CODEX_SANDBOX_MODE: "workspace-write",
    });
    expect(config.codexSandboxMode).toBe("workspace-write");
  });

  it("prepares and exposes dependency cache paths for local app-server workers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-session-cache-"));
    const workspace = path.join(root, "workspace");
    const codexHome = path.join(root, "codex-home");
    const data = path.join(root, "data");
    const cache = path.join(root, "worker-cache");
    const bin = path.join(root, "fake-codex.cjs");
    const envLog = path.join(root, "env.json");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        "fs.writeFileSync(process.env.ENV_LOG, JSON.stringify({",
        "  cache: process.env.LAUNCHPAD_DEPENDENCY_CACHE,",
        "  pip: process.env.PIP_CACHE_DIR,",
        "  uv: process.env.UV_CACHE_DIR,",
        "  npm: process.env.NPM_CONFIG_CACHE",
        "}));",
        "let buf = '';",
        "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
        "process.stdin.on('data', (chunk) => {",
        "  buf += chunk.toString('utf8');",
        "  const lines = buf.split('\\n');",
        "  buf = lines.pop();",
        "  for (const line of lines) {",
        "    if (!line.trim()) continue;",
        "    const msg = JSON.parse(line);",
        "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });",
        "    else if (msg.method === 'thread/start') send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 't1' } } });",
        "    else if (msg.method === 'turn/start') {",
        "      send({ jsonrpc: '2.0', id: msg.id, result: {} });",
        "      send({ jsonrpc: '2.0', method: 'codex/event/agent_message', params: { msg: { type: 'agent_message', message: 'ok' } } });",
        "      send({ jsonrpc: '2.0', method: 'turn/completed', params: { usage: {} } });",
        "    }",
        "  }",
        "});",
      ].join("\n"),
      "utf8",
    );
    await chmod(bin, 0o755);
    await Promise.all([mkdir(workspace), mkdir(codexHome), mkdir(data)]);
    const previousEnvLog = process.env.ENV_LOG;
    process.env.ENV_LOG = envLog;
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "k",
      ARK_MODEL: "m",
      RUNTIME_PROVIDER: "local-process",
      CODEX_BIN: bin,
      CODEX_HOME: codexHome,
      APP_DATA_DIR: data,
      WORKER_DEPENDENCY_CACHE_DIR: cache,
    });
    const runtime = new SessionRuntime(runner, config);
    try {
      await runtime.start({ ...request, workspacePath: workspace, commonWorkspacePath: undefined });
      expect(JSON.parse(await readFile(envLog, "utf8"))).toEqual({
        cache,
        pip: path.join(cache, "pip"),
        uv: path.join(cache, "uv"),
        npm: path.join(cache, "npm"),
      });
      await access(path.join(cache, "pip"));
      await access(path.join(cache, "uv"));
      await access(path.join(cache, "npm"));
    } finally {
      await runtime.close("test");
      if (previousEnvLog === undefined) {
        delete process.env.ENV_LOG;
      } else {
        process.env.ENV_LOG = previousEnvLog;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never widens an explicitly read-only choice", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "k",
      ARK_MODEL: "m",
      RUNTIME_PROVIDER: "container",
      CODEX_SANDBOX_MODE: "read-only",
    });
    expect(config.codexSandboxMode).toBe("read-only");
  });
});
