import { execFile } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import {
  prepareWorkerDependencyCache,
  workerDependencyEnvironment,
} from "./runtime/dependency-cache.js";
import { createRedactor } from "./redact.js";
import { createEventCollector, type EventCollector } from "./run-events.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
  /**
   * Optional so existing callers keep type-checking. When present, every parsed
   * Codex event is also handed to the collector, which turns it into
   * normalised RunEvent drafts for the runner to drain into its sink.
   */
  collector?: EventCollector;
}

/**
 * Where the Launchpad paths live *as the Codex process sees them*. The host
 * runner and the container runner disagree on every one of these, so the
 * caller supplies its own view rather than letting this module guess.
 */
export interface CodexRuntimePaths {
  codexHome: string;
  dataDir: string;
  dependencyCacheDir?: string;
}

/** TOML inline table, for `-c key={a="1",b="2"}`. */
function tomlInlineTable(entries: Record<string, string>): string {
  const pairs = Object.entries(entries).map(
    ([key, value]) => key + "=" + JSON.stringify(value),
  );
  return "{" + pairs.join(",") + "}";
}

/**
 * Per-run overrides that make the Launchpad MCP server actually start.
 *
 * Codex spawns an MCP server with only HOME and PATH in its environment —
 * nothing else is inherited. So the server can neither locate itself through
 * `$CODEX_HOME` nor read its run context from `$LAUNCHPAD_*`; both have to be
 * stated here. The generated `config.toml` cannot carry the per-run half
 * (it is written once at startup and shared by every run), which is why these
 * are command-line overrides rather than config.
 */
export function mcpConfigOverrides(
  request: RunnerRequest,
  paths: CodexRuntimePaths,
  workspacePath: string,
  commonWorkspacePath = request.commonWorkspacePath,
): string[] {
  const serverPath = paths.codexHome.replace(/\/+$/, "") + "/launchpad-mcp-server.mjs";
  const dependencyCacheDir =
    paths.dependencyCacheDir ??
    (paths.codexHome === "/codex-home" ? "/launchpad-cache" : ".cache/launchpad-workers");
  const dependencyEnv = workerDependencyEnvironment(
    { workerDependencyCacheDir: dependencyCacheDir },
    {
      runtimeCacheDir: dependencyCacheDir,
      pathValue:
        dependencyCacheDir === "/launchpad-cache"
          ? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
          : process.env.PATH,
      pathDelimiter: ":",
    },
  );
  return [
    "-c",
    "mcp_servers.launchpad.args=" + JSON.stringify([serverPath]),
    "-c",
    "mcp_servers.launchpad.env=" +
      tomlInlineTable({
        CODEX_HOME: paths.codexHome,
        LAUNCHPAD_DATA_DIR: paths.dataDir,
        LAUNCHPAD_DEPENDENCY_CACHE: dependencyEnv.LAUNCHPAD_DEPENDENCY_CACHE,
        PIP_CACHE_DIR: dependencyEnv.PIP_CACHE_DIR,
        UV_CACHE_DIR: dependencyEnv.UV_CACHE_DIR,
        NPM_CONFIG_CACHE: dependencyEnv.NPM_CONFIG_CACHE,
        PYTHONUSERBASE: dependencyEnv.PYTHONUSERBASE,
        LAUNCHPAD_PIP_BOOTSTRAP: dependencyEnv.LAUNCHPAD_PIP_BOOTSTRAP,
        LAUNCHPAD_SYSTEM_PYTHON: dependencyEnv.LAUNCHPAD_SYSTEM_PYTHON,
        BASH_ENV: dependencyEnv.BASH_ENV,
        PATH: dependencyEnv.PATH,
        LAUNCHPAD_WORKSPACE_PATH: workspacePath,
        ...(commonWorkspacePath === undefined
          ? {}
          : { COMMON_WORKSPACE: commonWorkspacePath }),
        LAUNCHPAD_AGENT_ID: request.agentId,
        LAUNCHPAD_AGENT_ROLE: request.agentRole ?? (request.runId === request.parentRunId ? "leader" : "worker"),
        LAUNCHPAD_RUN_ID: request.runId,
        LAUNCHPAD_PARENT_RUN_ID: request.parentRunId ?? "",
        // The MCP subprocess is what actually calls send_message, and Codex
        // gives it only HOME and PATH — so its route to the team has to be
        // stated here or the tools have nowhere to send.
        ...(request.coordinationEnv ?? {}),
      }),
  ];
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  paths: CodexRuntimePaths,
  workspacePath = request.workspacePath,
  commonWorkspacePath = request.commonWorkspacePath,
): string[] {
  const args = [
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
    ...mcpConfigOverrides(request, paths, workspacePath),
  ];
  if (commonWorkspacePath) {
    args.push("--add-dir", commonWorkspacePath);
  }
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export function parseCodexEventLine(line: string, parsed: ParsedEvents): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  parsed.collector?.consume(event);

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
    }
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, unknown>;
    parsed.usage = {
      ...(typeof usage.input_tokens === "number"
        ? { inputTokens: usage.input_tokens }
        : {}),
      ...(typeof usage.cached_input_tokens === "number"
        ? { cachedInputTokens: usage.cached_input_tokens }
        : {}),
      ...(typeof usage.output_tokens === "number"
        ? { outputTokens: usage.output_tokens }
        : {}),
    };
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(message);
  }
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active Codex process");
    }

    await prepareWorkerDependencyCache(this.config);
    const args = buildCodexArgs(request, this.config.codexSandboxMode, {
      codexHome: this.config.codexHome,
      dataDir: this.config.dataDirectory,
      dependencyCacheDir: this.config.workerDependencyCacheDir,
    });
    const child = spawn(this.config.codexBin, args, {
      cwd: request.workspacePath,
      env: this.childEnvironment(request),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
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
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          parseCodexEventLine(line, parsed);
        }
        drainToSink();
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        parseCodexEventLine(stdout.trim(), parsed);
      }
      drainToSink();
      if (active.cancelled) {
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        throw new Error("Codex timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail = parsed.errors.at(-1) ?? stderr.trim() ?? "No error detail";
        throw new Error("Codex exited with code " + exitCode + ": " + detail);
      }
      const output = parsed.messages.at(-1)?.trim();
      if (!output) {
        throw new Error("Codex completed without an agent message");
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: collector.totalUsage(),
      };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.agentId);
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(request?: RunnerRequest): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: this.config.codexHome,
      ARK_API_KEY: this.config.arkApiKey,
      NO_COLOR: "1",
      LAUNCHPAD_DATA_DIR: this.config.dataDirectory,
      ...(request === undefined
        ? {}
        : {
            LAUNCHPAD_WORKSPACE_PATH: request.workspacePath,
            ...(request.commonWorkspacePath === undefined
              ? {}
              : { COMMON_WORKSPACE: request.commonWorkspacePath }),
            LAUNCHPAD_AGENT_ID: request.agentId,
            LAUNCHPAD_AGENT_ROLE: request.agentRole ?? (request.runId === request.parentRunId ? "leader" : "worker"),
            LAUNCHPAD_RUN_ID: request.runId,
            LAUNCHPAD_PARENT_RUN_ID: request.parentRunId ?? "",
            ...(request.coordinationEnv ?? {}),
          }),
    };
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return {
      ...environment,
      ...workerDependencyEnvironment(this.config, { pathValue: environment.PATH }),
    };
  }
}
