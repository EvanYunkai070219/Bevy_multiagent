/**
 * Human-readable projection of a Run's event stream.
 *
 * A best-effort second reader of the same ordered `RunEvent` stream the JSONL
 * log consumes. It cannot disagree with the JSONL about order or content, but
 * it can fall short of it: a failed write is swallowed, because a log must
 * never fail the Run it describes. The JSONL stays the record of truth.
 *
 * Every value here has already passed the sink's redaction and truncation.
 * Content fingerprints are computed upstream, over raw content, and arrive as
 * `attributes` — this module only renders them.
 */
import type { RunEvent } from "./run-events.js";
import { visibleOutputTokens } from "./types.js";

export interface TrajectoryState {
  startedAt: number | null;
  apiCalls: number;
  openCalls: Set<string>;
  commands: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Lines produced while a model call is still open.
   *
   * Codex parses the same response stream the proxy relays, so it can act on a
   * reply before the proxy has summarised it. Appending in raw arrival order
   * would print the command above the reply that asked for it — the exact
   * inversion this log exists to make impossible. Anything derived while a call
   * is open is held and flushed directly after that call's response block.
   */
  held: string[];
}

export function createTrajectoryState(): TrajectoryState {
  return {
    startedAt: null,
    apiCalls: 0,
    openCalls: new Set(),
    commands: 0,
    inputTokens: 0,
    outputTokens: 0,
    held: [],
  };
}

/**
 * Rebuild counters by replaying the events already on disk.
 *
 * A process that recovers a run holds none of the state the original process
 * accumulated, and a trailer rendered from a fresh counter reports zero work
 * for a run whose own JSONL records the calls. The trailer has to be derived
 * from the same events the rest of the file was rendered from, or it becomes
 * a second, quieter source of truth that disagrees with the first.
 *
 * Deliberately mirrors what `apiRequest` / `apiResponse` / `command` do to the
 * state as they render, minus the rendering.
 */
export function replayTrajectoryState(events: RunEvent[]): TrajectoryState {
  const state = createTrajectoryState();
  for (const item of events) {
    if (state.startedAt === null) {
      const started = Date.parse(item.startedAt);
      if (!Number.isNaN(started)) state.startedAt = started;
    }
    if (item.kind === "api_call") {
      if (item.status === "in_progress") {
        state.apiCalls += 1;
        state.openCalls.add(item.spanId);
      } else {
        state.openCalls.delete(item.spanId);
        state.inputTokens += item.usage?.inputTokens ?? 0;
        state.outputTokens += item.usage?.outputTokens ?? 0;
      }
      continue;
    }
    if (item.kind === "command" && item.status !== "in_progress") {
      state.commands += 1;
    }
  }
  return state;
}

export function renderTrajectoryLines(
  event: RunEvent,
  state: TrajectoryState,
): string[] {
  switch (event.kind) {
    case "run":
      return event.status === "in_progress"
        ? runStart(event, state)
        : runEnd(event, state);
    case "api_call":
      return event.status === "in_progress"
        ? apiRequest(event, state)
        : apiResponse(event, state);
    case "command":
      return hold(
        state,
        event.status === "in_progress" ? commandStart(event, state) : commandEnd(event),
      );
    default:
      return hold(state, event.status === "in_progress" ? [] : other(event));
  }
}

function hold(state: TrajectoryState, lines: string[]): string[] {
  if (state.openCalls.size === 0 || lines.length === 0) return lines;
  state.held.push(...lines);
  return [];
}

function flushHeld(state: TrajectoryState): string[] {
  if (state.held.length === 0) return [];
  const lines = state.held;
  state.held = [];
  return lines;
}

function runStart(event: RunEvent, state: TrajectoryState): string[] {
  state.startedAt = Date.parse(event.startedAt) || null;
  const model = readString(event.attributes.model);
  return [
    "",
    "========== run start ==========",
    "timestamp=" + event.startedAt,
    "run_id=" + event.runId + "  agent_id=" + event.agentId +
      (model === null ? "" : "  model=" + model),
    ...(event.input.text === undefined ? [] : ["input=" + oneLine(event.input.text)]),
    "",
  ];
}

