import { describe, expect, it } from "vitest";
import {
  buildTranscript,
  countAgents,
  countToolCalls,
  formatDuration,
  partitionRunMessages,
  runDurationMs,
} from "./run-history";
import type { AgentRun, Message, RunEvent } from "./types";

function run(id: string, createdAt: string, over?: Partial<AgentRun>): AgentRun {
  return {
    id,
    agentId: "leader",
    projectId: null,
    kind: "single",
    parentRunId: null,
    orchestration: null,
    status: "completed",
    prompt: "do the thing",
    output: null,
    error: null,
    usage: null,
    startedAt: null,
    completedAt: null,
    createdAt,
    ...over,
  };
}

function message(
  id: string,
  runId: string,
  role: Message["role"],
  createdAt = "2026-08-30T00:00:00.000Z",
): Message {
  return { id, agentId: "leader", runId, role, content: id, createdAt };
}

function event(seq: number, over: Partial<RunEvent>): RunEvent {
  return {
    seq,
    runId: "r",
    agentId: "leader",
    spanId: "span-" + seq,
    parentSpanId: null,
    kind: "command",
    name: "bash",
    status: "ok",
    startedAt: "2026-08-30T00:00:00.000Z",
    endedAt: null,
    durationMs: null,
    input: {},
    output: {},
    error: null,
    attributes: {},
    usage: null,
    ...over,
  };
}

describe("partitionRunMessages", () => {
  const runs = [run("r3", "2026-08-30T03:00:00.000Z"), run("r2", "2026-08-30T02:00:00.000Z"), run("r1", "2026-08-30T01:00:00.000Z")];

  it("splits the viewed run into prompt, steers and answer", () => {
    const messages = [
      message("ask", "r2", "user"),
      message("steer", "r2", "user"),
      message("answer", "r2", "assistant"),
    ];
    const result = partitionRunMessages({ messages, runs, viewedRunId: "r2" });
    expect(result.prompt?.id).toBe("ask");
    expect(result.steers.map((item) => item.id)).toEqual(["steer"]);
    expect(result.answer?.id).toBe("answer");
  });

  it("keeps older runs as history when the newest run is viewed", () => {
    const messages = [
      message("old", "r1", "user"),
      message("mid", "r2", "user"),
      message("new", "r3", "user"),
    ];
    const result = partitionRunMessages({ messages, runs, viewedRunId: "r3" });
    expect(result.history.map((item) => item.id)).toEqual(["old", "mid"]);
  });

  it("hides runs newer than the one being viewed", () => {
    const messages = [
      message("old", "r1", "user"),
      message("mid", "r2", "user"),
      message("new", "r3", "user"),
    ];
    const result = partitionRunMessages({ messages, runs, viewedRunId: "r2" });
    expect(result.history.map((item) => item.id)).toEqual(["old"]);
    expect(result.prompt?.id).toBe("mid");
  });

  it("shows every message as history when no run is being viewed", () => {
    const messages = [message("old", "r1", "user"), message("new", "r3", "user")];
    const result = partitionRunMessages({ messages, runs, viewedRunId: null });
    expect(result.history.map((item) => item.id)).toEqual(["old", "new"]);
    expect(result.prompt).toBeNull();
  });

  it("falls back to every other run as history when the run list has not loaded", () => {
    const messages = [message("old", "r1", "user"), message("mine", "r2", "user")];
    const result = partitionRunMessages({ messages, runs: [], viewedRunId: "r2" });
    expect(result.history.map((item) => item.id)).toEqual(["old"]);
    expect(result.prompt?.id).toBe("mine");
  });
});

describe("runDurationMs", () => {
  it("measures from start to completion", () => {
    expect(
      runDurationMs(
        run("r", "2026-08-30T00:00:00.000Z", {
          startedAt: "2026-08-30T00:00:01.000Z",
          completedAt: "2026-08-30T00:00:31.000Z",
        }),
      ),
    ).toBe(30_000);
  });

  it("falls back to creation when the run never recorded a start", () => {
    expect(
      runDurationMs(
        run("r", "2026-08-30T00:00:00.000Z", {
          completedAt: "2026-08-30T00:00:05.000Z",
        }),
      ),
    ).toBe(5_000);
  });

  it("has no duration while the run is still open", () => {
    expect(runDurationMs(run("r", "2026-08-30T00:00:00.000Z", { status: "running" }))).toBeNull();
  });
});

describe("formatDuration", () => {
  it("reads in seconds under a minute", () => {
    expect(formatDuration(4_200)).toBe("4.2s");
  });

  it("reads in minutes and seconds beyond one", () => {
    expect(formatDuration(95_000)).toBe("1m 35s");
  });

  it("reads in hours beyond one", () => {
    expect(formatDuration(3_725_000)).toBe("1h 2m");
  });
});

