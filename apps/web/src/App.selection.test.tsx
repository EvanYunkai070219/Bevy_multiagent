// @vitest-environment jsdom

/**
 * Reloading lands on the chat that was open.
 *
 * `selection.ts` got the rules right, and the app still opened the wrong chat:
 * the effect that remembers the selection runs on mount, when `selectedId` is
 * still `null`, and cleared the stored id before `refreshAgents` -- which only
 * resolves after `/api/auth` and `/api/agents` -- ever got to read it. Every
 * reload therefore fell through to "first non-worker chat", which is exactly
 * the behaviour that was supposed to have been fixed.
 *
 * Caught in a browser against real data: a reload with a chat id in
 * localStorage opened a different chat entirely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import App from "./App";
import type { Agent, AgentRun } from "./types";

function agent(id: string, name: string, over: Partial<Agent> = {}): Agent {
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
    ...over,
  };
}

const FIRST = agent("11111111-1111-4111-8111-111111111111", "First chat");
const SECOND = agent("22222222-2222-4222-8222-222222222222", "Second chat");

function run(id: string, agentId: string, over: Partial<AgentRun> = {}): AgentRun {
  return {
    id,
    agentId,
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
    ...over,
  };
}

const RUNS: Record<string, AgentRun[]> = {
  [SECOND.id]: [
    run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SECOND.id, {
      createdAt: "2026-08-30T02:00:00.000Z",
      prompt: "the newest thing",
    }),
    run("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", SECOND.id, {
      createdAt: "2026-08-30T01:00:00.000Z",
      prompt: "the older thing",
      status: "failed",
    }),
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
  } as unknown as Response;
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
    const runsMatch = /^\/api\/agents\/([^/]+)\/runs$/.exec(url);
    if (runsMatch) return jsonResponse({ runs: RUNS[runsMatch[1]!] ?? [] });
    if (url.includes("/messages")) return jsonResponse({ messages: [] });
    if (url.includes("/children")) return jsonResponse({ runs: [] });
    if (url.includes("/coordination")) return jsonResponse({ messages: [], members: [] });
    if (url.includes("/artifacts")) return jsonResponse({ artifacts: [] });
    if (url.includes("/events")) {
      return jsonResponse({ events: [], lastSeq: 0, complete: true });
    }
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

describe("selection survives a reload", () => {
  it("opens the chat that was open, not the first one in the roster", async () => {
    window.localStorage.setItem("launchpad.selectedAgentId", SECOND.id);
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Second chat" })).toBeTruthy();
  });

  it("still keeps the remembered id after mounting, so the next reload works too", async () => {
    window.localStorage.setItem("launchpad.selectedAgentId", SECOND.id);
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Second chat" });
    expect(window.localStorage.getItem("launchpad.selectedAgentId")).toBe(SECOND.id);
  });

  it("falls back to the first chat when nothing was remembered", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "First chat" })).toBeTruthy();
  });
});

describe("a chat with more than one run offers its history", () => {
  it("opens on the newest run and says which of how many it is", async () => {
    window.localStorage.setItem("launchpad.selectedAgentId", SECOND.id);
    render(<App />);
    expect(await screen.findByText("Run 2 of 2")).toBeTruthy();
  });

  it("lists every run of the chat in the picker", async () => {
    window.localStorage.setItem("launchpad.selectedAgentId", SECOND.id);
    render(<App />);
    const picker = (await screen.findByLabelText("Run")) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual([
      expect.stringContaining("the newest thing"),
      expect.stringContaining("the older thing"),
    ]);
  });
});