function runEnd(event: RunEvent, state: TrajectoryState): string[] {
  return [
    // A call that never closed would otherwise take its derived events with it.
    ...flushHeld(state),
    "",
    "========== run end ==========",
    "status=" + event.name,
    "elapsed_ms=" + (event.durationMs ?? elapsed(state, event)),
    "api_calls=" + state.apiCalls +
      (state.openCalls.size > 0 ? "  incomplete=" + state.openCalls.size : "") +
      "  commands=" + state.commands +
      "  tokens_in=" + state.inputTokens +
      "  tokens_out=" + state.outputTokens,
    "",
  ];
}

function apiRequest(event: RunEvent, state: TrajectoryState): string[] {
  const index = callIndex(event, state);
  state.apiCalls += 1;
  state.openCalls.add(event.spanId);
  const endpoint = readString(event.attributes.endpoint) ?? "";
  return [
    "[API] #" + index + (endpoint === "" ? "" : "  " + endpoint),
    "  | request:",
    // The recorder that produced this event owns how the request reads: it is
    // the only side holding the raw bodies and their digests. Rendering a
    // second pointer line here from `attributes` duplicated it.
    ...body(event.input.text),
  ];
}

function apiResponse(event: RunEvent, state: TrajectoryState): string[] {
  const index = callIndex(event, state);
  state.openCalls.delete(event.spanId);
  state.inputTokens += event.usage?.inputTokens ?? 0;
  state.outputTokens += event.usage?.outputTokens ?? 0;
  const status = readNumber(event.attributes.httpStatus);
  // The outcome cannot go on the header line: that line was already appended
  // when the request went out, and this file is append-only.
  const outcome =
    (status === null ? event.status : String(status)) +
    "  " + (event.durationMs ?? 0) + "ms" +
    "  in=" + (event.usage?.inputTokens ?? 0) +
    "  out=" + (event.usage?.outputTokens ?? 0) +
    // `out=` is what the provider billed. On a reasoning model most of it is
    // thinking that never reached the response, so the split has to be visible
    // here or the number reads as "the model wrote a lot".
    (event.usage?.reasoningTokens === undefined
      ? ""
      : "  (visible=" +
        visibleOutputTokens(event.usage) +
        " reasoning=" +
        event.usage.reasoningTokens +
        ")");
  return [
    ...(event.error === null
      ? ["  | response: " + outcome, ...body(event.output.text)]
      : [
          "  | error: " + outcome,
          "  |   " + oneLine(event.error.message),
          ...body(event.output.text),
        ]),
    "",
    // Anything Codex derived from this response, in its original order.
    ...flushHeld(state),
  ];
}

function commandStart(event: RunEvent, state: TrajectoryState): string[] {
  state.commands += 1;
  const command = event.input.command ?? event.name;
  return ["[CMD] " + oneLine(command)];
}

function commandEnd(event: RunEvent): string[] {
  const exit = event.output.exitCode;
  return [
    "  | exit=" + (exit ?? (event.status === "ok" ? 0 : "?")) +
      "  " + (event.durationMs ?? 0) + "ms",
    ...body(event.output.text),
    "",
  ];
}

function other(event: RunEvent): string[] {
  const text = event.output.text ?? event.input.text;
  if (text === undefined) return [];
  return ["[" + event.kind.toUpperCase() + "] " + event.name, ...body(text), ""];
}

function callIndex(event: RunEvent, state: TrajectoryState): number {
  return readNumber(event.attributes.callIndex) ?? state.apiCalls + 1;
}

function body(text: string | undefined): string[] {
  if (text === undefined || text.length === 0) return [];
  return text.split("\n").map((line) => "  |   " + line);
}

function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, " ");
}

function elapsed(state: TrajectoryState, event: RunEvent): number {
  if (state.startedAt === null) return 0;
  return Math.max(0, (Date.parse(event.startedAt) || state.startedAt) - state.startedAt);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
