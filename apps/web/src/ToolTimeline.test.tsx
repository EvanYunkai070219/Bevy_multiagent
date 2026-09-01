// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ToolTimeline, stepLabel } from "./ToolTimeline";
import type { Message, RunEvent } from "./types";

function event(
  partial: Partial<RunEvent> & Pick<RunEvent, "seq" | "spanId" | "kind" | "name">,
): RunEvent {
  return {
    runId: "run-1",
    agentId: "agent-1",
    parentSpanId: "run",
    status: "ok",
    startedAt: "2026-08-29T00:00:00.000Z",
    endedAt: "2026-08-29T00:00:00.000Z",
    durationMs: 0,
    input: {},
    output: {},
    error: null,
    attributes: {},
    usage: null,
    ...partial,
  } as RunEvent;
}

/** Every step line, in the order the transcript renders them. */
function steps(): string[] {
  return [...document.querySelectorAll(".step-text")].map((node) => node.textContent ?? "");
}

afterEach(cleanup);

describe("stepLabel", () => {
  it("says what happened rather than naming an event type", () => {
    expect(
      stepLabel(
        event({
          seq: 1,
          spanId: "a",
          kind: "command",
          name: "command",
          input: { command: "./build.sh" },
        }),
      ),
    ).toBe("Ran ./build.sh");
  });

  it("uses the present tense for a step still open", () => {
    expect(
      stepLabel(
        event({
          seq: 1,
          spanId: "a",
          kind: "command",
          name: "command",
          status: "in_progress",
          input: { command: "./build.sh" },
        }),
      ),
    ).toBe("Running ./build.sh");
    expect(
      stepLabel(
        event({
          seq: 2,
          spanId: "b",
          kind: "api_call",
          name: "planner",
          status: "in_progress",
        }),
      ),
    ).toBe("Waiting on the model");
  });

  it("names the tool a call went to", () => {
    expect(
      stepLabel(
        event({ seq: 1, spanId: "a", kind: "mcp_tool", name: "launchpad.whiteboard_read" }),
      ),
    ).toBe("Called launchpad.whiteboard_read");
  });
});

describe("ToolTimeline ordering", () => {
  /**
   * A span is emitted twice. Its completion carries its own `startedAt`, equal
   * to the end time, so the row kept for display cannot be trusted to say when
   * the step began — only the span's first `seq` can.
   */
  const events: RunEvent[] = [
    event({
      seq: 1,
      spanId: "cmd-a",
      kind: "command",
      name: "command",
      status: "in_progress",
      input: { command: "first" },
    }),
    event({
      seq: 2,
      spanId: "api-1",
      kind: "api_call",
      name: "planner",
      startedAt: "2026-08-29T00:00:01.000Z",
    }),
    event({
      seq: 4,
      spanId: "cmd-b",
      kind: "command",
      name: "command",
      input: { command: "second" },
      startedAt: "2026-08-29T00:00:05.000Z",
    }),
    // The long-running first command settles last, stamped with its end time.
    event({
      seq: 5,
      spanId: "cmd-a",
      kind: "command",
      name: "command",
      input: { command: "first" },
      startedAt: "2026-08-29T00:00:09.000Z",
    }),
  ];

  it("keeps a step where it began, not where it finished", () => {
    render(<ToolTimeline events={events} />);
    expect(steps()).toEqual(["Ran first", "Ran second"]);
  });

  it("interleaves debug model calls instead of appending them as a block", async () => {
    const user = userEvent.setup();
    render(<ToolTimeline events={events} />);

    await user.click(screen.getByRole("button", { name: /show 1 model call/i }));
    expect(steps()).toEqual(["Ran first", "Model call", "Ran second"]);
  });
});

