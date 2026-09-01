/** Normalises provider-specific Codex output into the stable RunEvent contract. */
import { truncateHead, truncateHeadTail } from "./redact.js";
import type { RunUsage } from "./types.js";

const MAX_ATTRIBUTES_BYTES = 32 * 1024;

export type RunEventKind =
  | "run"
  | "turn"
  | "reasoning"
  | "command"
  | "file_change"
  | "mcp_tool"
  | "web_search"
  | "todo"
  | "delegation"
  | "api_call"
  | "message"
  | "error";

/**
 * `warning` is a diagnostic the Run survived. A genuine failure always arrives
 * as `turn.failed`, a non-zero exit code, or a top-level error event, so a red
 * row in the timeline always means a step actually failed.
 */
export type RunEventStatus = "in_progress" | "ok" | "warning" | "error";

/** Normalised action input. Stable across Runtime providers. */
export interface RunEventInput {
  command?: string;
  tool?: string;
  paths?: string[];
  text?: string;
}

/** Normalised execution outcome. Stable across Runtime providers. */
export interface RunEventOutput {
  text?: string;
  exitCode?: number;
  changedFiles?: string[];
  /** The plan Codex maintains through update_plan. Replaced wholesale, not merged. */
  todos?: { text: string; done: boolean }[];
}

export interface RunEventError {
  message: string;
  code?: string;
}

/**
 * One immutable fact about a span.
 *
 * Every phase of a span (started, updated, completed) appends its own draft;
 * nothing is updated in place. Consumers group by `spanId` and take the entry
 * with the highest `seq` to get the span's current state.
 *
 * `input`, `output` and `error` are the normalisation contract: downstream
 * middleware may depend on them and must never read `attributes`, which holds
 * provider-specific metadata for display and debugging only.
 */
export interface RunEventDraft {
  spanId: string;
  parentSpanId: string | null;
  kind: RunEventKind;
  name: string;
  status: RunEventStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  input: RunEventInput;
  output: RunEventOutput;
  error: RunEventError | null;
  attributes: Record<string, unknown>;
  usage: RunUsage | null;
}

export interface RunEvent extends RunEventDraft {
  seq: number;
  runId: string;
  agentId: string;
}

export interface RunEventSink {
  emit(draft: RunEventDraft): void;
}

export interface SpanState {
  startedAt: string;
  kind: RunEventKind;
  name: string;
}

function truncateAttributes(
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  const truncateValue = (value: unknown): unknown => {
    if (typeof value === "string") return truncateHead(value);
    if (Array.isArray(value)) return value.map(truncateValue);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          truncateValue(item),
        ]),
      );
    }
    return value;
  };

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const candidate = { ...output, [key]: truncateValue(value) };
    if (
      Buffer.byteLength(JSON.stringify(candidate), "utf8") <=
      MAX_ATTRIBUTES_BYTES
    ) {
      output[key] = candidate[key];
    }
  }
  return output;
}

/**
 * Apply the complete control-plane safety boundary to a draft.
 *
 * The runner uses this before emitting as defence in depth, and EventLog uses
 * it again immediately before assigning a sequence and persisting. Truncation
 * helpers are idempotent, so a second pass cannot discard a retained tail.
 */
