import { describe, expect, it } from "vitest";
import { ROSTER, assignCreatures, creatureFor, creatureOf, type Creature } from "./creatures";
import type { Agent } from "./types";

function agent(partial: Partial<Agent> & Pick<Agent, "id">): Agent {
  return {
    name: "worker",
    description: "",
    instructions: "",
    status: "ready",
    role: "worker",
    parentAgentId: "leader-1",
    specialty: null,
    projectId: null,
    unassignedPlacement: null,
    workspacePath: "/workspace",
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...partial,
  } as Agent;
}

describe("creatureFor", () => {
  it("gives the same agent the same creature every time", () => {
    const subject = agent({ id: "agent-7" });
    const first = creatureFor(subject);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(creatureFor(subject).id).toBe(first.id);
    }
  });

  it("draws a coding agent and a research agent from different pools", () => {
    const coders = new Set<string>();
    const researchers = new Set<string>();
    for (let index = 0; index < 40; index += 1) {
      coders.add(creatureFor(agent({ id: "c" + index, specialty: "Coding worker" })).id);
      researchers.add(
        creatureFor(agent({ id: "r" + index, specialty: "Research worker" })).id,
      );
    }
    for (const id of coders) expect(researchers.has(id)).toBe(false);
  });

  it("falls back to the whole roster for a null or unknown specialty", () => {
    expect(creatureFor(agent({ id: "a", specialty: null }))).toBeDefined();
    expect(creatureFor(agent({ id: "b", specialty: "chief vibes officer" }))).toBeDefined();
  });

  it("keeps assigning once there are more agents than roster entries", () => {
    for (let index = 0; index < ROSTER.length * 3; index += 1) {
      expect(creatureFor(agent({ id: "overflow-" + index })).sprite).toContain("/creatures/");
    }
  });

  it("follows a replacement roster, so the cast is swappable", () => {
    const replacement: Creature[] = [
      { id: "robot", displayName: "Robot", sprite: "/robots/robot.gif", affinity: "any" },
    ];
    expect(creatureFor(agent({ id: "agent-7" }), replacement).id).toBe("robot");
  });
});

describe("assignCreatures", () => {
  function member(id: string, specialty: string | null, parentAgentId: string | null, createdAt: string) {
    return { id, specialty, parentAgentId, createdAt };
  }

  const mission = [
    member("leader", null, null, "2026-08-30T00:00:00.000Z"),
    member("w1", "code", "leader", "2026-08-30T00:00:01.000Z"),
    member("w2", "code", "leader", "2026-08-30T00:00:02.000Z"),
    member("w3", "code", "leader", "2026-08-30T00:00:03.000Z"),
    member("w4", "code", "leader", "2026-08-30T00:00:04.000Z"),
  ];

  it("gives everyone on one mission a different creature", () => {
    const cast = assignCreatures(mission);
    const sprites = Object.values(cast).map((creature) => creature.id);
    expect(new Set(sprites).size).toBe(sprites.length);
  });

  it("is the same casting every time, so a reload changes nobody", () => {
    expect(assignCreatures(mission)).toEqual(assignCreatures(mission));
    // Order of arrival must not matter either: the sort inside decides.
    expect(assignCreatures([...mission].reverse())).toEqual(assignCreatures(mission));
  });

  it("does not recast anyone when a later worker joins", () => {
    const before = assignCreatures(mission);
    const after = assignCreatures([
      ...mission,
      member("w5", "code", "leader", "2026-08-30T00:00:05.000Z"),
    ]);
    for (const agent of mission) {
      expect(after[agent.id]).toEqual(before[agent.id]);
    }
  });

  it("keeps the theme where it can and drops it rather than repeat", () => {
    const cast = assignCreatures(mission);
    const themed = mission
      .filter((agent) => agent.specialty === "code")
      .map((agent) => cast[agent.id]!.affinity);
    expect(themed.filter((affinity) => affinity === "code").length).toBeGreaterThan(0);
  });

  it("lets unrelated chats share a creature", () => {
    const cast = assignCreatures([
      member("solo-a", null, null, "2026-08-30T00:00:00.000Z"),
      member("solo-b", null, null, "2026-08-30T00:00:01.000Z"),
    ]);
    expect(Object.keys(cast)).toHaveLength(2);
  });

  it("falls back to the plain hash with no casting available", () => {
    const agent = { id: "w1", specialty: "code" };
    expect(creatureOf(agent)).toEqual(creatureFor(agent));
    expect(creatureOf(agent, assignCreatures(mission))).toEqual(assignCreatures(mission).w1);
  });
});