describe("ToolTimeline transcript shape", () => {
  it("folds the work behind a summary and leaves what was said in the open", () => {
    render(
      <ToolTimeline
        events={[
          event({
            seq: 1,
            spanId: "r-1",
            kind: "reasoning",
            name: "reasoning",
            output: { text: "hm" },
          }),
          event({
            seq: 2,
            spanId: "c-1",
            kind: "command",
            name: "command",
            input: { command: "ls" },
          }),
          event({
            seq: 3,
            spanId: "m-1",
            kind: "message",
            name: "message",
            output: { text: "Here is the plan." },
          }),
        ]}
      />,
    );

    // Settled work that produced a message is folded; the message is not.
    expect(steps()).toEqual([]);
    expect(screen.getByText("Here is the plan.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /1 thought · 1 tool call/ })).toBeTruthy();
  });

  it("opens the trailing run of work, which is what is happening now", () => {
    render(
      <ToolTimeline
        events={[
          event({
            seq: 1,
            spanId: "m-1",
            kind: "message",
            name: "message",
            output: { text: "Working on it." },
          }),
          event({
            seq: 2,
            spanId: "c-1",
            kind: "command",
            name: "command",
            input: { command: "ls" },
          }),
        ]}
      />,
    );
    expect(steps()).toEqual(["Ran ls"]);
  });

  it("marks a group that contains a failed step", () => {
    render(
      <ToolTimeline
        events={[
          event({
            seq: 1,
            spanId: "c-1",
            kind: "command",
            name: "command",
            status: "error",
            input: { command: "boom" },
          }),
          event({
            seq: 2,
            spanId: "m-1",
            kind: "message",
            name: "message",
            output: { text: "That failed." },
          }),
        ]}
      />,
    );
    expect(screen.getByText("partly failed")).toBeTruthy();
  });
});

describe("ToolTimeline folding", () => {
  const long = Array.from({ length: 40 }, (_, index) => "line " + (index + 1)).join("\n");

  function commandWithOutput(): RunEvent[] {
    return [
      event({
        seq: 1,
        spanId: "cmd-a",
        kind: "command",
        name: "command",
        input: { command: "./build.sh" },
        output: { text: long },
      }),
    ];
  }

  it("folds a long output and says how much is hidden", async () => {
    const user = userEvent.setup();
    render(<ToolTimeline events={commandWithOutput()} />);
    await user.click(screen.getByRole("button", { name: /ran \.\/build\.sh/i }));

    expect(document.body.textContent).toContain("line 12");
    expect(document.body.textContent).not.toContain("line 13");
    expect(screen.getByRole("button", { name: "Show 28 more lines" })).toBeTruthy();
  });

  it("reveals the remainder on request and folds it back", async () => {
    const user = userEvent.setup();
    render(<ToolTimeline events={commandWithOutput()} />);
    await user.click(screen.getByRole("button", { name: /ran \.\/build\.sh/i }));

    await user.click(screen.getByRole("button", { name: "Show 28 more lines" }));
    expect(document.body.textContent).toContain("line 40");

    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(document.body.textContent).not.toContain("line 40");
  });

  it("leaves a short block alone", async () => {
    const user = userEvent.setup();
    render(
      <ToolTimeline
        events={[
          event({
            seq: 1,
            spanId: "cmd-a",
            kind: "command",
            name: "command",
            input: { command: "ls" },
            output: { text: "a\nb\nc" },
          }),
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /ran ls/i }));

    expect(screen.queryByRole("button", { name: /show .* more line/i })).toBeNull();
  });
});

describe("ToolTimeline steering", () => {
  function steer(createdAt: string, content: string): Message {
    return {
      id: "msg-" + createdAt,
      agentId: "agent-1",
      runId: "run-1",
      role: "user",
      content,
      createdAt,
    };
  }

  const work: RunEvent[] = [
    event({
      seq: 1,
      spanId: "cmd-a",
      kind: "command",
      name: "command",
      input: { command: "first" },
      startedAt: "2026-08-29T00:00:00.000Z",
    }),
    event({
      seq: 2,
      spanId: "cmd-b",
      kind: "command",
      name: "command",
      input: { command: "second" },
      startedAt: "2026-08-29T00:00:10.000Z",
    }),
  ];

  /** Spine entries, in render order. */
  function spine(): string[] {
    return [...document.querySelectorAll(".stream > *")].map((node) =>
      node.classList.contains("stream-steer")
        ? "steer:" + (node.textContent ?? "").replace("you said", "")
        : "work",
    );
  }

  it("keeps what the operator said on the spine, between the work it interrupted", () => {
    render(
      <ToolTimeline
        events={work}
        steers={[steer("2026-08-29T00:00:05.000Z", "use the other branch")]}
      />,
    );
    expect(spine()).toEqual(["work", "steer:use the other branch", "work"]);
  });

  it("shows a steer even though the work around it is folded", () => {
    render(
      <ToolTimeline
        events={[
          ...work,
          event({
            seq: 3,
            spanId: "m-1",
            kind: "message",
            name: "message",
            output: { text: "done" },
            startedAt: "2026-08-29T00:00:20.000Z",
          }),
        ]}
        steers={[steer("2026-08-29T00:00:05.000Z", "use the other branch")]}
      />,
    );
    // Every group here is settled and folded, so no step line is rendered.
    expect(steps()).toEqual([]);
    expect(screen.getByText(/use the other branch/)).toBeTruthy();
  });

  it("keeps a message sent after the last step at the end", () => {
    render(
      <ToolTimeline events={work} steers={[steer("2026-08-29T00:00:20.000Z", "stop there")]} />,
    );
    expect(spine()).toEqual(["work", "steer:stop there"]);
  });
});

describe("ToolTimeline verdict", () => {
  const run: RunEvent[] = [
    event({
      seq: 1,
      spanId: "c-1",
      kind: "command",
      name: "command",
      input: { command: "ls" },
    }),
    event({
      seq: 2,
      spanId: "m-1",
      kind: "message",
      name: "message",
      output: { text: "Narration nobody needs afterwards." },
    }),
    event({
      seq: 3,
      spanId: "c-2",
      kind: "command",
      name: "command",
      input: { command: "./build.sh" },
    }),
  ];

  it("folds a finished run's whole process into one line", () => {
    render(<ToolTimeline events={run} runStatus="completed" />);
    expect(screen.getByRole("button", { name: /completed/i })).toBeTruthy();
    expect(document.querySelector(".stream-verdict-count")?.textContent).toBe("2 steps");
    // Nothing from the process survives the fold — not a step, not narration.
    expect(steps()).toEqual([]);
    expect(screen.queryByText(/Narration nobody needs/)).toBeNull();
  });

  it("opens the whole process on request and folds it back", async () => {
    const user = userEvent.setup();
    render(<ToolTimeline events={run} runStatus="completed" />);

    await user.click(screen.getByRole("button", { name: /completed/i }));
    expect(screen.getByText(/Narration nobody needs/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /completed/i }));
    expect(steps()).toEqual([]);
  });

  it("says a run did not finish, and why, without being opened", () => {
    render(
      <ToolTimeline
        events={run}
        runStatus="failed"
        failureReason="Worker timed out after 900000 ms"
      />,
    );
    expect(screen.getByText("Didn't finish")).toBeTruthy();
    expect(screen.getByText("Worker timed out after 900000 ms")).toBeTruthy();
  });

  it("counts the failed steps on the line rather than hiding them in the fold", () => {
    render(
      <ToolTimeline
        events={[
          event({
            seq: 1,
            spanId: "c-1",
            kind: "command",
            name: "command",
            status: "error",
            input: { command: "boom" },
          }),
        ]}
        runStatus="completed"
      />,
    );
    expect(document.querySelector(".stream-verdict-count")?.textContent).toBe(
      "1 step · 1 failed",
    );
  });

  it("leaves a running transcript open, because that is what is happening", async () => {
    render(<ToolTimeline events={run} runStatus="running" />);
    // Not folded to a verdict: the narration and the group line are on screen.
    expect(screen.getByText(/Narration nobody needs/)).toBeTruthy();
    // Live groups start folded; the steps are one click away, not gone.
    const summaries = document.querySelectorAll(".stream-summary");
    await userEvent.click(summaries[summaries.length - 1] as HTMLElement);
    expect(steps()).toEqual(["Ran ./build.sh"]);
  });
});


describe("attribution", () => {
  const byte = {
    agentId: "a-byte",
    runId: "run-byte",
    name: "Byte",
    specialty: "Coding worker",
    creature: {
      id: "otter",
      displayName: "Otter",
      sprite: "/creatures/otter.png",
      affinity: "code" as const,
    },
    isLeader: false,
  };
  const scout = {
    ...byte,
    agentId: "a-scout",
    runId: "run-scout",
    name: "Scout",
    specialty: "Research worker",
    creature: { ...byte.creature, id: "rabbit", displayName: "Rabbit" },
  };
  const actorOf = (event: RunEvent) => (event.runId === "run-scout" ? scout : byte);

  it("starts a new group when the actor changes", () => {
    render(
      <ToolTimeline
        events={[
          event({ seq: 1, spanId: "a", kind: "command", name: "command", runId: "run-byte", input: { command: "one" } }),
          event({ seq: 2, spanId: "b", kind: "command", name: "command", runId: "run-scout", input: { command: "two" } }),
          event({ seq: 3, spanId: "c", kind: "command", name: "command", runId: "run-byte", input: { command: "three" } }),
        ]}
        actorOf={actorOf}
      />,
    );
    const names = [...document.querySelectorAll(".stream-summary-actor")].map(
      (node) => node.textContent,
    );
    expect(names).toEqual(["Byte", "Scout", "Byte"]);
  });

  /**
   * A running step used to open its full argument card on its own. In a live
   * mission that meant every in-flight tool call was a wall of TOOL/ARGUMENTS
   * boxes. Running is the step line's own news — the glyph and present tense
   * already say it — so the card waits to be asked for, like any other step.
   */
  it("keeps a running step's card folded until asked", async () => {
    render(
      <ToolTimeline
        events={[
          event({
            seq: 1,
            spanId: "a",
            kind: "command",
            name: "command",
            status: "in_progress",
            runId: "run-byte",
            input: { command: "./install.sh" },
          }),
        ]}
        actorOf={actorOf}
      />,
    );
    // The step line says it is running, but the detail card stays shut…
    expect(document.querySelector(".step-detail")).toBeNull();
    // …until the reader asks.
    await userEvent.click(document.querySelector(".step-line") as HTMLElement);
    expect(document.querySelector(".step-detail")).not.toBeNull();
  });

  it("opens a failed step, because a folded failure is a hidden one", () => {
    render(
      <ToolTimeline
        events={[
          event({ seq: 1, spanId: "a", kind: "command", name: "command", runId: "run-byte", input: { command: "one" } }),
          event({ seq: 2, spanId: "b", kind: "message", name: "message", runId: "run-byte", output: { text: "done" } }),
          event({
            seq: 3,
            spanId: "c",
            kind: "command",
            name: "command",
            status: "error",
            runId: "run-byte",
            input: { command: "sudo apt-get install" },
            error: { message: "Permission denied" },
          }),
        ]}
        actorOf={actorOf}
      />,
    );
    expect(screen.getByText("Permission denied")).toBeDefined();
  });

  it("names the move on the step line", () => {
    render(
      <ToolTimeline
        events={[
          event({
            seq: 1,
            spanId: "a",
            kind: "command",
            name: "command",
            runId: "run-byte",
            input: { command: "cat /etc/os-release" },
          }),
        ]}
        actorOf={actorOf}
      />,
    );
    expect(screen.getByText("SHELL")).toBeDefined();
    expect(screen.getByText("cat /etc/os-release")).toBeDefined();
  });

  it("still folds a settled run to one verdict line", () => {
    render(
      <ToolTimeline
        events={[
          event({
            seq: 1,
            spanId: "a",
            kind: "command",
            name: "command",
            runId: "run-byte",
            status: "error",
            error: { message: "boom" },
          }),
        ]}
        actorOf={actorOf}
        runStatus="completed"
      />,
    );
    expect(screen.getByText("Completed")).toBeDefined();
    expect(screen.queryByText("boom")).toBeNull();
  });

  /**
   * Runs are polled independently, so a worker's events can arrive AFTER the
   * transcript already rendered later work, and the session re-sort slots them
   * in front. Groups keyed by their position inherited each other's fold state
   * when that happened: the reader folded the live group, an earlier group
   * appeared above it, and the fold jumped onto the newcomer while the group
   * the reader actually folded sprang open again.
   */
  it("keeps a pin on its group when an earlier group is inserted above it", async () => {
    const live = event({
      seq: 5,
      spanId: "b1",
      kind: "command",
      name: "command",
      status: "in_progress",
      runId: "run-byte",
      input: { command: "./watch.sh" },
    });
    const { rerender } = render(
      <ToolTimeline events={[live]} actorOf={actorOf} runStatus="running" />,
    );
    // Live groups start folded; the reader opens this one on purpose.
    await userEvent.click(document.querySelector(".stream-summary") as HTMLElement);
    const early = event({
      seq: 2,
      spanId: "s1",
      kind: "command",
      name: "command",
      status: "error",
      runId: "run-scout",
      input: { command: "./probe.sh" },
      error: { message: "no such file" },
    });
    rerender(
      <ToolTimeline events={[early, live]} actorOf={actorOf} runStatus="running" />,
    );
    const expanded = [...document.querySelectorAll(".stream-summary")].map((node) =>
      node.getAttribute("aria-expanded"),
    );
    // The newcomer lands folded; Byte's deliberate open survives the insertion
    // instead of jumping onto whichever group now sits at its old index.
    expect(expanded).toEqual(["false", "true"]);
  });
});

/**
 * A running run's whole process — every group and everything said between
 * them — streams into ONE bounded box that follows its own tail: new tool
 * calls slide into view at the bottom, and the box's header folds the whole
 * long stream away from wherever the reader is. A reader who scrolled up
 * inside the box is reading something — new arrivals must not yank them back
 * down. jsdom does no layout, so the box's geometry is stubbed onto the
 * element and the assertion is about where `scrollTop` ends up.
 */
describe("the live process box", () => {
  const byte = {
    agentId: "a-byte",
    runId: "run-byte",
    name: "Byte",
    specialty: "Coding worker",
    creature: {
      id: "otter",
      displayName: "Otter",
      sprite: "/creatures/otter.png",
      affinity: "code" as const,
    },
    isLeader: false,
  };
  const actorOf = () => byte;

  function liveStep(seq: number, spanId: string, command: string): RunEvent {
    return event({
      seq,
      spanId,
      kind: "command",
      name: "command",
      status: "in_progress",
      runId: "run-byte",
      input: { command },
    });
  }

  function stubGeometry(list: HTMLElement): void {
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(list, "scrollTop", { value: 0, writable: true, configurable: true });
  }

  it("slides down to a new step when the reader is at the tail", () => {
    const { rerender } = render(
      <ToolTimeline events={[liveStep(1, "a", "one")]} actorOf={actorOf} runStatus="running" />,
    );
    const box = document.querySelector(".stream-live-box") as HTMLElement;
    stubGeometry(box);
    box.scrollTop = 700; // 700 + 300 reaches the 1000px tail
    fireEvent.scroll(box);
    rerender(
      <ToolTimeline
        events={[liveStep(1, "a", "one"), liveStep(2, "b", "two")]}
        actorOf={actorOf}
        runStatus="running"
      />,
    );
    expect(box.scrollTop).toBe(1000);
  });

  it("stays put when the reader has scrolled up to read", () => {
    const { rerender } = render(
      <ToolTimeline events={[liveStep(1, "a", "one")]} actorOf={actorOf} runStatus="running" />,
    );
    const box = document.querySelector(".stream-live-box") as HTMLElement;
    stubGeometry(box);
    box.scrollTop = 100; // well above the tail
    fireEvent.scroll(box);
    rerender(
      <ToolTimeline
        events={[liveStep(1, "a", "one"), liveStep(2, "b", "two")]}
        actorOf={actorOf}
        runStatus="running"
      />,
    );
    expect(box.scrollTop).toBe(100);
  });

  /**
   * The whole point of the box: the "一大长串" folds from one always-reachable
   * line, while the run is still going — not only after it settles.
   */
  it("folds the whole running stream from its header line", async () => {
    render(
      <ToolTimeline events={[liveStep(1, "a", "one")]} actorOf={actorOf} runStatus="running" />,
    );
    expect(document.querySelector(".stream-live-box")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Working/ }));
    expect(document.querySelector(".stream-live-box")).toBeNull();
    // The steps are away, not lost: the same line brings them back.
    await userEvent.click(screen.getByRole("button", { name: /Working/ }));
    expect(document.querySelector(".stream-live-box")).not.toBeNull();
  });

  /**
   * While the run is live the transcript is narration plus one folded line per
   * group — a running mission kept expanding itself into a wall: the trailing
   * group auto-opened, and every in-flight tool call auto-opened its full
   * argument card on top of that.
   */
  it("keeps every group folded while the run is live", () => {
    render(
      <ToolTimeline
        events={[
          event({
            seq: 1,
            spanId: "a",
            kind: "command",
            name: "command",
            runId: "run-byte",
            input: { command: "one" },
          }),
          liveStep(2, "b", "two"),
        ]}
        actorOf={actorOf}
        runStatus="running"
      />,
    );
    const expanded = [...document.querySelectorAll(".stream-summary")].map((node) =>
      node.getAttribute("aria-expanded"),
    );
    expect(expanded).toEqual(["false"]);
  });

  it("comes back to the tail when the box is folded away and reopened", async () => {
    const { rerender } = render(
      <ToolTimeline events={[liveStep(1, "a", "one")]} actorOf={actorOf} runStatus="running" />,
    );
    const first = document.querySelector(".stream-live-box") as HTMLElement;
    stubGeometry(first);
    first.scrollTop = 100;
    fireEvent.scroll(first); // the reader wandered up…
    await userEvent.click(screen.getByRole("button", { name: /Working/ })); // …put it away…
    await userEvent.click(screen.getByRole("button", { name: /Working/ })); // …and came back.
    const second = document.querySelector(".stream-live-box") as HTMLElement;
    stubGeometry(second);
    rerender(
      <ToolTimeline
        events={[liveStep(1, "a", "one"), liveStep(2, "b", "two")]}
        actorOf={actorOf}
        runStatus="running"
      />,
    );
    // Reopening is asking for "now", so the box follows its tail again.
    expect(second.scrollTop).toBe(1000);
  });

  it("does not box a settled run's expanded steps", async () => {
    render(
      <ToolTimeline
        events={[
          event({
            seq: 1,
            spanId: "a",
            kind: "command",
            name: "command",
            runId: "run-byte",
            input: { command: "one" },
          }),
        ]}
        actorOf={actorOf}
        runStatus="completed"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Completed/ }));
    expect(document.querySelector(".stream-live-box")).toBeNull();
  });
});

