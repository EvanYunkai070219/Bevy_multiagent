/**
 * Which creature stands for which agent.
 *
 * This file and `public/creatures/` are the swap seam: replace the roster and
 * the artwork and the whole cast changes, with no other file touched. The
 * mapping is a pure function of `agent.id`, so it survives reloads and restarts
 * without anything being stored anywhere.
 */
import type { Agent } from "./types";

export type Affinity = "code" | "research" | "review" | "ops" | "any";

export interface Creature {
  id: string;
  displayName: string;
  sprite: string;
  affinity: Affinity;
}

/**
 * Fuzzy Friends: sixteen originals, four per affinity.
 *
 * The cast used to be Pokémon, which is somebody else's intellectual property
 * and cannot ship. These are drawn for this product -- one generator, one
 * skeleton, one palette -- so they read as a set rather than sixteen unrelated
 * drawings. `public/creatures/_generate.py` is that generator; the SVGs it
 * produces are the fallback art, and swapping in a rendered pack means changing
 * the `sprite` paths here and nothing else.
 *
 * Affinity is a hint about what kind of work suits a face, never a rule: it
 * only narrows the pool a hash draws from, and an unrecognised specialty draws
 * from all sixteen.
 */
export const ROSTER: Creature[] = [
  // Builders.
  { id: "otter", displayName: "Otter", sprite: "/creatures/otter.png", affinity: "code" },
  { id: "panda", displayName: "Panda", sprite: "/creatures/panda.png", affinity: "code" },
  { id: "beaver", displayName: "Beaver", sprite: "/creatures/beaver.png", affinity: "code" },
  { id: "hedgehog", displayName: "Hedgehog", sprite: "/creatures/hedgehog.png", affinity: "code" },
  // The ones that go and look.
  { id: "fox", displayName: "Fox", sprite: "/creatures/fox.png", affinity: "research" },
  { id: "owl", displayName: "Owl", sprite: "/creatures/owl.png", affinity: "research" },
  { id: "rabbit", displayName: "Rabbit", sprite: "/creatures/rabbit.png", affinity: "research" },
  { id: "squirrel", displayName: "Squirrel", sprite: "/creatures/squirrel.png", affinity: "research" },
  // The ones that check.
  { id: "penguin", displayName: "Penguin", sprite: "/creatures/penguin.png", affinity: "review" },
  { id: "cat", displayName: "Cat", sprite: "/creatures/cat.png", affinity: "review" },
  { id: "raccoon", displayName: "Raccoon", sprite: "/creatures/raccoon.png", affinity: "review" },
  { id: "koala", displayName: "Koala", sprite: "/creatures/koala.png", affinity: "review" },
  // The ones that keep the place running.
  { id: "bear", displayName: "Bear", sprite: "/creatures/bear.png", affinity: "ops" },
  { id: "hamster", displayName: "Hamster", sprite: "/creatures/hamster.png", affinity: "ops" },
  { id: "shiba", displayName: "Shiba", sprite: "/creatures/shiba.png", affinity: "ops" },
  { id: "sloth", displayName: "Sloth", sprite: "/creatures/sloth.png", affinity: "ops" },
];

/** FNV-1a. Small, dependency-free, and well spread for short ids. */
function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

/**
 * A specialty is free text written by a leader, so this matches intent rather
 * than an enum. Anything unrecognised draws from the whole roster: an empty
 * pool would be worse than an unthemed creature.
 */
export function affinityOf(specialty: string | null): Affinity {
  const text = (specialty ?? "").toLowerCase();
  if (/cod|dev|engineer|implement|build|program/.test(text)) return "code";
  if (/research|search|explor|investigat|scout|docs/.test(text)) return "research";
  if (/eval|review|test|verif|valid|audit|qa/.test(text)) return "review";
  if (/ops|deploy|infra|release|runtime|environment/.test(text)) return "ops";
  return "any";
}

function poolFor(specialty: string | null, roster: Creature[]): Creature[] {
  const affinity = affinityOf(specialty);
  const themed =
    affinity === "any" ? roster : roster.filter((item) => item.affinity === affinity);
  return themed.length > 0 ? themed : roster;
}

export function creatureFor(
  agent: Pick<Agent, "id" | "specialty">,
  roster: Creature[] = ROSTER,
): Creature {
  const pool = poolFor(agent.specialty, roster);
  return pool[hash(agent.id) % pool.length]!;
}

/** An agent, as far as casting is concerned. */
export type Castable = Pick<Agent, "id" | "specialty" | "parentAgentId" | "createdAt">;

/**
 * Which creature each agent wears, with no two on one mission alike.
 *
 * `creatureFor` alone hashes into a themed pool of four, so two workers on the
 * same mission drew the same creature about as often as not -- and telling the
 * cast apart is the entire job of having one. Assignment stays derived, never
 * stored: the same roster and the same agents produce the same casting on every
 * reload, so a refresh cannot change who anybody is.
 *
 * Uniqueness is per family -- a leader and the workers it dispatched -- rather
 * than global. Two unrelated chats sharing a creature confuses nobody, while
 * insisting otherwise would exhaust a sixteen-creature roster across a busy
 * launchpad and start handing out duplicates inside a mission again.
 *
 * Order is fixed at oldest first, so a worker dispatched later is appended and
 * nobody already on screen is recast underneath the reader.
 */
export function assignCreatures(
  agents: Castable[],
  roster: Creature[] = ROSTER,
): Record<string, Creature> {
  const families = new Map<string, Castable[]>();
  for (const agent of agents) {
    const family = agent.parentAgentId ?? agent.id;
    const current = families.get(family) ?? [];
    current.push(agent);
    families.set(family, current);
  }

  const cast: Record<string, Creature> = {};
  for (const members of families.values()) {
    const taken = new Set<string>();
    const ordered = [...members].sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt.localeCompare(right.createdAt),
    );
    for (const agent of ordered) {
      const chosen = firstFree(agent, roster, taken);
      cast[agent.id] = chosen;
      taken.add(chosen.id);
    }
  }
  return cast;
}

/**
 * The agent's own creature if it is still free, then the rest of its theme,
 * then anything at all. A themed duplicate is worse than an off-theme original:
 * the theme is a hint, telling two agents apart is the point.
 */
function firstFree(agent: Castable, roster: Creature[], taken: Set<string>): Creature {
  const pool = poolFor(agent.specialty, roster);
  const preferred = hash(agent.id) % pool.length;
  for (let step = 0; step < pool.length; step += 1) {
    const candidate = pool[(preferred + step) % pool.length]!;
    if (!taken.has(candidate.id)) return candidate;
  }
  const offset = hash(agent.id) % roster.length;
  for (let step = 0; step < roster.length; step += 1) {
    const candidate = roster[(offset + step) % roster.length]!;
    if (!taken.has(candidate.id)) return candidate;
  }
  // More agents than creatures. Repeating beats leaving one with no face.
  return pool[preferred]!;
}

/**
 * The cast's answer where there is one, the standalone hash where there is not.
 *
 * Every sprite is looked up through here, so a component rendered without a
 * cast -- in a test, or before the roster has loaded -- still draws somebody.
 */
export function creatureOf(
  agent: Pick<Agent, "id" | "specialty">,
  cast?: Record<string, Creature>,
): Creature {
  return cast?.[agent.id] ?? creatureFor(agent);
}
