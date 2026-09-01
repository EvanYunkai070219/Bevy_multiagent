/** Verifies provider events are normalised into the canonical RunEvent shape. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createRedactor } from "../src/redact.js";
import { createEventCollector } from "../src/run-events.js";
import type { RunEventDraft } from "../src/run-events.js";

function collect(events: Record<string, unknown>[]): RunEventDraft[] {
  const collector = createEventCollector({ redact: createRedactor([]) });
  for (const event of events) collector.consume(event);
  return collector.drain();
}

const commandRun = (
  id: string,
  command: string,
  exitCode: number,
  output = "",
): Record<string, unknown>[] => [
  {
    type: "item.started",
    item: { id, type: "command_execution", command, status: "in_progress" },
  },
  {
    type: "item.completed",
    item: {
      id,
      type: "command_execution",
      command,
      exit_code: exitCode,
      aggregated_output: output,
      status: exitCode === 0 ? "completed" : "failed",
    },
  },
];

describe("Codex event normalisation", () => {
  it("pairs started and completed items by span id", () => {
    const drafts = collect(commandRun("item_1", "ls -la", 0, "total 0"));
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.spanId).toBe("item_1");
    expect(drafts[1]?.spanId).toBe("item_1");
    expect(drafts[0]?.status).toBe("in_progress");
    expect(drafts[0]?.endedAt).toBeNull();
    expect(drafts[1]?.status).toBe("ok");
    expect(drafts[1]?.endedAt).not.toBeNull();
    expect(drafts[1]?.durationMs).not.toBeNull();
  });

  it("carries the started timestamp through to the completed event", () => {
    const drafts = collect(commandRun("item_1", "ls", 0));
    expect(drafts[1]?.startedAt).toBe(drafts[0]?.startedAt);
  });

  it("marks a non-zero exit code as an error", () => {
    const drafts = collect(
      commandRun("item_2", "ls /nope", 1, "No such file or directory"),
    );
    const completed = drafts[1];
    expect(completed?.status).toBe("error");
    expect(completed?.output.exitCode).toBe(1);
  });

  it("includes command output in failed command errors", () => {
    const drafts = collect(
      commandRun("item_2", "python3 quick_validate.py skill", 1, "missing required directory: scripts"),
    );
    const completed = drafts[1];
    expect(completed?.error?.message).toContain("python3 quick_validate.py skill exited with code 1");
    expect(completed?.error?.message).toContain("Output tail:");
    expect(completed?.error?.message).toContain("missing required directory: scripts");
  });

  it("keeps the tail of long failed command output in the error message", () => {
    const output = "setup ok\n".repeat(400) + "final validator failure: references/example.md missing";
    const drafts = collect(commandRun("item_2", "python3 quick_validate.py skill", 1, output));
    const completed = drafts[1];
    expect(completed?.error?.message).toContain("output tail");
    expect(completed?.error?.message).toContain("final validator failure: references/example.md missing");
  });

  it("puts the command into canonical input, not attributes", () => {
    const drafts = collect(commandRun("item_1", "npm test", 0));
    expect(drafts[0]?.input.command).toBe("npm test");
    expect(drafts[0]?.attributes.command).toBeUndefined();
  });

  it("normalises file changes into canonical paths", () => {
    const drafts = collect([
      {
        type: "item.completed",
        item: {
          id: "item_3",
          type: "file_change",
          status: "completed",
          changes: [
            { path: "src/index.ts", kind: "add" },
            { path: "src/index.test.ts", kind: "update" },
          ],
        },
      },
    ]);
    expect(drafts[0]?.kind).toBe("file_change");
    expect(drafts[0]?.output.changedFiles).toEqual([
      "src/index.ts",
      "src/index.test.ts",
    ]);
    expect(drafts[0]?.input.paths).toEqual([
      "src/index.ts",
      "src/index.test.ts",
    ]);
  });

  it("emits a message event carrying the agent reply", () => {
    const drafts = collect([
      {
        type: "item.completed",
        item: { id: "item_4", type: "agent_message", text: "All done." },
      },
    ]);
    expect(drafts[0]?.kind).toBe("message");
    expect(drafts[0]?.output.text).toBe("All done.");
  });

  it("omits todos when the plan payload is missing or malformed", () => {
    const missing = collect([
      { type: "item.completed", item: { id: "t1", type: "todo_list" } },
    ]);
    expect(missing[0]?.output.todos).toBeUndefined();

    const malformed = collect([
      {
        type: "item.completed",
        item: { id: "t2", type: "todo_list", items: "not an array" },
      },
    ]);
    expect(malformed[0]?.output.todos).toBeUndefined();
  });

  it("shows MCP tool result text instead of the raw protocol envelope", () => {
    const drafts = collect([
      {
        type: "item.completed",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          server: "launchpad",
          tool: "publish_artifact",
          arguments: "{\"description\":\"player2 moves\",\"path\":\"player2_moves.json\"}",
          result: {
            content: [
              {
                type: "text",
                text: "Mcp error: -32000: ENOENT: no such file or directory, open '/workspace/player2_moves.json'",
              },
            ],
            isError: true,
          },
        },
      },
    ]);

    expect(drafts[0]?.status).toBe("error");
    expect(drafts[0]?.input).toEqual({
      tool: "launchpad.publish_artifact",
      text: "{\"description\":\"player2 moves\",\"path\":\"player2_moves.json\"}",
    });
    expect(drafts[0]?.output.text).toContain("/workspace/player2_moves.json");
    expect(drafts[0]?.output.text).not.toContain("\"content\"");
    expect(drafts[0]?.error?.message).toContain("/workspace/player2_moves.json");
    expect(drafts[0]?.error?.message).not.toBe("mcp_tool_call failed");
  });

  it("keeps an empty plan distinct from no plan at all", () => {
    const drafts = collect([
      { type: "item.completed", item: { id: "t3", type: "todo_list", items: [] } },
    ]);
    // An empty array is Codex reporting a cleared plan, which is not the same
    // as Codex never reporting one. The frontend decides whether to show it.
    expect(drafts[0]?.output.todos).toEqual([]);
  });

  it("skips plan entries that are not usable", () => {
    const drafts = collect([
      {
        type: "item.completed",
        item: {
          id: "t4",
          type: "todo_list",
          items: [
            { text: "keep me", completed: true },
            null,
            { completed: true },
            { text: "also keep", completed: "yes" },
          ],
        },
      },
    ]);
    expect(drafts[0]?.output.todos).toEqual([
      { text: "keep me", done: true },
      { text: "also keep", done: false },
    ]);
  });

  it("ignores unknown item types", () => {
    const drafts = collect([
      { type: "item.completed", item: { id: "x", type: "future_thing" } },
    ]);
    expect(drafts).toEqual([]);
  });

  it("keeps the thread id from thread.started", () => {
    const collector = createEventCollector({ redact: createRedactor([]) });
    collector.consume({ type: "thread.started", thread_id: "thread-123" });
    expect(collector.threadId()).toBe("thread-123");
  });
});

describe("canonical schema invariants", () => {
  const everyShape = (): RunEventDraft[] =>
    collect([
      ...commandRun("item_1", "ls", 0, "ok"),
      ...commandRun("item_2", "ls /nope", 2, "boom"),
      {
        type: "item.completed",
        item: { id: "item_3", type: "reasoning", text: "thinking" },
      },
      {
        type: "item.completed",
        item: { id: "item_4", type: "agent_message", text: "done" },
      },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
      { type: "error", message: "boom" },
    ]);

  it("always provides input and output objects", () => {
    const drafts = everyShape();
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(draft.input).toBeTypeOf("object");
      expect(draft.output).toBeTypeOf("object");
      expect(draft.input).not.toBeNull();
      expect(draft.output).not.toBeNull();
    }
  });

  it("pairs an error status with a non-null error object", () => {
    const drafts = everyShape();
    for (const draft of drafts) {
      if (draft.status === "error" || draft.status === "warning") {
        expect(draft.error).not.toBeNull();
        expect(String(draft.error?.message ?? "")).not.toBe("");
      } else {
        expect(draft.error).toBeNull();
      }
    }
  });

  it("only attaches usage to turn events", () => {
    const drafts = everyShape();
    for (const draft of drafts) {
      if (draft.kind !== "turn") expect(draft.usage).toBeNull();
    }
  });
});

describe("usage accumulation", () => {
  it("adds usage across turns instead of overwriting", () => {
    const collector = createEventCollector({ redact: createRedactor([]) });
    collector.consume({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    collector.consume({
      type: "turn.completed",
      usage: { input_tokens: 7, output_tokens: 3, cached_input_tokens: 2 },
    });
    const turns = collector.drain().filter((draft) => draft.kind === "turn");
    expect(turns).toHaveLength(2);
    expect(turns[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(turns[1]?.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cachedInputTokens: 2,
    });
    expect(collector.totalUsage()).toEqual({
      inputTokens: 17,
      outputTokens: 7,
      cachedInputTokens: 2,
    });
  });

  it("reports no usage when Codex never sent any", () => {
    const collector = createEventCollector({ redact: createRedactor([]) });
    collector.consume({ type: "turn.completed" });
    expect(collector.totalUsage()).toBeNull();
  });
});

describe("redaction inside events", () => {
  it("never leaks the API key into a command event", () => {
    const secret = "ark-super-secret-value-1234";
    const collector = createEventCollector({ redact: createRedactor([secret]) });
    collector.consume({
      type: "item.started",
      item: { id: "item_1", type: "command_execution", command: "env" },
    });
    collector.consume({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command: "env",
        exit_code: 0,
        aggregated_output: "ARK_API_KEY=" + secret + "\nPATH=/usr/bin",
      },
    });
    const serialised = JSON.stringify(collector.drain());
    expect(serialised).not.toContain(secret);
    expect(serialised).toContain("***");
  });

  it("keeps the tail of long agent messages in trajectory details", () => {
    const collector = createEventCollector({ redact: createRedactor([]) });
    collector.consume({
      type: "item.completed",
      item: {
        id: "message-1",
        type: "agent_message",
        text: "a".repeat(8_500) + "TAIL_DETAIL",
      },
    });

    const text = collector.drain()[0]?.output.text ?? "";
    expect(text).toContain("truncated");
    expect(text).toContain("TAIL_DETAIL");
  });
});

describe("drain", () => {
  it("hands out each draft exactly once", () => {
    const collector = createEventCollector({ redact: createRedactor([]) });
    for (const event of commandRun("item_1", "ls", 0)) collector.consume(event);
    expect(collector.drain()).toHaveLength(2);
    expect(collector.drain()).toEqual([]);
  });

  it("never reuses generated span ids after a drain", () => {
    const collector = createEventCollector({ redact: createRedactor([]) });
    const generatedIds: string[] = [];
    const consumeAndDrain = (event: Record<string, unknown>): void => {
      collector.consume(event);
      const emitted = collector.drain();
      expect(emitted).toHaveLength(1);
      generatedIds.push(emitted[0]?.spanId ?? "");
    };

    consumeAndDrain({ type: "turn.completed" });
    consumeAndDrain({ type: "turn.completed" });
    consumeAndDrain({ type: "error", message: "first" });
    consumeAndDrain({ type: "error", message: "second" });
    consumeAndDrain({
      type: "item.completed",
      item: { type: "agent_message", text: "first" },
    });
    consumeAndDrain({
      type: "item.completed",
      item: { type: "agent_message", text: "second" },
    });

    expect(new Set(generatedIds).size).toBe(generatedIds.length);
  });
});

describe("real Codex output", () => {
  const fixture = (name: string): RunEventDraft[] => {
    const file = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      name,
    );
    const collector = createEventCollector({ redact: createRedactor([]) });
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      collector.consume(JSON.parse(line) as Record<string, unknown>);
    }
    return collector.drain();
  };

  it("reads the canonical command fields from a real run", () => {
    const drafts = fixture("codex-run.jsonl");
    const commands = drafts.filter((draft) => draft.kind === "command");
    expect(commands.length).toBeGreaterThan(0);

    const started = commands[0];
    expect(started?.status).toBe("in_progress");
    expect(started?.input.command).toContain("hello.txt");

    const completed = commands.at(-1);
    expect(completed?.status).toBe("error");
    expect(completed?.output.exitCode).toBe(2);
    expect(completed?.output.text).toContain("No such file or directory");
    expect(completed?.error?.code).toBe("2");
  });

  it("reads reasoning, messages and usage from a real run", () => {
    const drafts = fixture("codex-run.jsonl");
    expect(drafts.some((draft) => draft.kind === "reasoning")).toBe(true);
    const messages = drafts.filter((draft) => draft.kind === "message");
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.at(-1)?.output.text).not.toBe("");

    const turn = drafts.find((draft) => draft.kind === "turn");
    expect(turn?.usage?.inputTokens).toBeGreaterThan(0);
    expect(turn?.usage?.outputTokens).toBeGreaterThan(0);
    expect(turn?.usage?.cachedInputTokens).toBeGreaterThan(0);
  });

  it("treats a Codex diagnostic item as a warning, not a run failure", () => {
    const drafts = collect([
      {
        type: "item.completed",
        item: {
          id: "item_0",
          type: "error",
          message:
            "Model metadata for `deepseek/deepseek-v4-flash` not found. " +
            "Defaulting to fallback metadata.",
        },
      },
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.kind).toBe("error");
    expect(drafts[0]?.status).toBe("warning");
    expect(drafts[0]?.error?.message).toContain("Model metadata");
  });

  it("still reports a genuine failure as an error", () => {
    const drafts = collect([
      { type: "turn.failed", usage: { input_tokens: 1 } },
      { type: "error", message: "upstream refused the request" },
    ]);
    expect(drafts.map((draft) => draft.status)).toEqual(["error", "error"]);
  });

  it("captures a Codex diagnostic item rather than dropping it", () => {
    const drafts = fixture("codex-run.jsonl");
    const diagnostics = drafts.filter((draft) => draft.kind === "error");
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.status).toBe("warning");
    expect(diagnostics[0]?.error?.message).toContain("Model metadata");
    expect(diagnostics[0]?.error?.code).toBe("codex_diagnostic");
  });

  it("reads the plan Codex maintains into canonical output", () => {
    const drafts = fixture("codex-todo-list.jsonl");
    const todos = drafts.filter((draft) => draft.kind === "todo");
    expect(todos.length).toBeGreaterThan(0);

    expect(todos[0]?.output.todos).toEqual([
      { text: "Initialize skill folder via init_skill.py", done: false },
      { text: "Write SKILL.md body from provided content", done: false },
      { text: "Validate skill with quick_validate.py", done: false },
    ]);
  });

  it("treats each plan update as a whole snapshot on one span", () => {
    const drafts = fixture("codex-todo-list.jsonl");
    const todos = drafts.filter((draft) => draft.kind === "todo");
    const last = todos[todos.length - 1];
    // Codex resends the entire plan every time, so the newest event is the
    // current state rather than a delta to merge into the previous one.
    expect(last?.output.todos?.every((todo) => todo.done)).toBe(true);
    expect(last?.spanId).toBe(todos[0]?.spanId);
  });

  it("leaves no failed-looking step in a run that succeeded", () => {
    const drafts = fixture("codex-file-change.jsonl");
    expect(drafts.some((draft) => draft.status === "error")).toBe(false);
  });

  it("reads canonical changed files from a real apply_patch", () => {
    const drafts = fixture("codex-file-change.jsonl");
    const changes = drafts.filter((draft) => draft.kind === "file_change");
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[0]?.output.changedFiles).toEqual(["/workspace/config.ts"]);
    expect(changes[0]?.input.paths).toEqual(["/workspace/config.ts"]);
    expect(changes[0]?.status).toBe("ok");
  });

  it("pairs every span id and never leaves a span in progress at the end", () => {
    for (const name of ["codex-run.jsonl", "codex-file-change.jsonl"]) {
      const drafts = fixture(name);
      const bySpan = new Map<string, RunEventDraft>();
      for (const draft of drafts) bySpan.set(draft.spanId, draft);
      for (const [, last] of bySpan) {
        expect(last.status).not.toBe("in_progress");
      }
    }
  });
});
