/** Covers the model egress proxy: admission, credential swap, streaming, recording. */
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ModelProxy } from "../src/model-proxy.js";
import type { RunEventDraft } from "../src/run-events.js";

const running: ModelProxy[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((proxy) => proxy.close()));
});

interface Harness {
  proxy: ModelProxy;
  url: string;
  drafts: RunEventDraft[];
  forwarded: { url: string; init: RequestInit }[];
  sidecars: { label: string; digest: string; text: string }[];
}

async function makeProxy(
  upstream: (url: string, init: RequestInit) => Promise<Response>,
): Promise<Harness> {
  const drafts: RunEventDraft[] = [];
  const forwarded: { url: string; init: RequestInit }[] = [];
  const sidecars: { label: string; digest: string; text: string }[] = [];
  const proxy = new ModelProxy({
    saveSidecar: (_runId, label, digest, text) => {
      sidecars.push({ label, digest, text });
      return label + "-" + digest.slice(0, 12) + ".txt";
    },
    config: loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "sk-real-provider-key",
      ARK_MODEL: "ep-test",
      ARK_BASE_URL: "https://provider.example.test/api/v1",
    }),
    createSink: () => ({ emit: (draft) => drafts.push(draft) }),
    fetchImpl: (async (url: string, init: RequestInit) => {
      forwarded.push({ url: String(url), init });
      return upstream(String(url), init);
    }) as unknown as typeof fetch,
  });
  running.push(proxy);
  const port = await proxy.listen(0);
  return { proxy, url: "http://127.0.0.1:" + port, drafts, forwarded, sidecars };
}

