import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { RunEventDraft } from "../src/run-events.js";
import { ArkClient, responseText } from "../src/orchestration/leader/ark-client.js";
import { rateLimitDecision } from "../src/orchestration/leader/rate-limit.js";
import {
  RunControl,
  RunTerminalError,
  type RunClock,
} from "../src/orchestration/run-control.js";
import { defaultExecutionPolicy } from "../src/orchestration/policies.js";
import type { ExecutionPolicy } from "../src/types.js";

describe("ArkClient orchestration transport", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // The timeout used to race only `fetch`, which resolves when response HEADERS
  // arrive. The body read that follows was unguarded, so a provider that streamed
  // headers immediately and then stalled could hang the run forever — observed as
  // a planner call sitting at 17m30s with the 120s timeout never firing.
  it("times out when the body stalls after headers arrive", async () => {
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: "https://ark.example.test/api/v3/",
        ORCHESTRATION_MODEL_TIMEOUT_MS: "10000",
      }),
      ((_url, init) => {
        // Headers are already available; the body never completes.
        const body = new ReadableStream<Uint8Array>({
          start() {
            /* never enqueue, never close */
          },
        });
        const response = new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
        init?.signal?.addEventListener("abort", () => {
          void body.cancel().catch(() => undefined);
        });
        return Promise.resolve(response);
      }) as unknown as typeof fetch,
    );

    await expect(
      client.completeJson([{ role: "user", content: "hello" }]),
    ).rejects.toThrow(/timed out/i);
  }, 20_000);

  // The recorder used to declare `endpoint: "/responses"` itself while the
  // request path chose the real URL from arkApiFormat. Against OpenRouter the
  // call went to /chat/completions but every trajectory said /responses, which
  // is how a working routing fix got misread as "not applied".
  it("records the endpoint actually used, not a hardcoded one", async () => {
    const drafts: RunEventDraft[] = [];
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "deepseek/test",
        ARK_BASE_URL: "https://openrouter.ai/api/v1",
      }),
      (async () =>
        new Response(
          JSON.stringify({
            model: "deepseek/test",
            choices: [{ message: { content: "{\"ok\":true}" } }],
            usage: { prompt_tokens: 1, completion_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    );

    await client.completeJson([{ role: "user", content: "hello" }], {
      sink: { emit: (draft) => drafts.push(draft) },
      label: "planner",
      iteration: 0,
      attempt: 1,
    });

    // auto-resolves to chat_completions for openrouter.ai
    for (const draft of drafts) {
      expect(draft.attributes?.endpoint).toBe("/chat/completions");
    }
    expect(drafts.length).toBeGreaterThan(0);
  });

  // A reasoning model bills thinking as output. Run 9f5ba522's planner call was
  // billed 24919 output tokens for a plan of roughly 2000 — reading that single
  // number as "it generated a lot" points at the wrong fix entirely.
  it("parses reasoning tokens from chat_completions usage", async () => {
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "deepseek/test",
        ARK_BASE_URL: "https://openrouter.ai/api/v1",
      }),
      (async () =>
        new Response(
          JSON.stringify({
            model: "deepseek/test",
            choices: [{ message: { content: "{\"ok\":true}" } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 64,
              completion_tokens_details: { reasoning_tokens: 61 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    );

    const completion = await client.completeJson([{ role: "user", content: "hi" }]);
    expect(completion.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 64,
      reasoningTokens: 61,
    });
  });

  it("parses reasoning tokens from the Responses path too", async () => {
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: "https://ark.example.test/api/v3",
      }),
      (async () =>
        new Response(
          JSON.stringify({
            model: "ep-test",
            output_text: "{\"ok\":true}",
            usage: {
              input_tokens: 5,
              output_tokens: 30,
              output_tokens_details: { reasoning_tokens: 22 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    );

    const completion = await client.completeJson([{ role: "user", content: "hi" }]);
    expect(completion.usage).toMatchObject({ outputTokens: 30, reasoningTokens: 22 });
  });

  // Measured on the real planner request: >600s with reasoning on, 11.2s off —
  // and the plan came back better, using a dependency chain instead of the lock
  // protocol the thinking pass talked itself into.
  it("disables reasoning on orchestration chat_completions calls by default", async () => {
    let sentBody: Record<string, unknown> = {};
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "deepseek/test",
        ARK_BASE_URL: "https://openrouter.ai/api/v1",
      }),
      (async (_url, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            model: "deepseek/test",
            choices: [{ message: { content: "{\"ok\":true}" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );

    await client.completeJson([{ role: "user", content: "hi" }]);
    expect(sentBody.reasoning).toEqual({ enabled: false });
  });

  it("omits the reasoning field on the Responses path", async () => {
    let sentBody: Record<string, unknown> = {};
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: "https://ark.example.test/api/v3",
      }),
      (async (_url, init) => {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ model: "ep-test", output_text: "{\"ok\":true}" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );

    await client.completeJson([{ role: "user", content: "hi" }]);
    expect(sentBody).not.toHaveProperty("reasoning");
  });

  it("uses the Responses endpoint and parses output_text", async () => {
    let requestedUrl = "";
    let requestedBody: Record<string, unknown> = {};
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: "https://ark.example.test/api/v3/",
      }),
      (async (url, init) => {
        requestedUrl = String(url);
        requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            model: "ep-test",
            output_text: "{\"ok\":true}",
            usage: { input_tokens: 3, output_tokens: 4 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );

    const completion = await client.completeJson([
      { role: "system", content: "Return JSON." },
      { role: "user", content: "hello" },
    ]);

    expect(requestedUrl).toBe("https://ark.example.test/api/v3/responses");
    expect(requestedBody).toMatchObject({
      model: "ep-test",
      input: [
        { role: "system", content: "Return JSON." },
        { role: "user", content: "hello" },
      ],
    });
    expect(completion.text).toBe("{\"ok\":true}");
    expect(completion.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it("uses the Chat Completions endpoint for OpenRouter-style bases", async () => {
    let requestedUrl = "";
    let requestedBody: Record<string, unknown> = {};
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "deepseek/deepseek-v4-flash-0731",
        ARK_BASE_URL: "https://openrouter.ai/api/v1",
      }),
      (async (url, init) => {
        requestedUrl = String(url);
        requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            model: "deepseek/deepseek-v4-flash-0731",
            choices: [{ message: { role: "assistant", content: "{\"ok\":true}" } }],
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );

    const completion = await client.completeJson([
      { role: "system", content: "Return JSON." },
      { role: "user", content: "hello" },
    ]);

    expect(requestedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(requestedBody).toMatchObject({
      model: "deepseek/deepseek-v4-flash-0731",
      messages: [
        { role: "system", content: "Return JSON." },
        { role: "user", content: "hello" },
      ],
      response_format: { type: "json_object" },
    });
    expect(requestedBody.input).toBeUndefined();
    expect(completion.text).toBe("{\"ok\":true}");
    expect(completion.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it("honors an explicit ARK_API_FORMAT override", async () => {
    let requestedUrl = "";
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
        ARK_BASE_URL: "https://ark.example.test/api/v3",
        ARK_API_FORMAT: "chat_completions",
      }),
      (async (url) => {
        requestedUrl = String(url);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );

    await client.completeJson([{ role: "user", content: "hi" }]);
    expect(requestedUrl).toBe("https://ark.example.test/api/v3/chat/completions");
  });

  it("parses Responses output content arrays", () => {
    expect(
      responseText({
        output: [
          {
            type: "reasoning",
            content: [
              { type: "reasoning_text", text: "This must not be parsed as JSON." },
            ],
          },
          {
            type: "message",
            content: [
              { type: "output_text", text: "{\"a\":" },
              { type: "output_text", text: "1}" },
            ],
          },
        ],
      }),
    ).toBe("{\"a\":1}");
  });

  it("fails direct orchestration model calls on a hard timeout", async () => {
    vi.useFakeTimers();
    const client = new ArkClient(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
        ORCHESTRATION_MODEL_TIMEOUT_MS: "10000",
      }),
      (async () => new Promise<Response>(() => {})) as typeof fetch,
    );

    const completion = client.completeJson([{ role: "user", content: "hello" }]);
    const assertion = expect(completion).rejects.toThrow(
      "Ark request timed out after 10000 ms",
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    vi.useRealTimers();
  });
});

describe("ArkClient api_call recording", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const testConfig = (overrides: Record<string, string> = {}) =>
    loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      ARK_BASE_URL: "https://ark.example.test/api/v3",
      ...overrides,
    });

  const collector = () => {
    const drafts: RunEventDraft[] = [];
    return { drafts, sink: { emit: (draft: RunEventDraft) => drafts.push(draft) } };
  };

  it("records one api_call event for a successful call", async () => {
    const { drafts, sink } = collector();
    const client = new ArkClient(
      testConfig(),
      (async () =>
        new Response(
          JSON.stringify({
            model: "ep-test",
            output_text: "{\"ok\":true}",
            usage: { input_tokens: 3, output_tokens: 4 },
          }),
          { status: 200 },
        )) as typeof fetch,
    );

    await client.completeJson([{ role: "user", content: "hello" }], {
      sink,
      label: "planner",
      iteration: 1,
    });

    // One call is two events sharing a spanId: the request anchor, then the
    // outcome. Ordering in the trace must key off the request, not completion.
    expect(drafts).toHaveLength(2);
    const [started, finished] = drafts as [RunEventDraft, RunEventDraft];

    expect(started.kind).toBe("api_call");
    expect(started.spanId).toBe("api-planner-1-1");
    expect(started.parentSpanId).toBe("run");
    expect(started.status).toBe("in_progress");
    expect(started.input.text).toContain("hello");
    expect(started.endedAt).toBeNull();
    expect(started.usage).toBeNull();

    expect(finished.spanId).toBe(started.spanId);
    expect(finished.name).toBe("planner");
    expect(finished.status).toBe("ok");
    expect(finished.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(finished.output.text).toBe("{\"ok\":true}");
    expect(finished.error).toBeNull();
    expect(finished.attributes).toMatchObject({
      endpoint: "/responses",
      model: "ep-test",
      httpStatus: 200,
      attempt: 1,
    });
  });

  it("records a failed api_call and still throws on an HTTP error", async () => {
    const { drafts, sink } = collector();
    const client = new ArkClient(
      testConfig(),
      (async () => new Response("upstream boom", { status: 429 })) as typeof fetch,
    );

    await expect(
      client.completeJson([{ role: "user", content: "hello" }], {
        sink,
        label: "evaluator",
        iteration: 2,
      }),
    ).rejects.toThrow(/status 429/);

    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.status).toBe("in_progress");
    const event = drafts[1]!;
    expect(event.status).toBe("error");
    expect(event.spanId).toBe("api-evaluator-2-1");
    expect(event.error?.code).toBe("http_429");
    expect(event.output.text).toContain("upstream boom");
    expect(event.usage).toBeNull();
  });

  it("records a timed-out api_call", async () => {
    vi.useFakeTimers();
    const { drafts, sink } = collector();
    const client = new ArkClient(
      testConfig({ ORCHESTRATION_MODEL_TIMEOUT_MS: "10000" }),
      (async () => new Promise<Response>(() => {})) as typeof fetch,
    );

    const call = client.completeJson([{ role: "user", content: "hello" }], {
      sink,
      label: "synthesizer",
      iteration: 1,
    });
    const assertion = expect(call).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();

    expect(drafts).toHaveLength(2);
    expect(drafts[1]!.status).toBe("error");
    expect(drafts[1]!.error?.code).toBe("timeout");
  });

  it("marks a repair call as a separate attempt", async () => {
    const { drafts, sink } = collector();
    const client = new ArkClient(
      testConfig(),
      (async () =>
        new Response(JSON.stringify({ output_text: "{}" }), { status: 200 })) as typeof fetch,
    );

    await client.completeJson([{ role: "user", content: "hello" }], {
      sink,
      label: "planner_repair",
      iteration: 1,
      attempt: 2,
    });

    expect(drafts[0]!.spanId).toBe("api-planner_repair-1-2");
    expect(drafts[0]!.name).toBe("planner_repair");
    expect(drafts[1]!.attributes).toMatchObject({ attempt: 2 });
  });

  it("records nothing when no sink is supplied", async () => {
    const client = new ArkClient(
      testConfig(),
      (async () =>
        new Response(JSON.stringify({ output_text: "{}" }), { status: 200 })) as typeof fetch,
    );

    await expect(
      client.completeJson([{ role: "user", content: "hello" }]),
    ).resolves.toMatchObject({ text: "{}" });
  });

  it("anchors the request event before anything that happens during the call", async () => {
    const drafts: RunEventDraft[] = [];
    const sink = { emit: (draft: RunEventDraft) => drafts.push(draft) };
    let release: (value: Response) => void = () => {};
    const client = new ArkClient(
      testConfig(),
      (async () => new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch,
    );

    const call = client.completeJson([{ role: "user", content: "hello" }], {
      sink,
      label: "planner",
      iteration: 1,
    });
    // The call is still open. An unrelated event lands now; the request anchor
    // must already be recorded ahead of it.
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe("in_progress");

    release(new Response(JSON.stringify({ output_text: "{}" }), { status: 200 }));
    await call;
    expect(drafts).toHaveLength(2);
  });
});

function tinyPolicy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    ...defaultExecutionPolicy,
    emergencyTokenFuse: 10_000_000,
    emergencyModelCallFuse: 1_000,
    rootTimeoutMs: 60_000,
    ...overrides,
  };
}

function createClock(start = 0): RunClock & { advance(ms: number): void } {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fireAt: now + Number(ms), fn: fn as () => void });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(id) {
      timers.delete(id as unknown as number);
    },
    advance(ms: number) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.fireAt <= now)
        .sort((left, right) => left[1].fireAt - right[1].fireAt);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

describe("rateLimitDecision", () => {
  const base = {
    status: 429,
    retryAfter: "5",
    responseBody: '{"error":"slow down"}',
    attempt: 1 as const,
    remainingMs: 60_000,
  };

  it("retries once when Retry-After is a bounded delay with no usage", () => {
    expect(rateLimitDecision(base)).toEqual({
      retry: true,
      delayMs: 5_000,
      reason: "safe_retry",
    });
  });

  it("parses an HTTP-date Retry-After", () => {
    const when = new Date(Date.now() + 8_000).toUTCString();
    const decision = rateLimitDecision({ ...base, retryAfter: when });
    expect(decision.retry).toBe(true);
    expect(decision.reason).toBe("safe_retry");
    expect(decision.delayMs).toBeGreaterThan(0);
    expect(decision.delayMs).toBeLessThanOrEqual(30_000);
  });

  it("does not infer retry from status alone", () => {
    expect(rateLimitDecision({ ...base, retryAfter: null })).toMatchObject({
      retry: false,
      reason: "missing_retry_after",
    });
  });

  it("rejects a malformed Retry-After", () => {
    expect(rateLimitDecision({ ...base, retryAfter: "soon" })).toMatchObject({
      retry: false,
      reason: "invalid_retry_after",
    });
  });

  it("rejects a Retry-After above 30 seconds instead of clamping it", () => {
    expect(rateLimitDecision({ ...base, retryAfter: "31" })).toMatchObject({
      retry: false,
      reason: "invalid_retry_after",
    });
  });

  it("latches immediately when usage evidence is present", () => {
    expect(rateLimitDecision({
      ...base,
      responseBody: '{"error":"slow","usage":{"prompt_tokens":3}}',
    })).toMatchObject({ retry: false, reason: "usage_present" });
  });

  it("refuses a second attempt", () => {
    expect(rateLimitDecision({ ...base, attempt: 2 })).toMatchObject({
      retry: false,
      reason: "retry_exhausted",
    });
  });

  it("refuses when the delay does not fit remaining root time", () => {
    expect(rateLimitDecision({ ...base, remainingMs: 4_000 })).toMatchObject({
      retry: false,
      reason: "deadline_insufficient",
    });
  });
});

describe("ArkClient root control and 429 retry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const testConfig = (overrides: Record<string, string> = {}) =>
    loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      ARK_BASE_URL: "https://ark.example.test/api/v3",
      ...overrides,
    });

  it("cancels a never-closing body at the root deadline and preserves partial usage", async () => {
    const clock = createClock();
    const control = new RunControl(tinyPolicy({ rootTimeoutMs: 40 }), clock);
    const drafts: RunEventDraft[] = [];
    let cancelled = false;
    const client = new ArkClient(
      testConfig(),
      ((_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                '{"usage":{"input_tokens":11,"output_tokens":3},"output_text":',
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        });
        init?.signal?.addEventListener("abort", () => {
          void body.cancel().catch(() => undefined);
        });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }) as unknown as typeof fetch,
    );

    const pending = client.completeJson([{ role: "user", content: "hello" }], {
      sink: { emit: (draft) => drafts.push(draft) },
      label: "planner",
      control,
      budgetScopeId: "root",
    });
    clock.advance(40);
    await expect(pending).rejects.toBeInstanceOf(RunTerminalError);
    expect(cancelled).toBe(true);
    const outcome = drafts.filter((draft) => draft.kind === "api_call").at(-1);
    expect(outcome?.usage).toMatchObject({ inputTokens: 11, outputTokens: 3 });
    expect(() => control.assertActive()).toThrow(RunTerminalError);
    control.close();
  });

  it("denies a follow-up call after the run is terminal", async () => {
    const control = new RunControl(tinyPolicy());
    control.stop("root_deadline", "already done");
    let forwarded = 0;
    const client = new ArkClient(
      testConfig(),
      (async () => {
        forwarded += 1;
        return new Response(JSON.stringify({ output_text: "{}" }), { status: 200 });
      }) as typeof fetch,
    );
    await expect(
      client.completeJson([{ role: "user", content: "hello" }], {
        sink: { emit() {} },
        label: "planner",
        control,
        budgetScopeId: "root",
      }),
    ).rejects.toBeInstanceOf(RunTerminalError);
    expect(forwarded).toBe(0);
    control.close();
  });

  it("still records when the sink throws", async () => {
    const control = new RunControl(tinyPolicy());
    const client = new ArkClient(
      testConfig(),
      (async () =>
        new Response(JSON.stringify({ output_text: "{\"ok\":true}" }), { status: 200 })) as typeof fetch,
    );
    await expect(
      client.completeJson([{ role: "user", content: "hello" }], {
        sink: { emit() { throw new Error("sink down"); } },
        label: "planner",
        control,
        budgetScopeId: "root",
      }),
    ).resolves.toMatchObject({ text: "{\"ok\":true}" });
    control.close();
  });

  it("retries a 429 once with a valid Retry-After and no usage", async () => {
    const clock = createClock();
    const control = new RunControl(tinyPolicy({ rootTimeoutMs: 60_000 }), clock);
    const drafts: RunEventDraft[] = [];
    let attempts = 0;
    const client = new ArkClient(
      testConfig(),
      (async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response('{"error":"slow down"}', {
            status: 429,
            headers: { "retry-after": "0", "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({ output_text: "{\"ok\":true}", usage: { input_tokens: 2, output_tokens: 1 } }),
          { status: 200 },
        );
      }) as typeof fetch,
    );
    const pending = client.completeJson([{ role: "user", content: "hello" }], {
      sink: { emit: (draft) => drafts.push(draft) },
      label: "planner",
      control,
      budgetScopeId: "root",
    });
    const completion = await pending;
    expect(completion.text).toContain("ok");
    expect(attempts).toBe(2);
    const attemptsRecorded = drafts.filter(
      (draft) => draft.kind === "api_call" && draft.status === "in_progress",
    );
    expect(attemptsRecorded).toHaveLength(2);
    control.close();
  });

  it("latches provider_rate_limited on a second 429 without diagnosing", async () => {
    const control = new RunControl(tinyPolicy({ rootTimeoutMs: 60_000 }));
    let attempts = 0;
    const client = new ArkClient(
      testConfig(),
      (async () => {
        attempts += 1;
        return new Response("{}", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }) as typeof fetch,
    );
    await expect(
      client.completeJson([{ role: "user", content: "hello" }], {
        sink: { emit() {} },
        label: "planner",
        control,
        budgetScopeId: "root",
      }),
    ).rejects.toMatchObject({ reason: "provider_rate_limited" });
    expect(attempts).toBe(2);
    expect(control.snapshot().terminalReason).toBe("provider_rate_limited");
    control.close();
  });

  it("sends the reserved positive max_tokens instead of recomputing after admit", async () => {
    const control = new RunControl(tinyPolicy());
    const messages = [{ role: "user" as const, content: "hello" }];
    const estimatedInput = Math.ceil(JSON.stringify(messages).length / 4);
    let sent: Record<string, unknown> = {};
    let reservedDuringCall = 0;
    const client = new ArkClient(
      testConfig({
        ARK_MODEL: "deepseek/test",
        ARK_BASE_URL: "https://openrouter.ai/api/v1",
      }),
      (async (_url, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        reservedDuringCall = control.snapshot().reservedTokens;
        return new Response(
          JSON.stringify({
            model: "deepseek/test",
            choices: [{ message: { content: "{\"ok\":true}" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );
    await client.completeJson(messages, {
      sink: { emit() {} },
      label: "planner",
      control,
      budgetScopeId: "root",
    });
    expect(typeof sent.max_tokens).toBe("number");
    expect(sent.max_tokens).toBeGreaterThan(0);
    expect(reservedDuringCall).toBe(estimatedInput + 256 + Number(sent.max_tokens));
    control.close();
  });

  it("sends the reserved positive max_output_tokens on the responses path", async () => {
    const control = new RunControl(tinyPolicy());
    const messages = [{ role: "user" as const, content: "hello" }];
    const estimatedInput = Math.ceil(JSON.stringify(messages).length / 4);
    let sent: Record<string, unknown> = {};
    let reservedDuringCall = 0;
    const client = new ArkClient(
      testConfig(),
      (async (_url, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        reservedDuringCall = control.snapshot().reservedTokens;
        return new Response(
          JSON.stringify({ output_text: "{\"ok\":true}" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );
    await client.completeJson(messages, {
      sink: { emit() {} },
      label: "planner",
      control,
      budgetScopeId: "root",
    });
    expect(typeof sent.max_output_tokens).toBe("number");
    expect(sent.max_output_tokens).toBeGreaterThan(0);
    expect(reservedDuringCall).toBe(estimatedInput + 256 + Number(sent.max_output_tokens));
    control.close();
  });

  it("rethrows a mid-stream body error when the run is not aborting", async () => {
    const client = new ArkClient(
      testConfig(),
      ((_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"output_text":'));
            controller.error(new Error("socket reset"));
          },
        });
        init?.signal?.addEventListener("abort", () => {
          void body.cancel().catch(() => undefined);
        });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }) as unknown as typeof fetch,
    );
    await expect(
      client.completeJson([{ role: "user", content: "hello" }], {
        sink: { emit() {} },
        label: "planner",
      }),
    ).rejects.toThrow(/socket reset/);
  });
});
