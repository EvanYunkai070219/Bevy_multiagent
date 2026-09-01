/**
 * A worker as a persistent `codex app-server` session.
 *
 * The difference from the exec backend is what happens between turns. A one-shot
 * turn is gone when it returns; a session stays addressable, so a sibling can
 * hand this worker something without the leader planning another round. That is
 * the whole reason this file exists.
 *
 * Protocol details that bite are documented in `app-server-protocol.ts`.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createRedactor } from "../redact.js";
import { createEventCollector } from "../run-events.js";
import type { AppConfig } from "../config.js";
import { removeOwnedContainer, type ContainerAuthority } from "./container-authority.js";
import type { RunnerRequest, RunUsage } from "../types.js";
import type { TeamMessageQueued } from "../coordination/messages.js";
import {
  REQUIRED_METHODS,
  assertCapabilities,
  initializeParams,
  readThreadId,
  readTurnId,
  normalizeItem,
  threadResumeParams,
  threadStartParams,
  turnSandboxPolicy,
  type JsonRpcMessage,
} from "./app-server-protocol.js";
import {
  undeliverable,
  type AgentRuntime,
  type CoordinationCapability,
  type DeliveryResult,
  type RuntimeSnapshot,
  type RuntimeState,
  type WorkerCheckpoint,
} from "./agent-runtime.js";
import {
  ToolCallProtocolError,
  looksLikeUnparsedToolCall,
} from "../tool-call-protocol.js";

export interface AppServerSpawn {
  /** Extra directories the worker must be able to write, as it sees them. */
  writableRoots?: string[];
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /**
   * The workspace path as the Codex process sees it, which is not the path we
   * see: in container mode the host directory is bind-mounted at /workspace.
   * `thread/start` sets the sandbox's writable root from this, so handing it a
   * host path leaves the worker unable to write anything — it reads as the
   * sandbox refusing, not as a wiring mistake.
   */
  workspacePath: string;
  termination?:
    | { kind: "process_group" }
    | { kind: "container"; engine: string; authority: ContainerAuthority };
}

const execFileAsync = promisify(execFile);

interface Pending {
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
}

export class CodexAppServerRuntime implements AgentRuntime {
  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private state: RuntimeState = "not_started";
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private idleWaiters: (() => void)[] = [];
  private messages: string[] = [];
  private usage: RunUsage | null = null;
  /**
   * Quiet messages waiting for this worker's next turn. The protocol has no way
   * to add an item to a thread without running it (`thread/inject_items` does
   * not exist), so quiet delivery means "rides along with whatever turn happens
   * next" — and if no turn ever happens, they must be reported undelivered
   * rather than silently forgotten.
   */
  private pendingQuiet: TeamMessageQueued[] = [];
  private readonly delivered = new Set<string>();
  private sink: RunnerRequest["sink"] | null = null;
  private errorSeq = 0;
  private closeBarrier: Promise<void> | null = null;
  private lastBackendError: string | null = null;

  constructor(
    private readonly spawnSpec: AppServerSpawn,
    private readonly config: Pick<AppConfig, "arkApiKey" | "codexSandboxMode">,
  ) {}

