// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerInspector, roleLabel, roleTone } from "./WorkerInspector";
import type { Agent, RunEvent } from "./types";

const byte = {
  id: "a1",
  name: "Byte",
  description: "",
  instructions: "",
  status: "busy",
  role: "worker",
  parentAgentId: "leader",
  specialty: "Coding worker",
  projectId: null,
  unassignedPlacement: null,
  workspacePath: "/workspace",
  codexThreadId: null,
  lastError: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
} as Agent;

function event(
  partial: Partial<RunEvent> & Pick<RunEvent, "seq" | "spanId" | "kind" | "name">,
): RunEvent {
  return {
    runId: "r1",
    agentId: "a1",
    parentSpanId: "run",
    status: "ok",
    startedAt: "2026-08-30T00:00:00.000Z",
    endedAt: "2026-08-30T00:00:00.000Z",
    durationMs: 0,
    input: {},
    output: {},
    error: null,
    attributes: {},
    usage: null,
    ...partial,
  } as RunEvent;
}

afterEach(cleanup);

describe("WorkerInspector", () => {
  it("names the agent, and names its creature for anyone who cannot see it", () => {
    const { container } = render(
      <WorkerInspector agent={byte} events={[]} runStatus="running" />,
    );
    expect(screen.getByText("Byte")).toBeDefined();
    const creature = container.querySelector(".inspector-creature")?.textContent ?? "";
    expect(creature.length).toBeGreaterThan(0);
    // Whatever the roster assigns, the sprite and the text agree.
    expect(screen.getByAltText(creature)).toBeDefined();
  });

  it("reports counts, and calls errors errors", () => {
    render(
      <WorkerInspector
        agent={byte}
        events={[
          event({ seq: 1, spanId: "a", kind: "command", name: "command" }),
          event({
            seq: 2,
            spanId: "b",
            kind: "command",
            name: "command",
            status: "error",
            error: { message: "boom" },
          }),
          event({
            seq: 3,
            spanId: "c",
            kind: "file_change",
            name: "file_change",
            output: { changedFiles: ["a.ts"] },
          }),
        ]}
        runStatus="running"
      />,
    );
    expect(screen.getByText("Errors")).toBeDefined();
    expect(screen.queryByText(/recovered/i)).toBeNull();
  });

  it("shows the move it is in the middle of, with live output", () => {
    render(
      <WorkerInspector
        agent={byte}
        events={[
          event({
            seq: 1,
            spanId: "a",
            kind: "command",
            name: "command",
            status: "in_progress",
            input: { command: "./dotnet-install.sh" },
            output: { text: "Downloading .NET SDK 8.0.403..." },
          }),
        ]}
        runStatus="running"
      />,
    );
    expect(screen.getByText("./dotnet-install.sh")).toBeDefined();
    expect(screen.getByText(/Downloading \.NET SDK/)).toBeDefined();
  });

  it("lists moves by how often they were used, without a rating", () => {
    render(
      <WorkerInspector
        agent={byte}
        events={[
          event({ seq: 1, spanId: "a", kind: "command", name: "command" }),
          event({ seq: 2, spanId: "b", kind: "command", name: "command" }),
          event({ seq: 3, spanId: "c", kind: "file_change", name: "file_change" }),
        ]}
        runStatus="running"
      />,
    );
    const labels = [...document.querySelectorAll(".inspector-move-label")].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(["SHELL", "WRITE"]);
    expect(document.querySelector(".inspector-move-stars")).toBeNull();
  });
});

describe("roleLabel with a real dispatched specialty", () => {
  it("refuses a machine identity built from role, subtask and digest", () => {
    // What the server actually stores: worker-resolver.ts builds
    // `<role prefix>-<subtask id>-<sha256 head>` and caps it at 64 chars.
    const specialty = "you-are-a-random-choice-generator-choice-gen-3f8a21bc";
    expect(roleLabel({ role: "worker", specialty })).toBe("Worker");
  });

  it("still shows a specialty that is actually a role", () => {
    expect(roleLabel({ role: "worker", specialty: "research-analyst" })).toBe(
      "research analyst",
    );
    expect(roleLabel({ role: "leader", specialty: "leader" })).toBe("leader");
  });

  it("refuses anything too long to be a role, digest or not", () => {
    const sentence = "you-are-a-report-writer-read-the-notes-and-summarise";
    expect(roleLabel({ role: "worker", specialty: sentence })).toBe("Worker");
  });

  it("falls back to the role when there is no specialty at all", () => {
    expect(roleLabel({ role: "leader", specialty: null })).toBe("Leader");
    expect(roleLabel({ role: "standalone", specialty: "" })).toBe("Agent");
  });

});

/**
 * A finished run has no current move.
 *
 * The card kept rendering "CURRENT MOVE -> DISPATCH" with the leader's
 * live-session narration under it long after the run reported Done, so the
 * panel said the agent was working while the transcript said it had finished.
 * The move it last made is still worth naming; the running commentary and the
 * in-flight output snapshot are not.
 */
