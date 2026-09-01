import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import {
  buildCodexArgs,
  mcpConfigOverrides,
  parseCodexEventLine,
  type ParsedEvents,
} from "./codex-runner.js";
import { createRedactor } from "./redact.js";
import { createEventCollector } from "./run-events.js";
import { RunCancelledError } from "./errors.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import {
  CONTAINER_OWNER_LABEL,
  createContainerAuthority,
  prepareContainerAuthority,
  removeOwnedContainer,
  type ContainerAuthority,
} from "./runtime/container-authority.js";
import {
  prepareWorkerDependencyCache,
  workerDependencyEnvironment,
} from "./runtime/dependency-cache.js";

export { createContainerAuthority, type ContainerAuthority } from "./runtime/container-authority.js";
export {
  prepareWorkerDependencyCache,
  workerDependencyEnvironment,
} from "./runtime/dependency-cache.js";

const execFileAsync = promisify(execFile);
const IMMUTABLE_IMAGE_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const CONTAINER_PYTHON_BOOTSTRAP = `
set -eu
if ! python3 - <<'PY' >/dev/null 2>&1
import yaml
PY
then
  mkdir -p "$(dirname "$LAUNCHPAD_PIP_BOOTSTRAP")" "$PYTHONUSERBASE"
  if ! python3 - <<'PY' >/dev/null 2>&1
import pip
PY
  then
    if [ ! -s "$LAUNCHPAD_PIP_BOOTSTRAP" ]; then
      python3 - "$LAUNCHPAD_PIP_BOOTSTRAP" <<'PY'
import sys
import urllib.request

urllib.request.urlretrieve("https://bootstrap.pypa.io/get-pip.py", sys.argv[1])
PY
    fi
    python3 "$LAUNCHPAD_PIP_BOOTSTRAP" --user --break-system-packages --no-warn-script-location --quiet >/dev/null 2>&1 || \\
      python3 "$LAUNCHPAD_PIP_BOOTSTRAP" --user --no-warn-script-location --quiet >/dev/null 2>&1
  fi
  python3 -m pip install --user --break-system-packages --quiet pyyaml >/dev/null 2>&1 || \\
    python3 -m pip install --user --quiet pyyaml >/dev/null 2>&1
fi
exec "$@"
`.trim();

interface ActiveContainer {
  child: ChildProcess;
  authority: ContainerAuthority;
  cancelled: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  settled: Promise<void>;
  termination: Promise<void> | null;
}

export function containerName(agentId: string, instanceId = "default"): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
  return "launchpad-" + safeInstance + "-" + safeAgent;
}

export function appServerContainerName(
  agentId: string,
  runId: string,
  instanceId = "default",
): string {
  const safeInstance = instanceId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  const safeRun = runId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 36);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 36);
  return "launchpad-" + safeInstance + "-" + safeRun + "-" + safeAgent;
}

