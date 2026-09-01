/** Verifies that Codex runner events reach the sink without leaking secrets. */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexRunner } from "../src/codex-runner.js";
import { loadConfig } from "../src/config.js";
import type { RunEventDraft, RunEventSink } from "../src/run-events.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const SECRET = "ark-fake-secret-key-abcdef";

const CODEX_LINES = [
  { type: "thread.started", thread_id: "thread-abc" },
  {
    type: "item.started",
    item: { id: "item_1", type: "command_execution", command: "env", status: "in_progress" },
  },
  {
    type: "item.completed",
    item: {
      id: "item_1",
      type: "command_execution",
      command: "env",
      exit_code: 1,
      aggregated_output: "ARK_API_KEY=" + SECRET,
      status: "failed",
    },
  },
  {
    type: "item.completed",
    item: { id: "item_2", type: "agent_message", text: "All done." },
  },
  { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } },
  { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } },
];

/** A stand-in for the Codex binary that replays a fixed event stream. */
async function makeFakeCodex(): Promise<{ bin: string; workspace: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "fake-codex-"));
  directories.push(root);
  const bin = path.join(root, "fake-codex.sh");
  const body = CODEX_LINES.map(
    (line) => "printf '%s\\n' " + JSON.stringify(JSON.stringify(line)),
  ).join("\n");
  await writeFile(bin, "#!/bin/sh\n" + body + "\nexit 0\n", "utf8");
  await chmod(bin, 0o755);
  return { bin, workspace: root };
}

function collectingSink(): { sink: RunEventSink; drafts: RunEventDraft[] } {
  const drafts: RunEventDraft[] = [];
  return {
    drafts,
    sink: {
      emit(draft) {
        drafts.push(draft);
      },
    },
  };
}

async function runFake(sink?: RunEventSink) {
  const { bin, workspace } = await makeFakeCodex();
  const config = loadConfig({
    NODE_ENV: "test",
    CODEX_BIN: bin,
    ARK_API_KEY: SECRET,
    ARK_MODEL: "ep-test",
  });
  const runner = new CodexRunner(config);
  return runner.run({
    runId: "run-1",
    agentId: "agent-1",
    workspacePath: workspace,
    prompt: "do the thing",
    threadId: null,
    ...(sink ? { sink } : {}),
  });
}

describe("CodexRunner event reporting", () => {
  it("reports normalised events to the sink as they are parsed", async () => {
    const { sink, drafts } = collectingSink();
    await runFake(sink);

    const commands = drafts.filter((draft) => draft.kind === "command");
    expect(commands).toHaveLength(2);
    expect(commands[0]?.status).toBe("in_progress");
    expect(commands[1]?.status).toBe("error");
    expect(commands[1]?.output.exitCode).toBe(1);
    expect(drafts.some((draft) => draft.kind === "message")).toBe(true);
  });

  it("accumulates usage across turns in the runner result", async () => {
    const result = await runFake();
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 3 });
    expect(result.threadId).toBe("thread-abc");
    expect(result.output).toBe("All done.");
  });

  it("redacts the API key before it reaches the sink", async () => {
    const { sink, drafts } = collectingSink();
    await runFake(sink);
    expect(JSON.stringify(drafts)).not.toContain(SECRET);
    expect(JSON.stringify(drafts)).toContain("***");
  });

  it("completes the run even when the sink throws on every event", async () => {
    let calls = 0;
    const result = await runFake({
      emit() {
        calls += 1;
        throw new Error("sink is broken");
      },
    });
    expect(calls).toBeGreaterThan(0);
    expect(result.output).toBe("All done.");
  });

  it("runs without a sink at all", async () => {
    const result = await runFake();
    expect(result.output).toBe("All done.");
  });
});