describe("the current move once the run has settled", () => {
  const leader = { ...byte, role: "leader", specialty: null } as Agent;
  const dispatched = [
    event({
      seq: 1,
      spanId: "d1",
      kind: "delegation",
      name: "dispatch",
      status: "in_progress",
      output: { text: "Leader is running as a live Codex session." },
      input: { command: "dispatch --worker alpha" },
    }),
  ];

  it("calls it the current move while the run is going", () => {
    render(<WorkerInspector agent={leader} events={dispatched} runStatus="running" />);
    expect(screen.getByText("Current move")).toBeTruthy();
  });

  it("calls it the last move once the run is done", () => {
    render(<WorkerInspector agent={leader} events={dispatched} runStatus="completed" />);
    expect(screen.getByText("Last move")).toBeTruthy();
    expect(screen.queryByText("Current move")).toBeNull();
  });

  it("drops the live narration a finished run cannot still be producing", () => {
    render(<WorkerInspector agent={leader} events={dispatched} runStatus="completed" />);
    expect(screen.queryByText(/Leader is running as a live Codex session/)).toBeNull();
    expect(screen.queryByText("dispatch --worker alpha")).toBeNull();
  });

  it("still keeps that detail while the run is live", () => {
    render(<WorkerInspector agent={leader} events={dispatched} runStatus="running" />);
    expect(screen.getByText(/Leader is running as a live Codex session/)).toBeTruthy();
    expect(screen.getByText("dispatch --worker alpha")).toBeTruthy();
  });
});

/**
 * The move card names a move, or it does not appear.
 *
 * `leader_codex_loop` is the leader's own session opening -- it dispatches
 * nobody and is no longer counted as a dispatch, so it has no move. The card
 * fell back to the raw span name and printed `leader_codex_loop` at the reader,
 * which is a machine identifier, not something the agent did.
 */
describe("an event that is not a move", () => {
  const loopOnly = [
    event({
      seq: 1,
      spanId: "l1",
      kind: "delegation",
      name: "leader_codex_loop",
      status: "in_progress",
      output: { text: "Leader is running as a live Codex session." },
    }),
  ];

  it("shows no move card rather than a span name", () => {
    render(<WorkerInspector agent={byte} events={loopOnly} runStatus="completed" />);
    expect(screen.queryByText("leader_codex_loop")).toBeNull();
    expect(screen.queryByText("Last move")).toBeNull();
    expect(screen.queryByText("Current move")).toBeNull();
  });

  it("still shows the card for a real move", () => {
    const dispatched = [
      // `current` is the span still open when the run stopped -- which is
      // exactly the case that produced the reported screenshot.
      event({
        seq: 1,
        spanId: "d1",
        kind: "delegation",
        name: "dispatch_subagent",
        status: "in_progress",
      }),
    ];
    render(<WorkerInspector agent={byte} events={dispatched} runStatus="completed" />);
    const card = screen.getByText("Last move").closest(".rail-card") as HTMLElement;
    // DISPATCH also appears in the Moves tally, so the assertion is scoped.
    expect(card.querySelector(".inspector-move-label")?.textContent).toBe("DISPATCH");
  });
});

/**
 * One colour, one meaning.
 *
 * Role tags were tinted by what the worker's specialty looked like -- purple
 * for anything matching /cod|dev|engineer/, green for /review|test/, and so on.
 * Nobody could say what the colours meant ("这个颜色是啥意思"), and they
 * competed with the creature's own posture and the run's status for the same
 * signal. A worker's colour now says the one thing a colour is good at from
 * across the room: whether it is working right now.
 */
describe("roleTone", () => {
  it("is running while the platform has the agent busy", () => {
    expect(roleTone({ status: "busy" })).toBe("running");
  });

  it("is idle once it is done", () => {
    expect(roleTone({ status: "ready" })).toBe("idle");
  });

  it("is idle for an agent that was never started", () => {
    expect(roleTone({ status: "stopped" })).toBe("idle");
  });

  /** A failure has its own reporting; the tag does not become a third colour. */
  it("is idle for an agent that errored", () => {
    expect(roleTone({ status: "error" })).toBe("idle");
  });
});

/**
 * "Files changed 0" was a claim the platform could not support.
 *
 * The count comes from Codex `file_change` items, which it emits for patch
 * edits and nothing else. An agent told to `echo >> countdown.txt` writes a
 * real file and produces a command, not a file change -- and across this
 * deployment's entire event log there is not a single `file_change` event, so
 * the counter read 0 next to missions that had demonstrably written files.
 *
 * Zero and "cannot see" are different answers, and only one of them is honest
 * here. The number appears when there is something to count.
 */
describe("files changed", () => {
  it("reports the count when the agent patched files", () => {
    const patched = [
      event({
        seq: 1,
        spanId: "f1",
        kind: "file_change",
        name: "apply_patch",
        output: { changedFiles: ["src/a.ts", "src/b.ts"] },
      }),
    ];
    render(<WorkerInspector agent={byte} events={patched} runStatus="completed" />);
    expect(screen.getByText("Files changed")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("says nothing rather than zero when no file change was ever reported", () => {
    const shellOnly = [
      event({
        seq: 1,
        spanId: "c1",
        kind: "command",
        name: "command",
        input: { command: "echo hi >> out.txt" },
      }),
    ];
    render(<WorkerInspector agent={byte} events={shellOnly} runStatus="completed" />);
    expect(screen.queryByText("Files changed")).toBeNull();
  });

  it("still reports the other counters", () => {
    const shellOnly = [
      event({ seq: 1, spanId: "c1", kind: "command", name: "command" }),
    ];
    render(<WorkerInspector agent={byte} events={shellOnly} runStatus="completed" />);
    expect(screen.getByText("Tools used")).toBeTruthy();
    expect(screen.getByText("Errors")).toBeTruthy();
  });
});
