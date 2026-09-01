/** Shows the plan Codex maintains for the current run. */
import type { PlanItem, RunEvent } from "./types";

/**
 * Pick the current plan.
 *
 * Codex resends the whole plan on every update, so the newest todo event is
 * the current state. Taking the highest seq across all todo events works
 * whether Codex reuses one span or opens a new one.
 */
export function selectPlan(events: RunEvent[]): PlanItem[] | null {
  let newest: RunEvent | null = null;
  for (const event of events) {
    if (event.kind !== "todo" || event.output.todos === undefined) continue;
    if (newest === null || event.seq > newest.seq) newest = event;
  }
  return newest?.output.todos ?? null;
}

function StatusMark({ state }: { state: "done" | "active" | "pending" }) {
  if (state === "done") {
    return <span className="plan-mark plan-mark--done">✓</span>;
  }
  if (state === "active") {
    return (
      <span className="plan-mark plan-mark--active" aria-label="in progress" />
    );
  }
  return <span className="plan-mark plan-mark--pending">○</span>;
}

export function PlanPanel({ todos }: { todos: PlanItem[] }) {
  if (todos.length === 0) return null;

  const done = todos.filter((todo) => todo.done).length;
  // Codex reports only done or not done. The first unfinished entry is treated
  // as the one in progress because the plan runs in order; Codex never says
  // which entry it is working on, and there is no signal for a failed entry.
  const activeIndex = todos.findIndex((todo) => !todo.done);

  return (
    <section className="plan">
      <header className="plan-header">
        <span>Plan</span>
        <span className="plan-count">
          {done}/{todos.length}
        </span>
      </header>
      <ol className="plan-list">
        {todos.map((todo, index) => (
          <li className="plan-row" key={index + "-" + todo.text}>
            <span className="plan-index">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="plan-text">{todo.text}</span>
            <StatusMark
              state={
                todo.done ? "done" : index === activeIndex ? "active" : "pending"
              }
            />
          </li>
        ))}
      </ol>
    </section>
  );
}
