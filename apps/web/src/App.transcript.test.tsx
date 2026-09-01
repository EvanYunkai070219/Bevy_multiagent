// @vitest-environment jsdom

/**
 * How a session is laid out: what the transcript covers, and where the run's
 * records live.
 *
 * A leader's transcript is the whole session by default -- the mission is what
 * happened -- but it makes reading what the leader itself decided hard once a
 * handful of workers are talking over it, so it can be narrowed to the leader's
 * own run. Everything that is bookkeeping about the run rather than a turn in
 * it belongs in the rail, and the rail is opened from one fixed place.
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
    status: "completed",
    prompt: "do the thing",
    output: null,
    error: null,
    usage: null,
    startedAt: "2026-08-30T00:00:00.000Z",
    completedAt: "2026-08-30T00:01:00.000Z",
    createdAt: "2026-08-30T00:00:00.000Z",
    ...over,
  };
}

const LEADER_RUN = run(LEADER_RUN_ID, LEADER.id, {
  kind: "orchestration",
  project: {
    source: {
      mode: "existing_repository",
      repositoryPath: "/Users/me/repos/CodeJam",
      requestedRevision: "HEAD",
      baseCommit: "a".repeat(40),
      sourceFingerprint: "fp",
    },
    runBranch: "launchpad/run/" + LEADER_RUN_ID,
    canonicalWorkspacePath: "/runtime/run-1/canonical",
    headCommit: "b".repeat(40),
    state: "completed",
    attempts: [],
    integrations: [],
  },
} as Partial<AgentRun>);
const WORKER_RUN = run(WORKER_RUN_ID, WORKER.id, { parentRunId: LEADER_RUN_ID });

function command(seq: number, runId: string, agentId: string, text: string): RunEvent {
  return {
    seq,
    runId,
    agentId,
    spanId: "span-" + seq,
    parentSpanId: "run",
    kind: "command",
    name: "command",
    status: "ok",
    startedAt: "2026-08-30T00:00:0" + seq + ".000Z",
    endedAt: "2026-08-30T00:00:0" + seq + ".500Z",
    durationMs: 500,
    input: { command: text },
    output: {},
    error: null,
    attributes: {},
    usage: null,
  } as RunEvent;
}

const LEADER_STEP = command(1, LEADER_RUN_ID, LEADER.id, "leader-only-step");
const WORKER_STEP = command(2, WORKER_RUN_ID, WORKER.id, "worker-only-step");

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
    if (url === `/api/runs/${LEADER_RUN_ID}/children`) return jsonResponse({ runs: [WORKER_RUN] });
    if (url.includes("/children")) return jsonResponse({ runs: [] });
    if (url.includes("/coordination")) return jsonResponse({ messages: [], members: [] });
    if (url.includes("/artifacts")) return jsonResponse({ artifacts: [] });
    if (url.startsWith(`/api/runs/${LEADER_RUN_ID}/events`)) {
      return jsonResponse({ events: [LEADER_STEP], lastSeq: 1, complete: true });
    }
    if (url.startsWith(`/api/runs/${WORKER_RUN_ID}/events`)) {
      return jsonResponse({ events: [WORKER_STEP], lastSeq: 2, complete: true });
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

async function openLeader() {
  window.localStorage.setItem("launchpad.selectedAgentId", LEADER.id);
  render(<App />);
  await screen.findByRole("heading", { level: 1, name: "Leader" });
}

/**
 * The transcript folds finished work, so a step's text is not in the DOM until
 * a reader opens it. Every fold is one run's group, and its heading names the
 * actor -- which is exactly what scoping changes.
 */
/**
 * A settled run folds its whole timeline into one verdict, and that verdict
 * counts the steps it covers -- which is exactly what scoping changes.
 */
function foldText(): string {
  return [...document.querySelectorAll(".stream-verdict")]
    .map((node) => node.textContent ?? "")
    .join(" | ");
}

