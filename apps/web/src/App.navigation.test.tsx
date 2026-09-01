// @vitest-environment jsdom

/**
 * Moving between the two things this app is: your chats, and what the agents
 * have learned.
 *
 * The skill hub was bolted on as a boolean that only its own button could
 * clear, so picking a chat from the sidebar changed the selection underneath a
 * page that was still showing the hub -- nothing appeared to happen, and only a
 * reload got you back. A destination is not a toggle: choosing a chat IS
 * choosing the chats view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { Agent, AgentRun } from "./types";

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    description: "",
    instructions: "",
    status: "ready",
    role: "standalone",
    parentAgentId: null,
    specialty: null,
    projectId: null,
    unassignedPlacement: "temporary",
    workspacePath: "/tmp/" + id,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

const FIRST = agent("11111111-1111-4111-8111-111111111111", "First chat");
const SECOND = agent("22222222-2222-4222-8222-222222222222", "Second chat");

const RUN: AgentRun = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  agentId: SECOND.id,
  projectId: null,
  kind: "single",
  parentRunId: null,
  orchestration: null,
  status: "completed",
  prompt: "do the thing",
  output: "done",
  error: null,
  usage: null,
  startedAt: "2026-08-30T00:00:00.000Z",
  completedAt: "2026-08-30T00:00:05.000Z",
  createdAt: "2026-08-30T00:00:00.000Z",
};

const SKILL = {
  name: "repo-triage",
  version: "1",
  description: "Triage an unfamiliar repository",
  tags: [],
  notes: "",
  ownerAgentId: null,
  ownerRunId: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  versions: ["1"],
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

function installFetch() {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/auth") return jsonResponse({ required: false });
    if (url === "/api/system") {
      return jsonResponse({
        arkConfigured: true,
        arkBaseUrl: "http://ark.invalid",
        arkModel: "test-model",
        codexAvailable: true,
        codexSandboxMode: "workspace-write",
        runtimeProvider: "container",
        containerEngine: "docker",
        runtime: "test-runtime",
        pricing: null,
      });
    }
    if (url === "/api/agents") return jsonResponse({ agents: [FIRST, SECOND] });
    if (url === "/api/projects") return jsonResponse({ projects: [] });
    if (url === "/api/skills") return jsonResponse({ skills: [SKILL] });
    if (url.startsWith("/api/skills/")) {
      return jsonResponse({
        skill: { ...SKILL, sourcePath: null, hubPath: null, originPatterns: [], evidenceRefs: [], supersedesVersion: null, provenanceWarnings: [], skillMarkdown: "# doc", files: [] },
      });
    }
    if (url === `/api/agents/${SECOND.id}/runs`) return jsonResponse({ runs: [RUN] });
    if (url.includes("/runs")) return jsonResponse({ runs: [] });
    if (url.includes("/messages")) return jsonResponse({ messages: [] });
    if (url.includes("/children")) return jsonResponse({ runs: [] });
    if (url.includes("/coordination")) return jsonResponse({ messages: [], members: [] });
    if (url.includes("/artifacts")) return jsonResponse({ artifacts: [] });
    if (url.includes("/events")) return jsonResponse({ events: [], lastSeq: 0, complete: true });
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  installFetch();
  window.localStorage.clear();
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openApp() {
  render(<App />);
  await screen.findByRole("heading", { level: 1, name: "First chat" });
}

describe("switching between chats and skills", () => {
  it("opens the skill hub from the rail", async () => {
    await openApp();
    await userEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.getByText("What the agents have published")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "First chat" })).toBeNull();
  });

  it("goes back to the chat from the rail", async () => {
    await openApp();
    await userEvent.click(screen.getByRole("button", { name: "Skills" }));
    await userEvent.click(screen.getByRole("button", { name: "Chats" }));
    expect(await screen.findByRole("heading", { level: 1, name: "First chat" })).toBeTruthy();
  });

  /** The reported bug: the sidebar list kept working, and the page did not. */
  it("returns to the chats view when a chat is picked while the hub is open", async () => {
    await openApp();
    await userEvent.click(screen.getByRole("button", { name: "Skills" }));
    await userEvent.click(screen.getByText("Second chat"));
    expect(await screen.findByRole("heading", { level: 1, name: "Second chat" })).toBeTruthy();
    expect(screen.queryByText("What the agents have published")).toBeNull();
  });

  it("marks which destination is showing", async () => {
    await openApp();
    expect(screen.getByRole("button", { name: "Chats" }).getAttribute("aria-current")).toBe("page");
    await userEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.getByRole("button", { name: "Skills" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Chats" }).getAttribute("aria-current")).toBeNull();
  });

  it("still closes the hub from its own Close button", async () => {
    await openApp();
    await userEvent.click(screen.getByRole("button", { name: "Skills" }));
    await userEvent.click(screen.getByRole("button", { name: "Close the skill hub" }));
    expect(await screen.findByRole("heading", { level: 1, name: "First chat" })).toBeTruthy();
  });
});

/**
 * The rail is a panel you can put away.
 *
 * It is a third of the window and, on a finished run, most of it is a creature
 * and a column of counters. Collapsing it is a per-viewer preference, so it is
 * remembered.
 */
describe("collapsing the agent panel", () => {
  /** The panel only has a subject when the chat has actually run something. */
  async function openChatWithARun() {
    window.localStorage.setItem("launchpad.selectedAgentId", SECOND.id);
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Second chat" });
  }

  it("is open to start with", async () => {
    await openChatWithARun();
    expect(await screen.findByRole("complementary", { name: "Agent panel" })).toBeTruthy();
  });

  /**
   * Closing is done from the panel's own corner; opening is done from the
   * header, which is the one place that does not move when the panel does.
   * The edge handle these used to reach for is gone: it existed only while the
   * panel was away, so the control changed position every time it was used.
   */
  it("puts the panel away and brings it back", async () => {
    await openChatWithARun();
    await screen.findByRole("complementary", { name: "Agent panel" });
    const hideControl = await screen.findByRole("button", { name: "Hide the agent panel" });
    expect(hideControl.className).toBe("panel-control");
    expect(hideControl.getAttribute("title")).toBe("Hide the agent panel");
    expect(hideControl.textContent).toBe("→");
    expect(document.querySelectorAll(".panel-control")).toHaveLength(1);

    await userEvent.click(hideControl);
    expect(screen.queryByRole("complementary", { name: "Agent panel" })).toBeNull();
    const showControl = screen.getByRole("button", { name: "Show the agent panel" });
    expect(showControl.className).toBe("panel-control");
    expect(showControl.getAttribute("title")).toBe("Show the agent panel");
    expect(showControl.textContent).toBe("←");
    expect(document.querySelectorAll(".panel-control")).toHaveLength(1);

    await userEvent.click(showControl);
    expect(await screen.findByRole("complementary", { name: "Agent panel" })).toBeTruthy();
  });

  it("remembers that it was put away", async () => {
    await openChatWithARun();
    // The toggle only exists once the run has loaded and given the panel a
    // subject, so it is awaited rather than assumed.
    await userEvent.click(await screen.findByRole("button", { name: "Hide the agent panel" }));
    cleanup();
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Second chat" });
    expect(screen.queryByRole("complementary", { name: "Agent panel" })).toBeNull();
  });
});