const ok = async () =>
  new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2}}}\n\n', {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const post = (url: string, token: string, body: unknown, path = "/v1/responses") =>
  fetch(url + path, {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("ModelProxy admission", () => {
  it("swaps the run token for the real key and never forwards the token", async () => {
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1");

    const response = await post(h.url, token, { model: "ep-test", input: "hi" });

    expect(response.status).toBe(200);
    expect(h.forwarded).toHaveLength(1);
    const headers = new Headers(h.forwarded[0]!.init.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer sk-real-provider-key");
    expect(JSON.stringify(h.forwarded[0])).not.toContain(token);
    expect(h.forwarded[0]!.url).toBe("https://provider.example.test/api/v1/responses");
  });

  it("rejects an unknown token without forwarding or recording a body", async () => {
    const h = await makeProxy(ok);

    const response = await post(h.url, "not-a-real-token", { secret: "payload" });

    expect(response.status).toBe(401);
    expect(h.forwarded).toHaveLength(0);
    expect(JSON.stringify(h.drafts)).not.toContain("payload");
  });

  it("rejects a revoked token but lets an in-flight request finish", async () => {
    let release: (value: Response) => void = () => {};
    const h = await makeProxy(
      async () => new Promise<Response>((resolve) => { release = resolve; }),
    );
    const token = h.proxy.issue("run-1", "agent-1");

    const inFlight = post(h.url, token, { model: "ep-test" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.proxy.revoke("run-1");

    release(new Response("done", { status: 200 }));
    const finished = await inFlight;
    expect(finished.status).toBe(200);
    expect(await finished.text()).toBe("done");

    const after = await post(h.url, token, { model: "ep-test" });
    expect(after.status).toBe(401);
  });

  it("rejects a method or path outside the allowlist and records the denial", async () => {
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1");

    const wrongMethod = await fetch(h.url + "/v1/responses", {
      method: "GET",
      headers: { authorization: "Bearer " + token },
    });
    const wrongPath = await post(h.url, token, { model: "ep-test" }, "/v1/chat/completions");

    expect(wrongMethod.status).toBe(405);
    expect(wrongPath.status).toBe(404);
    expect(h.forwarded).toHaveLength(0);
    const denials = h.drafts.filter((draft) => draft.status === "error");
    expect(denials).toHaveLength(2);
    expect(denials.map((draft) => draft.error?.code)).toEqual([
      "method_not_allowed",
      "path_not_allowed",
    ]);
  });

  it("rejects a body over the size limit without forwarding it", async () => {
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1");
    const huge = JSON.stringify({ model: "ep-test", pad: "x".repeat(2_000_000) });

    const response = await post(h.url, token, huge);

    expect(response.status).toBe(413);
    expect(h.forwarded).toHaveLength(0);
    expect(JSON.stringify(h.drafts)).not.toContain("xxxxxxxxxx");
  });
});

describe("ModelProxy streaming and recording", () => {
  it("relays chunks before the upstream stream closes", async () => {
    let pushSecond: () => void = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        pushSecond = () => {
          controller.enqueue(new TextEncoder().encode("data: second\n\n"));
          controller.close();
        };
      },
    });
    const h = await makeProxy(async () => new Response(stream, { status: 200 }));
    const token = h.proxy.issue("run-1", "agent-1");

    const response = await post(h.url, token, { model: "ep-test" });
    const reader = response.body!.getReader();
    // Must arrive while the upstream is still open. If the proxy buffered the
    // whole response this read would hang until pushSecond() ran.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("first");

    pushSecond();
    const rest = await reader.read();
    expect(new TextDecoder().decode(rest.value)).toContain("second");
  });

  it("records a request anchor before the outcome, sharing one span", async () => {
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1");

    await post(h.url, token, {
      model: "ep-test",
      instructions: "you are an agent",
      tools: [{ name: "exec_command" }],
      input: [{ role: "user", content: "list files" }],
    });
    await h.proxy.settled();

    const calls = h.drafts.filter((draft) => draft.kind === "api_call");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.status).toBe("in_progress");
    expect(calls[0]!.endedAt).toBeNull();
    expect(calls[1]!.status).toBe("ok");
    expect(calls[1]!.spanId).toBe(calls[0]!.spanId);
    expect(calls[0]!.attributes).toMatchObject({
      callIndex: 1,
      inputItems: 1,
      toolCount: 1,
      instructionsBytes: "you are an agent".length,
    });
    expect(Number(calls[0]!.attributes.inputBytes)).toBeGreaterThan(0);
    expect(Number(calls[0]!.attributes.toolsBytes)).toBeGreaterThan(0);
    expect(calls[1]!.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
  });

  it("fingerprints repeated blocks over raw content and never stores them raw", async () => {
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1");
    const body = { model: "ep-test", instructions: "SYSTEM PROMPT BODY", input: [] };

    await post(h.url, token, body);
    await post(h.url, token, body);
    await h.proxy.settled();

    const anchors = h.drafts.filter(
      (draft) => draft.kind === "api_call" && draft.status === "in_progress",
    );
    expect(anchors).toHaveLength(2);
    const first = anchors[0]!.attributes.instructionsRef as string;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(anchors[1]!.attributes.instructionsRef).toBe(first);
    expect(anchors.map((draft) => draft.attributes.callIndex)).toEqual([1, 2]);
  });

  it("relays an upstream error verbatim and records it", async () => {
    const h = await makeProxy(async () => new Response("rate limited", { status: 429 }));
    const token = h.proxy.issue("run-1", "agent-1");

    const response = await post(h.url, token, { model: "ep-test" });
    await h.proxy.settled();

    expect(response.status).toBe(429);
    expect(await response.text()).toBe("rate limited");
    const outcome = h.drafts.filter((d) => d.kind === "api_call").at(-1)!;
    expect(outcome.status).toBe("error");
    expect(outcome.error?.code).toBe("http_429");
  });

  it("reports an unreachable provider as 502 and records it", async () => {
    const h = await makeProxy(async () => {
      throw new Error("ECONNREFUSED");
    });
    const token = h.proxy.issue("run-1", "agent-1");

    const response = await post(h.url, token, { model: "ep-test" });
    await h.proxy.settled();

    expect(response.status).toBe(502);
    const outcome = h.drafts.filter((d) => d.kind === "api_call").at(-1)!;
    expect(outcome.error?.code).toBe("upstream_unreachable");
  });

  it("gives each retry of an identical request its own record", async () => {
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1");
    const body = { model: "ep-test", input: "same" };

    await post(h.url, token, body);
    await post(h.url, token, body);
    await post(h.url, token, body);
    await h.proxy.settled();

    const anchors = h.drafts.filter(
      (draft) => draft.kind === "api_call" && draft.status === "in_progress",
    );
    expect(anchors.map((draft) => draft.attributes.callIndex)).toEqual([1, 2, 3]);
    expect(new Set(anchors.map((draft) => draft.spanId)).size).toBe(3);
  });

  it("keeps the real provider key out of every recorded draft", async () => {
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1");

    await post(h.url, token, { model: "ep-test", input: "hi" });
    await h.proxy.settled();

    expect(JSON.stringify(h.drafts)).not.toContain("sk-real-provider-key");
  });

  it("writes a repeated block once and then only new conversation items", async () => {
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1");
    const instructions = "SYSTEM PROMPT " + "x".repeat(200);

    await post(h.url, token, {
      model: "ep-test",
      instructions,
      input: [{ role: "user", type: "message", content: "first" }],
    });
    await post(h.url, token, {
      model: "ep-test",
      instructions,
      input: [
        { role: "user", type: "message", content: "first" },
        { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}' },
        { type: "function_call_output", output: "a.txt" },
      ],
    });
    await h.proxy.settled();

    const anchors = h.drafts.filter(
      (draft) => draft.kind === "api_call" && draft.status === "in_progress",
    );
    const first = anchors[0]!.input.text ?? "";
    const second = anchors[1]!.input.text ?? "";

    // Written once, to the side store; the 20 KB system prompt must neither
    // repeat every turn nor sit inline in the event.
    expect(h.sidecars.map((entry) => entry.label)).toEqual(["instructions"]);
    expect(h.sidecars[0]!.text).toContain("SYSTEM PROMPT");
    expect(first).not.toContain("SYSTEM PROMPT");
    expect(first).toContain("instructions-");
    expect(second).toContain("same as #1");

    // Only the items this turn added.
    expect(first).toContain("first");
    expect(second).not.toContain("input[0]");
    expect(second).toContain("input[+2]");
  });

  it("renders what a tool call actually asked for", async () => {
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1");

    await post(h.url, token, {
      model: "ep-test",
      input: [
        { type: "function_call", name: "exec_command", arguments: '{"cmd":"printf hi"}' },
        { type: "function_call_output", output: "done" },
      ],
    });
    await h.proxy.settled();

    const anchor = h.drafts.find(
      (draft) => draft.kind === "api_call" && draft.status === "in_progress",
    )!;
    expect(anchor.input.text).toContain("exec_command");
    expect(anchor.input.text).toContain("printf hi");
    expect(anchor.input.text).toContain("done");
  });

  it("records native exec command output from the next model request", async () => {
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1");

    await post(h.url, token, {
      model: "ep-test",
      input: [
        {
          type: "function_call",
          call_id: "call_validate",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: "python3 /codex-home/skills/.system/skill-creator/scripts/quick_validate.py /common-workspace/skills/codex-ppt",
          }),
        },
        {
          type: "function_call_output",
          call_id: "call_validate",
          output: [
            "Chunk ID: abc123",
            "Wall time: 0.0526 seconds",
            "Process exited with code 1",
            "Output:",
            "ModuleNotFoundError: No module named 'yaml'",
          ].join("\n"),
        },
      ],
    });
    await h.proxy.settled();

    const command = h.drafts.find((draft) =>
      draft.kind === "command" &&
      draft.spanId === "call_validate" &&
      draft.attributes.source === "model_proxy_request"
    );
    expect(command).toMatchObject({
      status: "error",
      input: {
        command: expect.stringContaining("quick_validate.py /common-workspace/skills/codex-ppt"),
      },
      output: {
        exitCode: 1,
        text: expect.stringContaining("ModuleNotFoundError: No module named 'yaml'"),
      },
      error: {
        code: "1",
        message: expect.stringContaining("Output tail:"),
      },
    });
  });

  it("does not re-record native tool outputs from unchanged request history", async () => {
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1");
    const history = [
      {
        type: "function_call",
        call_id: "call_ls",
        name: "exec_command",
        arguments: '{"cmd":"ls /nope"}',
      },
      {
        type: "function_call_output",
        call_id: "call_ls",
        output: "Process exited with code 2\nOutput:\nNo such file or directory",
      },
    ];

    await post(h.url, token, { model: "ep-test", input: history });
    await post(h.url, token, {
      model: "ep-test",
      input: [...history, { role: "user", type: "message", content: "continue" }],
    });
    await h.proxy.settled();

    const recorded = h.drafts.filter((draft) =>
      draft.kind === "command" &&
      draft.spanId === "call_ls" &&
      draft.attributes.source === "model_proxy_request"
    );
    expect(recorded).toHaveLength(1);
  });

  it("spills a large repeated block to a side file instead of the event", async () => {
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1");
    const instructions = "SYSTEM PROMPT " + "y".repeat(30_000);

    await post(h.url, token, {
      model: "ep-test",
      instructions,
      input: [{ role: "user", type: "message", content: "go" }],
    });
    await h.proxy.settled();

    // The 20 KB system prompt would otherwise blow the event field cap on the
    // first call of every Run and take the conversation items down with it.
    expect(h.sidecars).toHaveLength(1);
    expect(h.sidecars[0]!.label).toBe("instructions");
    expect(h.sidecars[0]!.text).toBe(instructions);

    const anchor = h.drafts.find(
      (draft) => draft.kind === "api_call" && draft.status === "in_progress",
    )!;
    const rendered = anchor.input.text ?? "";
    expect(rendered).not.toContain("yyyyyyyyyy");
    expect(rendered).toContain("instructions-");
    expect(rendered).toContain(".txt");
    expect(rendered).toContain("input[0] user: go");
    expect(rendered.length).toBeLessThan(2_000);
  });
});

