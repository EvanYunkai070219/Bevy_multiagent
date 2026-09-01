import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Diagnoser } from "../src/orchestration/healing/diagnoser.js";
import { ArkClient } from "../src/orchestration/leader/ark-client.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import {
  RunControl,
  RunTerminalError,
} from "../src/orchestration/run-control.js";
import type { RunEventDraft, RunEventSink } from "../src/run-events.js";
import type {
  EvidenceSnapshot,
  FaultRecord,
  SubtaskContract,
} from "../src/types.js";

function contract(overrides: Partial<SubtaskContract> = {}): SubtaskContract {
  return {
    subtaskId: "worker-1",
    revision: 1,
    contractKey: "demo",
    inputs: [],
    outputs: ["src/app.ts"],
    dependencyIds: [],
    downstreamConsumers: ["tester"],
    allowedMutationPaths: ["src/"],
    protectedPaths: ["package-lock.json"],
    artifactSchemaIds: [],
    targetedGateIds: ["targeted"],
    contractGateIds: ["contract"],
    consumerGateIds: ["consumer"],
    regressionGateIds: ["regression"],
    authorizedTools: ["bash"],
    ...overrides,
  };
}

function fault(overrides: Partial<FaultRecord> = {}): FaultRecord {
  return {
    id: "fault-1",
    subtaskId: "worker-1",
    revision: 1,
    class: "hard_failure",
    reasonCode: "tests_failed",
    summary: "Tests failed.",
    repairable: true,
    evidenceRefs: ["snap-1"],
    affectedConsumers: ["tester"],
    detectedAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  };
}

function evidence(): Pick<
  EvidenceSnapshot,
  "id" | "source" | "failureFingerprints" | "changedPaths" | "stateFingerprint"
>[] {
  return [
    {
      id: "snap-1",
      source: "verification",
      failureFingerprints: ["assert:required-field"],
      changedPaths: ["src/app.ts"],
      stateFingerprint: "abc",
    },
  ];
}

function control(overrides: Partial<typeof defaultExecutionPolicy> = {}): RunControl {
  return new RunControl({ ...defaultExecutionPolicy, ...overrides });
}

function sink(emit: RunEventSink["emit"] = () => undefined): RunEventSink {
  return { emit };
}

function validDiagnosis(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    classification: "context",
    rationale: "The worker lacked an upstream artifact it was contracted to consume.",
    allowedMutationFamilies: ["context_patch"],
    ...overrides,
  });
}

class ScriptedArk {
  calls = 0;
  contexts: unknown[] = [];

  constructor(
    private readonly replies: Array<string | Error>,
  ) {}

  async completeJson(messages: unknown, context?: unknown) {
    this.calls += 1;
    this.contexts.push(context);
    void messages;
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error("No fake completion");
    if (reply instanceof Error) throw reply;
    return { text: reply, model: "fake-model", usage: null };
  }
}

function diagnose(
  ark: ScriptedArk | ArkClient,
  options: {
    control?: RunControl;
    sink?: RunEventSink;
    fault?: FaultRecord;
  } = {},
) {
  return new Diagnoser(ark as unknown as ArkClient).diagnose({
    fault: options.fault ?? fault(),
    contract: contract(),
    evidence: evidence(),
    control: options.control ?? control(),
    budgetScopeId: "diagnosis:worker-1",
    sink: options.sink ?? sink(),
  });
}

