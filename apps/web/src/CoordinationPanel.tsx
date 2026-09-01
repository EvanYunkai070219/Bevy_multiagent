/** What the team said to each other, and what never arrived. */
import { useEffect, useState } from "react";
import { api } from "./api";
import type { CoordinationMessage, CoordinationView } from "./types";

const STATE_LABEL: Record<string, string> = {
  queued: "Queued",
  delivered: "Delivered",
  undeliverable: "Not delivered",
};

/**
 * A quiet note nobody read is the failure this channel makes easiest: the
 * sender believes it passed the information on, and nothing else in the run
 * says otherwise. So undelivered messages are shown first and marked, rather
 * than sorted to the bottom of a list.
 */
function messageWeight(message: CoordinationMessage): number {
  if (message.state === "undeliverable") return 0;
  if (message.state === "queued") return 1;
  return 2;
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

export function CoordinationPanel({
  leaderRunId,
  running,
}: {
  leaderRunId: string;
  running: boolean;
}) {
  const [view, setView] = useState<CoordinationView | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = async (): Promise<void> => {
      try {
        const next = await api.coordination(leaderRunId);
        if (cancelled) return;
        setView(next);
      } catch {
        // A missing projection is normal for runs that predate coordination.
      }
      if (!cancelled && running) timer = window.setTimeout(tick, 1500);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [leaderRunId, running]);

  if (view === null || view.messages.length === 0) return null;

  const ordered = [...view.messages].sort((a, b) => messageWeight(a) - messageWeight(b));
  const memberNames = new Map(
    view.members.map((member) => [member.workerRunId, member.displayName]),
  );
  const label = (workerRunId: string): string =>
    memberNames.get(workerRunId) ?? shortId(workerRunId);

  return (
    <section className="coordination-panel">
      <div className="orchestration-head">
        <span className="eyebrow">Coordination</span>
        <strong>{view.messages.length} messages</strong>
      </div>
      {ordered.map((message) => (
        <div className={"coordination-message state-" + message.state} key={message.id}>
          <div className="coordination-row">
            <span className="coordination-route">
              {label(message.from)} → {label(message.to)}
            </span>
            <span className={"coordination-kind kind-" + message.delivery}>
              {message.delivery === "wakeup"
                ? "woke them"
                : message.delivery === "talk"
                  ? "talk"
                  : "quiet"}
            </span>
            <span className="coordination-state">
              {STATE_LABEL[message.state] ?? message.state}
              {message.via === undefined ? "" : " · " + message.via}
            </span>
          </div>
          {message.reason !== undefined && (
            <span className="coordination-reason">{message.reason}</span>
          )}
          <span className="coordination-content">{message.content}</span>
        </div>
      ))}
    </section>
  );
}