describe("ModelProxy root control and 429 retry", () => {
  it("cancels a stalled upstream body at the root deadline and preserves partial usage", async () => {
    const { RunControl } = await import("../src/orchestration/run-control.js");
    const { defaultExecutionPolicy } = await import("../src/orchestration/policies.js");
    const control = new RunControl({ ...defaultExecutionPolicy, rootTimeoutMs: 80 });
    let readerCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":4}}}\n\n',
          ),
        );
      },
      cancel() {
        readerCancelled = true;
      },
    });
    const h = await makeProxy(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const token = h.proxy.issue("run-1", "agent-1", control, "root");
    const pending = post(h.url, token, { model: "ep-test" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    control.stop("root_deadline", "Root deadline elapsed");
    await pending.catch(() => undefined);
    await h.proxy.settled();
    expect(readerCancelled).toBe(true);
    const outcome = h.drafts.filter((draft) => draft.kind === "api_call").at(-1);
    expect(outcome?.usage).toMatchObject({ inputTokens: 9, outputTokens: 4 });
    expect(() => control.assertActive()).toThrow();
    control.close();
  });

  it("denies a follow-up proxy call after terminalError is latched", async () => {
    const { RunControl } = await import("../src/orchestration/run-control.js");
    const { defaultExecutionPolicy } = await import("../src/orchestration/policies.js");
    const control = new RunControl(defaultExecutionPolicy);
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1", control, "root");
    control.stop("root_deadline", "done");
    const response = await post(h.url, token, { model: "ep-test" });
    expect(response.status).toBe(409);
    expect(h.forwarded).toHaveLength(0);
    control.close();
  });

  it("returns a controlled denial when admission trips the emergency token fuse", async () => {
    const { RunControl } = await import("../src/orchestration/run-control.js");
    const { defaultExecutionPolicy } = await import("../src/orchestration/policies.js");
    const control = new RunControl({
      ...defaultExecutionPolicy,
      emergencyTokenFuse: 200,
    });
    const h = await makeProxy(ok);
    const token = h.proxy.issue("run-1", "agent-1", control, "root");

    const response = await post(h.url, token, { model: "ep-test", input: "hi" });
    await h.proxy.settled();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { message: "emergency_token_fuse" },
    });
    expect(h.forwarded).toHaveLength(0);
    expect(control.snapshot().terminalReason).toBe("emergency_token_fuse");
    const calls = h.drafts.filter((draft) => draft.kind === "api_call");
    expect(calls).toHaveLength(2);
    expect(calls.at(-1)).toMatchObject({
      status: "error",
      error: {
        code: "emergency_token_fuse",
        message: "Emergency token fuse reached",
      },
    });
    control.close();
  });

  it("retries a 429 once with Retry-After and records two provider attempts", async () => {
    const { RunControl } = await import("../src/orchestration/run-control.js");
    const { defaultExecutionPolicy } = await import("../src/orchestration/policies.js");
    const control = new RunControl({ ...defaultExecutionPolicy, rootTimeoutMs: 60_000 });
    let attempts = 0;
    const h = await makeProxy(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("slow", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return ok();
    });
    const token = h.proxy.issue("run-1", "agent-1", control, "root");
    const response = await post(h.url, token, { model: "ep-test" });
    await h.proxy.settled();
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    const anchors = h.drafts.filter(
      (draft) => draft.kind === "api_call" && draft.status === "in_progress",
    );
    expect(anchors).toHaveLength(2);
    control.close();
  });

  it("does not retry a 429 from status alone", async () => {
    const { RunControl } = await import("../src/orchestration/run-control.js");
    const { defaultExecutionPolicy } = await import("../src/orchestration/policies.js");
    const control = new RunControl(defaultExecutionPolicy);
    let attempts = 0;
    const h = await makeProxy(async () => {
      attempts += 1;
      return new Response("rate limited", { status: 429 });
    });
    const token = h.proxy.issue("run-1", "agent-1", control, "root");
    const response = await post(h.url, token, { model: "ep-test" });
    await h.proxy.settled();
    expect(attempts).toBe(1);
    expect(control.snapshot().terminalReason).toBe("provider_rate_limited");
    expect(response.status).toBe(429);
    control.close();
  });

  it("admits two overlapping proxied calls without tripping the emergency fuse", async () => {
    const { RunControl } = await import("../src/orchestration/run-control.js");
    const { defaultExecutionPolicy } = await import("../src/orchestration/policies.js");
    const control = new RunControl(defaultExecutionPolicy);
    let inFlight = 0;
    let peak = 0;
    const h = await makeProxy(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return ok();
    });
    const token = h.proxy.issue("run-1", "agent-1", control, "root");
    const [first, second] = await Promise.all([
      post(h.url, token, { model: "ep-test", input: "one" }),
      post(h.url, token, { model: "ep-test", input: "two" }),
    ]);
    await h.proxy.settled();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(peak).toBe(2);
    expect(control.snapshot().terminalReason).toBeNull();
    control.close();
  });
});
