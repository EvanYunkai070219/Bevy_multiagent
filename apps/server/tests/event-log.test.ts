/** Covers append-only event persistence, recovery, limits, and redaction. */
import { appendFile, readFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/event-log.js";
import { createRedactor } from "../src/redact.js";
import { createEventCollector } from "../src/run-events.js";
import type { RunEventDraft } from "../src/run-events.js";
import { ArkClient } from "../src/orchestration/leader/ark-client.js";
import { loadConfig } from "../src/config.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeLog(options?: {
  maxBytes?: number;
  bufferSize?: number;
  secrets?: string[];
  append?: typeof appendFile;
}): Promise<{ log: EventLog; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "event-log-test-"));
  directories.push(root);
  const log = new EventLog(root, options);
  await log.initialize();
  return { log, root };
}

function draft(name: string): RunEventDraft {
  return {
    spanId: name,
    parentSpanId: "run",
    kind: "command",
    name,
    status: "ok",
    startedAt: "2026-08-26T00:00:00.000Z",
    endedAt: "2026-08-26T00:00:01.000Z",
    durationMs: 1000,
    input: { command: name },
    output: { exitCode: 0 },
    error: null,
    attributes: {},
    usage: null,
  };
}

async function runDir(root: string, runId: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const match = entries.find(
    (entry) => entry.isDirectory() && entry.name.endsWith("_" + runId),
  );
  if (!match) throw new Error("Missing run directory for " + runId);
  return path.join(root, match.name);
}

// A run created without placement is its own single-agent session, so its log
// lives at {ts}_{runId}/agent/trajectory.jsonl.
async function logFile(root: string, runId: string): Promise<string> {
  return path.join(await runDir(root, runId), "agent", "trajectory.jsonl");
}

