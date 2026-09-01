// @vitest-environment jsdom

/**
 * Opening "New chat" must not hand you the agent you were reading.
 *
 * One `form` state served two different forms: the agent settings panel, which
 * is supposed to follow whatever is selected, and the temporary new-chat
 * dialog, which is supposed to start blank. An effect reseeded that shared
 * state from `selected` on every change -- and because the roster is re-fetched
 * while a run is live, `selected` becomes a new object every two seconds. So
 * the dialog opened empty and then filled itself in with the highlighted
 * worker's name, description and instructions, and creating the chat would have
 * silently cloned that worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const LEADER = agent("11111111-1111-4111-8111-111111111111", "Leader", { role: "leader" });
const WORKER = agent("22222222-2222-4222-8222-222222222222", "hkoi-skill-developer", {
  role: "worker",
  parentAgentId: LEADER.id,
  description: "Worker specialist for hkoi-skill-developer-leader-dispatch-3",
  instructions: "Complete only the delegated subtask.",
  createdAt: "2026-08-30T00:00:01.000Z",
});

const LEADER_RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKER_RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function run(id: string, agentId: string, over: Partial<AgentRun> = {}): AgentRun {
  return {
    id,
    agentId,
    projectId: null,
    kind: "single",
    parentRunId: null,
    orchestration: null,
    // Live, because the roster only re-polls while something is running -- which
    // is exactly when this went wrong.
    status: "running",
    prompt: "do the thing",
    output: null,
    error: null,
    usage: null,
    startedAt: "2026-08-30T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    ...over,
  };
}

const LEADER_RUN = run(LEADER_RUN_ID, LEADER.id, { kind: "orchestration" });
const WORKER_RUN = run(WORKER_RUN_ID, WORKER.id, { parentRunId: LEADER_RUN_ID });

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
    // A fresh array every call, the way a real poll returns fresh objects.
    if (url === "/api/agents") return jsonResponse({ agents: [{ ...LEADER }, { ...WORKER }] });
    if (url === "/api/projects") return jsonResponse({ projects: [] });
    if (url === `/api/agents/${LEADER.id}/runs`) return jsonResponse({ runs: [LEADER_RUN] });
    if (url === `/api/agents/${WORKER.id}/runs`) return jsonResponse({ runs: [WORKER_RUN] });
    if (url.includes("/messages")) return jsonResponse({ messages: [] });
    if (url === `/api/runs/${LEADER_RUN_ID}/children`) return jsonResponse({ runs: [WORKER_RUN] });
    if (url.includes("/children")) return jsonResponse({ runs: [] });
    if (url.includes("/coordination")) return jsonResponse({ messages: [], members: [] });
    if (url.includes("/artifacts")) return jsonResponse({ artifacts: [] });
    if (url.includes("/events")) return jsonResponse({ events: [], lastSeq: 0, complete: true });
    if (url === `/api/runs/${LEADER_RUN_ID}`) return jsonResponse({ run: LEADER_RUN });
    if (url === `/api/runs/${WORKER_RUN_ID}`) return jsonResponse({ run: WORKER_RUN });
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

/** The temporary dialog's own title field, told apart by its placeholder. */
function nameField(): HTMLInputElement {
  const dialog = document.querySelector("form.modal") as HTMLElement;
  return within(dialog).getByPlaceholderText("Scratch research") as HTMLInputElement;
}

async function openNewChatWhileReading(agentName: string) {
  window.localStorage.setItem("launchpad.selectedAgentId", WORKER.id);
  render(<App />);
  await screen.findByRole("heading", { level: 1, name: agentName });
  const sidebar = document.querySelector("aside.sidebar") as HTMLElement;
  await userEvent.click(within(sidebar).getByRole("button", { name: "New chat" }));
  await screen.findByText("Uses an ephemeral workspace outside Projects.");
}

describe("the temporary New chat dialog", () => {
  it("opens blank while a worker is being read", async () => {
    await openNewChatWhileReading(WORKER.name);
    expect(nameField().value).toBe("");
  });

  /**
   * The roster re-polls every two seconds while a run is live. This waits past
   * one of those polls: before the fix the dialog filled itself in there.
   */
  it("stays blank when the roster refreshes underneath it", async () => {
    await openNewChatWhileReading(WORKER.name);
    await waitFor(
      () => {
        const calls = vi.mocked(globalThis.fetch).mock.calls.filter(
          (call) => String(call[0]) === "/api/agents",
        );
        expect(calls.length).toBeGreaterThan(1);
      },
      { timeout: 6000 },
    );
    expect(nameField().value).toBe("");
    const dialog = document.querySelector("form.modal") as HTMLElement;
    expect((dialog.textContent ?? "").includes("Worker specialist")).toBe(false);
  }, 10_000);
});
