/** Verifies Codex CLI arguments and JSONL protocol parsing. */
import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  mcpConfigOverrides,
  parseCodexEventLine,
} from "../src/codex-runner.js";
import { createRedactor } from "../src/redact.js";
import { createEventCollector } from "../src/run-events.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        runId: "run-1",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
      { codexHome: "/codex-home", dataDir: "/launchpad-data" },
    );
    expect(args.slice(0, 7)).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
    ]);
    expect(args.at(-1)).toBe("build a calculator");
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        runId: "run-2",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
      { codexHome: "/codex-home", dataDir: "/launchpad-data" },
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  // Codex spawns MCP servers with only HOME and PATH. A server path built from
  // `$CODEX_HOME`, or run context left to be inherited, silently never arrives:
  // the server dies on startup and the worker loses every Launchpad tool.
  it("points the MCP server at an absolute path, never at an env expansion", () => {
    const overrides = mcpConfigOverrides(
      {
        runId: "run-4",
        agentId: "agent",
        parentRunId: "leader-1",
        workspacePath: "/workspace",
        prompt: "x",
        threadId: null,
      },
      { codexHome: "/codex-home", dataDir: "/launchpad-data" },
      "/workspace",
    );
    const serialized = overrides.join(" ");
    expect(serialized).not.toContain("process.env");
    expect(serialized).toContain(
      'mcp_servers.launchpad.args=["/codex-home/launchpad-mcp-server.mjs"]',
    );
  });

  it("injects the run context the MCP server cannot inherit", () => {
    const overrides = mcpConfigOverrides(
      {
        runId: "run-5",
        agentId: "agent-9",
        parentRunId: "leader-1",
        workspacePath: "/workspace",
        prompt: "x",
        threadId: null,
      },
      { codexHome: "/codex-home", dataDir: "/launchpad-data" },
      "/workspace",
    );
    const env = overrides.at(-1) ?? "";
    expect(env).toContain('LAUNCHPAD_DATA_DIR="/launchpad-data"');
    expect(env).toContain('LAUNCHPAD_WORKSPACE_PATH="/workspace"');
    expect(env).toContain('LAUNCHPAD_DEPENDENCY_CACHE=');
    expect(env).toContain('PYTHONUSERBASE=');
    expect(env).toContain('BASH_ENV=');
    expect(env).toContain('PATH=');
    expect(env).toContain('LAUNCHPAD_AGENT_ID="agent-9"');
    expect(env).toContain('LAUNCHPAD_RUN_ID="run-5"');
    // Siblings resolve the same shared whiteboard only through the parent id.
    expect(env).toContain('LAUNCHPAD_PARENT_RUN_ID="leader-1"');
  });

  it("injects the shared workspace path into the MCP server environment", () => {
    const overrides = mcpConfigOverrides(
      {
        runId: "run-6",
        agentId: "agent-9",
        parentRunId: "leader-1",
        workspacePath: "/workspace",
        commonWorkspacePath: "/common-workspace",
        prompt: "x",
        threadId: null,
      },
      { codexHome: "/codex-home", dataDir: "/launchpad-data" },
      "/workspace",
    );

    expect(overrides.at(-1)).toContain('COMMON_WORKSPACE="/common-workspace"');
  });

  it("adds a shared workspace as an extra writable directory", () => {
    const args = buildCodexArgs(
      {
        runId: "run-3",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        commonWorkspacePath: "/tmp/shared",
        prompt: "coordinate",
        threadId: null,
      },
      "workspace-write",
      { codexHome: "/codex-home", dataDir: "/launchpad-data" },
    );
    expect(args).toContain("--add-dir");
    expect(args).toContain("/tmp/shared");
    expect(args.slice(-1)).toEqual(["coordinate"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("hands every parsed event to an attached collector", () => {
    const collector = createEventCollector({ redact: createRedactor([]) });
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
      collector,
    };

    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "ls",
          exit_code: 0,
        },
      }),
      parsed,
    );
    parseCodexEventLine("not json at all", parsed);

    const drafts = collector.drain();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.input.command).toBe("ls");
  });

  it("works without a collector attached", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    expect(() =>
      parseCodexEventLine(
        JSON.stringify({ type: "thread.started", thread_id: "t" }),
        parsed,
      ),
    ).not.toThrow();
    expect(parsed.threadId).toBe("t");
  });
});

describe("model proxy tokens", () => {
  // The solo fallback exists to rescue a failed plan. It was the one run path
  // that issued no token, so the proxy answered 401 and it could never succeed —
  // observed as `docker Runtime exited with code 1: unexpected status 401`.
  it("every runner request that reaches the proxy carries a token", () => {
    const withToken = {
      runId: "run-1",
      agentId: "agent",
      workspacePath: "/workspace",
      prompt: "x",
      threadId: null,
      modelToken: "tok-1",
    };
    const args = buildCodexArgs(withToken, "workspace-write", {
      codexHome: "/codex-home",
      dataDir: "/launchpad-data",
    });
    // The token travels in the environment, never in argv where `ps` would show
    // it, so what we assert here is that building args does not strip it.
    expect(withToken.modelToken).toBe("tok-1");
    expect(args.join(" ")).not.toContain("tok-1");
  });
});
