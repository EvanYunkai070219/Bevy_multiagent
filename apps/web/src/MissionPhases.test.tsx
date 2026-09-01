// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MissionPhases } from "./MissionPhases";

afterEach(cleanup);

describe("MissionPhases", () => {
  it("uses the orchestrator's own phase names", () => {
    render(<MissionPhases phase="executing" />);
    for (const label of ["Plan", "Delegate", "Execute", "Evaluate", "Synthesize"]) {
      expect(screen.getByText(label)).toBeDefined();
    }
    expect(screen.queryByText("Inspect")).toBeNull();
    expect(screen.queryByText("Verify")).toBeNull();
    expect(screen.queryByText("Recover")).toBeNull();
  });

  it("marks the phase the run is in", () => {
    const { container } = render(<MissionPhases phase="evaluating" />);
    expect(container.querySelector(".phase--current")?.textContent).toContain("Evaluate");
  });

  it("shows a replan as a loop back rather than a step forward", () => {
    const { container } = render(<MissionPhases phase="replanning" />);
    const current = container.querySelector(".phase--current");
    expect(current?.querySelector(".phase-label")?.textContent).toBe("Replan");
    expect(current?.querySelector(".phase-bubble")?.textContent).toBe("↻");
    // It loops back to delegating rather than adding a seventh step.
    expect(container.querySelectorAll(".phase")).toHaveLength(6);
  });

  it("reads a finished run as done", () => {
    const { container } = render(<MissionPhases phase="completed" />);
    expect(container.querySelector(".phase--current")?.textContent).toContain("Done");
  });

  it("marks a failed run on the step it stopped at", () => {
    const { container } = render(<MissionPhases phase="failed" />);
    expect(container.querySelector(".phase--failed")).not.toBeNull();
  });
});