describe("transcript scope in a leader session", () => {
  it("covers the leader and every worker by default", async () => {
    await openLeader();
    await waitFor(() => expect(foldText()).toContain("2 steps"));
  });

  it("drops every worker step when scoped to the leader", async () => {
    await openLeader();
    await waitFor(() => expect(foldText()).toContain("2 steps"));

    await userEvent.click(screen.getByRole("button", { name: "Leader only" }));

    await waitFor(() => expect(foldText()).toContain("1 step"));
    expect(foldText()).not.toBe("");
  });

  /**
   * The run footer counts the mission, not the view. Narrowing what is read
   * must not restate how much work the mission did.
   */
  it("leaves the run's own totals alone", async () => {
    await openLeader();
    await waitFor(() => expect(foldText()).toContain("2 steps"));
    await userEvent.click(screen.getByRole("button", { name: "Leader only" }));
    await waitFor(() => expect(foldText()).toContain("1 step"));
    expect(document.querySelector(".messages")?.textContent ?? "").toContain("2 agents");
  });

  it("remembers the scope across a reload", async () => {
    await openLeader();
    await waitFor(() => expect(foldText()).toContain("2 steps"));
    await userEvent.click(screen.getByRole("button", { name: "Leader only" }));
    await waitFor(() => expect(foldText()).toContain("1 step"));

    cleanup();
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Leader" });
    await waitFor(() => expect(foldText()).not.toBe(""));
    expect(foldText()).toContain("1 step");
  });

  /**
   * Structural integration and evolution are platform bookkeeping about a run,
   * not part of the conversation someone came to read. They belong with the
   * other run records in the rail, which is also the panel that can be put
   * away when they are not what you are here for.
   */
  it("keeps integration bookkeeping out of the transcript", async () => {
    await openLeader();
    await waitFor(() => expect(foldText()).toContain("2 steps"));
    const main = document.querySelector("main.main") as HTMLElement;
    expect((main.textContent ?? "").includes("Structural integration")).toBe(false);
  });

  it("puts integration bookkeeping in the rail", async () => {
    await openLeader();
    await waitFor(() => {
      const rail = document.querySelector("aside.rail");
      expect((rail?.textContent ?? "").includes("Structural integration")).toBe(true);
    });
  });

  /** A worker's own session has nothing to scope: it is one run by definition. */
  it("offers no scope control while reading a worker", async () => {
    window.localStorage.setItem("launchpad.selectedAgentId", WORKER.id);
    render(<App />);
    await screen.findByRole("heading", { level: 1, name: "Byte" });
    expect(screen.queryByRole("button", { name: "Leader only" })).toBeNull();
  });
});

describe("the agent panel", () => {
  it("is opened from a button that keeps its place in the header", async () => {
    await openLeader();
    // The control only exists once the run has given the panel a subject.
    await screen.findByRole("button", { name: "Process" });
    const actions = document.querySelector(".header-actions") as HTMLElement;

    await waitFor(() => expect(document.querySelector("aside.rail")).not.toBeNull());
    await userEvent.click(within(actions).getByRole("button", { name: "Process" }));
    await waitFor(() => expect(document.querySelector("aside.rail")).toBeNull());

    // The control that brings it back is the same control, in the same place.
    await userEvent.click(within(actions).getByRole("button", { name: "Process" }));
    await waitFor(() => expect(document.querySelector("aside.rail")).not.toBeNull());
  });

  /**
   * The old control was a handle pinned to the window edge while the panel was
   * away and a button inside the panel while it was open, so using it moved it.
   */
  it("never puts the control anywhere but the header and the panel itself", async () => {
    await openLeader();
    await waitFor(() => expect(document.querySelector("aside.rail")).not.toBeNull());
    expect(document.querySelector(".panel-handle")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Process" }));
    await waitFor(() => expect(document.querySelector("aside.rail")).toBeNull());
    expect(document.querySelector(".panel-handle")).toBeNull();
  });

  it("collapses from the stable viewport control", async () => {
    await openLeader();
    const rail = await waitFor(() => {
      const found = document.querySelector("aside.rail");
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(rail).queryByRole("button", { name: "Hide the agent panel" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Hide the agent panel" }));
    await waitFor(() => expect(document.querySelector("aside.rail")).toBeNull());
  });

  it("says whether the panel is showing", async () => {
    await openLeader();
    await waitFor(() => expect(document.querySelector("aside.rail")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Process" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Process" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Process" }).getAttribute("aria-pressed")).toBe("false"),
    );
  });
});