describe("whose voice is the spine", () => {
  const leader = {
    agentId: "a-ada",
    runId: "run-leader",
    name: "Ada",
    specialty: null,
    creature: {
      id: "fox",
      displayName: "Fox",
      sprite: "/creatures/fox.png",
      affinity: "review" as const,
    },
    isLeader: true,
  };
  const worker = {
    ...leader,
    agentId: "a-byte",
    runId: "run-byte",
    name: "Byte",
    specialty: "Coding worker",
    creature: { ...leader.creature, id: "otter", displayName: "Otter" },
    isLeader: false,
  };
  const actorOf = (event: RunEvent) => (event.runId === "run-byte" ? worker : leader);

  it("folds a worker's report into its own group instead of the spine", () => {
    render(
      <ToolTimeline
        events={[
          event({
            seq: 1,
            spanId: "a",
            kind: "command",
            name: "command",
            runId: "run-byte",
            input: { command: "wc -l" },
          }),
          event({
            seq: 2,
            spanId: "b",
            kind: "message",
            name: "message",
            runId: "run-byte",
            output: { text: "Appended a new line to countdown.txt" },
          }),
          event({
            seq: 3,
            spanId: "c",
            kind: "message",
            name: "message",
            runId: "run-leader",
            output: { text: "All ten lines are in order." },
          }),
        ]}
        actorOf={actorOf}
      />,
    );
    // The leader's answer stands on the spine.
    expect(document.querySelector(".stream-say")?.textContent).toContain(
      "All ten lines are in order.",
    );
    // The worker's report is not a second spine entry.
    expect(document.querySelectorAll(".stream-say")).toHaveLength(1);
  });

  it("counts a worker's report as a note, not as a tool call", () => {
    render(
      <ToolTimeline
        events={[
          event({
            seq: 1,
            spanId: "a",
            kind: "command",
            name: "command",
            runId: "run-byte",
            input: { command: "wc -l" },
          }),
          event({
            seq: 2,
            spanId: "b",
            kind: "message",
            name: "message",
            runId: "run-byte",
            output: { text: "done" },
          }),
        ]}
        actorOf={actorOf}
      />,
    );
    expect(document.querySelector(".stream-summary")?.textContent).toContain(
      "1 tool call · 1 note",
    );
  });
});

