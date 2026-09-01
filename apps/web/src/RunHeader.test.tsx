// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunHeader, RunMetadata } from "./RunHeader";
import type { AgentRun, RunEvent } from "./types";

afterEach(cleanup);

function run(id: string, over?: Partial<AgentRun>): AgentRun {
  return {
    id,
    agentId: "leader",
    projectId: null,
    kind: "single",
    parentRunId: null,
    orchestration: null,
    status: "completed",
    prompt: "Build a responsive todo app with tests",
    output: null,
    error: null,
    usage: null,
    startedAt: "2026-08-30T10:00:00.000Z",
    completedAt: "2026-08-30T10:00:12.000Z",
    createdAt: "2026-08-30T10:00:00.000Z",
    ...over,
  };
}

function event(seq: number, over: Partial<RunEvent>): RunEvent {
  return {
    seq,
    runId: "r1",
    agentId: "leader",
    spanId: "span-" + seq,
    parentSpanId: null,
    kind: "command",
    name: "bash",
    status: "ok",
    startedAt: "2026-08-30T10:00:00.000Z",
    endedAt: null,
    durationMs: null,
    input: {},
    output: {},
    error: null,
    attributes: {},
    usage: null,
    ...over,
  };
}

describe("RunHeader", () => {
  it("names the session and states the run's status", () => {
    render(
      <RunHeader
        runs={[run("r1")]}
        run={run("r1")}
        sessionName="Weather CLI"
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByText("Weather CLI")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
  });

  it("shows when the run happened and how long it took", () => {
    render(
      <RunHeader
        runs={[run("r1")]}
        run={run("r1")}
        sessionName="Weather CLI"
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByText("12.0s")).toBeTruthy();
    expect(screen.getByTitle("2026-08-30T10:00:00.000Z")).toBeTruthy();
  });

  it("says a run is still going rather than inventing a duration", () => {
    render(
      <RunHeader
        runs={[run("r1", { status: "running", completedAt: null })]}
        run={run("r1", { status: "running", completedAt: null })}
        sessionName="Weather CLI"
        onSelect={() => undefined}
      />,
    );
    expect(screen.queryByText("12.0s")).toBeNull();
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("offers no picker when the session has run exactly once", () => {
    render(
      <RunHeader
        runs={[run("r1")]}
        run={run("r1")}
        sessionName="Weather CLI"
        onSelect={() => undefined}
      />,
    );
    expect(screen.queryByLabelText("Run")).toBeNull();
  });

  it("places the viewed run in the session's history", () => {
    const runs = [run("r3"), run("r2"), run("r1")];
    render(
      <RunHeader
        runs={runs}
        run={runs[1]!}
        sessionName="Weather CLI"
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByText("Run 2 of 3")).toBeTruthy();
  });

  it("opens the run the reader picks", async () => {
    const onSelect = vi.fn();
    const runs = [run("r3"), run("r2"), run("r1")];
    render(
      <RunHeader runs={runs} run={runs[0]!} sessionName="Weather CLI" onSelect={onSelect} />,
    );
    await userEvent.selectOptions(screen.getByLabelText("Run"), "r1");
    expect(onSelect).toHaveBeenCalledWith("r1");
  });

  it("labels each run in the picker by its position, status and prompt", () => {
    const runs = [run("r2"), run("r1", { status: "failed", prompt: "Explain the repo" })];
    render(
      <RunHeader runs={runs} run={runs[0]!} sessionName="Weather CLI" onSelect={() => undefined} />,
    );
    const option = screen.getByRole("option", { name: /Explain the repo/ });
    expect(option.textContent).toContain("Run 1");
    expect(option.textContent).toContain("failed");
  });
});

describe("RunMetadata", () => {
  it("counts the tool calls, agents and artifacts of the run", () => {
    const events = [
      event(1, { spanId: "a", status: "in_progress" }),
      event(2, { spanId: "a", status: "ok" }),
      event(3, { spanId: "b", kind: "mcp_tool", agentId: "worker" }),
    ];
    render(<RunMetadata events={events} artifactCount={3} />);
    expect(screen.getByText("2 tool calls")).toBeTruthy();
    expect(screen.getByText("2 agents")).toBeTruthy();
    expect(screen.getByText("3 artifacts")).toBeTruthy();
  });

  it("uses the singular for a run that did one of each", () => {
    render(<RunMetadata events={[event(1, {})]} artifactCount={1} />);
    expect(screen.getByText("1 tool call")).toBeTruthy();
    expect(screen.getByText("1 agent")).toBeTruthy();
    expect(screen.getByText("1 artifact")).toBeTruthy();
  });

  it("renders nothing for a run that did nothing", () => {
    const { container } = render(<RunMetadata events={[]} artifactCount={0} />);
    expect(container.firstChild).toBeNull();
  });
});

/**
 * Every run in the transcript gets a header; only the one being read gets the
 * picker. A selector on each of eight stacked headers is eight controls that
 * all do the same thing.
 */
describe("RunHeader in a transcript of several runs", () => {
  const runs = [run("r3"), run("r2"), run("r1")];

  it("takes the position it is told, counting from the operator's first run", () => {
    render(
      <RunHeader
        runs={runs}
        run={runs[2]!}
        position={1}
        total={3}
        sessionName="Weather CLI"
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByText("Run 1 of 3")).toBeTruthy();
  });

  it("offers no picker on a run that is not the one being read", () => {
    render(
      <RunHeader
        runs={runs}
        run={runs[2]!}
        position={1}
        total={3}
        sessionName="Weather CLI"
        onSelect={() => undefined}
        pickable={false}
      />,
    );
    expect(screen.queryByLabelText("Run")).toBeNull();
  });

  it("offers the picker on the run being read", () => {
    render(
      <RunHeader
        runs={runs}
        run={runs[0]!}
        position={3}
        total={3}
        sessionName="Weather CLI"
        onSelect={() => undefined}
        pickable
      />,
    );
    expect(screen.getByLabelText("Run")).toBeTruthy();
  });
});
