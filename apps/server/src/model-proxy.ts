/**
 * Model egress proxy.
 *
 * Codex issues its model calls from inside the Runtime container, so the
 * control plane cannot observe them from beside the path — only from on it.
 * This puts it on the path: the generated `config.toml` points Codex here, and
 * every call is recorded before it is forwarded to the real provider.
 *
 * Two consequences follow from that position and are deliberate:
 *
 * - The real provider key never enters the container. Containers carry a
 *   per-Run token that is meaningless anywhere else, which is also how a
 *   request is attributed to a Run.
 * - This component is in the Run's critical path. It runs in the control-plane
 *   process: if it is down, no Run could have started anyway.
 *
 * It records and forwards. It does not rewrite requests or decide policy.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import type { RunEventDraft, RunEventSink } from "./run-events.js";
import type { RunUsage } from "./types.js";
import {
  publishBudgetAdmission,
  publishBudgetReconciliation,
} from "./orchestration/workers/budget-events.js";
import { rateLimitDecision } from "./orchestration/leader/rate-limit.js";
import { RunTerminalError, type RunControl } from "./orchestration/run-control.js";

/** What Codex posts to, under the `/v1` base we hand it in config.toml. */
const INBOUND_PATH = "/v1/responses";
/** Appended to ARK_BASE_URL, which carries the provider's own version segment. */
const UPSTREAM_PATH = "/responses";
const DIGEST_KEYS = ["instructions", "tools"] as const;

interface RunToken {
  runId: string;
  agentId: string;
  sink: RunEventSink;
  calls: number;
  /** Content digest -> the call that first carried it, so bodies repeat once. */
  seen: Map<string, number>;
  /** How many conversation items the previous call already rendered. */
  renderedInputs: number;
  control?: RunControl;
  budgetScopeId?: string;
}

/** The slice of the proxy a Run's lifecycle needs. Keeps callers off the server. */
export interface ModelCredentialIssuer {
  issue(runId: string, agentId: string, control?: RunControl, budgetScopeId?: string): string;
  revoke(runId: string): void;
  terminalError(runId: string): RunTerminalError | undefined;
}

export interface ModelProxyDeps {
  config: AppConfig;
  createSink: (runId: string, agentId: string) => RunEventSink;
  /**
   * Persists a large repeated block beside the Run's log and returns its file
   * name. `instructions` alone is ~21 KB and would blow the event field cap on
   * the first call of every Run, taking the conversation items with it.
   * Without one, the body is rendered inline and may be truncated.
   */
  saveSidecar?: (
    runId: string,
    label: string,
    digest: string,
    text: string,
  ) => string;
  fetchImpl?: typeof fetch;
}

export class ModelProxy {
  private readonly tokens = new Map<string, RunToken>();
  private readonly byRun = new Map<string, string>();
  private readonly inFlight = new Set<Promise<void>>();
  private server: Server | null = null;
  private port = 0;

  constructor(private readonly deps: ModelProxyDeps) {}

  /** Base URL to write into the generated Codex config. */
  baseUrl(host: string): string {
    return "http://" + host + ":" + this.port + "/v1";
  }

  issue(runId: string, agentId: string, control?: RunControl, budgetScopeId?: string): string {
    this.revoke(runId);
    const token = randomBytes(24).toString("hex");
    this.tokens.set(token, {
      runId,
      agentId,
      sink: this.deps.createSink(runId, agentId),
      calls: 0,
      seen: new Map(),
      renderedInputs: 0,
      ...(control === undefined ? {} : { control }),
      ...(budgetScopeId === undefined ? {} : { budgetScopeId }),
    });
    this.byRun.set(runId, token);
    return token;
  }

  terminalError(runId: string): RunTerminalError | undefined {
    const token = this.byRun.get(runId);
    const entry = token === undefined ? undefined : this.tokens.get(token);
    try {
      entry?.control?.assertActive();
    } catch (error) {
      return error as RunTerminalError;
    }
    return undefined;
  }

  /**
   * Admission control only. A request that already passed authorisation keeps
   * streaming to completion: cutting it off here would truncate a response
   * mid-flight and record a failure that did not happen. Cancelling work is the
   * runner's job.
   */
  revoke(runId: string): void {
    const token = this.byRun.get(runId);
    if (token === undefined) return;
    this.tokens.delete(token);
    this.byRun.delete(runId);
  }

