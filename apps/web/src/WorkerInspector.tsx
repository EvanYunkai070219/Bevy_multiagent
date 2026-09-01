/**
 * One agent, up close.
 *
 * The order is deliberate: the creature, then what it can do, then the raw
 * output of what it is doing right now. A cartoon directly above a live
 * `./dotnet-install.sh` is the whole idea of this interface in one column.
 *
 * The count is `Errors`, not `Errors recovered`. All that is knowable is that
 * errors happened; whether each was repaired is a story the transcript tells by
 * showing the retry, and a counter could only assert it.
 */
import { agentStatsOf } from "./agent-stats";
import { CreatureSprite } from "./CreatureSprite";
import { creatureOf, type Creature } from "./creatures";
import { creatureStateOf, type CreatureState } from "./creature-state";
import { moveFor } from "./moves";
import type { Agent, RunEvent, RunStatus } from "./types";

const TAIL_CHARS = 1200;

const SETTLED = new Set<RunStatus>(["completed", "failed", "cancelled"]);

const STATE_LABEL: Record<CreatureState, string> = {
  done: "Done",
  searching: "Searching",
  working: "Working",
  thinking: "Thinking",
  hurt: "Hit a failure",
  waiting: "Waiting",
  idle: "Idle",
};

/**
 * Which tint a role wears. Free text from a leader, matched by intent, so an
 * unrecognised specialty gets the neutral tint rather than no tint at all.
 */
/**
 * A specialty that describes the agent, or nothing.
 *
 * On a dispatched worker `specialty` is a machine identity, not a role: the
 * server builds it as `<role prefix>-<subtask id>-<sha256 head>` capped at 64
 * characters, precisely so two workers sharing a long role stay distinct.
 * Printing it verbatim produced pills reading
 * `YOU-ARE-A-RANDOM-CHOICE-GENE…` -- a slugified instruction with a hash
 * stapled on, in a chip meant to hold a word.
 *
 * The digest suffix is the tell; excessive length is the backstop. Either way
 * the string is identity rather than description, and identity has a better
 * home: the agent's own name, which is what tells two workers apart. `roleTint`
 * still reads the whole specialty, because matching intent is not displaying
 * it.
 */
export function describedRole(specialty: string | null): string | null {
  const text = (specialty ?? "").trim();
  if (text.length === 0) return null;
  if (/-[0-9a-f]{8}$/.test(text)) return null;
  if (text.length > 24) return null;
  return text.replace(/[-_]+/g, " ");
}

/**
 * What to call an agent whose specialty says nothing usable.
 *
 * `specialty` is only ever set on a dispatched worker, so falling back to
 * "Worker" labelled every standalone chat and every leader as one. The role is
 * the answer when the specialty is absent or unprintable.
 */
export function roleLabel(agent: Pick<Agent, "role" | "specialty">): string {
  const described = describedRole(agent.specialty);
  if (described !== null) return described;
  if (agent.role === "leader") return "Leader";
  if (agent.role === "worker") return "Worker";
  return "Agent";
}

/**
 * One colour, one meaning: is this agent working right now?
 *
 * Tags used to be tinted by what the specialty string looked like -- purple for
 * anything matching /cod|dev|engineer/, green for /review|test/ -- which nobody
 * could read ("这个颜色是啥意思") and which competed with the creature's posture
 * and the run's status for the same signal. `busy` is the platform's own record
 * of a dispatched agent still running; everything else is done, stopped or
 * never started, and a failure reports itself elsewhere rather than claiming a
 * third colour here.
 */
export function roleTone(agent: Pick<Agent, "status">): "running" | "idle" {
  return agent.status === "busy" ? "running" : "idle";
}

/** A long-running command should show its newest output, not its oldest. */
function tail(text: string | undefined): string {
  if (text === undefined) return "";
  const trimmed = text.trimEnd();
  return trimmed.length <= TAIL_CHARS ? trimmed : trimmed.slice(trimmed.length - TAIL_CHARS);
}