describe("Diagnoser structured output", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a context classification with a context_patch family", async () => {
    const ark = new ScriptedArk([validDiagnosis()]);
    const record = await diagnose(ark);
    expect(record.status).toBe("available");
    expect(record.classification).toBe("context");
    expect(record.allowedMutationFamilies).toEqual(["context_patch"]);
    expect(record.rationale.length).toBeGreaterThan(0);
    expect(record.faultId).toBe("fault-1");
    expect(ark.calls).toBe(1);
  });

  it("accepts a strategy classification with a strategy_patch family", async () => {
    const ark = new ScriptedArk([
      validDiagnosis({
        classification: "reasoning",
        allowedMutationFamilies: ["strategy_patch"],
      }),
    ]);
    const record = await diagnose(ark);
    expect(record.status).toBe("available");
    expect(record.classification).toBe("reasoning");
    expect(record.allowedMutationFamilies).toEqual(["strategy_patch"]);
    expect(ark.calls).toBe(1);
  });

  it("accepts both context_patch and strategy_patch together", async () => {
    const ark = new ScriptedArk([
      validDiagnosis({
        classification: "task",
        allowedMutationFamilies: ["context_patch", "strategy_patch"],
      }),
    ]);
    const record = await diagnose(ark);
    expect(record.status).toBe("available");
    expect(record.allowedMutationFamilies).toEqual(["context_patch", "strategy_patch"]);
    expect(ark.calls).toBe(1);
  });

  it("persists unavailable for malformed JSON and never regenerates", async () => {
    const ark = new ScriptedArk(["not-json {"]);
    const record = await diagnose(ark);
    expect(record.status).toBe("unavailable");
    expect(ark.calls).toBe(1);
  });

  it("persists unavailable for an unknown classification", async () => {
    const ark = new ScriptedArk([validDiagnosis({ classification: "task_failure" })]);
    const record = await diagnose(ark);
    expect(record.status).toBe("unavailable");
    expect(ark.calls).toBe(1);
  });

  it("persists unavailable for an empty rationale", async () => {
    const ark = new ScriptedArk([validDiagnosis({ rationale: "   " })]);
    const record = await diagnose(ark);
    expect(record.status).toBe("unavailable");
    expect(ark.calls).toBe(1);
  });

  it("persists unavailable when rationale exceeds 2000 characters", async () => {
    const ark = new ScriptedArk([validDiagnosis({ rationale: "x".repeat(2001) })]);
    const record = await diagnose(ark);
    expect(record.status).toBe("unavailable");
    expect(ark.calls).toBe(1);
  });

  it("persists unavailable for an unauthorized mutation family", async () => {
    const ark = new ScriptedArk([
      validDiagnosis({ allowedMutationFamilies: ["control"] }),
    ]);
    const record = await diagnose(ark);
    expect(record.status).toBe("unavailable");
    expect(ark.calls).toBe(1);
  });

  it("persists unavailable when the model requests permission, verifier, or budget changes", async () => {
    const ark = new ScriptedArk([
      validDiagnosis({
        permissions: ["git_write"],
        verifierCommands: ["pytest"],
        budget: { tokens: 99_999 },
      }),
    ]);
    const record = await diagnose(ark);
    expect(record.status).toBe("unavailable");
    expect(ark.calls).toBe(1);
  });

  it("retries a first 429 then returns an available diagnosis", async () => {
    const runControl = control();
    let attempts = 0;
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: "https://ark.example.test/api/v3/",
      }),
      (async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response('{"error":"slow down"}', {
            status: 429,
            headers: { "retry-after": "0", "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            output_text: validDiagnosis(),
            usage: { input_tokens: 2, output_tokens: 1 },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    );
    const record = await diagnose(client, { control: runControl });
    expect(record.status).toBe("available");
    expect(attempts).toBe(2);
    runControl.close();
  });

  it("persists unavailable after a second 429 and does not declare a tournament", async () => {
    const runControl = control();
    let attempts = 0;
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: "https://ark.example.test/api/v3/",
      }),
      (async () => {
        attempts += 1;
        return new Response("{}", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }) as typeof fetch,
    );
    const record = await diagnose(client, { control: runControl });
    expect(record.status).toBe("unavailable");
    expect(attempts).toBe(2);
    expect(runControl.snapshot().terminalReason).toBe("provider_rate_limited");
    runControl.close();
  });

  it("persists unavailable when the Ark call times out", async () => {
    vi.useFakeTimers();
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: "https://ark.example.test/api/v3/",
        ORCHESTRATION_MODEL_TIMEOUT_MS: "10000",
      }),
      (async () => new Promise<Response>(() => {})) as typeof fetch,
    );
    const pending = diagnose(client);
    await vi.advanceTimersByTimeAsync(10_000);
    const record = await pending;
    expect(record.status).toBe("unavailable");
  });

  it("persists unavailable when a budget terminal signal fires", async () => {
    const runControl = control({ emergencyModelCallFuse: 0 });
    const ark = new ScriptedArk([validDiagnosis()]);
    const record = await diagnose(ark, { control: runControl });
    expect(record.status).toBe("unavailable");
    expect(ark.calls).toBe(0);
    expect(runControl.snapshot().terminalReason).toBe("emergency_model_call_fuse");
    runControl.close();
  });

  it("does not issue a JSON-repair regeneration call after malformed output", async () => {
    const ark = new ScriptedArk(["{"]);
    const record = await diagnose(ark);
    expect(record.status).toBe("unavailable");
    expect(ark.calls).toBe(1);
  });

  it("issues one real ArkClient HTTP call for malformed JSON without a repair span", async () => {
    const drafts: RunEventDraft[] = [];
    let attempts = 0;
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: "https://ark.example.test/api/v3/",
      }),
      (async () => {
        attempts += 1;
        return new Response(
          JSON.stringify({ output_text: "{", usage: { input_tokens: 1, output_tokens: 1 } }),
          { status: 200 },
        );
      }) as typeof fetch,
    );
    const record = await diagnose(client, {
      sink: { emit: (draft) => drafts.push(draft) },
    });
    expect(record.status).toBe("unavailable");
    expect(attempts).toBe(1);
    expect(drafts.some((draft) => draft.name === "diagnoser_repair")).toBe(false);
    const recorded = drafts.filter((draft) => draft.kind === "api_call");
    expect(recorded.length).toBeGreaterThan(0);
    for (const draft of recorded) {
      expect(draft.name).toBe("diagnoser");
    }
  });

  it("maps a latched RunTerminalError onto unavailable without a second call", async () => {
    const ark = new ScriptedArk([
      new RunTerminalError("user_cancelled", "cancelled during diagnosis"),
    ]);
    const record = await diagnose(ark);
    expect(record.status).toBe("unavailable");
    expect(ark.calls).toBe(1);
  });
});
