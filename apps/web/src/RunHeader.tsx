/**
 * One header for every Run, current or historical.
 *
 * The complaint was that the current Run and the last one looked like different
 * products: no session name, no timestamp, no status, no way back to a Run that
 * had already finished. The fix is not a second screen for old Runs -- it is
 * naming the Run the transcript is showing, and letting that name be changed.
 * Everything below the header (transcript, trajectory, usage, rail) already
 * keys off one Run id, so switching it here switches all of them at once.
 */
import { countAgents, countToolCalls, formatDuration, runDurationMs } from "./run-history";
import type { AgentRun, RunEvent } from "./types";
import { formatStamp } from "./format";

const PROMPT_PREVIEW = 60;

function preview(prompt: string): string {
  const text = prompt.trim().replace(/\s+/g, " ");
  return text.length > PROMPT_PREVIEW ? text.slice(0, PROMPT_PREVIEW - 1) + "…" : text;
}

/**
 * Runs arrive newest-first, which is the right order to choose from and the
 * wrong order to count in: the operator's first Run is Run 1.
 */
function positionOf(runs: AgentRun[], index: number): number {
  return runs.length - index;
}

export function RunHeader({
  runs,
  run,
  sessionName,
  onSelect,
  position,
  total,
  pickable = true,
}: {
  runs: AgentRun[];
  run: AgentRun;
  sessionName: string;
  onSelect: (runId: string) => void;
  /** Supplied by the transcript, which already knows where this run falls. */
  position?: number;
  total?: number;
  /**
   * Only the run being read carries the picker. Every run in the transcript
   * gets a header, and eight selectors that all do the same thing is noise.
   */
  pickable?: boolean;
}) {
  const index = runs.findIndex((item) => item.id === run.id);
  const shownPosition = position ?? (index >= 0 ? positionOf(runs, index) : null);
  const shownTotal = total ?? runs.length;
  const duration = runDurationMs(run);

  return (
    <section className="run-header">
      <div className="run-header-identity">
        {shownPosition !== null && shownTotal > 0 && (
          <span className="eyebrow">
            Run {shownPosition} of {shownTotal}
          </span>
        )}
        <h3>{sessionName}</h3>
      </div>
      <div className="run-header-meta">
        <span className={"run-status run-status--" + run.status}>{run.status}</span>
        {/* The machine-readable instant stays on the element, so a Run whose
            local rendering is ambiguous is still pinnable to a moment. */}
        <span title={run.createdAt}>{formatStamp(run.createdAt)}</span>
        {duration !== null && <span title="Duration">{formatDuration(duration)}</span>}
      </div>
      {pickable && runs.length > 1 && (
        <label className="run-header-picker">
          <span>Run</span>
          <select value={run.id} onChange={(event) => onSelect(event.target.value)}>
            {runs.map((item, itemIndex) => (
              <option key={item.id} value={item.id}>
                {"Run " +
                  positionOf(runs, itemIndex) +
                  " · " +
                  item.status +
                  " · " +
                  formatStamp(item.createdAt) +
                  " · " +
                  preview(item.prompt)}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}

function plural(count: number, noun: string): string {
  return count + " " + noun + (count === 1 ? "" : "s");
}

/**
 * What the Run amounted to, next to what it cost.
 *
 * Read off the same trace the transcript is drawn from rather than off run
 * fields, so a historical Run reports exactly what its persisted events say --
 * no separate summary to drift out of step with the trajectory above it.
 */
export function RunMetadata({
  events,
  artifactCount,
}: {
  events: RunEvent[];
  artifactCount: number;
}) {
  const toolCalls = countToolCalls(events);
  const agents = countAgents(events);
  if (toolCalls === 0 && agents === 0 && artifactCount === 0) return null;

  return (
    <div className="run-metadata">
      <span>{plural(toolCalls, "tool call")}</span>
      <span>{plural(agents, "agent")}</span>
      {artifactCount > 0 && <span>{plural(artifactCount, "artifact")}</span>}
    </div>
  );
}
