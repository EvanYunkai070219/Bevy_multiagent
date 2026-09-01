/**
 * The squad sent on this mission, and everyone else.
 *
 * Party membership is "dispatched on this mission", not "busy right now". A
 * worker that finished would otherwise vanish the instant it succeeded, and the
 * one moment worth seeing -- Byte, done -- would be on screen for the shortest
 * time of any. Whether a member is still working is carried by its posture;
 * presence only says it was sent.
 *
 * There are no status dots here. The creature is the status.
 */
import { agentStatsOf } from "./agent-stats";
import { CreatureSprite } from "./CreatureSprite";
import { creatureOf, type Creature } from "./creatures";
import { creatureStateOf, type CreatureState } from "./creature-state";
import { moveFor, type Move } from "./moves";
import { roleLabel, roleTone } from "./WorkerInspector";
import type { Agent, AgentRun, RunEvent } from "./types";

/**
 * Workers in the order they were dispatched.
 *
 * `/api/agents` returns whatever order the store yields, and every surface that
 * lists workers -- the sidebar branch, the party, the bench, the rail -- took
 * that order as given, so one mission listed its workers differently in
 * different places and in no order at all. Creation time is the one ordering
 * that matches what the operator watched happen; the id breaks ties so the
 * result is total and stable rather than left to the sort implementation.
 */
export function orderWorkers(workers: Agent[]): Agent[] {
  return [...workers].sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.id.localeCompare(right.id)
      : left.createdAt.localeCompare(right.createdAt),
  );
}

export interface PartyMember {
  agent: Agent;
  runId: string;
  state: CreatureState;
  move: Move | null;
  /**
   * What it did last, and only while `move` is null. A member between two tool
   * calls has nothing open; showing a dash there read as the agent having
   * stopped. The two are never both set, so no reader can mistake one for the
   * other.
   */
  lastMove: Move | null;
}

export function partitionParty({
  workers,
  runs,
  byRun,
  leaderSettled,
}: {
  workers: Agent[];
  runs: AgentRun[];
  byRun: Record<string, RunEvent[]>;
  /** A finished mission disbands its party; everyone goes back to the bench. */
  leaderSettled: boolean;
}): { party: PartyMember[]; bench: Agent[] } {
  const ordered = orderWorkers(workers);
  if (leaderSettled) return { party: [], bench: ordered };

  const runByAgent = new Map<string, AgentRun>();
  for (const run of runs) if (!runByAgent.has(run.agentId)) runByAgent.set(run.agentId, run);

  const party: PartyMember[] = [];
  const bench: Agent[] = [];
  for (const worker of ordered) {
    const run = runByAgent.get(worker.id);
    if (run === undefined) {
      bench.push(worker);
      continue;
    }
    const events = byRun[run.id] ?? [];
    const stats = agentStatsOf(events);
    party.push({
      agent: worker,
      runId: run.id,
      state: creatureStateOf(events, run.status),
      move: stats.current === null ? null : moveFor(stats.current),
      lastMove: stats.last === null ? null : moveFor(stats.last),
    });
  }
  return { party, bench };
}

export function AgentParty({
  party,
  bench,
  selectedId,
  onSelect,
  cast,
}: {
  party: PartyMember[];
  bench: Agent[];
  selectedId: string | null;
  onSelect(agentId: string): void;
  /** Who wears which creature. Absent, each agent falls back to its own hash. */
  cast?: Record<string, Creature>;
}) {
  if (party.length === 0 && bench.length === 0) return null;

  return (
    <div className="party">
      {party.length > 0 && (
        <>
          <div className="party-heading">
            <span>Party</span>
            <span>{party.length}</span>
          </div>
          <div className="party-list">
            {party.map((member) => (
              <button
                type="button"
                key={member.agent.id}
                className={"party-card " + (member.agent.id === selectedId ? "selected" : "")}
                onClick={() => onSelect(member.agent.id)}
              >
                <CreatureSprite
                  creature={creatureOf(member.agent, cast)}
                  state={member.state}
                  name={member.agent.name}
                  size={30}
                />
                <div className="party-card-copy">
                  <strong>{member.agent.name}</strong>
                  <span>{member.agent.specialty ?? "Worker Agent"}</span>
                </div>
                <span
                  className={
                    "party-move" + (member.move === null && member.lastMove !== null
                      ? " party-move--settled"
                      : "")
                  }
                >
                  {member.move !== null
                    ? member.move.glyph + " " + member.move.label
                    : member.state === "done"
                      ? "✓ Done"
                      : member.lastMove !== null
                        ? member.lastMove.glyph + " " + member.lastMove.label
                        : "—"}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {bench.length > 0 && (
        <>
          <div className="party-heading">
            <span>Bench</span>
            <span>{bench.length}</span>
          </div>
          {/* Every worker, not a preview. This list was capped at eight, which
              silently dropped the ninth worker of a large mission and made the
              interface disagree with the count printed directly above it. */}
          <div className="bench-list">
            {bench.map((worker) => (
              <button
                type="button"
                key={worker.id}
                className={"bench-row " + (worker.id === selectedId ? "selected" : "")}
                onClick={() => onSelect(worker.id)}
                title={worker.name}
              >
                <CreatureSprite
                  creature={creatureOf(worker, cast)}
                  state="idle"
                  name={worker.name}
                  size={22}
                />
                {/* A grid of creatures could not say which worker did what. The
                    name and the role it was dispatched for are the answer, and a
                    cartoon alone was never going to be. */}
                <span className="bench-row-name">{worker.name}</span>
                <span className={"role-tag role-tag--" + roleTone(worker)}>
                  {roleLabel(worker).toUpperCase()}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
