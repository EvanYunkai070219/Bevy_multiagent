/**
 * Where the mission is, in the orchestrator's own words.
 *
 * It lives in the rail, read top to bottom, beside the other things that
 * describe the run rather than across the header above the conversation: a
 * six-stop strip competing with the chat title made the header the busiest part
 * of the page, and the phase is reference material, not a headline.
 *
 * A generic Plan / Inspect / Execute / Verify strip would read well and mean
 * nothing: `delegating` is not "inspect" and `replanning` is not "recover".
 * Letting a theme word overwrite what the orchestrator actually did would make
 * this the one part of the interface that is decoration. Using the real names
 * costs a row of width and shows the actual loop -- execute, replan, execute --
 * which is the part worth seeing.
 */
export const PHASES: { id: string; label: string; glyph: string }[] = [
  { id: "planning", label: "Plan", glyph: "✎" },
  { id: "delegating", label: "Delegate", glyph: "⇢" },
  { id: "executing", label: "Execute", glyph: "❯" },
  { id: "evaluating", label: "Evaluate", glyph: "◎" },
  { id: "synthesizing", label: "Synthesize", glyph: "❖" },
  { id: "completed", label: "Done", glyph: "✓" },
];

export function MissionPhases({ phase }: { phase: string }) {
  const replanning = phase === "replanning";
  // A replan is a return to planning, not a seventh step, so the strip keeps
  // its shape and the loop is drawn where it actually happens.
  const currentId = replanning ? "delegating" : phase === "failed" ? "completed" : phase;
  const currentIndex = PHASES.findIndex((item) => item.id === currentId);

  return (
    <section className="rail-card card--phase">
      <div className="rail-card-title">Mission phase</div>
      <ol className="phases">
      {PHASES.map((item, index) => {
        const done = currentIndex > index;
        const current = currentIndex === index;
        const failed = phase === "failed" && current;
        return (
          <li
            key={item.id}
            className={
              "phase" +
              (current ? " phase--current" : "") +
              (done ? " phase--done" : "") +
              (failed ? " phase--failed" : "")
            }
          >
            {index > 0 && <span className="phase-link" aria-hidden="true" />}
            <span className="phase-bubble" aria-hidden="true">
              {failed ? "!" : done ? "✓" : replanning && current ? "↻" : item.glyph}
            </span>
            <span className="phase-label">
              {replanning && current ? "Replan" : item.label}
            </span>
          </li>
        );
      })}
      </ol>
    </section>
  );
}