export function buildContainerRunArgs(
  request: RunnerRequest,
  config: AppConfig,
  authority: ContainerAuthority = createContainerAuthority(request.agentId, config),
): string[] {
  const engineName = config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase();
  const repairCandidate = request.coordinationEnv?.LAUNCHPAD_REPAIR_CANDIDATE === "1";
  const runtimeImage = repairCandidate
    ? request.runtimeImageId ?? config.containerRuntimeImage
    : config.containerRuntimeImage;
  if (
    typeof runtimeImage !== "string" ||
    (repairCandidate && request.runtimeImageId !== undefined &&
      !IMMUTABLE_IMAGE_PATTERN.test(runtimeImage))
  ) {
    throw new Error("Repair Runtime requires an immutable resolved container image id");
  }
  const commonWorkspaceMount = request.commonWorkspacePath
    ? [
        "--env",
        "COMMON_WORKSPACE=/common-workspace",
        "--mount",
        "type=bind,src=" + request.commonWorkspacePath + ",dst=/common-workspace",
      ]
    : [];
  const dependencyEnv = workerDependencyEnvironment(config, {
    runtimeCacheDir: "/launchpad-cache",
    pathValue: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    pathDelimiter: ":",
    systemPython: "/usr/bin/python3",
  });
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    authority.name,
    "--cidfile",
    authority.cidFile,
    "--label",
    "io.codejam.launchpad=agent-runtime",
    "--label",
    "io.codejam.agent-id=" + request.agentId,
    "--label",
    "io.codejam.instance-id=" + config.runtimeInstanceId,
    "--label",
    CONTAINER_OWNER_LABEL + "=" + authority.ownerId,
    ...(engineName === "podman" ? ["--userns", "keep-id"] : []),
    "--network",
    "bridge",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cpus",
    String(config.containerCpuLimit),
    "--memory",
    config.containerMemoryLimit,
    "--pids-limit",
    String(config.containerPidsLimit),
    "--user",
    config.containerUser,
    "--add-host",
    "host.docker.internal:host-gateway",
    // Pass-through form: the value is read from the spawned process's
    // environment and never appears in argv, where `ps` would show it. What the
    // value *is* — a per-Run proxy token or the real key — is decided in
    // `childEnvironment`.
    "--env",
    "ARK_API_KEY",
    "--env",
    "CODEX_HOME=/codex-home",
    "--env",
    "HOME=/tmp",
    "--env",
    "NO_COLOR=1",
    "--env",
    "LAUNCHPAD_DATA_DIR=/launchpad-data",
    "--env",
    "LAUNCHPAD_DEPENDENCY_CACHE=/launchpad-cache",
    "--env",
    "PIP_CACHE_DIR=" + dependencyEnv.PIP_CACHE_DIR,
    "--env",
    "UV_CACHE_DIR=" + dependencyEnv.UV_CACHE_DIR,
    "--env",
    "NPM_CONFIG_CACHE=" + dependencyEnv.NPM_CONFIG_CACHE,
    "--env",
    "PYTHONUSERBASE=" + dependencyEnv.PYTHONUSERBASE,
    "--env",
    "LAUNCHPAD_PIP_BOOTSTRAP=" + dependencyEnv.LAUNCHPAD_PIP_BOOTSTRAP,
    "--env",
    "LAUNCHPAD_SYSTEM_PYTHON=" + dependencyEnv.LAUNCHPAD_SYSTEM_PYTHON,
    "--env",
    "BASH_ENV=" + dependencyEnv.BASH_ENV,
    "--env",
    "PATH=" + dependencyEnv.PATH,
    "--env",
    "LAUNCHPAD_WORKSPACE_PATH=/workspace",
    "--env",
    "LAUNCHPAD_AGENT_ID=" + request.agentId,
    "--env",
    "LAUNCHPAD_AGENT_ROLE=" + (request.agentRole ?? (request.runId === request.parentRunId ? "leader" : "worker")),
    "--env",
    "LAUNCHPAD_RUN_ID=" + request.runId,
    "--env",
    "LAUNCHPAD_PARENT_RUN_ID=" + (request.parentRunId ?? ""),
    ...(request.coordinationEnv === undefined
      ? []
      : Object.entries(request.coordinationEnv).flatMap(([key, value]) =>
          value === undefined ? [] : ["--env", key + "=" + value],
        )),
    "--mount",
    "type=bind,src=" + request.workspacePath + ",dst=/workspace",
    ...commonWorkspaceMount,
    "--mount",
    "type=bind,src=" + config.codexHome + ",dst=/codex-home",
    "--mount",
    "type=bind,src=" + config.dataDirectory + ",dst=/launchpad-data",
    "--mount",
    "type=bind,src=" + config.workerDependencyCacheDir + ",dst=/launchpad-cache",
    "--workdir",
    "/workspace",
    runtimeImage,
    "sh",
    "-lc",
    CONTAINER_PYTHON_BOOTSTRAP,
    "launchpad-bootstrap",
    "codex",
    ...buildCodexArgs(
      request,
      config.codexSandboxMode,
      {
        codexHome: "/codex-home",
        dataDir: "/launchpad-data",
        dependencyCacheDir: "/launchpad-cache",
      },
      "/workspace",
      request.commonWorkspacePath ? "/common-workspace" : undefined,
    ),
  ];
}

