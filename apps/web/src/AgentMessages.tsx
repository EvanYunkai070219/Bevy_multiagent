/**
 * The session's chatroom.
 *
 * Agent-to-agent messaging is a real capability of this platform -- workers
 * leave each other notes, wake each other up, and sometimes talk into the void
 * -- and the journal behind `/api/runs/:id/coordination` has recorded all of it
 * from the start. This card shows ALL of it, in the order it was said,
 * whichever agent happens to be under the cursor. It used to filter down to
 * the inspected agent's own mail, which hid exactly the traffic a chatroom
 * exists to show: two workers coordinating with each other.
 *
 * It sits in the rail, folded shut, showing a count and nothing else until it
 * is opened. A mission where nobody spoke renders nothing at all rather than
 * an empty section that has to be read to be dismissed.
 *
 * The timeline is chronological -- a chatroom reads in time -- so the failure
 * this channel makes easiest to miss, a message nobody received, is counted
 * on the fold line itself and painted red inside.
 */
import { useEffect, useState } from "react";
import { api } from "./api";
import type { CoordinationMessage, CoordinationView } from "./types";

const POLL_MS = 2000;

const STATE_LABEL: Record<string, string> = {
  queued: "Queued",
  delivered: "Delivered",
  undeliverable: "Never arrived",
};

const DELIVERY_LABEL: Record<string, string> = {
  wakeup: "woke them",
  talk: "talk",
  quiet: "quiet note",
};

export interface ConversationRow {
  message: CoordinationMessage;
  from: string;
  to: string;
}

/**
 * The whole team's traffic, in journal order, with both ends named.
 */
export function selectChatroom(
  view: CoordinationView,
  leaderRunId: string,
): ConversationRow[] {
  // A run that predates coordination answers without a projection, and the
  // payload is not guaranteed to carry either array. Reading a mission's mail
  // must never be able to take the page down with it.
  const members = Array.isArray(view.members) ? view.members : [];
  const messages = Array.isArray(view.messages) ? view.messages : [];
  const names = new Map(members.map((member) => [member.workerRunId, member.displayName]));
  const label = (workerRunId: string): string =>
    workerRunId === leaderRunId
      ? "Leader"
      : (names.get(workerRunId) ?? workerRunId.slice(0, 8));

  return messages.map((message) => ({
    message,
    from: label(message.from),
    to: label(message.to),
  }));
}

export function AgentMessages({
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
        // Runs from before coordination existed have no journal. That is not
        // an error state to report, it is a run with nothing to show.
      }
      // A settled mission's team log cannot change, so it is read once.
      if (!cancelled && running) timer = window.setTimeout(() => void tick(), POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [leaderRunId, running]);

  if (view === null) return null;
  const rows = selectChatroom(view, leaderRunId);
  if (rows.length === 0) return null;
  const lost = rows.filter((row) => row.message.state === "undeliverable").length;

  return (
    <details className="rail-card card--talk agent-messages">
      <summary>
        <span className="rail-card-title">Chatroom</span>
        {lost > 0 && <span className="agent-message-lost">{lost} lost</span>}
        <span className="rail-card-count">{rows.length}</span>
      </summary>
      <ul className="agent-message-list">
        {rows.map((row) => (
          <li className={"agent-message state-" + row.message.state} key={row.message.id}>
            <div className="agent-message-head">
              <span className="agent-message-route">
                {row.from} → {row.to}
              </span>
              <span className={"agent-message-kind kind-" + row.message.delivery}>
                {DELIVERY_LABEL[row.message.delivery] ?? row.message.delivery}
              </span>
            </div>
            <p className="agent-message-body">{row.message.content}</p>
            <span className="agent-message-state">
              {STATE_LABEL[row.message.state] ?? row.message.state}
              {row.message.via === undefined ? "" : " · " + row.message.via}
              {row.message.reason === undefined ? "" : " · " + row.message.reason}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