export function WorkerInspector({
  agent,
  events,
  runStatus,
  cast,
}: {
  agent: Agent;
  events: RunEvent[];
  runStatus?: RunStatus;
  /** Who wears which creature. Absent, the agent falls back to its own hash. */
  cast?: Record<string, Creature>;
}) {
  const creature = creatureOf(agent, cast);
  const state = creatureStateOf(events, runStatus);
  const settled = runStatus !== undefined && SETTLED.has(runStatus);
  const stats = agentStatsOf(events);
  const current = stats.current;
  const currentMove = current === null ? null : moveFor(current);

  return (
    <section className="inspector">
      <div className="rail-card card--agent">
        <div className="rail-card-title">Current agent</div>
        <header className="inspector-head">
          <CreatureSprite creature={creature} state={state} name={agent.name} size={78} />
          <div className="inspector-identity">
            <strong>{agent.name}</strong>
            {/* The picture names the creature for anyone who can see it. This
                names it for everyone else, and it is the one place the assigned
                name is worth the words. */}
            <span className="inspector-creature">{creature.displayName}</span>
            <span className={"role-tag role-tag--" + roleTone(agent)}>
              {roleLabel(agent).toUpperCase()}
            </span>
            <span className="inspector-state-label">Status</span>
            <span className="inspector-state">
              <span className={"state-dot state-dot--" + state} />
              {STATE_LABEL[state]}
            </span>
          </div>
        </header>
        <div className="inspector-stats">
          <div>
            <span className="stat-glyph">⌘</span>
            <strong>{stats.toolsUsed}</strong>
            <span>Tools used</span>
          </div>
          {/* Codex reports a file change for a patch edit and nothing else, so
              an agent that writes with `echo >>` produces a command and no file
              change at all. Across this deployment's whole event log there is
              not one such event, and the counter sat at 0 beside missions that
              had demonstrably written files. "Zero" and "cannot see" are
              different answers; only one of them is true here. */}
          {stats.filesChanged > 0 && (
            <div>
              <span className="stat-glyph">✎</span>
              <strong>{stats.filesChanged}</strong>
              <span>Files changed</span>
            </div>
          )}
          <div>
            <span className="stat-glyph">!</span>
            <strong>{stats.errors}</strong>
            <span>Errors</span>
          </div>
        </div>
        <div className="inspector-creature-note">
          {stats.tasksDone} task{stats.tasksDone === 1 ? "" : "s"} done
        </div>
      </div>

      {stats.moves.length > 0 && (
        <div className="rail-card card--moves">
          <div className="rail-card-title">Moves</div>
          <ul className="inspector-moves">
            {stats.moves.map((tally) => (
              <li key={tally.move.id}>
                <span className="inspector-move-glyph">{tally.move.glyph}</span>
                <span className="inspector-move-label">{tally.move.label}</span>
                <span className="inspector-move-count">{tally.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The card names a move. An event that is not one -- the leader's own
          session opening, say -- has no move, and falling back to its span name
          printed `leader_codex_loop` at the reader: a machine identifier, not
          something the agent did. */}
      {current !== null && currentMove !== null && (
        <div className="rail-card card--move">
          {/* A finished run has no current move. The card used to keep saying
              "Current move -> Dispatch" with the leader's live-session
              narration under it long after the run reported Done, so the panel
              claimed work was in progress while the transcript said otherwise.
              What it last did is still worth naming; the commentary and the
              half-written output of a step in flight are not -- both describe a
              moment that has passed. */}
          <div className="rail-card-title">{settled ? "Last move" : "Current move"}</div>
          <div className="inspector-current">
            <span className="inspector-move-glyph">{currentMove.glyph}</span>
            <span className="inspector-move-label">{currentMove.label}</span>
          </div>
          {!settled && current.input.command !== undefined && (
            <code className="inspector-command">{current.input.command}</code>
          )}
          {!settled && tail(current.output.text).length > 0 && (
            <pre className="inspector-terminal">{tail(current.output.text)}</pre>
          )}
        </div>
      )}
    </section>
  );
}