describe("a Run that stopped with a step still open", () => {
  const dangling = event({
    seq: 1,
    spanId: "a",
    kind: "command",
    name: "command",
    status: "in_progress",
    input: { command: "./slow.sh" },
  });

  it("keeps spinning while the Run is still going", () => {
    render(<ToolTimeline events={[dangling]} runStatus="running" />);
    expect(document.querySelector(".step-glyph--pending")).not.toBeNull();
    expect(document.querySelector(".step-glyph--stalled")).toBeNull();
  });

  it("stops claiming the step is running once the Run has settled", async () => {
    render(<ToolTimeline events={[dangling]} runStatus="cancelled" failureReason="Stopped" />);
    await userEvent.click(screen.getByRole("button", { name: /Stopped/ }));

    expect(document.querySelector(".step-glyph--pending")).toBeNull();
    expect(document.querySelector(".step-glyph--stalled")).not.toBeNull();
    expect(steps()).toEqual(["Ran ./slow.sh"]);
  });

  it("uses the past tense for a cut-off step", () => {
    expect(stepLabel(dangling)).toBe("Running ./slow.sh");
    expect(stepLabel(dangling, true)).toBe("Ran ./slow.sh");
  });
});

describe("a worker's caption in the transcript", () => {
  const actor = {
    agentId: "w1", runId: "run-1", name: "WorkerA", isLeader: false,
    creature: { id: "otter", displayName: "Otter", sprite: "/creatures/otter.png", affinity: "code" as const },
  };
  const step = event({ seq: 1, spanId: "a", kind: "command", name: "bash", input: { command: "sleep 70" } });

  it("does not caption a group with a machine identity", () => {
    render(
      <ToolTimeline
        events={[step]}
        actorOf={() => ({ ...actor, specialty: "sleep-worker-sleep-a-78ef6503" })}
      />,
    );
    expect(document.querySelector(".stream-summary-role")).toBeNull();
    expect(screen.getByText("WorkerA")).toBeTruthy();
  });

  it("still captions one with a real role", () => {
    render(<ToolTimeline events={[step]} actorOf={() => ({ ...actor, specialty: "reviewer" })} />);
    expect(document.querySelector(".stream-summary-role")?.textContent).toBe("reviewer");
  });
});

