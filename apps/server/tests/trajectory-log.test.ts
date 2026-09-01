/** Covers the human-readable projection of the RunEvent stream. */
import { describe, expect, it } from "vitest";
import {
  createTrajectoryState,
  renderTrajectoryLines,
  replayTrajectoryState,
} from "../src/trajectory-log.js";
import type { RunEvent } from "../src/run-events.js";

let seq = 0;

function event(overrides: Partial<RunEvent>): RunEvent {
  seq += 1;
  return {
    seq,
    runId: "run-1",
    agentId: "agent-1",
    spanId: "span-" + seq,
    parentSpanId: "run",
    kind: "message",
    name: "message",
    status: "ok",
    startedAt: "2026-08-26T12:00:00.000Z",
    endedAt: "2026-08-26T12:00:00.000Z",
    durationMs: 0,
    input: {},
    output: {},
    error: null,
    attributes: {},
    usage: null,
    ...overrides,
  };
}

const render = (events: RunEvent[]): string => {
  const state = createTrajectoryState();
  return events.flatMap((item) => renderTrajectoryLines(item, state)).join("\n");
};

describe("trajectory trailer after a restart", () => {
  // A restarted process starts with empty counters, so the trailer it renders
  // reports zero for a run that demonstrably did work. Run 9f5ba522 ended with
  // `api_calls=0 tokens_out=0` while its own events.jsonl held one 159020ms call
  // billing 24919 output tokens — reading that trailer says nothing happened.
  it("rebuilds counters from persisted events instead of an empty state", () => {
    const persisted: RunEvent[] = [
      event({ kind: "api_call", name: "planner", status: "in_progress", spanId: "api-1" }),
      event({
        kind: "api_call",
        name: "planner",
        status: "ok",
        spanId: "api-1",
        durationMs: 159020,
        usage: { inputTokens: 382, outputTokens: 24919 },
      }),
      event({ kind: "command", name: "bash", status: "ok", spanId: "cmd-1" }),
    ];

    const state = replayTrajectoryState(persisted);
    const trailer = renderTrajectoryLines(
      event({ kind: "run", name: "server_restarted", status: "error" }),
      state,
    ).join("\n");

    expect(trailer).toContain("api_calls=1");
    expect(trailer).toContain("commands=1");
    expect(trailer).toContain("tokens_in=382");
    expect(trailer).toContain("tokens_out=24919");
  });

  it("does not count an api_call whose response never arrived as complete", () => {
    const state = replayTrajectoryState([
      event({ kind: "api_call", name: "planner", status: "in_progress", spanId: "api-1" }),
    ]);
    const trailer = renderTrajectoryLines(
      event({ kind: "run", name: "server_restarted", status: "error" }),
      state,
    ).join("\n");

    expect(trailer).toContain("api_calls=1");
    expect(trailer).toContain("incomplete=1");
    expect(trailer).toContain("tokens_out=0");
  });
});