export function sanitizeRunEventDraft(
  draft: RunEventDraft,
  redact: (value: unknown) => unknown,
): RunEventDraft {
  const redacted = redact(draft) as RunEventDraft;
  const outputText = redacted.output.text;
  return {
    ...redacted,
    spanId: truncateHead(redacted.spanId),
    parentSpanId:
      redacted.parentSpanId === null
        ? null
        : truncateHead(redacted.parentSpanId),
    name: truncateHead(redacted.name),
    startedAt: truncateHead(redacted.startedAt),
    endedAt:
      redacted.endedAt === null ? null : truncateHead(redacted.endedAt),
    input: {
      ...(redacted.input.command === undefined
        ? {}
        : { command: truncateHead(redacted.input.command) }),
      ...(redacted.input.tool === undefined
        ? {}
        : { tool: truncateHead(redacted.input.tool) }),
      ...(redacted.input.paths === undefined
        ? {}
        : { paths: redacted.input.paths.map((item) => truncateHead(item)) }),
      ...(redacted.input.text === undefined
        ? {}
        : { text: truncateHead(redacted.input.text) }),
    },
    output: {
      ...(outputText === undefined
        ? {}
        : {
            text:
              redacted.kind === "command" ||
              redacted.kind === "mcp_tool" ||
              redacted.kind === "message" ||
              redacted.kind === "reasoning"
                ? truncateHeadTail(outputText)
                : truncateHead(outputText),
          }),
      ...(redacted.output.exitCode === undefined
        ? {}
        : { exitCode: redacted.output.exitCode }),
      ...(redacted.output.changedFiles === undefined
        ? {}
        : {
            changedFiles: redacted.output.changedFiles.map((item) =>
              truncateHead(item),
            ),
          }),
      ...(redacted.output.todos === undefined
        ? {}
        : {
            todos: redacted.output.todos.map((todo) => ({
              text: truncateHead(todo.text),
              done: todo.done,
            })),
          }),
    },
    error:
      redacted.error === null
        ? null
        : {
            message: truncateHeadTail(redacted.error.message),
            ...(redacted.error.code === undefined
              ? {}
              : { code: truncateHead(redacted.error.code) }),
          },
    attributes: truncateAttributes(redacted.attributes),
  };
}

const ITEM_KIND: Record<string, RunEventKind> = {
  agent_message: "message",
  reasoning: "reasoning",
  command_execution: "command",
  file_change: "file_change",
  mcp_tool_call: "mcp_tool",
  web_search: "web_search",
  todo_list: "todo",
  // Codex reports diagnostics (e.g. missing model metadata) as an item, not
  // only as a top-level event. Confirmed against a real run.
  error: "error",
};

const ROOT_SPAN_ID = "run";

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" ? value : null;
}

function itemName(itemType: string, item: Record<string, unknown>): string {
  if (itemType === "command_execution") return "bash";
  if (itemType === "file_change") return "apply_patch";
  if (itemType === "mcp_tool_call") {
    const server = readString(item, "server") ?? "mcp";
    const tool = readString(item, "tool") ?? "call";
    return server + "." + tool;
  }
  return itemType;
}

function changedFiles(item: Record<string, unknown>): string[] {
  const changes = item.changes;
  if (!Array.isArray(changes)) return [];
  const paths: string[] = [];
  for (const change of changes) {
    if (change === null || typeof change !== "object") continue;
    const candidate = change as Record<string, unknown>;
    const value = readString(candidate, "path") ?? readString(candidate, "file");
    if (value) paths.push(value);
  }
  return paths;
}

/**
 * Read Codex's plan out of a todo_list item.
 *
 * Codex reports only whether each entry is finished, so `done` is all we can
 * honestly carry. Returns null when there is no usable array at all, which the
 * caller turns into an absent field rather than an empty plan.
 */
function planItems(
  item: Record<string, unknown>,
): { text: string; done: boolean }[] | null {
  const items = item.items;
  if (!Array.isArray(items)) return null;
  const todos: { text: string; done: boolean }[] = [];
  for (const entry of items) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const text = readString(candidate, "text");
    if (text === null) continue;
    todos.push({ text, done: candidate.completed === true });
  }
  return todos;
}

/** Swapping Codex for another Runtime means rewriting only these three. */
function toInput(itemType: string, item: Record<string, unknown>): RunEventInput {
  switch (itemType) {
    case "command_execution":
      return { command: readString(item, "command") ?? "" };
    case "mcp_tool_call":
      return {
        tool: itemName(itemType, item),
        text:
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments ?? {}),
      };
    case "web_search":
      return { text: readString(item, "query") ?? "" };
    case "file_change":
      return { paths: changedFiles(item) };
    default:
      return {};
  }
}

function toOutput(
  itemType: string,
  item: Record<string, unknown>,
): RunEventOutput {
  switch (itemType) {
    case "command_execution": {
      const raw = readString(item, "aggregated_output");
      return {
        ...(typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {}),
        ...(raw === null ? {} : { text: raw }),
      };
    }
    case "todo_list": {
      const todos = planItems(item);
      return todos === null ? {} : { todos };
    }
    case "file_change":
      return { changedFiles: changedFiles(item) };
    case "agent_message":
      return { text: readString(item, "text") ?? "" };
    case "reasoning":
      return { text: readString(item, "text") ?? "" };
    case "mcp_tool_call": {
      const raw = item.result;
      if (raw === undefined || raw === null) return {};
      const text = mcpResultText(raw);
      if (text !== null) return { text };
      return {
        text: typeof raw === "string" ? raw : JSON.stringify(raw),
      };
    }
    default:
      return {};
  }
}