/**
 * "Show 18 model calls" has to show eighteen.
 *
 * Model calls are steps like any other, so they land in whichever group of work
 * they happened inside -- and only the last group opens by default. Revealing
 * them therefore revealed the one that happened to fall in the open group and
 * left the other seventeen inside folds, while the button went on claiming
 * eighteen. Asking to see them is explicit; the groups holding them stop
 * hiding them.
 */
describe("revealing model calls", () => {
  const spread: RunEvent[] = [
    event({ seq: 1, spanId: "c1", kind: "command", name: "command", input: { command: "one.sh" } }),
    event({ seq: 2, spanId: "m1", kind: "api_call", name: "model" }),
    event({ seq: 3, spanId: "s1", kind: "message", name: "message", output: { text: "thinking" } }),
    event({ seq: 4, spanId: "c2", kind: "command", name: "command", input: { command: "two.sh" } }),
    event({ seq: 5, spanId: "m2", kind: "api_call", name: "model" }),
    event({ seq: 6, spanId: "s2", kind: "message", name: "message", output: { text: "more" } }),
    event({ seq: 7, spanId: "c3", kind: "command", name: "command", input: { command: "three.sh" } }),
    event({ seq: 8, spanId: "m3", kind: "api_call", name: "model" }),
  ];

  const modelSteps = () => steps().filter((text) => /model/i.test(text));

  it("counts every model call in its offer", async () => {
    render(<ToolTimeline events={spread} />);
    expect(screen.getByRole("button", { name: /Show 3 model calls/ })).toBeTruthy();
  });

  it("shows all of them, not only the one in the open group", async () => {
    render(<ToolTimeline events={spread} />);
    await userEvent.click(screen.getByRole("button", { name: /Show 3 model calls/ }));
    expect(modelSteps()).toHaveLength(3);
  });

  it("hides them again", async () => {
    render(<ToolTimeline events={spread} />);
    await userEvent.click(screen.getByRole("button", { name: /Show 3 model calls/ }));
    await userEvent.click(screen.getByRole("button", { name: /Hide 3 model calls/ }));
    expect(modelSteps()).toHaveLength(0);
  });

  it("shows them on a run that has already finished", async () => {
    render(<ToolTimeline events={spread} runStatus="completed" />);
    await userEvent.click(screen.getByRole("button", { name: /step/ }));
    await userEvent.click(screen.getByRole("button", { name: /Show 3 model calls/ }));
    expect(modelSteps()).toHaveLength(3);
  });

  it("leaves a group the reader folded shut alone", async () => {
    render(<ToolTimeline events={spread} />);
    await userEvent.click(screen.getByRole("button", { name: /Show 3 model calls/ }));
    const groups = document.querySelectorAll(".stream-summary");
    await userEvent.click(groups[0] as HTMLElement);
    expect(modelSteps().length).toBeLessThan(3);
  });
});

