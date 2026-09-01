/** The append-only record of what one leader run's team did. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TeamJournal } from "../src/coordination/team-journal.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "journal-"));

const queued = (id: string) =>
  ({
    type: "team.message.queued" as const,
    message: {
      id,
      parentRunId: "leader-1",
      fromWorkerRunId: "w1",
      toWorkerRunId: "w2",
      delivery: "quiet" as const,
      content: "note " + id,
      workspaceRefs: [],
      createdAt: "2026-08-27T00:00:00.000Z",
    },
  });

describe("team journal", () => {
  it("assigns gapless sequences and rebuilds the projection from disk", async () => {
    const root = dir();
    const journal = await TeamJournal.open(root, "leader-1");
    await journal.append(queued("m1"));
    await journal.append({
      type: "team.message.delivered",
      receipt: {
        messageId: "m1",
        state: "delivered",
        deliveredVia: "pending_quiet",
        recordedAt: "2026-08-27T00:00:01.000Z",
      },
    });

    // A fresh process must see the same thing: the projection is derived, not
    // a second place where the truth lives.
    const reloaded = await TeamJournal.open(root, "leader-1");
    expect(reloaded.projection().messages.get("m1")?.state).toBe("delivered");
    expect(reloaded.entries().map((e) => e.seq)).toEqual([1, 2]);
  });

  it("serialises concurrent appends without dropping or reordering", async () => {
    const journal = await TeamJournal.open(dir(), "leader-1");
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => journal.append(queued("m" + i))),
    );
    expect(journal.projection().messages.size).toBe(40);
    expect(journal.entries().map((e) => e.seq)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
  });

  // Delivery state is what the coordination layer reads to decide whether a
  // message still needs sending, so a queued-but-unreceipted message has to
  // survive a restart as still-pending rather than quietly resolving.
  it("reports a queued message with no receipt as pending after reload", async () => {
    const root = dir();
    const journal = await TeamJournal.open(root, "leader-1");
    await journal.append(queued("m1"));

    const reloaded = await TeamJournal.open(root, "leader-1");
    expect(reloaded.projection().messages.get("m1")?.state).toBe("queued");
    expect(reloaded.pendingMessages()).toHaveLength(1);
  });

  it("keeps each leader run's journal separate", async () => {
    const root = dir();
    const a = await TeamJournal.open(root, "leader-a");
    const b = await TeamJournal.open(root, "leader-b");
    await a.append(queued("m1"));
    expect(b.entries()).toHaveLength(0);
  });

  it("replays a legacy top-level team journal when no migrated journal exists", async () => {
    const root = dir();
    const legacyDir = join(root, "team", "leader-1");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "journal.jsonl"),
      JSON.stringify({ seq: 1, at: "2026-08-27T00:00:00.000Z", event: queued("m1") }) + "\n",
      "utf8",
    );

    const journal = await TeamJournal.open(root, "leader-1");

    expect(journal.entries().map((entry) => entry.seq)).toEqual([1]);
    expect(journal.projection().messages.get("m1")?.state).toBe("queued");
  });
});