describe("EventLog", () => {
  it("rejects later appends and waits for queued writes before close resolves", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { log } = await makeLog({
      append: async () => blocked,
    });
    const sink = log.createSink("run-close", "agent-1");
    sink.emit(draft("before"));
    const closing = log.close("run-close");
    sink.emit(draft("after"));
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect((await log.read("run-close", 0)).events.map((event) => event.name)).toEqual([
      "before",
    ]);
  });

  it("fails the leader close barrier when an authoritative session child append failed", async () => {
    const { log } = await makeLog({
      append: async (...args) => {
        if (String(args[1]).includes('"name":"candidate_terminal"')) {
          throw new Error("candidate append denied");
        }
        await appendFile(...args);
      },
    });
    const leader = log.createSink("leader-run", "leader-agent", {
      sessionId: "leader-run",
      member: "leader",
    });
    const candidate = log.createSink("candidate-run", "candidate-agent", {
      sessionId: "leader-run",
      member: "repair-control",
    });
    leader.emit(draft("leader_started"));
    candidate.emit(draft("candidate_terminal"));

    await expect(log.close("leader-run")).rejects.toThrow("candidate append denied");
  });

  it("assigns monotonic sequence numbers starting at 1", async () => {
    const { log } = await makeLog();
    const sink = log.createSink("run-1", "agent-1");
    sink.emit(draft("a"));
    sink.emit(draft("b"));
    sink.emit(draft("c"));
    await log.flush("run-1");

    const result = await log.read("run-1", 0);
    expect(result.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(result.lastSeq).toBe(3);
    expect(result.events[0]?.runId).toBe("run-1");
    expect(result.events[0]?.agentId).toBe("agent-1");
  });

  it("reads a redacted newest-event tail instead of the first page", async () => {
    const { log } = await makeLog();
    const sink = log.createSink("run-inspect-tail", "agent-1");
    for (let index = 0; index < 40; index += 1) {
      sink.emit(draft("event-" + index));
    }
    await log.flush("run-inspect-tail");
    const tail = await log.readTail("run-inspect-tail", 12);
    expect(tail.events).toHaveLength(12);
    expect(tail.events[0]?.name).toBe("event-28");
    expect(tail.events.at(-1)?.name).toBe("event-39");
    expect(tail.events.map((event) => event.name)).not.toContain("event-0");
    await expect(
      log.summarizeProgressTail("run-inspect-tail", 12, {
        checkpointId: "snap-9",
        state: "progressing",
      }),
    ).resolves.toMatchObject({
      observational: true,
      authorizesContinuation: false,
      recent: expect.arrayContaining([expect.objectContaining({ name: "event-39" })]),
      checkpoint: { checkpointId: "snap-9", state: "progressing" },
    });
  });

  it("exposes stable session and member directories for run-adjacent workspaces", async () => {
    const { log, root } = await makeLog();
    const sessionDir = log.sessionDirectory("leader-run");
    const leaderDir = log.runDirectory("leader-run", "leader-agent", {
      sessionId: "leader-run",
      member: "leader",
      role: "leader",
    });
    const workerDir = log.runDirectory("worker-run", "worker-agent", {
      sessionId: "leader-run",
      member: "Worker Agent",
      role: "reviewer",
    });

    expect(sessionDir).toContain(root);
    expect(leaderDir).toBe(path.join(sessionDir, "leader"));
    expect(workerDir).toBe(path.join(sessionDir, "Worker-Agent"));
    expect(log.sessionDirectory("leader-run")).toBe(sessionDir);
    // runDirectory queues member-directory and manifest ownership work. Cross
    // the authoritative close barrier before afterEach removes the root.
    await log.close("leader-run");
  });

  it("returns only events after the cursor", async () => {
    const { log } = await makeLog();
    const sink = log.createSink("run-2", "agent-1");
    sink.emit(draft("a"));
    sink.emit(draft("b"));
    sink.emit(draft("c"));
    await log.flush("run-2");

    const result = await log.read("run-2", 2);
    expect(result.events.map((event) => event.name)).toEqual(["c"]);
    expect(result.lastSeq).toBe(3);
  });

  it("keeps the cursor unchanged when there is nothing new", async () => {
    const { log } = await makeLog();
    const sink = log.createSink("run-2b", "agent-1");
    sink.emit(draft("a"));
    await log.flush("run-2b");

    const result = await log.read("run-2b", 1);
    expect(result.events).toEqual([]);
    expect(result.lastSeq).toBe(1);
  });

  it("writes lines to disk in sequence order", async () => {
    const { log, root } = await makeLog();
    const sink = log.createSink("run-3", "agent-1");
    for (let index = 0; index < 25; index += 1) sink.emit(draft("c" + index));
    await log.flush("run-3");

    const raw = await readFile(await logFile(root, "run-3"), "utf8");
    const seqs = raw
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
  });

  it("names new run directories with a timestamp prefix", async () => {
    const { log, root } = await makeLog();
    const sink = log.createSink("run-timestamped", "agent-1");
    sink.emit(draft("a"));
    await log.flush("run-timestamped");

    const entries = await readdir(root, { withFileTypes: true });
    expect(
      entries.some(
        (entry) =>
          entry.isDirectory() &&
          /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_run-timestamped$/.test(entry.name),
      ),
    ).toBe(true);
  });

  it("reads events back from disk after the buffer is gone", async () => {
    const { log, root } = await makeLog();
    const sink = log.createSink("run-4", "agent-1");
    sink.emit(draft("persisted"));
    await log.flush("run-4");

    const reopened = new EventLog(root);
    await reopened.initialize();
    const result = await reopened.read("run-4", 0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.name).toBe("persisted");
    expect(result.events[0]?.input.command).toBe("persisted");
  });

  it("continues a persisted sequence after reopening", async () => {
    const { log, root } = await makeLog();
    const firstSink = log.createSink("run-reopened", "agent-1");
    firstSink.emit(draft("before-restart"));
    await log.flush("run-reopened");

    const reopened = new EventLog(root);
    await reopened.initialize();
    const secondSink = reopened.createSink("run-reopened", "wrong-agent");
    secondSink.emit(draft("after-restart"));
    await reopened.flush("run-reopened");

    const result = await reopened.read("run-reopened", 0);
    expect(result.events.map((event) => event.name)).toEqual([
      "before-restart",
      "after-restart",
    ]);
    expect(result.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(result.events.map((event) => event.agentId)).toEqual([
      "agent-1",
      "agent-1",
    ]);
    expect(result.lastSeq).toBe(2);
  });

  it("rehydrates the persisted byte count before appending", async () => {
    const { log, root } = await makeLog();
    const firstSink = log.createSink("run-bytes", "agent-1");
    firstSink.emit(draft("first"));
    await log.flush("run-bytes");
    const raw = await readFile(await logFile(root, "run-bytes"), "utf8");
    const firstLineBytes = Buffer.byteLength(raw, "utf8");

    const reopened = new EventLog(root, {
      maxBytes: firstLineBytes + Math.floor(firstLineBytes / 2),
    });
    await reopened.initialize();
    reopened.createSink("run-bytes", "agent-1").emit(draft("second"));
    await reopened.flush("run-bytes");

    const result = await reopened.read("run-bytes", 0);
    expect(result.events.map((event) => event.name)).toEqual([
      "first",
      "log_truncated",
    ]);
    expect(result.events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("does not append after reopening a truncated log", async () => {
    const { log, root } = await makeLog({ maxBytes: 900 });
    const sink = log.createSink("run-truncated", "agent-1");
    for (let index = 0; index < 20; index += 1) {
      sink.emit(draft("event-" + index));
    }
    await log.flush("run-truncated");

    const reopened = new EventLog(root, { maxBytes: 900 });
    await reopened.initialize();
    reopened.createSink("run-truncated", "agent-1").emit(draft("too-late"));
    await reopened.flush("run-truncated");

    const result = await reopened.read("run-truncated", 0);
    expect(
      result.events.filter((event) => event.name === "log_truncated"),
    ).toHaveLength(1);
    expect(result.events.some((event) => event.name === "too-late")).toBe(false);
  });

  it("falls back to disk when the cursor predates the ring buffer", async () => {
    const { log } = await makeLog({ bufferSize: 3 });
    const sink = log.createSink("run-5", "agent-1");
    for (let index = 0; index < 10; index += 1) sink.emit(draft("c" + index));
    await log.flush("run-5");

    const result = await log.read("run-5", 0);
    expect(result.events).toHaveLength(10);
    expect(result.events[0]?.seq).toBe(1);
  });

  it("returns an empty result for a run with no events", async () => {
    const { log } = await makeLog();
    const result = await log.read("missing-run", 0);
    expect(result.events).toEqual([]);
    expect(result.lastSeq).toBe(0);
  });

  it("stops appending past the byte ceiling and records a marker", async () => {
    const { log } = await makeLog({ maxBytes: 900 });
    const sink = log.createSink("run-6", "agent-1");
    for (let index = 0; index < 20; index += 1) sink.emit(draft("c" + index));
    await log.flush("run-6");

    const result = await log.read("run-6", 0);
    const markers = result.events.filter(
      (event) => event.name === "log_truncated",
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]?.error?.code).toBe("log_truncated");
    expect(result.events.length).toBeLessThan(21);
    expect(result.events.at(-1)?.name).toBe("log_truncated");
  });

  it("measures the byte ceiling in UTF-8 bytes", async () => {
    const { log } = await makeLog({ maxBytes: 900 });
    const sink = log.createSink("run-utf8", "agent-1");
    sink.emit(draft("界".repeat(100)));
    await log.flush("run-utf8");

    const result = await log.read("run-utf8", 0);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.name).toBe("log_truncated");
  });

  it("archives a run log instead of deleting it", async () => {
    const { log, root } = await makeLog();
    const sink = log.createSink("run-7", "agent-1");
    sink.emit(draft("kept"));
    await log.flush("run-7");

    await log.archive(["run-7"]);

    const archived = await readdir(path.join(root, ".deleted"), { withFileTypes: true });
    expect(archived).toHaveLength(1);
    expect(archived[0]?.name).toContain("run-7");
    expect(archived[0]?.name).toContain("-archived-");
    const content = await readFile(
      path.join(root, ".deleted", archived[0]?.name ?? "", "agent", "trajectory.jsonl"),
      "utf8",
    );
    expect(content).toContain("kept");

    const result = await log.read("run-7", 0);
    expect(result.events).toEqual([]);
  });

  it("archives a run that never produced events without throwing", async () => {
    const { log } = await makeLog();
    await expect(log.archive(["never-ran"])).resolves.toBeUndefined();
  });

  it("never throws out of emit when the payload cannot be serialised", async () => {
    const { log } = await makeLog();
    const sink = log.createSink("run-8", "agent-1");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      sink.emit({ ...draft("bad"), attributes: circular }),
    ).not.toThrow();
    await log.flush("run-8");
  });

  it("keeps recording after one event fails to serialise", async () => {
    const { log } = await makeLog();
    const sink = log.createSink("run-9", "agent-1");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    sink.emit({ ...draft("bad"), attributes: circular });
    sink.emit(draft("good"));
    await log.flush("run-9");

    const result = await log.read("run-9", 0);
    expect(result.events.map((event) => event.name)).toEqual(["good"]);
  });

  it("redacts every persisted draft field including short configured secrets", async () => {
    const secret = "s3k";
    const { log, root } = await makeLog({ secrets: [secret] });
    const sink = log.createSink("run-secret", "agent-1");
    sink.emit({
      ...draft("name-" + secret),
      spanId: "span-" + secret,
      input: { command: "echo " + secret },
      output: { text: "output " + secret },
      error: { message: "error " + secret },
      attributes: { providerName: "provider-" + secret },
    });
    await log.flush("run-secret");

    const raw = await readFile(await logFile(root, "run-secret"), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("***");
  });

  it("retains the true command-output tail through normalisation and persistence", async () => {
    const { log } = await makeLog();
    const collector = createEventCollector({ redact: createRedactor([]) });
    const output = "OUTPUT-HEAD\n" + "x".repeat(10_000) + "\nTRUE-FAILURE-TAIL";
    collector.consume({
      type: "item.completed",
      item: {
        id: "long-command",
        type: "command_execution",
        command: "npm test",
        exit_code: 1,
        aggregated_output: output,
        status: "failed",
      },
    });
    const sink = log.createSink("run-tail", "agent-1");
    for (const event of collector.drain()) sink.emit(event);
    await log.flush("run-tail");

    const result = await log.read("run-tail", 0);
    expect(result.events[0]?.output.text).toContain("OUTPUT-HEAD");
    expect(result.events[0]?.output.text).toContain("TRUE-FAILURE-TAIL");
    expect(result.events[0]?.output.text).toContain(
      "original_chars=" + output.length,
    );
  });

  it("caps provider attributes at 32 KiB without dropping canonical fields", async () => {
    const { log } = await makeLog();
    const collector = createEventCollector({ redact: createRedactor([]) });
    collector.consume({
      type: "item.completed",
      item: {
        id: "large-todo",
        type: "todo_list",
        status: "completed",
        items: Array.from({ length: 80 }, (_, index) => ({
          text: "todo-" + index + "-" + "x".repeat(900),
          completed: false,
        })),
      },
    });
    const sink = log.createSink("run-attributes", "agent-1");
    for (const event of collector.drain()) {
      sink.emit({
        ...event,
        input: { text: "canonical-input" },
        output: { text: "canonical-output" },
        error: null,
      });
    }
    await log.flush("run-attributes");

    const result = await log.read("run-attributes", 0);
    const persisted = result.events[0];
    expect(
      Buffer.byteLength(JSON.stringify(persisted?.attributes), "utf8"),
    ).toBeLessThanOrEqual(32 * 1024);
    expect(persisted?.input.text).toBe("canonical-input");
    expect(persisted?.output.text).toBe("canonical-output");
  });

  it("writes each run into a {ts}_{sessionId}/agent session directory", async () => {
    const { log, root } = await makeLog();
    const sink = log.createSink("11111111-1111-1111-1111-111111111111", "agent-a");
    sink.emit(draft("first"));
    await log.flush("11111111-1111-1111-1111-111111111111");

    const entries = await readdir(root, { withFileTypes: true });
    const runDir = entries.find(
      (entry) => entry.isDirectory() && entry.name.endsWith("_11111111-1111-1111-1111-111111111111"),
    );
    expect(runDir).toBeDefined();
    const sessionFiles = await readdir(path.join(root, runDir!.name));
    expect(sessionFiles).toContain("session.json");
    expect(sessionFiles).toContain("agent");
    const raw = await readFile(
      path.join(root, runDir!.name, "agent", "trajectory.jsonl"),
      "utf8",
    );
    expect(raw).toContain("\"name\":\"first\"");
  });

  it("groups sibling agents of one session under agent-name member folders", async () => {
    const { log, root } = await makeLog();
    const session = "aaaaaaaa-0000-0000-0000-000000000000";
    log.createSink(session, "leader-agent", { sessionId: session, member: "leader", role: "leader" }).emit(draft("plan"));
    log.createSink("worker-run-1", "w1", { sessionId: session, member: "Research Scout", role: "researcher" }).emit(draft("w1"));
    log.createSink("worker-run-2", "w2", { sessionId: session, member: "Draft Writer", role: "writer" }).emit(draft("w2"));
    await log.flush(session);
    await log.flush("worker-run-1");
    await log.flush("worker-run-2");

    const entries = await readdir(root, { withFileTypes: true });
    const sessionDir = entries.find((e) => e.isDirectory() && e.name.endsWith("_" + session));
    expect(sessionDir).toBeDefined();
    const members = await readdir(path.join(root, sessionDir!.name), { withFileTypes: true });
    const memberDirs = members.filter((m) => m.isDirectory()).map((m) => m.name).sort();
    expect(memberDirs).toEqual(["Draft-Writer", "Research-Scout", "leader"]);

    const manifest = JSON.parse(
      await readFile(path.join(root, sessionDir!.name, "session.json"), "utf8"),
    ) as { session: string; members: { member: string; runId: string; role: string }[] };
    expect(manifest.session).toBe(session);
    expect(manifest.members.find((m) => m.member === "Research-Scout")).toMatchObject({
      runId: "worker-run-1",
      role: "researcher",
    });
    // Each worker run is still independently readable by its own run id.
    const page = await log.read("worker-run-2", 0);
    expect(page.events.map((e) => e.name)).toContain("w2");
  });

  it("suffixes colliding agent-name member folders", async () => {
    const { log, root } = await makeLog();
    const session = "aaaaaaaa-0000-0000-0000-000000000001";
    log.createSink("worker-run-1", "w1", { sessionId: session, member: "Reviewer", role: "reviewer" }).emit(draft("w1"));
    log.createSink("worker-run-2", "w2", { sessionId: session, member: "Reviewer", role: "reviewer" }).emit(draft("w2"));
    await log.flush("worker-run-1");
    await log.flush("worker-run-2");

    const entries = await readdir(root, { withFileTypes: true });
    const sessionDir = entries.find((e) => e.isDirectory() && e.name.endsWith("_" + session));
    expect(sessionDir).toBeDefined();
    const members = await readdir(path.join(root, sessionDir!.name), { withFileTypes: true });
    expect(members.filter((m) => m.isDirectory()).map((m) => m.name).sort()).toEqual([
      "Reviewer",
      "Reviewer-2",
    ]);
  });

  it("rehydrates run state from a run directory across restarts", async () => {
    const { root } = await makeLog();
    const runId = "22222222-2222-2222-2222-222222222222";
    const first = new EventLog(root);
    await first.initialize();
    first.createSink(runId, "agent-b").emit(draft("persisted"));
    await first.flush(runId);

    const second = new EventLog(root);
    await second.initialize();
    const page = await second.read(runId, 0);
    expect(page.events.map((event) => event.name)).toContain("persisted");
  });

  it("archives the whole run directory into .deleted", async () => {
    const { log, root } = await makeLog();
    const runId = "33333333-3333-3333-3333-333333333333";
    log.createSink(runId, "agent-c").emit(draft("doomed"));
    await log.flush(runId);
    await log.archive([runId]);

    const rootEntries = await readdir(root, { withFileTypes: true });
    expect(
      rootEntries.some(
        (entry) => entry.isDirectory() && entry.name.endsWith("_" + runId),
      ),
    ).toBe(false);
    const deleted = await readdir(path.join(root, ".deleted"), { withFileTypes: true });
    expect(deleted.some((entry) => entry.isDirectory())).toBe(true);
  });

  it("writes a sidecar inside the run directory", async () => {
    const { log, root } = await makeLog();
    const runId = "44444444-4444-4444-4444-444444444444";
    log.createSink(runId, "agent-d").emit(draft("anchor"));
    const name = log.writeSidecar(runId, "request", "deadbeefcafe0000", "big block");
    await log.flush(runId);

    const entries = await readdir(root, { withFileTypes: true });
    const runDir = entries.find(
      (entry) => entry.isDirectory() && entry.name.endsWith("_" + runId),
    );
    const files = await readdir(path.join(root, runDir!.name, "agent"));
    expect(files).toContain(name);
  });

  it("ignores stray non-run files in the root on initialize", async () => {
    const { root } = await makeLog();
    await writeFile(path.join(root, "stray.txt"), "not a run", "utf8");
    const log = new EventLog(root);
    await expect(log.initialize()).resolves.toBeUndefined();
  });
});

describe("api_call persistence", () => {
  it("keeps the Ark key out of a persisted leader model call", async () => {
    const { log, root } = await makeLog({ secrets: ["sk-super-secret-key"] });
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "sk-super-secret-key",
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: "https://ark.example.test/api/v3",
      }),
      (async () =>
        new Response(JSON.stringify({ output_text: "{\"ok\":true}" }), {
          status: 200,
        })) as typeof fetch,
    );

    await client.completeJson(
      [{ role: "user", content: "the key is sk-super-secret-key, use it" }],
      { sink: log.createSink("run-api", "agent-api"), label: "planner", iteration: 1 },
    );
    await log.flush("run-api");

    const raw = await readFile(await logFile(root, "run-api"), "utf8");
    expect(raw).not.toContain("sk-super-secret-key");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    const event = JSON.parse(lines[0]!) as { kind: string; input: { text?: string } };
    expect(event.kind).toBe("api_call");
    expect(event.input.text).toContain("the key is");
  });
});

