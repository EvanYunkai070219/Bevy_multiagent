/** Deterministic protocol checks on a finished worker turn. */
import { describe, expect, it } from "vitest";
import { validateWorker } from "../src/orchestration/workers/worker-validator.js";

const base = {
  subtaskPrompt: "Read the number and decrement it.",
  openToolCallCount: 0,
  evidenceAvailable: true,
};

describe("worker validator", () => {
  // Run b3a3748b's agent2 returned exactly this and finished `completed` with no
  // error, 250 output tokens, and not one file touched. The countdown lost a
  // step and nothing in the system objected.
  it("flags tool-call markup emitted as text with no tool events", () => {
    const result = validateWorker({
      ...base,
      output:
        "I'll check the shared workspace state first.\n\n" +
        '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="exec_command">\n' +
        '<｜DSML｜parameter name="cmd" string="true">cat number.txt</｜DSML｜parameter>\n',
      toolEventCount: 0,
    });
    expect(result.integrity).toBe("invalid");
    expect(result.anomalyCodes).toContain("UNPARSED_TOOL_CALL");
  });

  it("accepts the same markup when real tool events exist", () => {
    const result = validateWorker({
      ...base,
      output: 'Ran it.\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="exec_command">\n',
      toolEventCount: 3,
    });
    expect(result.integrity).toBe("valid");
  });

  // Calling no tools is normal for research, analysis and writing subtasks.
  it("accepts plain prose with no tool calls", () => {
    const result = validateWorker({
      ...base,
      output: "Findings: the repository uses a monorepo layout. No unresolved gaps.",
      toolEventCount: 0,
    });
    expect(result.integrity).toBe("valid");
  });

  // A subtask that asks the worker to discuss the markup would otherwise never
  // be able to pass; quoting it back is not evidence of a broken turn.
  it("only warns when the subtask prompt itself carries the marker", () => {
    const result = validateWorker({
      ...base,
      subtaskPrompt:
        'Analyse this sample: <｜DSML｜tool_calls><｜DSML｜invoke name="x">',
      output:
        'The sample shows <｜DSML｜tool_calls><｜DSML｜invoke name="x"> which means…',
      toolEventCount: 0,
    });
    expect(result.integrity).toBe("unverified");
    expect(result.anomalyCodes).not.toContain("UNPARSED_TOOL_CALL");
  });

  it("is unverified when evidence could not be read", () => {
    const result = validateWorker({
      ...base,
      output: "done",
      toolEventCount: 0,
      evidenceAvailable: false,
    });
    expect(result.integrity).toBe("unverified");
    expect(result.anomalyCodes).toContain("EVIDENCE_UNAVAILABLE");
  });

  it("flags empty output", () => {
    const result = validateWorker({ ...base, output: "   \n ", toolEventCount: 0 });
    expect(result.integrity).toBe("invalid");
    expect(result.anomalyCodes).toContain("EMPTY_OUTPUT");
  });

  it("flags a tool call that never closed", () => {
    const result = validateWorker({
      ...base,
      output: "ok",
      toolEventCount: 2,
      openToolCallCount: 1,
    });
    expect(result.integrity).toBe("invalid");
    expect(result.anomalyCodes).toContain("OPEN_TOOL_CALL");
  });

  // The ASCII rendering shows up when the full-width pipes get normalised away.
  it("catches the degraded ASCII rendering of the marker", () => {
    const result = validateWorker({
      ...base,
      output: '<|DSML|tool_calls>\n<|DSML|invoke name="exec_command">',
      toolEventCount: 0,
    });
    expect(result.integrity).toBe("invalid");
    expect(result.anomalyCodes).toContain("UNPARSED_TOOL_CALL");
  });
});

describe("mcp tool failures are recorded as failures", () => {
  // Measured: a publish_artifact that returned "Mcp error: -32000: ENOENT"
  // counted toward "7 successes, 0 failures". The tally said the tools were
  // fine while the trajectory showed them failing — which is why "MCP looks
  // healthy" could not be trusted.
  const collect = async (result: unknown): Promise<string | undefined> => {
    const { createEventCollector } = await import("../src/run-events.js");
    const collector = createEventCollector({ redact: (value) => value });
    collector.consume({
      type: "item.completed",
      item: { id: "i1", type: "mcp_tool_call", server: "launchpad", tool: "publish_artifact", result },
    });
    return collector.drain().at(-1)?.status;
  };

  it("marks a structured MCP error as error", async () => {
    expect(await collect({ isError: true, content: [{ type: "text", text: "nope" }] })).toBe("error");
    expect(await collect({ error: { code: -32000, message: "ENOENT" } })).toBe("error");
  });

  it("marks a text-reported MCP error as error", async () => {
    expect(await collect("Mcp error: -32000: ENOENT: no such file")).toBe("error");
    expect(
      await collect({ content: [{ type: "text", text: "Error: tool call failed" }] }),
    ).toBe("error");
  });

  it("leaves a successful call alone", async () => {
    expect(await collect({ content: [{ type: "text", text: '{"ok": true}' }] })).toBe("ok");
    expect(await collect('{"ok": true}')).toBe("ok");
  });

  // A tool whose output merely discusses an error is not a failed tool.
  it("does not flag a result that only mentions an error", async () => {
    expect(
      await collect({ content: [{ type: "text", text: "Found 3 files matching error handling" }] }),
    ).toBe("ok");
  });
});
