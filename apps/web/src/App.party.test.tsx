// @vitest-environment jsdom

/**
 * Reading a worker must not change the mission it belongs to.
 *
 * Party membership was computed from whatever was selected: the workers of
 * `selected`. Click into a worker and `selected` becomes that worker, which has
 * no workers of its own -- so the leader's party emptied and every member fell
 * back to the bench, purely because someone had navigated. Membership is a fact
 * about a run, and navigation is not a run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { Agent, AgentRun, RunEvent } from "./types";

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
const WORKER = agent("22222222-2222-4222-8222-222222222222", "Byte", {
  role: "worker",
  parentAgentId: LEADER.id,
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

const WORKER_EVENT: RunEvent = {
  seq: 1,
  runId: WORKER_RUN_ID,
  agentId: WORKER.id,
  spanId: "s1",
  parentSpanId: "run",
  kind: "command",
  name: "command",
  status: "ok",
  startedAt: "2026-08-30T00:00:02.000Z",
  endedAt: "2026-08-30T00:00:03.000Z",
  durationMs: 1000,
  input: { command: "echo hi" },
  output: {},
  error: null,
  attributes: {},
  usage: null,
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
    if (url === "/api/agents") return jsonResponse({ agents: [LEADER, WORKER] });
    if (url === "/api/projects") return jsonResponse({ projects: [] });
    if (url === `/api/agents/${LEADER.id}/runs`) return jsonResponse({ runs: [LEADER_RUN] });
    if (url === `/api/agents/${WORKER.id}/runs`) return jsonResponse({ runs: [WORKER_RUN] });
    if (url.includes("/messages")) return jsonResponse({ messages: [] });
    if (url === `/api/runs/${LEADER_RUN_ID}/children`) {
      return jsonResponse({ runs: [WORKER_RUN] });
    }
    if (url.includes("/children")) return jsonResponse({ runs: [] });
    // The team journal is keyed by the LEADER's run. A worker run has none --
    // which is exactly what made asking the wrong run return nothing.
    if (url === `/api/runs/${LEADER_RUN_ID}/coordination`) {
      return jsonResponse({
        messages: [
          {
            id: "m1",
            from: WORKER_RUN_ID,
            to: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            delivery: "talk",
            state: "delivered",
            content: "parser is ready",
          },
        ],
        members: [
          { workerRunId: WORKER_RUN_ID, displayName: "Byte", runtimeState: "running" },
        ],
      });
    }
    if (url.includes("/coordination")) return jsonResponse({ messages: [], members: [] });
    if (url.includes("/artifacts")) return jsonResponse({ artifacts: [] });
    if (url.startsWith(`/api/runs/${WORKER_RUN_ID}/events`)) {
      return jsonResponse({ events: [WORKER_EVENT], lastSeq: 1, complete: true });
    }
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

/** Party cards are the squad on this mission; bench rows are everyone else. */
function inParty(name: string): boolean {
  return [...document.querySelectorAll(".party-card")].some((card) =>
    (card.textContent ?? "").includes(name),
  );
}

function onBench(name: string): boolean {
  return [...document.querySelectorAll(".bench-row")].some((row) =>
    (row.textContent ?? "").includes(name),
  );
}

/** The roster entry is a button wrapping the name. */
async function openWorker() {
  const sidebar = document.querySelector("aside.sidebar") as HTMLElement;
  const entry = (await within(sidebar).findByText("Byte")).closest("button");
  await userEvent.click(entry as HTMLElement);
  await screen.findByRole("heading", { level: 1, name: "Byte" });
}

async function openLeader() {
  window.localStorage.setItem("launchpad.selectedAgentId", LEADER.id);
  render(<App />);
  await screen.findByRole("heading", { level: 1, name: "Leader" });
}

/** The party forms once the mission's children have loaded. */
async function waitForParty() {
  await waitFor(() => expect(inParty("Byte")).toBe(true));
}

describe("party membership while navigating", () => {
  it("puts a dispatched worker in the party, not on the bench", async () => {
    await openLeader();
    await waitForParty();
    expect(onBench("Byte")).toBe(false);
  });

  it("keeps it in the party after the reader opens it", async () => {
    await openLeader();
    await waitForParty();
    await openWorker();
    expect(inParty("Byte")).toBe(true);
    expect(onBench("Byte")).toBe(false);
  });

  it("still shows the worker's own transcript, not the whole mission's", async () => {
    await openLeader();
    await waitForParty();
    await openWorker();
    const playground = document.querySelector(".playground") as HTMLElement;
    // Live groups start folded; the worker's own step is behind its group line.
    await waitFor(() => expect(playground.querySelector(".stream-summary")).not.toBeNull());
    await userEvent.click(playground.querySelector(".stream-summary") as HTMLElement);
    expect(await within(playground).findByText(/echo hi/)).toBeTruthy();
  });
});

/**
 * A worker's own conversation has to survive opening that worker.
 *
 * The coordination projection is built per leader run, and the panel was asked
 * for `activeRun.id` -- which is the worker's run once you open one. A worker
 * run has no journal, so the answer was empty and the card vanished: the one
 * place a worker's messages were supposed to be readable was the one view that
 * could not read them.
 */
describe("agent-to-agent messages while reading a worker", () => {
  it("shows the mission's conversation on the leader", async () => {
    await openLeader();
    expect(await screen.findByText("Chatroom")).toBeTruthy();
  });

  it("still shows it after opening the worker", async () => {
    await openLeader();
    await waitForParty();
    await openWorker();
    expect(await screen.findByText("Chatroom")).toBeTruthy();
  });

  it("shows that worker's own message once opened", async () => {
    await openLeader();
    await waitForParty();
    await openWorker();
    await userEvent.click(await screen.findByText("Chatroom"));
    expect(await screen.findByText("parser is ready")).toBeTruthy();
  });
});

/**
 * A worker's page had no way to open the process panel at all: the Process
 * toggle lived only in the leader's header branch, so a reader who put the
 * panel away while on a worker was locked out of that worker's process view
 * until they navigated back to the leader.
 */
describe("the process panel while reading a worker", () => {
  it("offers the Process toggle on a worker's page", async () => {
    await openLeader();
    await waitForParty();
    await openWorker();
    await userEvent.click(await screen.findByRole("button", { name: "Hide the agent panel" }));
    expect(screen.queryByRole("complementary", { name: "Agent panel" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Process" }));
    expect(await screen.findByRole("complementary", { name: "Agent panel" })).toBeTruthy();
  });
});
