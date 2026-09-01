/** How a subtask maps onto a worker agent. */
import { describe, expect, it } from "vitest";
import { WorkerResolver } from "../src/orchestration/workers/worker-resolver.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import type { Agent, LeaderSubtask } from "../src/types.js";

const leader: Agent = {
  id: "leader-1",
  name: "Leader",
  description: "",
  instructions: "",
  status: "ready",
  role: "leader",
  parentAgentId: null,
  specialty: null,
  workspacePath: "/w/leader",
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

const subtask = (id: string, role = "worker"): LeaderSubtask => ({
  id,
  title: id,
  role,
  prompt: "do " + id,
  objective: "",
  successCriteria: [],
  expectedOutput: "",
  dependsOn: [],
});

const workspacePath = (agentId: string): string => "/w/" + agentId;

describe("worker resolver", () => {
  // The plan reads as five collaborating agents; keying identity on `role` alone
  // collapsed them into one agent run five times, because a planner naturally
  // labels every peer "worker". Distinct subtasks are distinct participants.
  it("gives each subtask its own worker agent", () => {
    const resolver = new WorkerResolver();
    const agents: Agent[] = [];

    for (const id of ["agent-1", "agent-2", "agent-3"]) {
      const resolved = resolver.resolve(
        leader,
        subtask(id),
        defaultExecutionPolicy,
        agents,
        workspacePath,
      );
      expect(resolved.created).toBe(true);
      agents.push(resolved.agent);
    }

    expect(new Set(agents.map((a) => a.id)).size).toBe(3);
    expect(new Set(agents.map((a) => a.specialty)).size).toBe(3);
  });

  // A replan or retry of the same subtask is the same participant coming back,
  // not a new one — otherwise every iteration leaks a fresh agent and workspace.
  it("reuses the agent when the same subtask runs again", () => {
    const resolver = new WorkerResolver();
    const first = resolver.resolve(
      leader,
      subtask("agent-1"),
      defaultExecutionPolicy,
      [],
      workspacePath,
    );
    const second = resolver.resolve(
      leader,
      subtask("agent-1"),
      defaultExecutionPolicy,
      [first.agent],
      workspacePath,
    );

    expect(second.created).toBe(false);
    expect(second.agent.id).toBe(first.agent.id);
  });

  it("keeps the subtask id visible in the agent's name", () => {
    const resolver = new WorkerResolver();
    const resolved = resolver.resolve(
      leader,
      subtask("researcher-2", "researcher"),
      defaultExecutionPolicy,
      [],
      workspacePath,
    );
    expect(resolved.agent.name.toLowerCase()).toContain("researcher");
  });

  it("uses the leader-provided worker name when present", () => {
    const resolver = new WorkerResolver();
    const resolved = resolver.resolve(
      leader,
      { ...subtask("audit-api"), agentName: "API Auditor", title: "Audit API" },
      defaultExecutionPolicy,
      [],
      workspacePath,
    );
    expect(resolved.agent.name).toBe("API Auditor");
  });

  it("keeps generated worker names distinct", () => {
    const resolver = new WorkerResolver();
    const first = resolver.resolve(
      leader,
      { ...subtask("frontend"), agentName: "Reviewer" },
      defaultExecutionPolicy,
      [],
      workspacePath,
    );
    const second = resolver.resolve(
      leader,
      { ...subtask("backend"), agentName: "Reviewer" },
      defaultExecutionPolicy,
      [first.agent],
      workspacePath,
    );
    expect([first.agent.name, second.agent.name]).toEqual(["Reviewer", "Reviewer 2"]);
  });

  // Names are scoped to the crew that reads them together. A global counter made
  // rerunning one plan produce `agent4`, `agent4 2`, `agent4 3` -- the previous
  // runs' workers were still on file, still holding the name, forever.
  it("does not inherit a suffix from another leader's workers", () => {
    const resolver = new WorkerResolver();
    const otherLeadersWorker: Agent = {
      ...leader,
      id: "worker-elsewhere",
      name: "Reviewer",
      role: "worker",
      parentAgentId: "leader-2",
      specialty: "reviewer-elsewhere-11223344",
    };
    const resolved = resolver.resolve(
      leader,
      { ...subtask("frontend"), agentName: "Reviewer" },
      defaultExecutionPolicy,
      [otherLeadersWorker],
      workspacePath,
    );
    expect(resolved.agent.name).toBe("Reviewer");
  });

  it("does not inherit a suffix from a standalone chat that shares the name", () => {
    const resolver = new WorkerResolver();
    const chat: Agent = {
      ...leader,
      id: "chat-1",
      name: "Reviewer",
      role: "standalone",
      parentAgentId: null,
    };
    const resolved = resolver.resolve(
      leader,
      { ...subtask("frontend"), agentName: "Reviewer" },
      defaultExecutionPolicy,
      [chat],
      workspacePath,
    );
    expect(resolved.agent.name).toBe("Reviewer");
  });

  it("still separates two workers of the same leader", () => {
    const resolver = new WorkerResolver();
    const first = resolver.resolve(
      leader,
      { ...subtask("frontend"), agentName: "Reviewer" },
      defaultExecutionPolicy,
      [],
      workspacePath,
    );
    const second = resolver.resolve(
      leader,
      { ...subtask("backend"), agentName: "Reviewer" },
      defaultExecutionPolicy,
      [first.agent],
      workspacePath,
    );
    expect(second.agent.name).toBe("Reviewer 2");
  });

  it("does not collapse distinct named workers when their role slug is long", () => {
    const resolver = new WorkerResolver();
    const role =
      "play-5-rounds-of-rock-paper-scissors-against-the-orchestrator-for-match";
    const first = resolver.resolve(
      leader,
      { ...subtask("subagent-1", role), agentName: "rps-player-1" },
      defaultExecutionPolicy,
      [],
      workspacePath,
    );
    const second = resolver.resolve(
      leader,
      { ...subtask("subagent-2", role), agentName: "rps-player-2" },
      defaultExecutionPolicy,
      [first.agent],
      workspacePath,
    );

    expect(second.created).toBe(true);
    expect(second.agent.id).not.toBe(first.agent.id);
    expect(second.agent.specialty).not.toBe(first.agent.specialty);
  });

  // The old behaviour stays available: several subtasks that genuinely are the
  // same specialist should be able to share one agent.
  it("still shares one agent per role under per_role identity", () => {
    const resolver = new WorkerResolver();
    const policy = { ...defaultExecutionPolicy, workerIdentityPolicy: "per_role" as const };
    const first = resolver.resolve(leader, subtask("agent-1"), policy, [], workspacePath);
    const second = resolver.resolve(
      leader,
      subtask("agent-2"),
      policy,
      [first.agent],
      workspacePath,
    );
    expect(second.created).toBe(false);
    expect(second.agent.id).toBe(first.agent.id);
  });
});

describe("planned worker run ids", () => {
  // Run ids travel through API routes that validate the format. A bare digest
  // made every worker-trajectory request fail with a 500 the UI could only
  // render as "Internal Server Error".
  it("are valid v4 UUIDs, deterministic, and scoped by iteration", async () => {
    const { Orchestrator } = await import("../src/orchestration/orchestrator.js");
    const planned = (
      Orchestrator.prototype as unknown as {
        plannedWorkerRunId(leader: string, iteration: number, subtask: string): string;
      }
    ).plannedWorkerRunId;

    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const first = planned.call(null, "leader-1", 1, "step1");
    expect(first).toMatch(uuid);
    // Same subtask in the same iteration is the same participant coming back.
    expect(planned.call(null, "leader-1", 1, "step1")).toBe(first);
    // A replanned attempt must not inherit messages queued for the previous one.
    expect(planned.call(null, "leader-1", 2, "step1")).not.toBe(first);
    expect(planned.call(null, "leader-1", 1, "step2")).not.toBe(first);
  });
});
