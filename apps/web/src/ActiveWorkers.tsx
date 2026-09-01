/**
 * The workers on this mission, in the rail beside the work they are doing.
 *
 * The sidebar answers "which chat"; this answers "who is on it right now". Each
 * row is the creature, the real agent name, its role, what state it is in, and
 * the move it is in the middle of -- every one of those read off its own event
 * stream, none of them a label someone typed.
 */
import { CreatureSprite } from "./CreatureSprite";
import { creatureOf, type Creature } from "./creatures";
import type { PartyMember } from "./AgentParty";
import { roleLabel, roleTone } from "./WorkerInspector";

const STATE_TEXT: Record<string, string> = {
  done: "Done",
  searching: "Searching",
  working: "Working",
  thinking: "Thinking",
  hurt: "Recovering",
  waiting: "Waiting",
  idle: "Idle",
};

export function ActiveWorkers({
  party,
  selectedId,
  onSelect,
  cast,
}: {
  party: PartyMember[];
  selectedId: string | null;
  onSelect(agentId: string): void;
  /** Who wears which creature. Absent, each agent falls back to its own hash. */
  cast?: Record<string, Creature>;
}) {
  if (party.length === 0) return null;

  return (
    <section className="rail-card card--agent">
      <div className="rail-card-title">
        Active workers <span className="rail-card-count">{party.length}</span>
      </div>
      <ul className="worker-rows">
        {party.map((member) => (
          <li key={member.agent.id}>
            <button
              type="button"
              className={
                "worker-row " + (member.agent.id === selectedId ? "selected" : "")
              }
              onClick={() => onSelect(member.agent.id)}
            >
              <CreatureSprite
                creature={creatureOf(member.agent, cast)}
                state={member.state}
                name={member.agent.name}
                size={34}
              />
              <span className="worker-row-copy">
                <span className="worker-row-head">
                  <strong>{member.agent.name}</strong>
                  <span className={"role-tag role-tag--" + roleTone(member.agent)}>
                    {roleLabel(member.agent).toUpperCase()}
                  </span>
                </span>
                <span className="worker-row-state">
                  <span className={"state-dot state-dot--" + member.state} />
                  {STATE_TEXT[member.state] ?? member.state}
                </span>
              </span>
              <span
                className={
                  "worker-row-move" + (member.move === null && member.lastMove !== null
                    ? " worker-row-move--settled"
                    : "")
                }
              >
                {member.move !== null
                  ? member.move.glyph + " " + member.move.label
                  : member.state === "done"
                    ? "✓"
                    : member.lastMove !== null
                      ? member.lastMove.glyph + " " + member.lastMove.label
                      : "—"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
