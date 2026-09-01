/** The container form of an app-server session. */
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  appServerContainerName,
  buildContainerAppServerArgs,
  buildContainerRunArgs,
  createContainerAuthority,
  prepareWorkerDependencyCache,
} from "../src/container-codex-runner.js";
import { loadConfig } from "../src/config.js";
import type { RunnerRequest } from "../src/types.js";
import { CodexAppServerRuntime } from "../src/runtime/app-server-runtime.js";
import { prepareContainerAuthority, removeOwnedContainer } from "../src/runtime/container-authority.js";

const exec = promisify(execFile);
const containerIt = process.env.LAUNCHPAD_CONTAINER_INTEGRATION === "1" ? it : it.skip;

const config = loadConfig({
  NODE_ENV: "test",
  ARK_API_KEY: "k",
  ARK_MODEL: "m",
  RUNTIME_PROVIDER: "container",
});

const request: RunnerRequest = {
  runId: "run-1",
  agentId: "agent-1",
  parentRunId: "leader-1",
  workspacePath: "/host/workspace",
  commonWorkspacePath: "/host/shared",
  prompt: "do the thing",
  threadId: null,
  modelToken: "tok-1",
};

describe("container app-server args", () => {
  it("uses a full random owner id, immutable label, and run-owned cidfile", () => {
    const first = createContainerAuthority(request.agentId, config);
    const second = createContainerAuthority(request.agentId, config);
    const args = buildContainerAppServerArgs(request, config, first);

    expect(first.ownerId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.name).toContain(first.ownerId);
    expect(second.ownerId).not.toBe(first.ownerId);
    expect(args).toContain("--cidfile");
    expect(args[args.indexOf("--cidfile") + 1]).toBe(first.cidFile);
    expect(args).toContain("io.codejam.owner-id=" + first.ownerId);
  });

  it("does not remove a colliding container when no owned cid was captured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-container-collision-"));
    const authority = createContainerAuthority(request.agentId, { ...config, dataDirectory: root });
    const log = path.join(root, "commands.log");
    const engine = await fakeContainerEngine(root, {
      inspect: { Id: "a".repeat(64), Config: { Labels: { "io.codejam.owner-id": "someone-else" } } },
      log,
    });

    await expect(removeOwnedContainer(engine, authority)).rejects.toThrow("owner label");
    expect(await readFile(log, "utf8")).not.toContain("rm --force");
    await rm(root, { recursive: true, force: true });
  });

  it("does not accept generic inspect exit 1 as container absence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-container-inspect-"));
    const authority = createContainerAuthority(request.agentId, { ...config, dataDirectory: root });
    const engine = await fakeContainerEngine(root, { inspectError: "permission denied" });

    await expect(removeOwnedContainer(engine, authority)).rejects.toThrow(
      "ownership or absence could not be verified",
    );
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    "Error: No such container",
    "Error: No such object: a-different-container",
    "prefix No such container: target suffix",
  ])("does not accept generic or wrong-target absence text: %s", async (inspectError) => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-container-wrong-absence-"));
    const authority = createContainerAuthority(request.agentId, { ...config, dataDirectory: root });
    const engine = await fakeContainerEngine(root, { inspectError });

    await expect(removeOwnedContainer(engine, authority)).rejects.toThrow(
      "ownership or absence could not be verified",
    );
    await rm(root, { recursive: true, force: true });
  });

  it("accepts absence only when stderr names the exact inspected authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-container-exact-absence-"));
    const authority = createContainerAuthority(request.agentId, { ...config, dataDirectory: root });
    const engine = await fakeContainerEngine(root, {
      inspectError: "Error: No such container: " + authority.name,
    });

    await expect(removeOwnedContainer(engine, authority)).resolves.toBeUndefined();
    await rm(root, { recursive: true, force: true });
  });

  it("removes only the full cidfile id after exact owner-label verification", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-container-owned-"));
    const authority = createContainerAuthority(request.agentId, { ...config, dataDirectory: root });
    const id = "b".repeat(64);
    const log = path.join(root, "commands.log");
    await prepareContainerAuthority(authority);
    await writeFile(authority.cidFile, id + "\n", { mode: 0o600 });
    const engine = await fakeContainerEngine(root, {
      inspect: { Id: id, Config: { Labels: { "io.codejam.owner-id": authority.ownerId } } },
      absentAfterRemove: true,
      log,
    });

    await removeOwnedContainer(engine, authority);
    expect(await readFile(log, "utf8")).toContain("rm --force " + id);
    expect(await readFile(log, "utf8")).not.toContain("rm --force " + authority.name);
    await rm(root, { recursive: true, force: true });
  });

  containerIt("force-removes the exact production app-server container before late workspace mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-app-server-container-"));
    const workspace = path.join(root, "workspace");
    const codexHome = path.join(root, "codex-home");
    const data = path.join(root, "data");
    await Promise.all([mkdir(workspace), mkdir(codexHome), mkdir(data)]);
    const engine = process.env.CONTAINER_ENGINE ?? "docker";
    const image = process.env.CONTAINER_RUNTIME_IMAGE ?? "volc-agent-runtime:local";
    const integrationConfig = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "container-test-token",
      ARK_MODEL: "ep-test",
      APP_DATA_DIR: data,
      CODEX_HOME: codexHome,
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: engine,
      CONTAINER_RUNTIME_IMAGE: image,
      RUNTIME_INSTANCE_ID: "app-server-quiesce",
    });
    const integrationRequest: RunnerRequest = {
      runId: "app-server-quiesce",
      agentId: "app-server-quiesce",
      workspacePath: workspace,
      prompt: "wait",
      threadId: null,
    };
    const authority = createContainerAuthority(integrationRequest.agentId, integrationConfig);
    await prepareContainerAuthority(authority);
    const productionArgs = buildContainerAppServerArgs(integrationRequest, integrationConfig, authority);
    const productionNameAt = productionArgs.indexOf("--name");
    const productionContainerName = productionArgs[productionNameAt + 1];
    if (productionNameAt < 0 || !productionContainerName) {
      throw new Error("production app-server container name is missing");
    }
    const imageAt = productionArgs.indexOf(image);
    const codexCommand = productionArgs.slice(imageAt + 1);
    const wrappedArgs = [
      ...productionArgs.slice(0, imageAt + 1),
      "sh", "-c",
      "(while :; do printf 'late\\n' >> /workspace/late.txt; sleep 0.05; done) & exec \"$@\"",
      "launchpad-wrapper",
      ...codexCommand,
    ];
    const runtime = new CodexAppServerRuntime({
      command: engine,
      args: wrappedArgs,
      env: { ...process.env, ARK_API_KEY: "container-test-token" },
      cwd: root,
      workspacePath: "/workspace",
      termination: { kind: "container", engine, authority },
    }, { arkApiKey: "container-test-token", codexSandboxMode: "danger-full-access" });
    const start = runtime.start(integrationRequest).catch(() => undefined);
    try {
      // Parallel verifier-container startup can exceed five seconds on Docker
      // Desktop. Keep readiness bounded inside the existing 40-second test
      // horizon; the assertions below still prove the quiesce barrier itself.
      for (let check = 0; check < 800; check += 1) {
        try { await access(path.join(workspace, "late.txt")); break; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
      }
      await access(path.join(workspace, "late.txt"));
      await runtime.quiesce("test_collection");
      const atBarrier = await readFile(path.join(workspace, "late.txt"), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await readFile(path.join(workspace, "late.txt"), "utf8")).toBe(atBarrier);
      await expect(exec(engine, ["container", "inspect", authority.name], { timeout: 5_000 })).rejects.toMatchObject({ code: 1 });
      await start;
    } finally {
      await exec(engine, ["rm", "--force", productionContainerName], { timeout: 5_000 }).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 40_000);

  // The session is driven by JSON-RPC on stdin, so the pipe has to stay open —
  // without -i the container closes it and the first request goes nowhere.
  it("keeps stdin open", () => {
    expect(buildContainerAppServerArgs(request, config)).toContain("-i");
  });

  it("prepares the worker dependency cache before it is bind-mounted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-cache-mount-"));
    const cache = path.join(root, "missing-cache");
    try {
      await prepareWorkerDependencyCache({ workerDependencyCacheDir: cache });

      await access(cache);
      await access(path.join(cache, "pip"));
      await access(path.join(cache, "uv"));
      await access(path.join(cache, "npm"));
      await access(path.join(cache, "python/bin/python3"));
      await access(path.join(cache, "python/bin/pip"));
      await access(path.join(cache, "python/user"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs app-server rather than exec, with no prompt in argv", () => {
    const args = buildContainerAppServerArgs(request, config);
    expect(args).toContain("app-server");
    expect(args).not.toContain("exec");
    // What the worker does arrives later as turn/start; that is the point.
    expect(args).not.toContain("do the thing");
  });

  it("uses a run-scoped container name so later prompts for the same agent do not collide", () => {
    const args = buildContainerAppServerArgs(request, config);
    expect(args[args.indexOf("--name") + 1]).toBe(
      appServerContainerName(request.agentId, request.runId, config.runtimeInstanceId),
    );
    expect(args[args.indexOf("--name") + 1]).toContain(request.runId);
  });

  // The security boundary must not quietly differ between backends.
  it("keeps the same mounts, limits and user as the exec form", () => {
    const exec = buildContainerRunArgs(request, config);
    const session = buildContainerAppServerArgs(request, config);
    const mounts = (args: string[]): string[] =>
      args.filter((arg) => arg.startsWith("type=bind"));
    expect(mounts(session)).toEqual(mounts(exec));
    expect(session).toContain("--cap-drop");
    expect(session).toContain("no-new-privileges");
    expect(session[session.indexOf("--user") + 1]).toBe(
      exec[exec.indexOf("--user") + 1],
    );
  });

  // The MCP subprocess still gets its run context, or the coordination tools
  // have nowhere to send.
  it("carries the per-run MCP overrides", () => {
    const joined = buildContainerAppServerArgs(request, config).join(" ");
    expect(joined).toContain("mcp_servers.launchpad.env=");
    expect(joined).toContain("LAUNCHPAD_PARENT_RUN_ID=\"leader-1\"");
    expect(joined).toContain("COMMON_WORKSPACE=\"/common-workspace\"");
    expect(joined).not.toContain("process.env");
  });
});

async function fakeContainerEngine(
  root: string,
  behavior: {
    inspect?: Record<string, unknown>;
    inspectError?: string;
    absentAfterRemove?: boolean;
    log?: string;
  },
): Promise<string> {
  const engine = path.join(root, "fake-container-engine");
  const state = path.join(root, "removed");
  const source = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(behavior.log ?? path.join(root, "commands.log"))}
if [ "$1" = "rm" ]; then
  : > ${JSON.stringify(state)}
  exit 0
fi
if [ ${JSON.stringify(behavior.absentAfterRemove === true ? "yes" : "no")} = yes ] && [ -f ${JSON.stringify(state)} ]; then
  echo "Error: No such container: $5" >&2
  exit 1
fi
${behavior.inspectError === undefined ? `printf '%s\\n' ${JSON.stringify(JSON.stringify(behavior.inspect ?? {}))}` : `echo ${JSON.stringify(behavior.inspectError)} >&2
exit 1`}
`;
  await writeFile(engine, source);
  await chmod(engine, 0o700);
  return engine;
}
