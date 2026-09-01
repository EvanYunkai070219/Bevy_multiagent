/** The authenticated boundary between a worker's MCP subprocess and the team. */
import { describe, expect, it } from "vitest";
import { CoordinationIngress } from "../src/coordination/ingress.js";
import { Roster } from "../src/coordination/roster.js";
import type { TeamMessageQueued } from "../src/coordination/messages.js";
import { CoordinationServer } from "../src/coordination/server.js";

function setup() {
  const roster = new Roster("leader-1");
  roster.register("w-a", "step1", 1, "HarnessVisionary");
  roster.register("w-b", "step2", 1, "HarnessPragmatist");
  const queued: TeamMessageQueued[] = [];
  const dispatched: string[] = [];
  const ingress = new CoordinationIngress(roster, async (message) => {
    queued.push(message);
  }, async (request) => {
    dispatched.push(request.prompt);
    return { ok: true };
  });
  return { roster, ingress, queued, dispatched };
}

describe("coordination ingress", () => {
  // A subprocess that could name its own sender could impersonate a sibling,
  // and every judgement built on "who said this" would be worthless.
  it("takes the sender from the token, never from the request", async () => {
    const { ingress } = setup();
    const token = ingress.issue("leader-1", "w-a");
    const message = await ingress.submit(token, {
      to: "w-b",
      content: "hello",
      delivery: "quiet",
      ...({ from: "w-b" } as object),
    });
    expect(message.fromWorkerRunId).toBe("w-a");
  });

  it("refuses an unknown token", async () => {
    const { ingress } = setup();
    await expect(
      ingress.submit("not-a-token", { to: "w-b", content: "x", delivery: "quiet" }),
    ).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("refuses a recipient outside this leader run", async () => {
    const { ingress } = setup();
    const token = ingress.issue("leader-1", "w-a");
    await expect(
      ingress.submit(token, { to: "stranger", content: "x", delivery: "quiet" }),
    ).rejects.toThrow(/RECIPIENT_NOT_IN_ROSTER/);
  });

  it("resolves a recipient by its model-visible name", async () => {
    const { ingress } = setup();
    const token = ingress.issue("leader-1", "w-a");
    const message = await ingress.submit(token, {
      to: "HarnessPragmatist",
      content: "x",
      delivery: "wakeup",
    });
    expect(message.toWorkerRunId).toBe("w-b");
  });

  it("keeps the legacy subtask id addressable", async () => {
    const { ingress } = setup();
    const token = ingress.issue("leader-1", "w-a");
    const message = await ingress.submit(token, {
      to: "step2",
      content: "x",
      delivery: "quiet",
    });
    expect(message.toWorkerRunId).toBe("w-b");
  });

  // Long content belongs in the shared workspace; the message carries a pointer.
  it("refuses content past the size bound with an actionable message", async () => {
    const { ingress } = setup();
    const token = ingress.issue("leader-1", "w-a");
    await expect(
      ingress.submit(token, { to: "w-b", content: "x".repeat(2_500), delivery: "quiet" }),
    ).rejects.toThrow(/COMMON_WORKSPACE/);
  });

  it("refuses a workspace ref that climbs out of the shared directory", async () => {
    const { ingress } = setup();
    const token = ingress.issue("leader-1", "w-a");
    await expect(
      ingress.submit(token, {
        to: "w-b",
        content: "see this",
        delivery: "quiet",
        workspaceRefs: ["../../etc/passwd"],
      }),
    ).rejects.toThrow(/WORKSPACE_REF_ESCAPES/);
  });

  it("refuses a worker messaging itself", async () => {
    const { ingress } = setup();
    const token = ingress.issue("leader-1", "w-a");
    await expect(
      ingress.submit(token, { to: "w-a", content: "x", delivery: "quiet" }),
    ).rejects.toThrow(/RECIPIENT_IS_SENDER/);
  });

  // Downstream DAG members are legitimate recipients before they exist as
  // processes: a message sent now should ride in with their first turn.
  it("lists teammates that have not started yet, excluding the caller", async () => {
    const { ingress } = setup();
    const token = ingress.issue("leader-1", "w-a");
    const mates = ingress.listTeammates(token);
    expect(mates.map((m) => m.workerRunId)).toEqual(["w-b"]);
    expect(mates.map((m) => m.displayName)).toEqual(["HarnessPragmatist"]);
    expect(mates[0]?.state).toBe("not_started");
  });

  it("persists before telling the caller it was queued", async () => {
    const { ingress, queued } = setup();
    const token = ingress.issue("leader-1", "w-a");
    const message = await ingress.submit(token, {
      to: "w-b",
      content: "x",
      delivery: "quiet",
    });
    expect(queued.map((m) => m.id)).toEqual([message.id]);
  });

  it("allows only the leader token to dispatch subagents", async () => {
    const { ingress, dispatched } = setup();
    const leaderToken = ingress.issue("leader-1", "leader-1");
    const workerToken = ingress.issue("leader-1", "w-a");

    await expect(
      ingress.dispatch(workerToken, { prompt: "worker may not spawn sibling" }),
    ).rejects.toThrow(/DISPATCH_UNAVAILABLE/);
    await expect(
      ingress.dispatch(leaderToken, { prompt: "inspect the code" }),
    ).resolves.toEqual({ ok: true });
    expect(dispatched).toEqual(["inspect the code"]);
  });

  it("preserves dispatch flags and initial messages across the HTTP boundary", async () => {
    const roster = new Roster("leader-1");
    roster.register("leader-1", "leader", 1, "leader");
    const seen: unknown[] = [];
    const ingress = new CoordinationIngress(
      roster,
      async () => undefined,
      async (request) => {
        seen.push(request);
        return { ok: true };
      },
    );
    const token = ingress.issue("leader-1", "leader-1");
    const server = new CoordinationServer();
    server.register(token, ingress);
    await server.listen(0);
    try {
      const response = await fetch(server.baseUrl("127.0.0.1") + "/dispatch_subagent", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + token,
        },
        body: JSON.stringify({
          prompt: "listen for the greeting",
          requiresGitContribution: false,
          initialMessage: "hello on first turn",
          initialMessageWorkspaceRefs: ["reports/greeting.md"],
        }),
      });
      expect(response.status).toBe(200);
      expect(seen[0]).toMatchObject({
        prompt: "listen for the greeting",
        requiresGitContribution: false,
        initialMessage: "hello on first turn",
        initialMessageWorkspaceRefs: ["reports/greeting.md"],
      });
    } finally {
      await server.close();
    }
  });

  it("preserves wait targets across the HTTP boundary", async () => {
    const roster = new Roster("leader-1");
    roster.register("leader-1", "leader", 1, "leader");
    const seen: unknown[] = [];
    const ingress = new CoordinationIngress(
      roster,
      async () => undefined,
      undefined,
      undefined,
      undefined,
      async (request) => {
        seen.push(request);
        return { ok: true, completed: true };
      },
    );
    const token = ingress.issue("leader-1", "leader-1");
    const server = new CoordinationServer();
    server.register(token, ingress);
    await server.listen(0);
    try {
      const response = await fetch(server.baseUrl("127.0.0.1") + "/wait_workers", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + token,
        },
        body: JSON.stringify({
          targets: ["contract", "validator"],
          timeoutSeconds: 42,
        }),
      });
      expect(response.status).toBe(200);
      expect(seen[0]).toEqual({
        targets: ["contract", "validator"],
        timeoutSeconds: 42,
      });
    } finally {
      await server.close();
    }
  });
});