describe("trajectory projection", () => {
  it("writes a readable log beside the JSONL from the same event stream", async () => {
    const { log, root } = await makeLog();
    const sink = log.createSink("run-traj", "agent-traj");
    const base: RunEventDraft = {
      spanId: "run",
      parentSpanId: null,
      kind: "run",
      name: "started",
      status: "in_progress",
      startedAt: "2026-08-26T12:00:00.000Z",
      endedAt: null,
      durationMs: null,
      input: { text: "audit the repo" },
      output: {},
      error: null,
      attributes: {},
      usage: null,
    };
    sink.emit(base);
    sink.emit({
      ...base,
      spanId: "api-codex-1",
      kind: "api_call",
      name: "codex",
      input: { text: "user: audit" },
      attributes: { callIndex: 1, endpoint: "POST /v1/responses" },
    });
    sink.emit({
      ...base,
      spanId: "api-codex-1",
      kind: "api_call",
      name: "codex",
      status: "ok",
      endedAt: "2026-08-26T12:00:03.000Z",
      durationMs: 2916,
      input: {},
      output: { text: "tool_call: exec_command(ls)" },
      usage: { inputTokens: 8412, outputTokens: 331 },
      attributes: { callIndex: 1, httpStatus: 200 },
    });
    sink.emit({
      ...base,
      name: "completed",
      status: "ok",
      endedAt: "2026-08-26T12:00:03.000Z",
      durationMs: 3000,
      input: {},
    });
    await log.flush("run-traj");

    // The run has no placement, so its files live in the single agent folder.
    const dir = path.join(await runDir(root, "run-traj"), "agent");
    const files = await readdir(dir);
    expect(files).toContain("trajectory.jsonl");
    expect(files).toContain("trajectory.log");

    const text = await readFile(path.join(dir, "trajectory.log"), "utf8");
    expect(text).toContain("========== run start ==========");
    expect(text).toContain("input=audit the repo");
    expect(text).toContain("[API] #1  POST /v1/responses");
    expect(text).toContain("  | response: 200  2916ms  in=8412  out=331");
    expect(text).toContain("api_calls=1");
    expect(text).toContain("========== run end ==========");
  });
});