/**
 * Whether an MCP result describes a refusal.
 *
 * The shape varies by server: a structured `isError`, an `error` member, or —
 * for a server that reports through text — a body that leads with the protocol's
 * own error wording. Matching the wording anywhere would flag a tool that merely
 * discussed an error, so it has to lead.
 */
function isFailedToolResult(raw: unknown): boolean {
  if (raw === null || raw === undefined) return false;
  if (typeof raw === "string") return /^\s*(?:mcp\s+)?error\b/i.test(raw);
  if (typeof raw !== "object") return false;
  const record = raw as Record<string, unknown>;
  if (record.isError === true || record.is_error === true) return true;
  if (record.error !== undefined && record.error !== null) return true;
  const content = record.content;
  if (Array.isArray(content)) {
    const first = content[0];
    if (first !== null && typeof first === "object") {
      const text = (first as { text?: unknown }).text;
      if (typeof text === "string") return /^\s*(?:mcp\s+)?error\b/i.test(text);
    }
  }
  return false;
}

function mcpResultText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (item === null || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) parts.push(text);
  }
  return parts.length === 0 ? null : parts.join("\n");
}

function mcpErrorMessage(raw: unknown): string | null {
  if (typeof raw === "string" && raw.trim().length > 0) return raw;
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string" && error.length > 0) return error;
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return mcpResultText(raw);
}

function itemStatus(
  completed: boolean,
  itemType: string,
  item: Record<string, unknown>,
): RunEventStatus {
  // Codex reports setup diagnostics (missing model metadata, for example) as an
  // item of type "error". They are not run failures and must not read as one.
  if (itemType === "error") return "warning";
  if (!completed) return "in_progress";
  const exitCode = item.exit_code;
  if (typeof exitCode === "number" && exitCode !== 0) return "error";
  if (readString(item, "status") === "failed") return "error";
  // An MCP tool reports failure inside its result, not through exit_code, so
  // without this a refused call was recorded as a success. Measured: a
  // publish_artifact that returned "Mcp error: -32000: ENOENT" counted toward
  // "7 successes, 0 failures" — the tally said the tools were fine while the
  // trajectory showed them failing.
  if (itemType === "mcp_tool_call" && isFailedToolResult(item.result)) return "error";
  return "ok";
}

function toError(
  status: RunEventStatus,
  itemType: string,
  item: Record<string, unknown>,
): RunEventError | null {
  if (status !== "error" && status !== "warning") return null;
  if (itemType === "error") {
    return {
      message: readString(item, "message") ?? "Codex reported a diagnostic",
      code: "codex_diagnostic",
    };
  }
  const exitCode = item.exit_code;
  if (typeof exitCode === "number" && exitCode !== 0) {
    const outputTail = commandOutputTail(readString(item, "aggregated_output"));
    return {
      message: [
        (readString(item, "command") ?? itemType) + " exited with code " + exitCode,
        ...(outputTail === null ? [] : ["Output tail:\n" + outputTail]),
      ].join("\n"),
      code: String(exitCode),
    };
  }
  if (itemType === "mcp_tool_call") {
    return { message: mcpErrorMessage(item.result) ?? itemType + " failed" };
  }
  return { message: readString(item, "error") ?? itemType + " failed" };
}

function commandOutputTail(output: string | null, limit = 2_000): string | null {
  const trimmed = output?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= limit) return trimmed;
  return "... (output tail, original_chars=" + trimmed.length + ")\n" +
    trimmed.slice(trimmed.length - limit);
}

/** Provider-specific metadata. Display only -- never consumed by logic. */
function toAttributes(
  itemType: string,
  item: Record<string, unknown>,
): Record<string, unknown> {
  return {
    itemType,
    ...(item.status === undefined ? {} : { codexStatus: item.status }),
    ...(itemType === "todo_list" && item.items !== undefined
      ? { items: item.items }
      : {}),
    ...(itemType === "file_change" && item.changes !== undefined
      ? { changes: item.changes }
      : {}),
  };
}