/**
 * A run that is still going has to say so.
 *
 * Reported as "seems ended but still ongoing": once the last visible step
 * closed, the transcript looked exactly like a finished one -- the verdict line
 * only appears when the run settles, and a leader waiting on its workers shows
 * no open step at all. Nothing on screen distinguished "working" from "done".
 *
 * The line is driven by the run's own status, so it disappears on a real
 * terminal status and never on a guess about the events.
 */
describe("saying that a run is still going", () => {
  const done = [
    event({ seq: 1, spanId: "c1", kind: "command", name: "command", input: { command: "one.sh" } }),
  ];

  it("marks a running run as still working", () => {
    render(<ToolTimeline events={done} runStatus="running" />);
    expect(screen.getByText("Still working")).toBeTruthy();
  });

  it("marks a queued run too, because it has not finished either", () => {
    render(<ToolTimeline events={done} runStatus="queued" />);
    expect(screen.getByText("Still working")).toBeTruthy();
  });

  it("says nothing once the run completed", () => {
    render(<ToolTimeline events={done} runStatus="completed" />);
    expect(screen.queryByText("Still working")).toBeNull();
  });

  it("says nothing once the run failed", () => {
    render(<ToolTimeline events={done} runStatus="failed" />);
    expect(screen.queryByText("Still working")).toBeNull();
  });

  it("says nothing when there is no run to speak for", () => {
    render(<ToolTimeline events={done} />);
    expect(screen.queryByText("Still working")).toBeNull();
  });
});