  async listen(port: number): Promise<number> {
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        if (!response.headersSent) {
          const status = error instanceof RunTerminalError ? 409 : 500;
          send(response, status, error instanceof RunTerminalError ? error.reason : "proxy error");
          return;
        }
        response.destroy(error instanceof Error ? error : undefined);
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Loopback only: the token would otherwise be a network-reachable
      // credential. Containers reach it through the host gateway mapping.
      server.listen(port, "0.0.0.0", resolve);
    });
    const address = server.address();
    this.port = typeof address === "object" && address !== null ? address.port : port;
    return this.port;
  }

  /** Resolves once every recorded call has finished emitting. For tests. */
  async settled(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  async close(): Promise<void> {
    await this.settled();
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = bearer(request.headers.authorization);
    const entry = token === null ? undefined : this.tokens.get(token);
    // Token first, so every attributable denial can be recorded against its Run.
    if (!entry) {
      request.resume();
      return send(response, 401, "unauthorized");
    }
    try {
      entry.control?.assertActive();
    } catch (error) {
      request.resume();
      this.denial(
        entry,
        error instanceof RunTerminalError ? error.reason : "run_terminal",
        error instanceof Error ? error.message : String(error),
      );
      return send(response, 409, "run terminal");
    }
    if (request.method !== "POST") {
      request.resume();
      this.denial(entry, "method_not_allowed", request.method + " is not allowed");
      return send(response, 405, "method not allowed");
    }
    const url = new URL(request.url ?? "/", "http://proxy.invalid");
    if (url.pathname !== INBOUND_PATH) {
      request.resume();
      this.denial(entry, "path_not_allowed", url.pathname + " is not allowed");
      return send(response, 404, "not found");
    }

    let body: string;
    try {
      body = await readBody(request, this.deps.config.maxModelRequestBytes);
    } catch {
      // Drain and discard the remainder: nothing further is buffered, and the
      // client gets a real 413 instead of a reset connection.
      request.resume();
      this.denial(entry, "request_too_large", "request exceeded the size limit");
      return send(response, 413, "payload too large");
    }

    const done = this.forward(entry, body, response);
    this.inFlight.add(done);
    await done.finally(() => this.inFlight.delete(done));
  }

  private async forward(
    entry: RunToken,
    body: string,
    response: ServerResponse,
  ): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    let attempt: 1 | 2 = 1;
    let lastError: unknown;
    while (attempt === 1 || attempt === 2) {
      try {
        await this.forwardAttempt(entry, body, response, fetchImpl, attempt);
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof RetryableRateLimit && attempt === 1) {
          await delay(error.delayMs, entry.control);
          attempt = 2;
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  private async forwardAttempt(
    entry: RunToken,
    body: string,
    response: ServerResponse,
    fetchImpl: typeof fetch,
    attempt: 1 | 2,
  ): Promise<void> {
    entry.calls += 1;
    const index = entry.calls;
    const spanId = "api-codex-" + index;
    const startedAt = new Date().toISOString();
    const start = Date.now();
    const parsed = parseJson(body);
    const digests = fingerprints(parsed);
    const renderedInputs = entry.renderedInputs;
    const requestText = this.renderRequest(parsed, body, entry, index);

    this.emitSafely(entry, {
      spanId,
      parentSpanId: "run",
      kind: "api_call",
      name: "model",
      status: "in_progress",
      startedAt,
      endedAt: null,
      durationMs: null,
      input: { text: requestText },
      output: {},
      error: null,
      attributes: {
        callIndex: index,
        endpoint: "POST " + INBOUND_PATH,
        requestBytes: Buffer.byteLength(body, "utf8"),
        ...requestShape(parsed),
        ...(typeof parsed?.model === "string" ? { model: parsed.model } : {}),
        ...digests,
      },
      usage: null,
    });
    this.recordNativeToolOutputs(entry, parsed, renderedInputs);

    let reservation: ReturnType<NonNullable<RunToken["control"]>["budget"]["reserve"]> | undefined;
    try {
      reservation = this.admit(entry, body);
    } catch (error) {
      if (error instanceof RunTerminalError) {
        this.finish(entry, spanId, index, startedAt, start, {
          httpStatus: null,
          text: error.message,
          usage: null,
          code: error.reason,
          events: 0,
        });
        if (!response.headersSent) send(response, 409, error.reason);
        else response.destroy();
        return;
      }
      throw error;
    }
    let upstream: Response;
    try {
      upstream = await this.performFetch(fetchImpl, body, entry.control);
    } catch (error) {
      if (reservation) entry.control?.budget.release(reservation);
      if (error instanceof RunTerminalError) {
        this.finish(entry, spanId, index, startedAt, start, {
          httpStatus: null,
          text: error.message,
          usage: null,
          code: error.reason,
          events: 0,
        });
        if (!response.headersSent) send(response, 409, error.reason);
        else response.destroy();
        return;
      }
      this.finish(entry, spanId, index, startedAt, start, {
        httpStatus: null,
        text: error instanceof Error ? error.message : String(error),
        usage: null,
        code: "upstream_unreachable",
        events: 0,
      });
      return send(response, 502, "upstream unreachable");
    }

    if (upstream.status === 429 && entry.control) {
      const detail = await upstream.text().catch(() => "");
      const decision = rateLimitDecision({
        status: 429,
        retryAfter: upstream.headers.get("retry-after"),
        responseBody: detail,
        attempt,
          remainingMs: Math.max(
            0,
            entry.control.remainingMs() - (this.deps.config.orchestrationModelTimeoutMs ?? 0),
          ),
      });
      if (reservation) {
        if (decision.retry) entry.control?.budget.release(reservation);
        else this.settle(entry, reservation, parseProxyUsage(detail));
      }
      if (decision.retry) {
        this.finish(entry, spanId, index, startedAt, start, {
          httpStatus: 429,
          text: detail,
          usage: null,
          code: "http_429",
          events: 0,
        });
        throw new RetryableRateLimit(decision.delayMs);
      }
      const limited = entry.control?.stop("provider_rate_limited", "Provider rate limited");
      this.finish(entry, spanId, index, startedAt, start, {
        httpStatus: 429,
        text: detail,
        usage: parseProxyUsage(detail),
        code: limited?.reason ?? "http_429",
        events: 0,
      });
      if (!response.headersSent) {
        response.writeHead(429, passthroughHeaders(upstream));
        response.end(detail);
      }
      return;
    }

    response.writeHead(upstream.status, passthroughHeaders(upstream));
    try {
      const summary = await pipeAndSummarise(upstream, response, entry.control);
      this.settle(entry, reservation, summary.usage);
      this.finish(entry, spanId, index, startedAt, start, {
        httpStatus: upstream.status,
        text: summary.text,
        usage: summary.usage,
        code: upstream.ok ? null : "http_" + upstream.status,
        events: summary.events,
      });
    } catch (error) {
      if (reservation) {
        this.settle(entry, reservation, error instanceof StreamTerminal ? error.usage : null);
      }
      if (error instanceof StreamTerminal || error instanceof RunTerminalError) {
        this.finish(entry, spanId, index, startedAt, start, {
          httpStatus: upstream.status,
          text: error.message,
          usage: error instanceof StreamTerminal ? error.usage : null,
          code: error instanceof RunTerminalError ? error.reason : "root_deadline",
          events: 0,
        });
        response.destroy();
        return;
      }
      throw error;
    }
  }

  private admit(entry: RunToken, body: string) {
    const control = entry.control;
    if (!control) return undefined;
    const estimatedInput = Math.ceil(body.length / 4);
    const maxOutput = control.budget.safeMaxOutputTokens(estimatedInput);
    const reservation = control.budget.reserve(
      entry.budgetScopeId ?? "root",
      estimatedInput,
      maxOutput,
    );
    publishBudgetAdmission({
      sink: entry.sink,
      reservation,
      snapshot: control.snapshot(),
    });
    return reservation;
  }

  private settle(
    entry: RunToken,
    reservation: ReturnType<NonNullable<RunToken["control"]>["budget"]["reserve"]> | undefined,
    usage: RunUsage | null,
  ): void {
    const control = entry.control;
    if (!control || !reservation) return;
    if (usage) {
      const notices = control.budget.reconcile(reservation, usage);
      publishBudgetReconciliation({
        sink: entry.sink,
        notices,
        snapshot: control.snapshot(),
      });
      return;
    }
    control.budget.release(reservation);
  }

  private async performFetch(
    fetchImpl: typeof fetch,
    body: string,
    control: RunControl | undefined,
  ): Promise<Response> {
    const exchange = fetchImpl(this.deps.config.arkBaseUrl + UPSTREAM_PATH, {
      method: "POST",
      headers: {
        authorization: "Bearer " + this.deps.config.arkApiKey,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body,
    });
    if (!control) return await exchange;
    return await control.race(exchange);
  }

  private emitSafely(entry: RunToken, draft: RunEventDraft): void {
    try {
      entry.sink.emit(draft);
    } catch {
      // Observability cannot change terminal or forwarding behavior.
    }
  }

  private finish(
    entry: RunToken,
    spanId: string,
    index: number,
    startedAt: string,
    start: number,
    outcome: {
      httpStatus: number | null;
      text: string;
      usage: RunUsage | null;
      code: string | null;
      events: number;
    },
  ): void {
    this.emitSafely(entry, {
      spanId,
      parentSpanId: "run",
      kind: "api_call",
      name: "model",
      status: outcome.code === null ? "ok" : "error",
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      input: {},
      output: { text: outcome.text },
      error: outcome.code === null ? null : { message: outcome.text, code: outcome.code },
      attributes: {
        callIndex: index,
        ...(outcome.httpStatus === null ? {} : { httpStatus: outcome.httpStatus }),
        responseBytes: Buffer.byteLength(outcome.text, "utf8"),
        streamEvents: outcome.events,
      },
      usage: outcome.usage,
    });
  }

  private renderRequest(
    parsed: Record<string, unknown> | null,
    body: string,
    entry: RunToken,
    index: number,
  ): string {
    return renderRequestWith(this.deps.saveSidecar, parsed, body, entry, index);
  }

  private denial(entry: RunToken, code: string, message: string): void {
    const timestamp = new Date().toISOString();
    entry.sink.emit({
      spanId: "api-denied-" + code + "-" + (entry.calls + 1),
      parentSpanId: "run",
      kind: "api_call",
      name: "denied",
      status: "error",
      startedAt: timestamp,
      endedAt: timestamp,
      durationMs: 0,
      input: {},
      output: {},
      error: { message, code },
      attributes: { denial: true },
      usage: null,
    });
  }

  private recordNativeToolOutputs(
    entry: RunToken,
    parsed: Record<string, unknown> | null,
    from: number,
  ): void {
    const input = parsed?.input;
    if (!Array.isArray(input)) return;
    const callsById = new Map<string, NativeFunctionCall>();
    let lastCall: NativeFunctionCall | null = null;
    const timestamp = new Date().toISOString();
    for (let position = Math.max(0, from); position < input.length; position += 1) {
      const item = input[position];
      if (item === null || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const type = String(record.type ?? "");
      if (type === "function_call") {
        const call = nativeFunctionCall(record, position);
        lastCall = call;
        if (call.callId !== null) callsById.set(call.callId, call);
        continue;
      }
      if (type !== "function_call_output") continue;
      const callId = typeof record.call_id === "string" ? record.call_id : null;
      const call = (callId === null ? null : callsById.get(callId)) ?? lastCall;
      if (!call || !isRecordableNativeTool(call.name)) continue;
      const output = stringify(record.output);
      const exitCode = parseNativeToolExitCode(output);
      const failed = exitCode !== null && exitCode !== 0;
      const command = nativeCommand(call);
      entry.sink.emit({
        spanId: call.callId ?? "native-tool-output-" + entry.calls + "-" + position,
        parentSpanId: "run",
        kind: call.name === "exec_command" || call.name === "write_stdin" ? "command" : "mcp_tool",
        name: call.name === "exec_command" || call.name === "write_stdin" ? "bash" : call.name,
        status: failed ? "error" : "ok",
        startedAt: timestamp,
        endedAt: timestamp,
        durationMs: 0,
        input: command === null ? {} : { command },
        output: {
          text: output,
          ...(exitCode === null ? {} : { exitCode }),
        },
        error: failed
          ? {
              message: [
                (command ?? call.name) + " exited with code " + exitCode,
                "Output tail:\n" + commandOutputTail(output),
              ].join("\n"),
              code: String(exitCode),
            }
          : null,
        attributes: {
          itemType: "function_call_output",
          toolName: call.name,
          source: "model_proxy_request",
        },
        usage: null,
      });
    }
  }
}

interface NativeFunctionCall {
  callId: string | null;
  name: string;
  arguments: unknown;
  position: number;
}

function bearer(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function send(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message } }));
}

/** Reads up to `limit` bytes and rejects rather than buffering past it. */
async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        reject(new Error("too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function passthroughHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  return headers;
}

/**
 * Relays bytes as they arrive while accumulating a summary. Buffering the whole
 * response before relaying would stall Codex, which streams.
 */
async function pipeAndSummarise(
  upstream: Response,
  response: ServerResponse,
  control?: RunControl,
): Promise<{ text: string; usage: RunUsage | null; events: number }> {
  if (!upstream.body) {
    response.end();
    return { text: "", usage: null, events: 0 };
  }
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  try {
    for (;;) {
      const read = control
        ? control.race(reader.read(), () => reader.cancel().then(() => undefined))
        : reader.read();
      const { done, value } = await read;
      if (done) break;
      response.write(Buffer.from(value));
      raw += decoder.decode(value, { stream: true });
    }
    response.end();
    return summarise(raw);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    const usage = summarise(raw).usage;
    if (error instanceof RunTerminalError) {
      throw new StreamTerminal(error.message, usage);
    }
    throw error;
  }
}

class RetryableRateLimit extends Error {
  constructor(readonly delayMs: number) {
    super("retryable_rate_limit");
    this.name = "RetryableRateLimit";
  }
}

class StreamTerminal extends Error {
  constructor(message: string, readonly usage: RunUsage | null) {
    super(message);
    this.name = "StreamTerminal";
  }
}

async function delay(ms: number, control?: RunControl): Promise<void> {
  if (ms <= 0) {
    control?.assertActive();
    return;
  }
  const wait = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
  if (control) await control.race(wait);
  else await wait;
}

function parseProxyUsage(raw: string): RunUsage | null {
  return summarise(raw).usage ?? readUsage(tryParseUsage(raw));
}

function tryParseUsage(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      return (parsed as Record<string, unknown>).usage;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function summarise(raw: string): { text: string; usage: RunUsage | null; events: number } {
  if (!raw.includes("data:")) {
    return { text: raw, usage: null, events: 0 };
  }
  const parts: string[] = [];
  let usage: RunUsage | null = null;
  let events = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    events += 1;
    const payload = parseJson(line.slice(5).trim());
    if (!payload) continue;
    const delta = payload.delta;
    if (typeof delta === "string") parts.push(delta);
    const nested = payload.response;
    const found = readUsage(payload.usage) ?? readUsage(
      nested !== null && typeof nested === "object"
        ? (nested as Record<string, unknown>).usage
        : undefined,
    );
    if (found) usage = found;
  }
  return { text: parts.join(""), usage, events };
}

function readUsage(raw: unknown): RunUsage | null {
  if (raw === null || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (typeof input !== "number" && typeof output !== "number") return null;
  // Both dialects report thinking under a *_tokens_details bag; the key differs
  // by API, the field inside does not.
  const details =
    (usage.completion_tokens_details ?? usage.output_tokens_details) as
      | Record<string, unknown>
      | undefined;
  const reasoning =
    details !== undefined &&
    details !== null &&
    typeof details === "object" &&
    typeof details.reasoning_tokens === "number"
      ? details.reasoning_tokens
      : undefined;
  return {
    ...(typeof input === "number" ? { inputTokens: input } : {}),
    ...(typeof output === "number" ? { outputTokens: output } : {}),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  };
}

/**
 * Digests are taken over raw content, before redaction and truncation:
 * redaction maps distinct secrets to one mask and would collide genuinely
 * different payloads, and truncation would tie the digest to a display limit.
 */
function fingerprints(body: Record<string, unknown> | null): Record<string, string> {
  if (!body) return {};
  const output: Record<string, string> = {};
  for (const key of DIGEST_KEYS) {
    const value = body[key];
    if (value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    output[key + "Ref"] = createHash("sha256").update(text, "utf8").digest("hex");
  }
  return output;
}

function requestShape(body: Record<string, unknown> | null): Record<string, number> {
  if (!body) return {};
  const output: Record<string, number> = {};
  if (typeof body.instructions === "string") {
    output.instructionsBytes = Buffer.byteLength(body.instructions, "utf8");
  }
  if (body.tools !== undefined) {
    output.toolsBytes = Buffer.byteLength(JSON.stringify(body.tools), "utf8");
    if (Array.isArray(body.tools)) output.toolCount = body.tools.length;
  }
  if (body.input !== undefined) {
    const inputText = typeof body.input === "string" ? body.input : JSON.stringify(body.input);
    output.inputBytes = Buffer.byteLength(inputText, "utf8");
    if (Array.isArray(body.input)) output.inputItems = body.input.length;
  }
  return output;
}

/**
 * Human-readable rendering only. Structured values live in `attributes`.
 *
 * Two forms of repetition are collapsed, because a turn resends everything:
 * a block whose digest was already written is referenced by call number, and
 * only conversation items the previous call had not already rendered are shown.
 */
function renderRequestWith(
  save: ModelProxyDeps["saveSidecar"],
  body: Record<string, unknown> | null,
  raw: string,
  entry: RunToken,
  index: number,
): string {
  if (!body) return raw;
  const lines: string[] = [];

  for (const key of DIGEST_KEYS) {
    const value = body[key];
    if (value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    lines.push(...renderOnce(save, key, text, entry, index));
  }

  const input = body.input;
  if (typeof input === "string") {
    lines.push("input: " + input);
  } else if (Array.isArray(input)) {
    const from = Math.min(entry.renderedInputs, input.length);
    if (from > 0) lines.push("input[0.." + (from - 1) + "]: <unchanged>");
    for (let position = from; position < input.length; position += 1) {
      lines.push(renderInputItem(input[position], position, from > 0));
    }
    entry.renderedInputs = input.length;
  }
  return lines.join("\n");
}

/**
 * A pointer once the content has been seen; on first sight, the body goes to a
 * side file so the event stays small, or inline when no store is available.
 */
function renderOnce(
  save: ModelProxyDeps["saveSidecar"],
  label: string,
  text: string,
  entry: RunToken,
  index: number,
): string[] {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  const preview = "sha256:" + digest.slice(0, 12) + "\u2026";
  const first = entry.seen.get(digest);
  if (first !== undefined) {
    return [label + ": <same as #" + first + ", " + preview + ">"];
  }
  entry.seen.set(digest, index);
  if (!save) return [label + ": <" + preview + ">", text];
  const file = save(entry.runId, label, digest, text);
  return [
    label + ": <" + preview + ", " + text.length + " chars> \u2192 " + file,
  ];
}

function renderInputItem(item: unknown, position: number, incremental: boolean): string {
  const label = "input[" + (incremental ? "+" : "") + position + "] ";
  if (item === null || typeof item !== "object") return label + stringify(item);
  const message = item as Record<string, unknown>;
  const type = String(message.type ?? "");
  // A tool call's payload is in name/arguments, not content: rendering only
  // `content` left the most interesting line of the trace blank.
  if (type === "function_call") {
    return label + "function_call: " + String(message.name ?? "?") +
      "(" + stringify(message.arguments) + ")";
  }
  if (type === "function_call_output") {
    return label + "function_call_output: " + stringify(message.output);
  }
  return label + String(message.role ?? (type === "" ? "?" : type)) + ": " + stringify(message.content);
}

function nativeFunctionCall(record: Record<string, unknown>, position: number): NativeFunctionCall {
  return {
    callId: typeof record.call_id === "string" ? record.call_id : null,
    name: String(record.name ?? "tool"),
    arguments: record.arguments,
    position,
  };
}

function isRecordableNativeTool(name: string): boolean {
  return name === "exec_command" || name === "write_stdin";
}

function nativeCommand(call: NativeFunctionCall): string | null {
  if (typeof call.arguments !== "string") return null;
  const parsed = parseJson(call.arguments);
  if (!parsed) return call.arguments;
  const command = parsed.cmd ?? parsed.command;
  return typeof command === "string" ? command : call.arguments;
}

function parseNativeToolExitCode(output: string): number | null {
  const match = output.match(/Process exited with code\s+(-?\d+)/i);
  return match ? Number(match[1]) : null;
}

function commandOutputTail(output: string, limit = 2_000): string {
  const trimmed = output.trim();
  if (trimmed.length <= limit) return trimmed;
  return "... (output tail, original_chars=" + trimmed.length + ")\n" +
    trimmed.slice(trimmed.length - limit);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