  async start(request: RunnerRequest): Promise<WorkerCheckpoint> {
    this.state = "active";
    this.sink = request.sink ?? null;
    const collector = createEventCollector({
      redact: createRedactor([this.config.arkApiKey]),
    });
    const drain = (): void => {
      for (const draft of collector.drain()) {
        try {
          request.sink?.emit(draft);
        } catch {
          // A broken sink must never fail the run it is describing.
        }
      }
    };

    const termination = this.spawnSpec.termination ?? { kind: "process_group" as const };
    if (termination.kind === "process_group" && process.platform === "win32") {
      this.state = "closed";
      throw new Error("Host app-server process-group isolation is unavailable on Windows");
    }
    this.child = spawn(this.spawnSpec.command, this.spawnSpec.args, {
      cwd: this.spawnSpec.cwd,
      env: this.spawnSpec.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: termination.kind === "process_group",
    });
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.consume(chunk.toString("utf8"), collector, drain);
    });
    // Without this the backend's own complaints stay in the container's output,
    // where nothing in the product ever looks. A rejected request then presents
    // as a run that simply produces nothing.
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) this.reportError("app_server_stderr", text.slice(0, 2_000));
    });
    this.child.on("error", (error: Error) => {
      this.reportError("app_server_spawn_failed", error.message);
      this.rejectPending("app-server spawn failed: " + error.message);
    });
    this.child.on("close", (code, signal) => {
      if (this.state === "closed") return;
      const detail = this.lastBackendError === null ? "" : ": " + this.lastBackendError;
      this.reportError(
        "app_server_exited",
        "app-server exited early with code " + String(code) + " signal " + String(signal) +
          detail,
      );
      this.state = "closed";
      this.rejectPending(
        "app-server exited early with code " + String(code) + " signal " + String(signal) +
          detail,
      );
      this.releaseIdle();
    });

    const init = await this.request("initialize", initializeParams("launchpad"));
    assertCapabilities(REQUIRED_METHODS, availableMethods(init));

    this.threadId = await this.openThread(request.threadId);
    if (this.threadId === null) throw new Error("app-server did not return a thread id");

    await this.runTurnWithProtocolRecovery(this.framedInput(request.prompt), "initial_turn");
    drain();
    return { threadId: this.threadId, output: this.messages.at(-1) ?? "", usage: this.usage };
  }

  /**
   * Reopen the caller's prior thread so this turn continues that conversation;
   * start a new one when there is nothing to resume. A carried thread can be
   * gone (compacted, never committed a rollout) or owned by another live
   * process — either way resume must degrade to a fresh start rather than fail
   * the run, since a new thread is exactly the behaviour before continuity
   * existed. A silent fresh start would look like memory loss, so the fallback
   * is announced into the run's own event stream.
   */
  private async openThread(threadId: string | null): Promise<string | null> {
    const freshStart = (): Promise<JsonRpcMessage> =>
      this.request(
        "thread/start",
        threadStartParams(this.spawnSpec.workspacePath, this.config.codexSandboxMode),
      );
    if (threadId !== null) {
      const resumed = await this.request("thread/resume", threadResumeParams(threadId));
      const resumedId = resumed.error === undefined ? readThreadId(resumed.result) : null;
      if (resumedId !== null) return resumedId;
      this.reportError(
        "thread_resume_failed",
        "Could not resume thread " + threadId +
          (resumed.error !== undefined
            ? " (JSON-RPC " + resumed.error.code + ": " + resumed.error.message + ")"
            : "") +
          "; starting a fresh thread, so this turn will not see the prior conversation.",
      );
    }
    return readThreadId((await freshStart()).result);
  }

  /**
   * Quiet: never starts a turn. It waits for one, and rides in at the top of
   * that turn's input so the recipient sees it before doing its own work.
   */
  async inject(message: TeamMessageQueued): Promise<DeliveryResult> {
    if (this.state === "closed") return undeliverable("TARGET_CLOSED");
    if (this.delivered.has(message.id)) return { state: "delivered", via: "pending_quiet" };
    this.pendingQuiet.push(message);
    return { state: "delivered", via: "pending_quiet" };
  }

  /**
   * Wakeup: steer the turn in flight, or start one on the same thread. The
   * no-active-turn fallback is required, not defensive — a turn can finish
   * between reading the state and issuing the steer.
   */
  async wake(message: TeamMessageQueued): Promise<DeliveryResult> {
    if (this.state === "closed") return undeliverable("TARGET_CLOSED");
    if (this.threadId === null) {
      if (this.state === "active") {
        if (!this.delivered.has(message.id)) this.pendingQuiet.push(message);
        return { state: "delivered", via: "pending_quiet" };
      }
      return undeliverable("TARGET_NOT_STARTED");
    }

    const input = this.framedInput(message.content, [message]);
    if (this.state === "active" && this.activeTurnId !== null) {
      const steered = await this.request("turn/steer", {
        threadId: this.threadId,
        input,
        expectedTurnId: this.activeTurnId,
      }).catch(() => null);
      if (steered !== null && steered.error === undefined) {
        this.delivered.add(message.id);
        return { state: "delivered", via: "steer", turnId: this.activeTurnId };
      }
      // Fell through: the turn ended under us. Start one instead of losing it.
    }
    await this.runTurnWithProtocolRecovery(input, "follow_up_turn");
    this.delivered.add(message.id);
    return {
      state: "delivered",
      via: "follow_up",
      output: this.messages.at(-1) ?? "",
      usage: this.usage,
    };
  }

  /** Quiet notes that never found a turn to ride. Reported, not forgotten. */
  undeliveredQuiet(): TeamMessageQueued[] {
    return [...this.pendingQuiet];
  }

  async waitForIdle(): Promise<void> {
    if (this.state !== "active") return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  snapshot(): RuntimeSnapshot {
    return { state: this.state, threadId: this.threadId, activeTurnId: this.activeTurnId };
  }

  capability(): CoordinationCapability {
    return "live_steer";
  }

  async quiesce(reason: string): Promise<void> {
    await this.close(reason);
  }

  async close(_reason: string): Promise<void> {
    if (this.closeBarrier) return this.closeBarrier;
    this.state = "closed";
    const child = this.child;
    for (const pending of this.pending.values()) pending.reject(new Error("app-server closed"));
    this.pending.clear();
    this.releaseIdle();
    if (!child) {
      this.child = null;
      return;
    }
    const termination = this.spawnSpec.termination ?? { kind: "process_group" as const };
    this.closeBarrier = (async () => {
      if (termination.kind === "container") {
        await terminateOwnedContainer(child, termination);
      } else {
        await terminateOwnedProcessGroup(child);
      }
      this.child = null;
    })();
    await this.closeBarrier;
  }

  async cancel(reason: string): Promise<void> {
    if (this.threadId !== null && this.activeTurnId !== null) {
      await this.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      }).catch(() => null);
    }
    await this.close(reason);
  }

  /** Pending quiet notes ride at the top, in journal order, each id only once. */
  private framedInput(
    text: string,
    extra: TeamMessageQueued[] = [],
  ): { type: string; text: string }[] {
    const notes = [...this.pendingQuiet, ...extra].filter(
      (message) => !this.delivered.has(message.id),
    );
    this.pendingQuiet = [];
    for (const note of notes) this.delivered.add(note.id);
    return [
      ...notes.map((note) => ({
        type: "text",
        text: "[from " + note.fromWorkerRunId + "] " + note.content,
      })),
      { type: "text", text },
    ];
  }

  private async runTurn(input: { type: string; text: string }[]): Promise<void> {
    this.state = "active";
    await this.request("turn/start", {
      threadId: this.threadId,
      input,
      // Declared per turn: the shared directory sits outside the thread's cwd,
      // and without naming it the worker cannot hand anything to a sibling.
      sandboxPolicy: turnSandboxPolicy(this.config.codexSandboxMode, [
        this.spawnSpec.workspacePath,
        ...(this.spawnSpec.writableRoots ?? []),
      ]),
    });
    await this.waitForIdle();
  }

  private async runTurnWithProtocolRecovery(
    input: { type: string; text: string }[],
    phase: string,
  ): Promise<void> {
    const messageCountBefore = this.messages.length;
    await this.runTurn(input);
    const latest = this.messages.at(-1) ?? "";
    if (
      this.messages.length <= messageCountBefore ||
      !looksLikeUnparsedToolCall(latest)
    ) {
      return;
    }

    const maxRecoveries = 2;
    for (let attempt = 1; attempt <= maxRecoveries; attempt += 1) {
      this.reportError(
        "unparsed_tool_call_text",
        "The model emitted tool-call markup as assistant text during " + phase +
          "; starting corrective turn " + attempt + "/" + maxRecoveries +
          " so the tool can be called with the runtime protocol or the answer can be restated.",
      );
      await this.runTurn(this.framedInput(protocolRecoveryPrompt(attempt)));
      const recovered = this.messages.at(-1) ?? "";
      if (!looksLikeUnparsedToolCall(recovered)) return;
    }
    {
      throw new ToolCallProtocolError(
        "Model repeatedly emitted tool-call markup as assistant text during " + phase +
          "; aborting before contribution repair because no native tool calls can be trusted",
      );
    }
  }

  private consume(
    chunk: string,
    collector: ReturnType<typeof createEventCollector>,
    drain: () => void,
  ): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      this.handle(message, collector, drain);
    }
  }

  private handle(
    message: JsonRpcMessage,
    collector: ReturnType<typeof createEventCollector>,
    drain: () => void,
  ): void {
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      // A refused request is the single most useful thing this stream carries:
      // measured, a bad `sandbox` variant made thread/start fail, no turn ever
      // started, and the run produced no events at all — indistinguishable from
      // a hang unless the refusal is recorded.
      if (message.error !== undefined) {
        this.reportError(
          "app_server_request_failed",
          "JSON-RPC " + message.error.code + ": " + message.error.message,
        );
      }
      this.pending.get(message.id)?.resolve(message);
      this.pending.delete(message.id);
      return;
    }
    if (message.method === "turn/started") {
      this.activeTurnId = readTurnId(message);
      this.state = "active";
      return;
    }
    if (message.method === "turn/completed") {
      this.activeTurnId = null;
      this.state = "idle";
      this.releaseIdle();
      const usage = message.params?.usage;
      if (usage !== null && typeof usage === "object") {
        collector.consume({ type: "turn.completed", usage: usage as Record<string, unknown> });
        drain();
      }
      return;
    }
    // The collector was written for the exec backend's `--json` stream, whose
    // items arrive as `{type: "item.completed", item}`. app-server sends the
    // same items as `item/completed` notifications with the item under
    // `params.item` — close enough to look equivalent, different enough that
    // forwarding the raw notification records nothing. Without this translation
    // a worker's commands and tool calls never enter its own event log: the run
    // shows model calls and no work.
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = message.params?.item;
      if (item !== null && typeof item === "object") {
        collector.consume({
          type: message.method === "item/started" ? "item.started" : "item.completed",
          item: normalizeItem(item as Record<string, unknown>),
        });
        drain();
      }
      return;
    }
    if (message.method?.startsWith("codex/event/") === true) {
      const text = agentMessageText(message);
      if (text !== null) this.messages.push(text);
    }
  }

  /** Surfaces a backend failure into the run's own event stream. */
  private reportError(code: string, message: string): void {
    this.lastBackendError = message;
    const at = new Date().toISOString();
    try {
      this.sink?.emit({
        kind: "error",
        name: code,
        status: "error",
        spanId: "app-server-error-" + (this.errorSeq += 1),
        parentSpanId: null,
        startedAt: at,
        endedAt: at,
        durationMs: 0,
        input: {},
        output: {},
        error: { code, message },
        attributes: { backend: "app_server" },
        usage: null,
      });
    } catch {
      // A broken sink must never fail the run it is describing.
    }
  }

  private releaseIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      if (this.state === "closed") {
        reject(new Error("app-server is closed"));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.child?.stdin?.write(payload, (error) => {
        if (error === null || error === undefined) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }
}

export function protocolRecoveryPrompt(attempt: number): string {
  return [
    "Your previous message emitted DSML/XML tool-call markup as plain assistant text, so no tool actually ran.",
    "Never repeat `<｜DSML｜tool_calls>`, `<|DSML|tool_calls>`, `<｜DSML｜invoke>`, or similar XML tags.",
    "If you need shell access, request exactly one command as a bare JSON object and no surrounding prose, for example:",
    '{"cmd":"pwd && ls -la"}',
    "If you need to continue without a tool, answer plainly in normal prose.",
    attempt === 1
      ? "Now retry the last needed action using the runtime's tool protocol, not DSML."
      : "This is the final recovery attempt. Do not mention tool-call markup; either emit one bare JSON tool request or give a plain final answer.",
  ].join("\n");
}

function availableMethods(init: JsonRpcMessage): string[] {
  const methods = init.result?.methods;
  // The server does not enumerate methods, so absent means "assume the set we
  // verified against this version" rather than failing every start.
  return Array.isArray(methods) ? (methods as string[]) : [...REQUIRED_METHODS];
}

function agentMessageText(message: JsonRpcMessage): string | null {
  const msg = message.params?.msg;
  if (msg === null || typeof msg !== "object") return null;
  const record = msg as Record<string, unknown>;
  if (record.type !== "agent_message") return null;
  return typeof record.message === "string" ? record.message : null;
}

async function terminateOwnedProcessGroup(child: ChildProcess): Promise<void> {
  if (process.platform === "win32") {
    throw new Error("Host app-server process-group quiescence is unavailable on Windows");
  }
  const pid = child.pid;
  if (pid === undefined) throw new Error("App-server process group has no authoritative PID");
  signalGroup(pid, "SIGTERM");
  if (!(await waitForGroupGone(pid, 1_000))) {
    signalGroup(pid, "SIGKILL");
    if (!(await waitForGroupGone(pid, 1_000))) {
      throw new Error("App-server process group did not quiesce");
    }
  }
  await waitForChildExit(child, 1_000);
}

async function terminateOwnedContainer(
  child: ChildProcess,
  termination: { engine: string; authority: ContainerAuthority },
): Promise<void> {
  await removeOwnedContainer(termination.engine, termination.authority);
  await waitForChildExit(child, 3_000);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForGroupGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("App-server CLI did not exit after quiescence")), timeoutMs);
    timeout.unref();
    const finish = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", finish);
    child.once("close", finish);
    child.once("error", finish);
  });
}