/**
 * `seq` numbers restart at 1 in every run, so it cannot order two of them.
 *
 * Reported as "each agent's own message order is fine, but between agents it is
 * placed at random" -- which is exactly the shape of this bug. The caller
 * interleaves the mission's runs by time before handing them over, and this
 * component then re-sorted everything by `seq`, throwing that away: a worker's
 * `seq 1` landed beside the leader's `seq 1`, so the leader saying "no
 * teammates yet, I'll dispatch both workers" rendered AFTER the two workers had
 * already started working.
 *
 * The order events arrive in is the order they are shown in. Ordering across
 * runs belongs to whoever knows about all of them.
 */
describe("ordering work from several agents", () => {
  /** Given in true time order; the leader's seq numbers are not comparable to the worker's. */
  const interleaved: RunEvent[] = [
    event({ seq: 1, runId: "leader", spanId: "L1", kind: "command", name: "command", input: { command: "leader-first.sh" } }),
    event({ seq: 2, runId: "leader", spanId: "L2", kind: "command", name: "command", input: { command: "leader-second.sh" } }),
    event({ seq: 1, runId: "worker", spanId: "W1", kind: "command", name: "command", input: { command: "worker-first.sh" } }),
    event({ seq: 3, runId: "leader", spanId: "L3", kind: "command", name: "command", input: { command: "leader-third.sh" } }),
    event({ seq: 2, runId: "worker", spanId: "W2", kind: "command", name: "command", input: { command: "worker-second.sh" } }),
  ];

  it("keeps the order it was given, across runs", () => {
    render(<ToolTimeline events={interleaved} />);
    expect(steps()).toEqual([
      "Ran leader-first.sh",
      "Ran leader-second.sh",
      "Ran worker-first.sh",
      "Ran leader-third.sh",
      "Ran worker-second.sh",
    ]);
  });

  it("does not gather a run's work together just because its seq numbers are low", () => {
    render(<ToolTimeline events={interleaved} />);
    const order = steps();
    expect(order.indexOf("Ran worker-first.sh")).toBeGreaterThan(
      order.indexOf("Ran leader-second.sh"),
    );
    expect(order.indexOf("Ran leader-third.sh")).toBeGreaterThan(
      order.indexOf("Ran worker-first.sh"),
    );
  });

  /** A span still takes the place it opened in, not the place it finished. */
  it("keeps a long step where it started", () => {
    const longRunning: RunEvent[] = [
      event({ seq: 1, runId: "r", spanId: "slow", kind: "command", name: "command", status: "in_progress", input: { command: "slow.sh" } }),
      event({ seq: 2, runId: "r", spanId: "quick", kind: "command", name: "command", input: { command: "quick.sh" } }),
      event({ seq: 3, runId: "r", spanId: "slow", kind: "command", name: "command", input: { command: "slow.sh" } }),
    ];
    render(<ToolTimeline events={longRunning} />);
    expect(steps()).toEqual(["Ran slow.sh", "Ran quick.sh"]);
  });
});