/**
 * Container arguments for an app-server session.
 *
 * Two differences from the exec form, both load-bearing. `-i` keeps stdin open,
 * because the session is driven by JSON-RPC on that pipe rather than by a prompt
 * baked into argv. And no prompt is appended: what the worker does arrives later
 * as `turn/start`, which is the entire point of running it this way.
 *
 * Everything else — mounts, limits, user, proxy token, MCP overrides — is
 * deliberately identical, so the security boundary does not quietly differ
 * between the two backends.
 */
export function buildContainerAppServerArgs(
  request: RunnerRequest,
  config: AppConfig,
  authority: ContainerAuthority = createContainerAuthority(request.agentId, config),
): string[] {
  const execArgs = buildContainerRunArgs(request, config, authority);
  const nameIndex = execArgs.indexOf("--name");
  if (nameIndex >= 0) {
    execArgs[nameIndex + 1] = appServerContainerName(
      request.agentId,
      request.runId,
      config.runtimeInstanceId,
    );
  }
  const codexAt = execArgs.lastIndexOf("codex");
  const preamble = execArgs.slice(0, codexAt);
  return [
    ...preamble.slice(0, 1),
    "-i",
    ...preamble.slice(1),
    "codex",
    "app-server",
    ...mcpConfigOverrides(
      request,
      {
        codexHome: "/codex-home",
        dataDir: "/launchpad-data",
        dependencyCacheDir: "/launchpad-cache",
      },
      "/workspace",
      request.commonWorkspacePath ? "/common-workspace" : undefined,
    ),
  ];
}

export class ContainerCodexRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveContainer>();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.containerEngine, ["version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      await execFileAsync(
        this.config.containerEngine,
        ["image", "inspect", this.config.containerRuntimeImage],
        { timeout: 5_000, env: this.childEnvironment() },
      );
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) return false;

    active.cancelled = true;
    await this.removeContainer(active);
    await active.settled;
    return true;
  }

  private removeContainer(active: ActiveContainer): Promise<void> {
    if (!active.termination) {
      active.termination = removeOwnedContainer(
        this.config.containerEngine,
        active.authority,
        this.childEnvironment(),
      )
        .catch(async (error) => {
          active.child.kill("SIGTERM");
          const forceKill = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
          forceKill.unref();
          throw error;
        });
    }
    return active.termination;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Runtime container");
    }

    const authority = createContainerAuthority(request.agentId, this.config);
    const args = buildContainerRunArgs(request, this.config, authority);
    await prepareContainerAuthority(authority);
    await prepareWorkerDependencyCache(this.config);
    const child = spawn(
      this.config.containerEngine,
      args,
      {
        cwd: request.workspacePath,
        env: this.childEnvironment(request.modelToken),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active: ActiveContainer = {
      child,
      authority,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      termination: null,
    };
    this.active.set(request.agentId, active);

    const collector = createEventCollector({
      redact: createRedactor([this.config.arkApiKey]),
    });
    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
      collector,
    };
    const drainToSink = (): void => {
      for (const draft of collector.drain()) {
        try {
          request.sink?.emit(draft);
        } catch {
          // Best-effort: a broken sink must not fail the run.
        }
      }
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        void this.removeContainer(active).catch(() => undefined);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) parseCodexEventLine(line, parsed);
        drainToSink();
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      void this.removeContainer(active).catch(() => undefined);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) parseCodexEventLine(stdout.trim(), parsed);
      drainToSink();
      if (active.cancelled) throw new RunCancelledError();
      if (active.timedOut) {
        throw new Error("Runtime timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new Error(
          this.config.containerEngine +
            " Runtime exited with code " +
            exitCode +
            ": " +
            detail,
        );
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) throw new Error("Codex completed without an agent message");
      return { output, threadId: parsed.threadId, usage: collector.totalUsage() };
    } finally {
      clearTimeout(timeout);
      this.active.delete(request.agentId);
    }
  }

  private childEnvironment(modelToken?: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
      // The proxy token when one was issued, so the real key never reaches the
      // container; the real key only when no proxy is running.
      ARK_API_KEY: modelToken ?? this.config.arkApiKey,
      NO_COLOR: "1",
    };
    for (const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "XDG_RUNTIME_DIR",
    ] as const) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }

}
