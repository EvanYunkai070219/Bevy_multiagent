/**
 * Append-only record of what one leader run's team did.
 *
 * Single writer, and the write reaches disk before anything acts on it. That
 * ordering is the whole point: a message the sender was told is "queued" but
 * which no longer exists after a crash is the failure this file is built to
 * prevent. Coordination reads the projection, but the projection is derived —
 * every piece of it must be rebuildable by replaying the file, or it becomes a
 * second, quieter place where the truth lives.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TeamMessageQueued, TeamMessageReceipt } from "./messages.js";

export type TeamJournalEvent =
  | { type: "team.member.registered"; workerRunId: string; subtaskId: string; displayName: string }
  | { type: "team.member.runtime_changed"; workerRunId: string; state: string }
  | { type: "team.message.queued"; message: TeamMessageQueued }
  | { type: "team.message.delivered"; receipt: TeamMessageReceipt }
  | { type: "team.message.undeliverable"; receipt: TeamMessageReceipt }
  | { type: "team.followup.turn_completed"; messageId: string; turnId: string; status: string }
  | { type: "team.workspace.snapshotted"; barrier: string; changedPaths: string[] }
  | { type: "team.checkpoint.committed"; workerRunId: string; checkpointId: string }
  | {
      type: "team.checkpoint.invalidated";
      upstreamWorkerRunId: string;
      checkpointId: string;
      consumedByWorkerRunIds: string[];
    };

export interface TeamJournalEntry {
  seq: number;
  at: string;
  event: TeamJournalEvent;
}

/** What a message's life looks like right now, derived from the entries. */
export interface MessageState {
  message: TeamMessageQueued;
  state: "queued" | "delivered" | "undeliverable";
  receipt: TeamMessageReceipt | null;
}

export interface TeamProjection {
  messages: Map<string, MessageState>;
  members: Map<string, { subtaskId: string; displayName: string; runtimeState: string }>;
}

export class TeamJournal {
  private readonly entryList: TeamJournalEntry[] = [];
  private seq = 0;
  /** Serialises appends: sequence numbers and file order must not diverge. */
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    readonly parentRunId: string,
    private readonly legacyFile: string | null,
  ) {}

  static async open(root: string, parentRunId: string): Promise<TeamJournal> {
    const dir = path.join(root, "runs", "team", safeSegment(parentRunId));
    await mkdir(dir, { recursive: true });
    const journal = new TeamJournal(
      path.join(dir, "journal.jsonl"),
      parentRunId,
      path.join(root, "team", safeSegment(parentRunId), "journal.jsonl"),
    );
    await journal.replay();
    return journal;
  }

  private async replay(): Promise<void> {
    await this.replayFile(this.file);
    if (this.entryList.length === 0 && this.legacyFile !== null) {
      await this.replayFile(this.legacyFile);
    }
  }

  private async replayFile(file: string): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return; // No journal yet is a valid empty history.
    }
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const entry = JSON.parse(line) as TeamJournalEntry;
        this.entryList.push(entry);
        this.seq = Math.max(this.seq, entry.seq);
      } catch {
        // A torn final line is the expected shape of a crash mid-append. The
        // entries before it are still good, so keep them rather than failing
        // the whole run over the last few bytes.
      }
    }
  }

  append(event: TeamJournalEvent): Promise<TeamJournalEntry> {
    const run = this.queue.then(async () => {
      this.seq += 1;
      const entry: TeamJournalEntry = {
        seq: this.seq,
        at: new Date().toISOString(),
        event,
      };
      // Disk first. Callers act on the return value, and acting on something
      // that was never persisted is the failure this ordering prevents.
      await appendFile(this.file, JSON.stringify(entry) + "\n", "utf8");
      this.entryList.push(entry);
      return entry;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  entries(): TeamJournalEntry[] {
    return [...this.entryList];
  }

  nextSequence(): number {
    return this.seq + 1;
  }

  projection(): TeamProjection {
    const messages = new Map<string, MessageState>();
    const members = new Map<
      string,
      { subtaskId: string; displayName: string; runtimeState: string }
    >();

    for (const { event } of this.entryList) {
      switch (event.type) {
        case "team.member.registered":
          members.set(event.workerRunId, {
            subtaskId: event.subtaskId,
            displayName: event.displayName,
            runtimeState: "not_started",
          });
          break;
        case "team.member.runtime_changed": {
          const member = members.get(event.workerRunId);
          if (member) member.runtimeState = event.state;
          break;
        }
        case "team.message.queued":
          messages.set(event.message.id, {
            message: event.message,
            state: "queued",
            receipt: null,
          });
          break;
        case "team.message.delivered":
        case "team.message.undeliverable": {
          const existing = messages.get(event.receipt.messageId);
          if (existing) {
            existing.state = event.receipt.state;
            existing.receipt = event.receipt;
          }
          break;
        }
        default:
          break;
      }
    }
    return { messages, members };
  }

  /**
   * Messages queued with no terminal receipt. This is what a restart consults:
   * a lost in-memory signal must not lose the message, so delivery is driven
   * from queued-minus-terminal rather than from anything held in a process.
   */
  pendingMessages(): TeamMessageQueued[] {
    const { messages } = this.projection();
    return [...messages.values()]
      .filter((entry) => entry.state === "queued")
      .map((entry) => entry.message);
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
}
