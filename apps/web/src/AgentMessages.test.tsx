// @vitest-environment jsdom

/**
 * Agent-to-agent traffic is real and was unreadable.
 *
 * The journal behind `/api/runs/:id/coordination` records every note one worker
 * sent another, including the ones nobody read. The card is the session's
 * CHATROOM: all of it, in the order it was said, whoever is being inspected.
 * Filtering it down to the agent under the cursor hid exactly the traffic a
 * chatroom exists to show — two workers talking to each other. It also must
 * not shout -- the rail is for watching a mission, not for reading its mail --
 * so what is asserted here is both that the conversation is correct and that
 * it stays folded away until someone asks for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CoordinationMessage, CoordinationView } from "./types";

const coordination = vi.fn();

vi.mock("./api", () => ({
  api: { coordination: (id: string) => coordination(id) },
}));

const { AgentMessages, selectChatroom } = await import("./AgentMessages");

function message(over: Partial<CoordinationMessage>): CoordinationMessage {
  return {
    id: "m",
    from: "leader-run",
    to: "worker-a",
    delivery: "talk",
    state: "delivered",
    content: "check the parser",
    ...over,
  };
}

const view: CoordinationView = {
  messages: [
    message({ id: "m1", from: "leader-run", to: "worker-a" }),
    message({ id: "m2", from: "worker-a", to: "worker-b" }),
    message({ id: "m3", from: "worker-b", to: "leader-run" }),
  ],
  members: [
    { workerRunId: "worker-a", displayName: "Byte", runtimeState: "running" },
    { workerRunId: "worker-b", displayName: "Sable", runtimeState: "running" },
  ],
};

afterEach(() => {
  cleanup();
  coordination.mockReset();
});

describe("selectChatroom", () => {
  it("shows every agent's traffic, including notes between two workers", () => {
    const rows = selectChatroom(view, "leader-run");
    expect(rows.map((row) => row.message.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps the journal's own order, because a chatroom reads in time", () => {
    const mixed: CoordinationView = {
      messages: [
        message({ id: "delivered", from: "worker-a", state: "delivered" }),
        message({ id: "lost", from: "worker-a", state: "undeliverable" }),
        message({ id: "queued", from: "worker-a", state: "queued" }),
      ],
      members: view.members,
    };
    expect(selectChatroom(mixed, "leader-run").map((row) => row.message.id)).toEqual([
      "delivered",
      "lost",
      "queued",
    ]);
  });

  it("names both ends from the team roster", () => {
    const rows = selectChatroom(view, "leader-run");
    expect(rows[1]?.from).toBe("Byte");
    expect(rows[1]?.to).toBe("Sable");
  });

  it("calls the leader's own run the leader rather than an unknown id", () => {
    expect(selectChatroom(view, "leader-run")[0]?.from).toBe("Leader");
  });

  it("falls back to a short id for a run the roster does not know", () => {
    const orphan: CoordinationView = {
      messages: [message({ id: "m1", from: "worker-a", to: "abcdef0123456789" })],
      members: [{ workerRunId: "worker-a", displayName: "Byte", runtimeState: "running" }],
    };
    expect(selectChatroom(orphan, "leader-run")[0]?.to).toBe("abcdef01");
  });

  /**
   * A run from before coordination existed answers without a projection, and
   * the shape that comes back is not guaranteed to carry either array. Reading
   * a mission's mail must not be able to blank the whole page.
   */
  it("survives a coordination payload that carries neither array", () => {
    expect(selectChatroom({} as CoordinationView, "leader-run")).toEqual([]);
  });

  it("survives a payload with messages but no roster", () => {
    const rosterless = {
      messages: [message({ id: "m1", from: "worker-a", to: "leader-run" })],
    };
    const rows = selectChatroom(rosterless as CoordinationView, "leader-run");
    expect(rows[0]?.to).toBe("Leader");
  });
});

describe("AgentMessages", () => {
  beforeEach(() => {
    coordination.mockResolvedValue(view);
  });

  it("stays folded, and says only how many there are", async () => {
    await act(async () => {
      render(<AgentMessages leaderRunId="leader-run" running={false} />);
    });
    const summary = screen.getByText("Chatroom").closest("summary");
    expect(summary?.parentElement instanceof HTMLDetailsElement).toBe(true);
    // `details` keeps its content in the DOM while closed, so what is asserted
    // is the fold itself and that the visible line carries a count and no prose.
    expect((summary?.parentElement as HTMLDetailsElement).open).toBe(false);
    expect(summary?.textContent).toBe("Chatroom3");
  });

  it("shows who said what to whom once it is opened", async () => {
    await act(async () => {
      render(<AgentMessages leaderRunId="leader-run" running={false} />);
    });
    await userEvent.click(screen.getByText("Chatroom"));
    expect(screen.getAllByText("check the parser").length).toBe(3);
    expect(screen.getByText("Leader → Byte")).toBeTruthy();
    // The worker-to-worker leg is the whole point of a chatroom.
    expect(screen.getByText("Byte → Sable")).toBeTruthy();
  });

  /**
   * A message nobody received is the failure this channel makes easiest to
   * miss. The timeline stays chronological, so the fold line is what warns:
   * it counts the lost messages before anyone opens the card.
   */
  it("counts undelivered messages on the fold line", async () => {
    coordination.mockResolvedValue({
      messages: [
        message({ id: "m1", state: "delivered" }),
        message({ id: "m2", state: "undeliverable" }),
        message({ id: "m3", state: "undeliverable" }),
      ],
      members: view.members,
    });
    await act(async () => {
      render(<AgentMessages leaderRunId="leader-run" running={false} />);
    });
    expect(screen.getByText("2 lost")).toBeTruthy();
  });

  it("renders nothing at all when nobody spoke", async () => {
    coordination.mockResolvedValue({ messages: [], members: view.members });
    const { container } = render(
      <AgentMessages leaderRunId="leader-run" running={false} />,
    );
    await act(async () => undefined);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the run has no coordination journal", async () => {
    coordination.mockRejectedValue(new Error("no journal"));
    const { container } = render(
      <AgentMessages leaderRunId="leader-run" running={false} />,
    );
    await act(async () => undefined);
    expect(container.firstChild).toBeNull();
  });

  it("asks once for a mission that has finished", async () => {
    await act(async () => {
      render(<AgentMessages leaderRunId="leader-run" running={false} />);
    });
    expect(coordination).toHaveBeenCalledTimes(1);
  });
});
