/**
 * JSON-RPC framing and capability checks for `codex app-server`.
 *
 * Three facts here came from probing Codex 0.111.0 directly, not from its docs,
 * and each one fails at runtime if ignored:
 *
 *  1. `initialize` must declare `experimentalApi`, or `thread/start` with
 *     `persistExtendedHistory` is refused outright.
 *  2. The rollout file is written on the first turn, not on `thread/start`, so a
 *     thread that never took a turn cannot be resumed in another process.
 *  3. The turn id arrives at `params.turn.id` — not `params.turnId` — and
 *     `turn/steer` treats `expectedTurnId` as a hard precondition.
 */
export const REQUIRED_METHODS = [
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
] as const;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export function initializeParams(clientName: string): Record<string, unknown> {
  return {
    clientInfo: { name: clientName, version: "1" },
    // Without this the server refuses thread/start's persistExtendedHistory.
    capabilities: { experimentalApi: true },
  };
}

/**
 * The two sandbox surfaces disagree on spelling, and each rejects the other's.
 * Measured against Codex 0.111.0, not read from the generated bindings — which
 * say kebab-case for both and are wrong about the second:
 *
 *   thread/start  `sandbox`        kebab-case   "workspace-write"
 *   turn/start    `sandboxPolicy`  camelCase    { "type": "workspaceWrite" }
 *
 * Getting either backwards yields `unknown variant`, the request is refused,
 * and — before backend errors were surfaced — the run produced no events at all.
 */
export function sandboxPolicyVariant(mode: string): string {
  switch (mode) {
    case "danger-full-access":
      return "dangerFullAccess";
    case "read-only":
      return "readOnly";
    default:
      return "workspaceWrite";
  }
}

export function threadStartParams(
  cwd: string,
  sandbox: string,
): Record<string, unknown> {
  return {
    cwd,
    approvalPolicy: "never",
    // kebab-case here; the turn's policy below uses the other spelling.
    sandbox,
    experimentalRawEvents: false,
    // Needed to reconstruct history on resume; requires experimentalApi above.
    persistExtendedHistory: true,
  };
}

/**
 * Reopen a thread persisted by an earlier run so its conversation carries into
 * this one. History is reconstructed server-side from the rollout JSONL; the
 * thread's own persisted cwd/sandbox stand unless the turn overrides them, so
 * only the id is required here. Fails with JSON-RPC -32600 if another live
 * process already owns the thread — the caller falls back to a fresh start.
 */
export function threadResumeParams(threadId: string): Record<string, unknown> {
  return { threadId };
}

/**
 * The sandbox a turn runs under, with the shared directory named explicitly.
 *
 * `workspace-write` grants the thread's own cwd and nothing else, so a worker
 * told to hand a file to a sibling through $COMMON_WORKSPACE finds it
 * unwritable — and reports that as the sandbox refusing, which reads like the
 * task being impossible rather than a missing declaration. The exec backend
 * gets the same grant through `--add-dir`.
 */
export function turnSandboxPolicy(
  mode: string,
  writableRoots: string[],
): Record<string, unknown> {
  if (mode === "danger-full-access") return { type: sandboxPolicyVariant(mode) };
  if (mode === "read-only") return { type: sandboxPolicyVariant(mode) };
  return {
    type: sandboxPolicyVariant(mode),
    writable_roots: writableRoots.filter((root) => root.length > 0),
    network_access: true,
    exclude_tmpdir_env_var: false,
    exclude_slash_tmp: false,
  };
}

/** The turn id lives under `turn`, and reading `params.turnId` silently yields undefined. */
export function readTurnId(message: JsonRpcMessage): string | null {
  const turn = message.params?.turn;
  if (turn !== null && typeof turn === "object" && "id" in turn) {
    const id = (turn as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return null;
}

export function readThreadId(result: Record<string, unknown> | undefined): string | null {
  const thread = result?.thread;
  if (thread !== null && typeof thread === "object" && "id" in thread) {
    const id = (thread as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return null;
}

/**
 * `app-server` is experimental and its method set can change between Codex
 * releases. A missing method must stop the run before a worker starts rather
 * than surface later as a message that silently never arrives.
 */
export function assertCapabilities(required: readonly string[], available: readonly string[]): void {
  const missing = required.filter((method) => !available.includes(method));
  if (missing.length > 0) {
    throw new Error(
      "RUNTIME_CAPABILITY_UNAVAILABLE: codex app-server is missing " + missing.join(", "),
    );
  }
}

/**
 * app-server names item types in camelCase where the exec stream uses
 * snake_case — `commandExecution` against `command_execution`. The collector
 * keys off the snake_case names, so an untranslated item is silently dropped:
 * measured, a worker that ran shell commands logged nine model calls and zero
 * commands, and its trajectory showed no work at all.
 *
 * Unknown types pass through unchanged rather than being guessed at; a type
 * this does not know about is better recorded under its own name than mapped
 * onto the wrong one.
 */
const ITEM_TYPE_ALIASES: Record<string, string> = {
  commandExecution: "command_execution",
  fileChange: "file_change",
  mcpToolCall: "mcp_tool_call",
  webSearch: "web_search",
  agentMessage: "agent_message",
  todoList: "todo_list",
};

export function normalizeItem(item: Record<string, unknown>): Record<string, unknown> {
  const type = item.type;
  if (typeof type !== "string") return item;
  const alias = ITEM_TYPE_ALIASES[type];
  return alias === undefined ? item : { ...item, type: alias };
}
