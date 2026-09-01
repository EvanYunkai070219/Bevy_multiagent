// @vitest-environment jsdom

/**
 * One mission is polled by one loop.
 *
 * Navigating in and out of a leader while it runs re-runs the polling effect.
 * If the previous run's loop survives that, two loops write `runs` and `byRun`
 * for two different missions into the same state, and the transcript alternates
 * between them roughly once a second -- groups and prose blocks torn down and
 * rebuilt on every tick.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const children = vi.fn();
const runEvents = vi.fn();

vi.mock("./api", () => ({
  api: {
    children: (id: string) => children(id),
    runEvents: (id: string, after: number) => runEvents(id, after),
  },
}));

const { useSessionEvents } = await import("./useSessionEvents");

function props(leaderRunId: string | null, leaderRunning = true) {
  return {
    leaderRunId,
    leaderAgentId: "leader-agent",
    leaderEvents: [],
    agents: [],
    leaderRunning,
  };
}

/** Let pending promises settle without handing control to a real clock. */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  children.mockReset();
  runEvents.mockReset();
  runEvents.mockResolvedValue({ events: [], lastSeq: 0, complete: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("polling a leader's children", () => {
  it("stops polling the run it was told to leave", async () => {
    // The first loop is suspended mid-request when the switch happens, so there
    // is no pending timer for the cleanup to clear -- the only thing that can
    // stop it is its own cancellation.
    let releaseFirst: ((value: { runs: [] }) => void) | undefined;
    children.mockImplementation((id: string) =>
      id === "run-A"
        ? new Promise((resolve) => {
            releaseFirst = resolve;
          })
        : Promise.resolve({ runs: [] }),
    );

    const { rerender } = renderHook((given) => useSessionEvents(given), {
      initialProps: props("run-A"),
    });
    expect(children).toHaveBeenCalledWith("run-A");

    rerender(props("run-B"));
    releaseFirst?.({ runs: [] });
    await flush(50);

    children.mockClear();
    await flush(5000);

    const polled = children.mock.calls.map(([id]) => id as string);
    expect(polled).not.toContain("run-A");
    expect(polled).toContain("run-B");
  });

  it("stops polling entirely once the leader run is gone", async () => {
    let releaseFirst: ((value: { runs: [] }) => void) | undefined;
    children.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );

    const { rerender } = renderHook((given) => useSessionEvents(given), {
      initialProps: props("run-A"),
    });
    expect(children).toHaveBeenCalledWith("run-A");

    rerender(props(null));
    releaseFirst?.({ runs: [] });
    await flush(50);

    children.mockClear();
    await flush(5000);
    expect(children).not.toHaveBeenCalled();
  });

  it("does not leak a loop per navigation", async () => {
    // Six trips in and out of a live leader used to leave six loops running,
    // every one of them still writing into the state the seventh owns.
    const pending: ((value: { runs: [] }) => void)[] = [];
    children.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );

    const { rerender } = renderHook((given) => useSessionEvents(given), {
      initialProps: props("run-1"),
    });

    for (let step = 2; step <= 7; step += 1) {
      rerender(props("run-" + step));
      for (const resolve of pending.splice(0)) resolve({ runs: [] });
      await flush(50);
    }

    children.mockClear();
    for (const resolve of pending.splice(0)) resolve({ runs: [] });
    await flush(2000);

    // One live mission, one request per poll period.
    expect(new Set(children.mock.calls.map(([id]) => id as string))).toEqual(
      new Set(["run-7"]),
    );
  });
});

/**
 * A settled mission cannot produce new events, so a request that keeps failing
 * against one has nothing to wait for.
 *
 * The error path rescheduled unconditionally, and one child run the API will
 * never serve was enough to keep a finished mission polling every 1.5 seconds
 * for as long as the tab stayed open. Real case: worker runs recorded before
 * run ids were UUIDs, which `/api/runs/:id/events` now correctly rejects as
 * malformed -- a permanent 400, retried forever.
 */
describe("retrying after a failed request", () => {
  it("gives up on a finished mission instead of retrying forever", async () => {
    children.mockRejectedValue(new Error("Not a valid run id"));

    renderHook((given) => useSessionEvents(given), {
      initialProps: props("run-A", false),
    });
    await flush(60_000);

    // A transient failure still gets a few chances; a permanent one stops.
    expect(children.mock.calls.length).toBeGreaterThan(1);
    expect(children.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("keeps retrying while the mission is still running", async () => {
    children.mockRejectedValue(new Error("network blip"));

    renderHook((given) => useSessionEvents(given), {
      initialProps: props("run-A", true),
    });
    await flush(60_000);

    expect(children.mock.calls.length).toBeGreaterThan(10);
  });

  /**
   * The budget is spent, not consumed permanently: a mission whose children are
   * still open goes on polling through intermittent failures. Without the reset
   * three scattered blips over a long run would silently end the loop.
   */
  it("forgets earlier failures once a request succeeds", async () => {
    let attempt = 0;
    children.mockImplementation(() => {
      attempt += 1;
      return attempt % 2 === 0
        ? Promise.reject(new Error("blip"))
        : Promise.resolve({
            runs: [{ id: "worker-1", agentId: "worker-agent", status: "running" }],
          });
    });

    renderHook((given) => useSessionEvents(given), {
      initialProps: props("run-A", false),
    });
    await flush(60_000);

    expect(children.mock.calls.length).toBeGreaterThan(20);
  });
});