describe("trajectory log", () => {
  it("opens with a run start block carrying the prompt", () => {
    const text = render([
      event({
        kind: "run",
        name: "started",
        status: "in_progress",
        endedAt: null,
        input: { text: "Audit the repository" },
        attributes: { model: "ep-test" },
      }),
    ]);

    expect(text).toContain("========== run start ==========");
    expect(text).toContain("run_id=run-1");
    expect(text).toContain("input=Audit the repository");
  });

  it("renders one api_call span as a request block then a response block", () => {
    const text = render([
      event({
        kind: "api_call",
        name: "codex",
        status: "in_progress",
        spanId: "api-codex-1",
        endedAt: null,
        input: { text: "user: find the lockfiles" },
        attributes: { callIndex: 1, endpoint: "/v1/responses" },
      }),
      event({
        kind: "api_call",
        name: "codex",
        status: "ok",
        spanId: "api-codex-1",
        durationMs: 2916,
        output: { text: "tool_call: exec_command(rg --files)" },
        usage: { inputTokens: 8412, outputTokens: 331 },
        attributes: { callIndex: 1, httpStatus: 200 },
      }),
    ]);

    const lines = text.split("\n");
    // Exactly one [API] header per call: it is appended when the request goes
    // out, so the outcome has to ride the response line instead.
    expect(lines.filter((line) => line.startsWith("[API] #1"))).toHaveLength(1);
    const response = lines.find((line) => line.startsWith("  | response:"))!;
    expect(response).toContain("200");
    expect(response).toContain("2916ms");
    expect(response).toContain("in=8412");
    expect(response).toContain("out=331");
    expect(text).toContain("  | request:");
    expect(text).toContain("find the lockfiles");
    expect(text).toContain("exec_command");
  });

  it("keeps [API] and [CMD] in append order", () => {
    const text = render([
      event({ kind: "api_call", status: "in_progress", spanId: "a1", endedAt: null,
        input: { text: "run git clone" }, attributes: { callIndex: 1 } }),
      event({ kind: "api_call", status: "ok", spanId: "a1",
        output: { text: "tool_call: exec_command(git clone)" }, attributes: { callIndex: 1 } }),
      event({ kind: "command", name: "bash", status: "in_progress", spanId: "c1",
        endedAt: null, input: { command: "git clone --depth=1 https://x" } }),
      event({ kind: "command", name: "bash", status: "ok", spanId: "c1",
        durationMs: 1914, output: { text: "Cloning into ... done.", exitCode: 0 } }),
    ]);

    const order = text
      .split("\n")
      .filter((line) => line.startsWith("[API]") || line.startsWith("[CMD]"))
      .map((line) => line.slice(0, 5));
    expect(order).toEqual(["[API]", "[CMD]"]);
    expect(text.indexOf("git clone --depth=1")).toBeGreaterThan(text.indexOf("[API] #1"));
  });

  it("passes the recorder's request rendering through verbatim", () => {
    const text = render([
      event({ kind: "api_call", status: "in_progress", spanId: "a1", endedAt: null,
        input: { text: "instructions: <sha256:abc…>\ninput[+2] user: go" },
        attributes: { callIndex: 1 } }),
    ]);

    expect(text).toContain("  |   instructions: <sha256:abc…>");
    expect(text).toContain("  |   input[+2] user: go");
  });

  it("closes with totals and counts an unfinished call as incomplete", () => {
    const text = render([
      event({ kind: "run", name: "started", status: "in_progress", endedAt: null }),
      event({ kind: "api_call", status: "in_progress", spanId: "a1", endedAt: null,
        attributes: { callIndex: 1 } }),
      event({ kind: "api_call", status: "ok", spanId: "a1",
        usage: { inputTokens: 100, outputTokens: 20 }, attributes: { callIndex: 1 } }),
      event({ kind: "api_call", status: "in_progress", spanId: "a2", endedAt: null,
        attributes: { callIndex: 2 } }),
      event({ kind: "command", status: "in_progress", spanId: "c1", endedAt: null,
        input: { command: "ls" } }),
      event({ kind: "command", status: "ok", spanId: "c1", output: { exitCode: 0 } }),
      event({ kind: "run", name: "completed", status: "ok", durationMs: 182450 }),
    ]);

    expect(text).toContain("========== run end ==========");
    expect(text).toContain("status=completed");
    expect(text).toContain("elapsed_ms=182450");
    expect(text).toContain("api_calls=2");
    expect(text).toContain("incomplete=1");
    expect(text).toContain("commands=1");
    expect(text).toContain("tokens_in=100");
    expect(text).toContain("tokens_out=20");
  });

  it("holds events derived from an open call until that call's response lands", () => {
    // Codex parses the same stream the proxy relays, so it can act on a
    // response before the proxy has summarised it. Rendering in raw append
    // order would print the command above the reply that asked for it.
    const text = render([
      event({ kind: "api_call", status: "in_progress", spanId: "a1", endedAt: null,
        attributes: { callIndex: 1 } }),
      event({ kind: "message", name: "agent_message", status: "ok",
        output: { text: "I will create the file" } }),
      event({ kind: "command", name: "bash", status: "in_progress", spanId: "c1",
        endedAt: null, input: { command: "printf hi > hello.txt" } }),
      event({ kind: "api_call", status: "ok", spanId: "a1",
        output: { text: "tool_call: exec_command(printf)" },
        attributes: { callIndex: 1, httpStatus: 200 } }),
    ]);

    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const response = lines.findIndex((line) => line.startsWith("  | response:"));
    const message = lines.findIndex((line) => line.startsWith("[MESSAGE]"));
    const command = lines.findIndex((line) => line.startsWith("[CMD]"));
    expect(response).toBeGreaterThanOrEqual(0);
    expect(message).toBeGreaterThan(response);
    expect(command).toBeGreaterThan(response);
  });

  it("flushes held events when a run ends without closing its call", () => {
    const text = render([
      event({ kind: "run", name: "started", status: "in_progress", endedAt: null }),
      event({ kind: "api_call", status: "in_progress", spanId: "a1", endedAt: null,
        attributes: { callIndex: 1 } }),
      event({ kind: "command", name: "bash", status: "in_progress", spanId: "c1",
        endedAt: null, input: { command: "echo orphan" } }),
      event({ kind: "run", name: "failed", status: "error", durationMs: 10 }),
    ]);

    expect(text).toContain("echo orphan");
    expect(text.indexOf("echo orphan")).toBeLessThan(text.indexOf("run end"));
    expect(text).toContain("incomplete=1");
  });
});
