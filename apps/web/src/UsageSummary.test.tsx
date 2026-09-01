// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageBadge, UsageSummary } from "./UsageSummary";
import type { RunEvent } from "./types";

function event(partial: Partial<RunEvent> & Pick<RunEvent, "seq" | "spanId" | "kind">): RunEvent {
  return {
    runId: "run-1",
    agentId: "agent-1",
    parentSpanId: "run",
    name: partial.kind,
    status: "ok",
    startedAt: "2026-08-29T00:00:00.000Z",
    endedAt: "2026-08-29T00:00:01.000Z",
    durationMs: 1000,
    input: {},
    output: {},
    error: null,
    attributes: {},
    usage: null,
    ...partial,
  } as RunEvent;
}

describe("run usage", () => {
  it("reads api_call spans when the runtime reports no turn totals", () => {
    // The app-server runtime and a leader's own planning calls produce no `turn`
    // span at all, which previously left every figure at zero and hid the panel.
    render(
      <UsageSummary
        events={[
          event({ seq: 1, spanId: "api-1", kind: "api_call" }),
          event({
            seq: 2,
            spanId: "api-1",
            kind: "api_call",
            usage: { inputTokens: 300, outputTokens: 40, cachedInputTokens: 0 },
          }),
          event({
            seq: 3,
            spanId: "api-2",
            kind: "api_call",
            usage: { inputTokens: 100, outputTokens: 60, cachedInputTokens: 0 },
          }),
        ]}
        pricing={null}
      />,
    );

    expect(screen.getByText(/400 in \/ 100 out \/ 500 total/)).toBeTruthy();
  });

  it("counts a span once when it is reported both in progress and settled", () => {
    render(
      <UsageBadge
        events={[
          event({
            seq: 1,
            spanId: "api-1",
            kind: "api_call",
            status: "in_progress",
            usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0 },
          }),
          event({
            seq: 2,
            spanId: "api-1",
            kind: "api_call",
            usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
          }),
        ]}
        pricing={null}
      />,
    );

    expect(screen.getByText("15 tokens")).toBeTruthy();
  });

  it("prefers turn totals over the calls that produced them", () => {
    // In exec mode both are present and describe the same tokens. Adding them
    // would report exactly double what the run actually spent.
    render(
      <UsageBadge
        events={[
          event({
            seq: 1,
            spanId: "turn-1",
            kind: "turn",
            usage: { inputTokens: 90, outputTokens: 10, cachedInputTokens: 0 },
          }),
          event({
            seq: 2,
            spanId: "api-1",
            kind: "api_call",
            usage: { inputTokens: 90, outputTokens: 10, cachedInputTokens: 0 },
          }),
        ]}
        pricing={null}
      />,
    );

    expect(screen.getByText("100 tokens")).toBeTruthy();
  });

  it("renders nothing when no span reported usage", () => {
    const { container } = render(
      <UsageSummary events={[event({ seq: 1, spanId: "cmd-1", kind: "command" })]} pricing={null} />,
    );
    expect(container.querySelector(".usage-summary")).toBeNull();
  });
});
