/**
 * Chooses how to spawn an app-server session for the backend in use, then hands
 * off to `CodexAppServerRuntime`.
 *
 * Exists so the session runtime itself stays ignorant of containers: the only
 * difference between running on the host and running in a container is the
 * command line and the environment, and both are decided here.
 */
import type { AppConfig } from "../config.js";
import { buildContainerAppServerArgs } from "../container-codex-runner.js";
import { createContainerAuthority, prepareContainerAuthority } from "./container-authority.js";
import {
  prepareWorkerDependencyCache,
  workerDependencyEnvironment,
} from "./dependency-cache.js";
import { mcpConfigOverrides } from "../codex-runner.js";
import type { AgentRunner, RunnerRequest } from "../types.js";
import type { TeamMessageQueued } from "../coordination/messages.js";
import { CodexAppServerRuntime } from "./app-server-runtime.js";
import type {
  AgentRuntime,
  CoordinationCapability,
  DeliveryResult,
  RuntimeSnapshot,
  WorkerCheckpoint,
} from "./agent-runtime.js";

/**
 * Whether Codex's in-container sandbox can actually enforce anything.
 *
 * Its Linux backend needs Landlock, which the runtime image does not provide —
 * `scripts/start-local-poc.sh` probes for this and drops to full access for the
 * same reason. What is left without it is not a weaker sandbox but a broken
 * one: it denies writes it should allow (a worker cannot reach the shared
 * directory it was told to hand files through) while enforcing nothing.
 *
 * The isolation that matters is the container itself: dropped capabilities, no
 * new privileges, a non-root user, and only the mounts this run needs.
 */
function effectiveSandboxMode(config: AppConfig): AppConfig["codexSandboxMode"] {
  if (config.runtimeProvider !== "container") return config.codexSandboxMode;
  if (config.codexSandboxMode !== "workspace-write") return config.codexSandboxMode;
  return "danger-full-access";
}

export class SessionRuntime implements AgentRuntime {
  private inner: CodexAppServerRuntime | null = null;
  private readonly preStartQuiet: TeamMessageQueued[] = [];

  constructor(
    private readonly runner: AgentRunner,
    private readonly config: AppConfig,
  ) {}

  async start(request: RunnerRequest): Promise<WorkerCheckpoint> {
    const containerAuthority = this.config.runtimeProvider === "container"
      ? createContainerAuthority(request.agentId, this.config)
      : null;
    await prepareWorkerDependencyCache(this.config);
    if (containerAuthority !== null) {
      await prepareContainerAuthority(containerAuthority);
    }
    const containerArgs = containerAuthority === null
      ? null
      : buildContainerAppServerArgs(request, this.config, containerAuthority);
    const spawnSpec =
      this.config.runtimeProvider === "container"
        ? {
            command: this.config.containerEngine,
            args: containerArgs!,
            env: { ...process.env, ARK_API_KEY: request.modelToken ?? this.config.arkApiKey },
            // docker runs on the host; the worker's own view is /workspace.
            cwd: process.cwd(),
            workspacePath: "/workspace",
            writableRoots: request.commonWorkspacePath === undefined ? [] : ["/common-workspace"],
            termination: {
              kind: "container" as const,
              engine: this.config.containerEngine,
              authority: containerAuthority!,
            },
          }
        : {
            command: this.config.codexBin,
            args: [
              "app-server",
              ...mcpConfigOverrides(
                request,
                {
                  codexHome: this.config.codexHome,
                  dataDir: this.config.dataDirectory,
                  dependencyCacheDir: this.config.workerDependencyCacheDir,
                },
                request.workspacePath,
                request.commonWorkspacePath,
              ),
            ],
            env: {
              ...process.env,
              CODEX_HOME: this.config.codexHome,
              ARK_API_KEY: request.modelToken ?? this.config.arkApiKey,
              ...workerDependencyEnvironment(this.config),
              LAUNCHPAD_WORKSPACE_PATH: request.workspacePath,
              LAUNCHPAD_AGENT_ID: request.agentId,
              LAUNCHPAD_AGENT_ROLE: request.agentRole ?? (request.runId === request.parentRunId ? "leader" : "worker"),
              LAUNCHPAD_RUN_ID: request.runId,
              LAUNCHPAD_PARENT_RUN_ID: request.parentRunId ?? "",
              ...(request.coordinationEnv ?? {}),
            },
            cwd: request.workspacePath,
            workspacePath: request.workspacePath,
            writableRoots:
              request.commonWorkspacePath === undefined ? [] : [request.commonWorkspacePath],
            termination: { kind: "process_group" as const },
          };

    this.inner = new CodexAppServerRuntime(spawnSpec, {
      arkApiKey: this.config.arkApiKey,
      codexSandboxMode: effectiveSandboxMode(this.config),
    });
    for (const message of this.preStartQuiet.splice(0)) {
      await this.inner.inject(message);
    }
    return await this.inner.start(request);
  }

  async inject(message: TeamMessageQueued): Promise<DeliveryResult> {
    if (this.inner === null) {
      this.preStartQuiet.push(message);
      return { state: "delivered", via: "pending_quiet" };
    }
    return await this.inner.inject(message);
  }

  async wake(message: TeamMessageQueued): Promise<DeliveryResult> {
    if (this.inner === null) {
      this.preStartQuiet.push(message);
      return { state: "delivered", via: "pending_quiet" };
    }
    return await this.inner.wake(message);
  }

  undeliveredQuiet(): TeamMessageQueued[] {
    return this.inner?.undeliveredQuiet() ?? [];
  }

  async waitForIdle(): Promise<void> {
    await this.inner?.waitForIdle();
  }

  snapshot(): RuntimeSnapshot {
    return this.inner?.snapshot() ?? { state: "not_started", threadId: null, activeTurnId: null };
  }

  capability(): CoordinationCapability {
    return "live_steer";
  }

  async close(reason: string): Promise<void> {
    await this.inner?.close(reason);
  }

  async quiesce(reason: string): Promise<void> {
    await this.inner?.quiesce(reason);
  }

  async cancel(reason: string): Promise<void> {
    await this.inner?.cancel(reason);
    // The runner still owns process bookkeeping keyed by agent id.
    await this.runner.cancel(reason).catch(() => undefined);
  }
}