describe("countToolCalls", () => {
  it("counts one call per span, not per event", () => {
    const events = [
      event(1, { spanId: "a", status: "in_progress" }),
      event(2, { spanId: "a", status: "ok" }),
      event(3, { spanId: "b", kind: "mcp_tool" }),
    ];
    expect(countToolCalls(events)).toBe(2);
  });

  it("ignores reasoning, messages and lifecycle events", () => {
    const events = [
      event(1, { spanId: "a", kind: "reasoning" }),
      event(2, { spanId: "b", kind: "message" }),
      event(3, { spanId: "c", kind: "run" }),
      event(4, { spanId: "d", kind: "turn" }),
      event(5, { spanId: "e", kind: "api_call" }),
    ];
    expect(countToolCalls(events)).toBe(0);
  });
});

describe("countAgents", () => {
  it("counts the distinct agents that appear in the trace", () => {
    const events = [
      event(1, { agentId: "leader" }),
      event(2, { agentId: "worker-a" }),
      event(3, { agentId: "worker-a" }),
    ];
    expect(countAgents(events)).toBe(2);
  });
});

describe("buildTranscript", () => {
  const runs = [
    run("r3", "2026-08-30T03:00:00.000Z"),
    run("r2", "2026-08-30T02:00:00.000Z"),
    run("r1", "2026-08-30T01:00:00.000Z"),
  ];
  const messages = [
    message("ask1", "r1", "user", "2026-08-30T01:00:00.000Z"),
    message("say1", "r1", "assistant", "2026-08-30T01:01:00.000Z"),
    message("ask2", "r2", "user", "2026-08-30T02:00:00.000Z"),
    message("say2", "r2", "assistant", "2026-08-30T02:01:00.000Z"),
    message("ask3", "r3", "user", "2026-08-30T03:00:00.000Z"),
    message("say3", "r3", "assistant", "2026-08-30T03:01:00.000Z"),
  ];

  const shape = (rows: ReturnType<typeof buildTranscript>["rows"]) =>
    rows.map((row) => (row.kind === "run" ? "run:" + row.run.id : "msg:" + row.message.id));

  it("opens every run with its own header, oldest first", () => {
    const result = buildTranscript({ messages, runs, viewedRunId: "r3" });
    expect(shape(result.rows)).toEqual([
      "run:r1",
      "msg:ask1",
      "msg:say1",
      "run:r2",
      "msg:ask2",
      "msg:say2",
      "run:r3",
      "msg:ask3",
    ]);
  });

  it("numbers runs from the operator's first, not from the newest", () => {
    const result = buildTranscript({ messages, runs, viewedRunId: "r3" });
    const headers = result.rows.filter((row) => row.kind === "run");
    expect(headers.map((row) => (row.kind === "run" ? row.position : 0))).toEqual([1, 2, 3]);
    expect(headers.every((row) => row.kind === "run" && row.total === 3)).toBe(true);
  });

  /** The viewed run's work is rendered below by the timeline, so only its prompt belongs here. */
  it("hands back the viewed run's steers and answer instead of placing them", () => {
    const withSteer = [...messages, message("steer3", "r3", "user", "2026-08-30T03:00:30.000Z")];
    const result = buildTranscript({ messages: withSteer, runs, viewedRunId: "r3" });
    expect(shape(result.rows).filter((id) => id.startsWith("msg:say3"))).toEqual([]);
    expect(result.steers.map((item) => item.id)).toEqual(["steer3"]);
    expect(result.answer?.id).toBe("say3");
  });

  it("keeps an older run's answer in the transcript, because nothing else shows it", () => {
    const result = buildTranscript({ messages, runs, viewedRunId: "r3" });
    expect(shape(result.rows)).toContain("msg:say1");
    expect(shape(result.rows)).toContain("msg:say2");
  });

  it("stops at the run being read, so an answer never precedes its question", () => {
    const result = buildTranscript({ messages, runs, viewedRunId: "r2" });
    expect(shape(result.rows)).toEqual([
      "run:r1",
      "msg:ask1",
      "msg:say1",
      "run:r2",
      "msg:ask2",
    ]);
  });

  it("orders a run's messages by when they were sent", () => {
    const jumbled = [
      message("say1", "r1", "assistant", "2026-08-30T01:01:00.000Z"),
      message("ask1", "r1", "user", "2026-08-30T01:00:00.000Z"),
    ];
    const result = buildTranscript({ messages: jumbled, runs: [runs[2]!], viewedRunId: "r1" });
    expect(shape(result.rows)).toEqual(["run:r1", "msg:ask1"]);
    expect(result.answer?.id).toBe("say1");
  });

  it("shows a message whose run is gone rather than dropping it", () => {
    const orphaned = [message("orphan", "gone", "user", "2026-08-30T00:00:00.000Z"), ...messages];
    const result = buildTranscript({ messages: orphaned, runs, viewedRunId: "r1" });
    expect(shape(result.rows)[0]).toBe("msg:orphan");
  });

  it("falls back to a plain message list before any run has loaded", () => {
    const result = buildTranscript({ messages, runs: [], viewedRunId: null });
    expect(shape(result.rows)).toEqual([
      "msg:ask1",
      "msg:say1",
      "msg:ask2",
      "msg:say2",
      "msg:ask3",
      "msg:say3",
    ]);
  });
});
