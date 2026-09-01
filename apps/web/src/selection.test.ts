// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { pickSelection, recallSelection, rememberSelection } from "./selection";
import type { Agent } from "./types";

function agent(id: string, role: Agent["role"]): Agent {
  return {
    id,
    name: id,
    description: "",
    instructions: "",
    status: "ready",
    role,
    parentAgentId: role === "worker" ? "leader" : null,
    specialty: null,
    projectId: null,
    unassignedPlacement: null,
    workspacePath: "/tmp/" + id,
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

describe("pickSelection", () => {
  it("keeps the current selection when the agent still exists", () => {
    const agents = [agent("worker", "worker"), agent("leader", "leader")];
    expect(pickSelection(agents, "leader", "worker")).toBe("leader");
  });

  it("restores the remembered agent when nothing is selected", () => {
    const agents = [agent("a", "standalone"), agent("b", "standalone")];
    expect(pickSelection(agents, null, "b")).toBe("b");
  });

  it("restores a remembered worker, because that is what was being viewed", () => {
    const agents = [agent("leader", "leader"), agent("w", "worker")];
    expect(pickSelection(agents, null, "w")).toBe("w");
  });

  it("never falls back to a worker when the list happens to start with one", () => {
    const agents = [agent("w1", "worker"), agent("w2", "worker"), agent("leader", "leader")];
    expect(pickSelection(agents, null, null)).toBe("leader");
  });

  it("drops a selection whose agent is gone", () => {
    const agents = [agent("leader", "leader")];
    expect(pickSelection(agents, "deleted", null)).toBe("leader");
  });

  it("ignores a remembered agent that no longer exists", () => {
    const agents = [agent("leader", "leader")];
    expect(pickSelection(agents, null, "deleted")).toBe("leader");
  });

  it("returns null when there is nothing selectable", () => {
    expect(pickSelection([agent("w", "worker")], null, null)).toBeNull();
    expect(pickSelection([], null, null)).toBeNull();
  });
});

describe("remembering", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips an id", () => {
    rememberSelection("agent-1");
    expect(recallSelection()).toBe("agent-1");
  });

  it("clears on null", () => {
    rememberSelection("agent-1");
    rememberSelection(null);
    expect(recallSelection()).toBeNull();
  });
});