function parseUsage(raw: unknown): RunUsage | null {
  if (raw === null || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const parsed: RunUsage = {
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
  return Object.keys(parsed).length === 0 ? null : parsed;
}

function addUsage(left: RunUsage, right: RunUsage): RunUsage {
  const sum = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const inputTokens = sum(left.inputTokens, right.inputTokens);
  const cachedInputTokens = sum(left.cachedInputTokens, right.cachedInputTokens);
  const outputTokens = sum(left.outputTokens, right.outputTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

export interface EventCollector {
  consume(event: Record<string, unknown>): void;
  drain(): RunEventDraft[];
  totalUsage(): RunUsage | null;
  threadId(): string | null;
}

export function createEventCollector(options: {
  redact: (value: unknown) => unknown;
  now?: () => string;
}): EventCollector {
  const now = options.now ?? (() => new Date().toISOString());
  const pending: RunEventDraft[] = [];
  const spans = new Map<string, SpanState>();
  let usageTotal: RunUsage | null = null;
  let thread: string | null = null;
  let nextAnonymousItem = 1;
  let nextTurn = 1;
  let nextTopLevelError = 1;

  const push = (draft: RunEventDraft): void => {
    pending.push(sanitizeRunEventDraft(draft, options.redact));
  };

  const handleItem = (
    event: Record<string, unknown>,
    phase: "started" | "updated" | "completed",
  ): void => {
    const raw = event.item;
    if (raw === null || typeof raw !== "object") return;
    const item = raw as Record<string, unknown>;
    const itemType = readString(item, "type");
    if (!itemType) return;
    const kind = ITEM_KIND[itemType];
    if (!kind) return;

    const spanId =
      readString(item, "id") ?? "anonymous-item-" + nextAnonymousItem++;
    const timestamp = now();
    const existing = spans.get(spanId);
    const startedAt = existing?.startedAt ?? timestamp;
    const name = existing?.name ?? itemName(itemType, item);

    if (!existing) spans.set(spanId, { startedAt, kind, name });

    const completed = phase === "completed";
    const status = itemStatus(completed, itemType, item);
    push({
      spanId,
      parentSpanId: ROOT_SPAN_ID,
      kind,
      name,
      status,
      startedAt,
      endedAt: completed ? timestamp : null,
      durationMs: completed
        ? Math.max(0, Date.parse(timestamp) - Date.parse(startedAt))
        : null,
      input: toInput(itemType, item),
      output: toOutput(itemType, item),
      error: toError(status, itemType, item),
      attributes: toAttributes(itemType, item),
      usage: null,
    });

    if (completed) spans.delete(spanId);
  };

  return {
    consume(event: Record<string, unknown>): void {
      const type = readString(event, "type");
      if (!type) return;

      if (type === "thread.started") {
        thread = readString(event, "thread_id");
        return;
      }

      if (type === "item.started") return handleItem(event, "started");
      if (type === "item.updated") return handleItem(event, "updated");
      if (type === "item.completed") return handleItem(event, "completed");

      if (type === "turn.completed" || type === "turn.failed") {
        const usage = parseUsage(event.usage);
        if (usage) {
          usageTotal = usageTotal === null ? usage : addUsage(usageTotal, usage);
        }
        const timestamp = now();
        const failed = type === "turn.failed";
        push({
          spanId: "turn-" + nextTurn++,
          parentSpanId: ROOT_SPAN_ID,
          kind: "turn",
          name: "turn",
          status: failed ? "error" : "ok",
          startedAt: timestamp,
          endedAt: timestamp,
          durationMs: 0,
          input: {},
          output: {},
          error: failed ? { message: "Codex turn failed" } : null,
          attributes: {},
          usage,
        });
        return;
      }

      if (type === "error") {
        const timestamp = now();
        const message =
          readString(event, "message") ??
          readString(event, "error") ??
          "Codex reported an unknown error";
        push({
          spanId: "top-level-error-" + nextTopLevelError++,
          parentSpanId: ROOT_SPAN_ID,
          kind: "error",
          name: "error",
          status: "error",
          startedAt: timestamp,
          endedAt: timestamp,
          durationMs: 0,
          input: {},
          output: {},
          error: { message },
          attributes: {},
          usage: null,
        });
      }
    },
    drain(): RunEventDraft[] {
      return pending.splice(0, pending.length);
    },
    totalUsage(): RunUsage | null {
      return usageTotal;
    },
    threadId(): string | null {
      return thread;
    },
  };
}
