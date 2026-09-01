import { describe, expect, it } from "vitest";
import { moveFor, talkOf, toolName } from "./moves";
import type { RunEvent } from "./types";

function event(
  partial: Partial<RunEvent> & Pick<RunEvent, "kind" | "name">,
): RunEvent {
  return {
    seq: 1,
    runId: "run-1",
    agentId: "agent-1",
    spanId: "span-1",
    parentSpanId: "run",
    status: "ok",
    startedAt: "2026-08-30T00:00:00.000Z",
    endedAt: "2026-08-30T00:00:00.000Z",
    durationMs: 0,
    input: {},
    output: {},
    error: null,
    attributes: {},
    usage: null,
    ...partial,
  } as RunEvent;
}

describe("moveFor", () => {
  it("names a command SHELL and summarises it with the command line", () => {
    const raw = event({
      kind: "command",
      name: "command",
      input: { command: "cat /etc/os-release" },
    });
    expect(moveFor(raw)?.label).toBe("SHELL");
    expect(moveFor(raw)?.category).toBe("execute");
    expect(moveFor(raw)?.summary(raw)).toBe("cat /etc/os-release");
  });

  it("names a web search SEARCH and summarises it with the query", () => {
    const raw = event({
      kind: "web_search",
      name: "web_search",
      input: { text: "install .NET 8 on Debian 12" },
    });
    expect(moveFor(raw)?.label).toBe("SEARCH");
    expect(moveFor(raw)?.summary(raw)).toBe("install .NET 8 on Debian 12");
  });

  it("routes a search-shaped MCP tool to SEARCH and names every other tool", () => {
    expect(moveFor(event({ kind: "mcp_tool", name: "search_files" }))?.label).toBe("SEARCH");
    // Not "MCP": the transport is the one thing about the call a reader can
    // already assume, and the tool is the part that says what happened.
    expect(moveFor(event({ kind: "mcp_tool", name: "publish_artifact" }))?.label).toBe(
      "PUBLISH_ARTIFACT",
    );
  });

  it("drops the server prefix Codex puts in front of an MCP tool", () => {
    const raw = event({
      kind: "mcp_tool",
      name: "launchpad.read_skill",
      input: { tool: "launchpad.read_skill" },
    });
    expect(toolName(raw)).toBe("read_skill");
    expect(moveFor(raw)?.label).toBe("READ_SKILL");
  });

  it("gives two different tools two different tallies", () => {
    const one = moveFor(event({ kind: "mcp_tool", name: "read_skill" }));
    const other = moveFor(event({ kind: "mcp_tool", name: "install_skill" }));
    expect(one?.id).not.toBe(other?.id);
  });

  it("names a file change WRITE and summarises it with the paths", () => {
    const raw = event({
      kind: "file_change",
      name: "file_change",
      output: { changedFiles: ["README.md", "src/a.ts"] },
    });
    expect(moveFor(raw)?.label).toBe("WRITE");
    expect(moveFor(raw)?.summary(raw)).toBe("README.md, src/a.ts");
  });

  it("has no move for events with no tool nature", () => {
    expect(moveFor(event({ kind: "reasoning", name: "reasoning" }))).toBeNull();
    expect(moveFor(event({ kind: "message", name: "message" }))).toBeNull();
    expect(moveFor(event({ kind: "error", name: "error" }))).toBeNull();
    expect(moveFor(event({ kind: "api_call", name: "api_call" }))).toBeNull();
  });

  it("falls back to the event name when a summary source is missing", () => {
    const raw = event({ kind: "command", name: "command" });
    expect(moveFor(raw)?.summary(raw)).toBe("command");
  });
});

describe("talk", () => {
  const talking = event({
    kind: "mcp_tool",
    name: "launchpad.talk",
    input: {
      tool: "launchpad.talk",
      text: JSON.stringify({
        target: "ai-skeptic",
        content: "can you double-check the migration?",
        workspace_refs: ["notes/plan.md"],
      }),
    },
  });

  it("is its own move rather than one more MCP call", () => {
    expect(moveFor(talking)?.label).toBe("TALK");
    expect(moveFor(talking)?.category).toBe("talk");
  });

  it("summarises as a message to a named agent", () => {
    expect(moveFor(talking)?.summary(talking)).toBe(
      "→ ai-skeptic: can you double-check the migration?",
    );
  });

  it("parses the recipient, the message and the shared paths", () => {
    expect(talkOf(talking)).toEqual({
      target: "ai-skeptic",
      content: "can you double-check the migration?",
      refs: ["notes/plan.md"],
    });
  });

  it("is not claimed for other tools or for unparseable arguments", () => {
    expect(talkOf(event({ kind: "mcp_tool", name: "read_skill" }))).toBeNull();
    expect(
      talkOf(event({ kind: "mcp_tool", name: "talk", input: { text: "not json" } })),
    ).toBeNull();
    expect(talkOf(event({ kind: "command", name: "bash" }))).toBeNull();
  });
});

/**
 * A dispatch is a worker being sent, not every event that mentions one.
 *
 * `1 leader + 8 workers` was tallying nine dispatches. Two things did it: the
 * leader's own `leader_codex_loop` span -- the leader running, which dispatches
 * nobody -- counted as one, and every dispatch was counted twice, once as the
 * MCP call the agent made and once as the platform's own record of the worker
 * it created. Counting the record alone answers "how many workers were sent".
 */
describe("counting dispatches", () => {
  const delegation = (name: string) =>
    moveFor(event({ seq: 1, spanId: "d", kind: "delegation", name }));

  it("counts the record of a worker being dispatched", () => {
    expect(delegation("dispatch_subagent")?.label).toBe("DISPATCH");
  });

  it("does not count the leader running as a dispatch", () => {
    expect(delegation("leader_codex_loop")).toBeNull();
  });

  it("does not count waiting on a dependency as a dispatch", () => {
    expect(delegation("dependency_wait")).toBeNull();
  });

  it("does not count the tool call as a second dispatch", () => {
    expect(
      moveFor(
        event({
          seq: 1,
          spanId: "m",
          kind: "mcp_tool",
          name: "launchpad.dispatch_subagent",
          input: { tool: "launchpad.dispatch_subagent" },
        }),
      ),
    ).toBeNull();
  });

  it("still counts other MCP tools", () => {
    expect(
      moveFor(
        event({
          seq: 1,
          spanId: "m",
          kind: "mcp_tool",
          name: "launchpad.read_file",
          input: { tool: "launchpad.read_file" },
        }),
      )?.label,
    ).toBe("READ_FILE");
  });
});
