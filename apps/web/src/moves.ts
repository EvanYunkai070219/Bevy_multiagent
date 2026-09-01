/**
 * A Move is what an agent DID, named and summarised in one place.
 *
 * The transcript, the party card and the inspector all describe the same tool
 * call, so the naming and the one-line rendering live here rather than in three
 * components reaching into `event.input` on their own. Replacing this file
 * replaces the whole vocabulary -- moves, abilities, spells -- without any
 * component relearning `RunEvent`.
 */
import type { RunEvent } from "./types";

export type MoveCategory = "execute" | "search" | "edit" | "coordinate" | "talk";

export interface Move {
  id: string;
  label: string;
  glyph: string;
  category: MoveCategory;
  summary(event: RunEvent): string;
}

function firstText(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return undefined;
}

const SHELL: Move = {
  id: "shell",
  label: "SHELL",
  glyph: "❯",
  category: "execute",
  summary: (event) => firstText(event.input.command) ?? event.name,
};

const SEARCH: Move = {
  id: "search",
  label: "SEARCH",
  glyph: "⌕",
  category: "search",
  summary: (event) => firstText(event.input.text, event.input.tool) ?? event.name,
};

const WRITE: Move = {
  id: "write",
  label: "WRITE",
  glyph: "✎",
  category: "edit",
  summary: (event) =>
    firstText(
      event.output.changedFiles?.join(", "),
      event.input.paths?.join(", "),
    ) ?? event.name,
};

/**
 * The tool itself, with the server prefix dropped.
 *
 * Codex names an MCP call `<server>.<tool>`, so `launchpad.read_skill` is one
 * string in which only the second half is about what the agent did.
 */
export function toolName(event: RunEvent): string {
  const raw = firstText(event.input.tool, event.name) ?? event.name;
  const dot = raw.lastIndexOf(".");
  return dot === -1 ? raw : raw.slice(dot + 1);
}

export interface TalkMessage {
  target: string;
  content: string;
  refs: string[];
}

/**
 * A `talk` call's arguments, or null when this is not one.
 *
 * Agent-to-agent messages arrive as an MCP call whose arguments are a JSON
 * string, which is why they read as `launchpad.talk` with a blob attached. The
 * blob is a message from one named agent to another, so it is parsed here once
 * rather than by every surface that wants to show it as one.
 */
export function talkOf(event: RunEvent): TalkMessage | null {
  if (event.kind !== "mcp_tool" || toolName(event) !== "talk") return null;
  const raw = event.input.text;
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const fields = parsed as Record<string, unknown>;
    const target = typeof fields.target === "string" ? fields.target : "";
    const content = typeof fields.content === "string" ? fields.content : "";
    if (target === "" && content === "") return null;
    const refs = Array.isArray(fields.workspace_refs)
      ? fields.workspace_refs.filter((item): item is string => typeof item === "string")
      : [];
    return { target, content, refs };
  } catch {
    return null;
  }
}

/**
 * Talking to a teammate is not the same act as calling a tool.
 *
 * It happens through the MCP transport, but what it produces is a message from
 * one agent to another -- so it gets its own name and its own tint rather than
 * appearing as one more `launchpad.*` call in a column of them.
 */
const TALK: Move = {
  id: "talk",
  label: "TALK",
  glyph: "☍",
  category: "talk",
  summary: (event) => {
    const message = talkOf(event);
    if (message === null) return toolName(event);
    const preview = message.content.replace(/\s+/g, " ").trim();
    return "→ " + (message.target || "teammate") + (preview ? ": " + preview : "");
  },
};

/**
 * One move per tool, not one move for the whole transport.
 *
 * A single `MCP` label answered "the agent used the MCP transport", which is
 * the one thing about the call the reader can already assume. The tool name is
 * the part that says what happened, and giving each its own id means the
 * inspector tallies a breakdown by tool instead of one undifferentiated count.
 */
function mcpMove(event: RunEvent): Move | null {
  const tool = toolName(event);
  if (tool === "talk") return TALK;
  // The platform records the worker it created as its own delegation span, and
  // that record is what "how many workers were sent" counts. Counting the call
  // that caused it as well made every dispatch two.
  if (isDispatchName(tool)) return null;
  return {
    id: "mcp:" + tool,
    label: tool.toUpperCase(),
    glyph: "⌘",
    category: "coordinate",
    summary: (item) => firstText(item.input.text, item.name) ?? item.name,
  };
}

const DISPATCH: Move = {
  id: "dispatch",
  label: "DISPATCH",
  glyph: "⇢",
  category: "coordinate",
  summary: (event) => firstText(event.input.text, event.name) ?? event.name,
};

const PLAN: Move = {
  id: "plan",
  label: "PLAN",
  glyph: "☰",
  category: "coordinate",
  summary: () => "Updated the plan",
};

/** The fixed moves. MCP calls mint one per tool, so they are not listed here. */
export const MOVES: Move[] = [SHELL, SEARCH, WRITE, TALK, DISPATCH, PLAN];

function isDispatchName(name: string): boolean {
  return /dispatch/i.test(name);
}

function looksLikeSearch(name: string): boolean {
  return /search|fetch_webpage|browser/i.test(name);
}

/**
 * The move an event represents, or null when it has no tool nature.
 *
 * Reasoning, messages, plain errors and model calls are not moves: they keep
 * the transcript's existing `stepLabel` rendering, and they stay out of the
 * inspector's tally because the agent did not reach for a tool.
 */
export function moveFor(event: RunEvent): Move | null {
  switch (event.kind) {
    case "command":
      return SHELL;
    case "web_search":
      return SEARCH;
    case "file_change":
      return WRITE;
    case "mcp_tool":
      return looksLikeSearch(event.name) ? SEARCH : mcpMove(event);
    case "delegation":
      // Not every delegation event dispatched anyone: `leader_codex_loop` is
      // the leader running, and `dependency_wait` is it waiting. Counting them
      // made `1 leader + 8 workers` report nine dispatches.
      return isDispatchName(event.name) ? DISPATCH : null;
    case "todo":
      return PLAN;
    default:
      return null;
  }
}
