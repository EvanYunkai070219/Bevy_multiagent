/** Structured JSONL projection of a Run's event stream, split by agent. */
import type { RunEvent } from "./run-events.js";

export interface RefinedTrajectoryRecord {
  member: string;
  ts: string;
  seq: number;
  type: string;
  run_id: string;
  span_id: string;
  parent_span_id: string | null;
  source_kind: string;
  name: string;
  status: string;
  [key: string]: unknown;
}

export interface RefinedTrajectoryState {
  startedToolSpans: Set<string>;
}

export function createRefinedTrajectoryState(): RefinedTrajectoryState {
  return { startedToolSpans: new Set() };
}

export function renderRefinedTrajectoryRecords(
  event: RunEvent,
  state: RefinedTrajectoryState,
): RefinedTrajectoryRecord[] {
  const startedAt = event.startedAt || event.endedAt || "";
  const endedAt = event.endedAt || event.startedAt || "";

  switch (event.kind) {
    case "api_call":
      return apiCall(event, startedAt, endedAt);
    case "command":
    case "mcp_tool":
    case "web_search":
      return toolEvent(event, state, startedAt, endedAt);
    case "message":
      return [message(event, endedAt)];
    case "reasoning":
      return [withText(base(event, "reasoning", endedAt, 0), event.output.text ?? event.input.text)];
    case "error":
      return [withError(base(event, "diagnostic", endedAt, 0), event.error)];
    default:
      return [generic(event, endedAt)];
  }
}

function apiCall(
  event: RunEvent,
  startedAt: string,
  endedAt: string,
): RefinedTrajectoryRecord[] {
  if (event.status === "in_progress") {
    const record = base(event, "api_call", startedAt, 0);
    add(record, "model", event.attributes.model);
    add(record, "endpoint", event.attributes.endpoint);
    add(record, "request_bytes", event.attributes.requestBytes);
    add(record, "input", event.input);
    return [record];
  }

  const text = event.output.text;
  if (text === undefined || text.length === 0) {
    const record = base(event, "api_call", endedAt, 1);
    add(record, "output", event.output);
    add(record, "error", event.error);
    add(record, "duration_ms", event.durationMs);
    add(record, "usage", event.usage);
    return [record];
  }

  const split = parseJsonSuffix(text);
  const records: RefinedTrajectoryRecord[] = [];
  if (split.text.trim().length > 0) {
    const record = withText(base(event, "reasoning", endedAt, 1), split.text);
    add(record, "duration_ms", event.durationMs);
    add(record, "usage", event.usage);
    records.push(record);
  }
  if (split.toolRequest !== undefined) {
    const record = base(event, "tool_call", endedAt, 2);
    record.name = inferRequestedTool(split.toolRequest);
    record.tool_kind = "assistant_tool_request";
    add(record, "arguments", split.toolRequest);
    records.push(record);
  }
  return records;
}

function toolEvent(
  event: RunEvent,
  state: RefinedTrajectoryState,
  startedAt: string,
  endedAt: string,
): RefinedTrajectoryRecord[] {
  const records: RefinedTrajectoryRecord[] = [];
  const sawStart = state.startedToolSpans.has(event.spanId);
  if (event.status === "in_progress") state.startedToolSpans.add(event.spanId);

  if (event.status === "in_progress" || !sawStart) {
    const call = base(event, "tool_call", startedAt, 0);
    call.tool_kind = event.kind;
    add(call, "command", event.input.command);
    add(call, "tool", event.input.tool || event.name);
    add(call, "arguments", event.input.text);
    records.push(call);
  }

  if (event.status !== "in_progress") {
    const result = base(event, "tool_result", endedAt, 1);
    result.tool_kind = event.kind;
    add(result, "output", event.output);
    add(result, "error", event.error);
    add(result, "duration_ms", event.durationMs);
    records.push(result);
  }

  return records;
}

function message(event: RunEvent, ts: string): RefinedTrajectoryRecord {
  const record = base(event, "agent_message", ts, 0);
  return withText(record, event.output.text ?? event.input.text);
}

function generic(event: RunEvent, ts: string): RefinedTrajectoryRecord {
  const record = base(event, event.kind === "run" ? "run" : "event", ts, 0);
  add(record, "input", event.input);
  add(record, "output", event.output);
  add(record, "error", event.error);
  add(record, "duration_ms", event.durationMs);
  add(record, "usage", event.usage);
  return record;
}

function base(
  event: RunEvent,
  type: string,
  ts: string,
  seqOffset: number,
): RefinedTrajectoryRecord {
  return {
    member: event.agentId || "unknown",
    ts,
    seq: event.seq * 10 + seqOffset,
    type,
    run_id: event.runId,
    span_id: event.spanId,
    parent_span_id: event.parentSpanId,
    source_kind: event.kind,
    name: event.name,
    status: event.status,
  };
}

function withText(
  record: RefinedTrajectoryRecord,
  text: string | undefined,
): RefinedTrajectoryRecord {
  add(record, "text", text);
  return record;
}

function withError(
  record: RefinedTrajectoryRecord,
  error: RunEvent["error"],
): RefinedTrajectoryRecord {
  add(record, "error", error);
  return record;
}

function add(record: RefinedTrajectoryRecord, key: string, value: unknown): void {
  const item = compact(value);
  if (item !== undefined) record[key] = item;
}

function compact(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.length === 0 ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length === 0 ? undefined : value;
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => compact(item) !== undefined);
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  }
  return value;
}

function parseJsonSuffix(text: string): {
  text: string;
  toolRequest: Record<string, unknown> | undefined;
} {
  const trimmed = text.trimEnd();
  for (const marker of ['{"cmd"', '{"command"', '{"session_id"', '{"tool"']) {
    const index = trimmed.lastIndexOf(marker);
    if (index < 0) continue;
    const prefix = trimmed.slice(0, index).trimEnd();
    const suffix = trimmed.slice(index).replace(/(?:\{\})+$/g, "");
    try {
      const parsed = JSON.parse(suffix) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { text: prefix, toolRequest: parsed as Record<string, unknown> };
      }
    } catch {
      // Keep looking for another recognizable JSON request marker.
    }
  }
  return { text, toolRequest: undefined };
}

function inferRequestedTool(args: Record<string, unknown>): string {
  if (typeof args.tool === "string") return args.tool;
  if (typeof args.cmd === "string" || typeof args.command === "string") return "exec_command";
  if (Object.prototype.hasOwnProperty.call(args, "session_id")) return "write_stdin";
  return "tool";
}
