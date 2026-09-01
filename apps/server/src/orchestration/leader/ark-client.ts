import type { AppConfig } from "../../config.js";
import type { RunEventDraft, RunEventSink } from "../../run-events.js";
import type { RunUsage } from "../../types.js";
import {
  publishBudgetAdmission,
  publishBudgetReconciliation,
} from "../workers/budget-events.js";
import { rateLimitDecision } from "./rate-limit.js";
import { RunTerminalError, type RunControl } from "../run-control.js";

export interface ArkChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ArkCompletion {
  text: string;
  usage: RunUsage | null;
  model: string;
}

/**
 * Identifies one leader model call in a Run's trace.
 *
 * The leader's planning/evaluation/replanning/synthesis calls are the only
 * model traffic the control plane issues itself, so they are the only calls it
 * can record request and response for. Codex's own model calls happen inside
 * the Runtime container and are visible only as aggregated usage.
 */
export interface ApiCallRecorder {
  sink: RunEventSink;
  /** Orchestration iteration this call belongs to; 0 before the first one. */
  iteration?: number;
  control?: RunControl;
  budgetScopeId?: string;
}

export interface ApiCallContext {
  sink: RunEventSink;
  /** Call role, e.g. "planner", "planner_repair", "evaluator". */
  label: string;
  /** Orchestration iteration, so repeated roles get distinct spans. */
  iteration?: number;
  /** 1 for the first try of a call, 2 for a repair retry. */
  attempt?: number;
  control?: RunControl;
  budgetScopeId?: string;
}

export class ArkRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super("Ark request timed out after " + timeoutMs + " ms");
    this.name = "ArkRequestTimeoutError";
  }
}

export function apiCallContext(
  recorder: ApiCallRecorder | undefined,
  label: string,
  attempt: number,
): ApiCallContext | undefined {
  if (!recorder) return undefined;
  return {
    sink: recorder.sink,
    label,
    iteration: recorder.iteration ?? 0,
    attempt,
    ...(recorder.control === undefined ? {} : { control: recorder.control }),
    ...(recorder.budgetScopeId === undefined ? {} : { budgetScopeId: recorder.budgetScopeId }),
  };
}

export class ArkClient {
  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async completeJson(
    messages: ArkChatMessage[],
    context?: ApiCallContext,
  ): Promise<ArkCompletion> {
    context?.control?.assertActive();
    let lastError: unknown;
    for (const providerAttempt of [1, 2] as const) {
      const attemptContext = context === undefined
        ? undefined
        : { ...context, attempt: context.attempt ?? providerAttempt };
      try {
        return await this.completeOnce(messages, attemptContext, providerAttempt);
      } catch (error) {
        lastError = error;
        if (error instanceof RetryableRateLimit && providerAttempt === 1) {
          await delay(error.delayMs, context?.control);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  private async completeOnce(
    messages: ArkChatMessage[],
    context: ApiCallContext | undefined,
    attempt: 1 | 2,
  ): Promise<ArkCompletion> {
    const startedAt = new Date().toISOString();
    const start = Date.now();
    let httpStatus: number | null = null;
    let partialUsage: RunUsage | null = null;
    this.record(context, {
      startedAt,
      endedAt: null,
      durationMs: null,
      messages,
      endpoint: this.endpointPath(),
      httpStatus: null,
      model: this.config.arkModel,
      outputText: null,
      usage: null,
      error: null,
      status: "in_progress",
    });
    const reservation = this.admit(messages, context);
    try {
      const completion = await this.send(
        messages,
        context,
        attempt,
        (status, usage) => {
          httpStatus = status;
          if (usage) partialUsage = usage;
        },
        reservation?.maxOutput,
      );
      this.settleBudget(reservation?.reservation, context, completion.usage);
      this.record(context, {
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - start,
        messages,
        endpoint: this.endpointPath(),
        httpStatus,
        model: completion.model,
        outputText: completion.text,
        usage: completion.usage,
        error: null,
        status: "ok",
      });
      return completion;
    } catch (error) {
      if (reservation && (error instanceof RunTerminalError || partialUsage)) {
        this.settleBudget(reservation.reservation, context, partialUsage);
      } else if (reservation) {
        context?.control?.budget.release(reservation.reservation);
      }
      this.record(context, {
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - start,
        messages,
        endpoint: this.endpointPath(),
        httpStatus,
        model: this.config.arkModel,
        outputText: error instanceof Error ? error.message : String(error),
        usage: partialUsage,
        error: errorCode(httpStatus, error),
        status: "error",
      });
      throw error;
    }
  }

  /** The path this client will use, decided by the configured API dialect. */
  private endpointPath(): string {
    return this.config.arkApiFormat === "chat_completions"
      ? "/chat/completions"
      : "/responses";
  }

  private admit(messages: ArkChatMessage[], context: ApiCallContext | undefined) {
    const control = context?.control;
    if (!control) return undefined;
    const estimatedInput = Math.ceil(JSON.stringify(messages).length / 4);
    const maxOutput = control.budget.safeMaxOutputTokens(estimatedInput);
    const reservation = control.budget.reserve(
      context?.budgetScopeId ?? "root",
      estimatedInput,
      maxOutput,
    );
    publishBudgetAdmission({
      sink: context?.sink,
      reservation,
      snapshot: control.snapshot(),
    });
    return { reservation, maxOutput };
  }

  private settleBudget(
    reservation: ReturnType<NonNullable<ApiCallContext["control"]>["budget"]["reserve"]> | undefined,
    context: ApiCallContext | undefined,
    usage: RunUsage | null,
  ): void {
    const control = context?.control;
    if (!control || !reservation) return;
    if (usage) {
      const notices = control.budget.reconcile(reservation, usage);
      publishBudgetReconciliation({
        sink: context?.sink,
        notices,
        snapshot: control.snapshot(),
      });
      return;
    }
    control.budget.release(reservation);
  }

  private async send(
    messages: ArkChatMessage[],
    context: ApiCallContext | undefined,
    attempt: 1 | 2,
    onStatus: (status: number, usage: RunUsage | null) => void,
    reservedMaxOutput?: number,
  ): Promise<ArkCompletion> {
    const controller = new AbortController();
    const timeoutMs = this.config.orchestrationModelTimeoutMs;
    const chatCompletions = this.config.arkApiFormat === "chat_completions";
    const url = this.config.arkBaseUrl + this.endpointPath();
    const maxOutput = reservedMaxOutput;
    const payload = chatCompletions
      ? {
          model: this.config.arkModel,
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          temperature: 0.2,
          response_format: { type: "json_object" },
          ...(this.config.orchestrationReasoningEnabled
            ? {}
            : { reasoning: { enabled: false } }),
          ...(maxOutput === undefined ? {} : { max_tokens: maxOutput }),
        }
      : {
          model: this.config.arkModel,
          input: messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          temperature: 0.2,
          text: { format: { type: "json_object" } },
          ...(maxOutput === undefined ? {} : { max_output_tokens: maxOutput }),
        };
    const body = JSON.stringify(payload);
    let timedOut = false;
    let timeout: NodeJS.Timeout | null = null;
    let raw = "";
    const timeoutError = (): Error => new ArkRequestTimeoutError(timeoutMs ?? 0);
    const deadline = timeoutMs === null
      ? null
      : new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(timeoutError());
          }, timeoutMs);
          timeout.unref();
        });

    const exchange = async (): Promise<ArkCompletion> => {
      const response = await this.fetchImpl(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: "Bearer " + this.config.arkApiKey,
          "Content-Type": "application/json",
        },
        body,
      });
      raw = await readResponseBody(response, controller.signal, (chunk) => {
        raw = chunk;
        const nextUsage = parsePartialUsage(raw);
        if (nextUsage) onStatus(response.status, nextUsage);
      });
      const usage = parsePartialUsage(raw);
      onStatus(response.status, usage);
      if (response.status === 429) {
        if (!context?.control) {
          throw new Error(
            "Ark request failed with status 429" + (raw ? ": " + raw.slice(0, 500) : ""),
          );
        }
        const decision = rateLimitDecision({
          status: 429,
          retryAfter: response.headers.get("retry-after"),
          responseBody: raw,
          attempt,
          remainingMs: Math.max(0, context.control.remainingMs() - (timeoutMs ?? 0)),
        });
        if (decision.retry) {
          throw new RetryableRateLimit(decision.delayMs);
        }
        throw context.control.stop(
          "provider_rate_limited",
          "Provider rate limited",
        );
      }
      if (!response.ok) {
        throw new Error(
          "Ark request failed with status " +
            response.status +
            (raw ? ": " + raw.slice(0, 500) : ""),
        );
      }
      const parsed = parseJsonObject(raw) ?? {};
      const text = chatCompletions ? chatCompletionText(parsed) : responseText(parsed);
      if (text.trim().length === 0) {
        throw new Error("Ark response did not include completion content");
      }
      return {
        text,
        usage: parseUsage(parsed.usage) ?? usage,
        model: typeof parsed.model === "string" ? parsed.model : this.config.arkModel,
      };
    };

    const runExchange = async (): Promise<ArkCompletion> => {
      try {
        return await (deadline === null ? exchange() : Promise.race([exchange(), deadline]));
      } catch (error) {
        if (error instanceof RetryableRateLimit || error instanceof RunTerminalError) throw error;
        if (timedOut) throw timeoutError();
        if (error instanceof Error && error.name === "AbortError") {
          if (context?.control) {
            try {
              context.control.assertActive();
            } catch (terminal) {
              throw terminal;
            }
          }
          if (timeoutMs !== null) throw timeoutError();
          throw error;
        }
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };

    if (context?.control) {
      return await context.control.race(runExchange(), () => new Promise<void>((resolve) => {
        queueMicrotask(() => {
          controller.abort();
          resolve();
        });
      }));
    }
    return await runExchange();
  }

  /**
   * Best-effort: a failure to record must never fail the call it describes.
   *
   * Request and response go in the canonical `input.text`/`output.text` fields
   * so the sink's existing redaction and truncation apply unchanged. The
   * Authorization header is never part of the draft.
   */
  private record(context: ApiCallContext | undefined, call: RecordedCall): void {
    if (!context) return;
    const iteration = context.iteration ?? 0;
    const attempt = context.attempt ?? 1;
    const draft: RunEventDraft = {
      spanId: "api-" + context.label + "-" + iteration + "-" + attempt,
      parentSpanId: "run",
      kind: "api_call",
      name: context.label,
      status: call.status,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      durationMs: call.durationMs,
      input: { text: renderMessages(call.messages) },
      output: call.outputText === null ? {} : { text: call.outputText },
      error:
        call.error === null
          ? null
          : { message: call.outputText ?? call.error, code: call.error },
      attributes: {
        endpoint: call.endpoint,
        model: call.model,
        iteration,
        attempt,
        ...(call.httpStatus === null ? {} : { httpStatus: call.httpStatus }),
      },
      usage: call.usage,
    };
    try {
      context.sink.emit(draft);
    } catch {
      // Recording is observability, not the work itself.
    }
  }
}

interface RecordedCall {
  startedAt: string;
  endedAt: string | null;
  /**
   * The path this call actually used. Passed in from the request path rather
   * than re-derived here: a field restated at the recording site drifts from
   * the behaviour it claims to describe the moment routing changes.
   */
  endpoint: string;
  durationMs: number | null;
  messages: ArkChatMessage[];
  httpStatus: number | null;
  model: string;
  outputText: string | null;
  usage: RunUsage | null;
  error: string | null;
  status: RunEventDraft["status"];
}

function renderMessages(messages: ArkChatMessage[]): string {
  return messages.map((message) => message.role + ": " + message.content).join("\n\n");
}

function errorCode(httpStatus: number | null, error: unknown): string {
  if (error instanceof RunTerminalError) return error.reason;
  if (httpStatus !== null && httpStatus >= 400) return "http_" + httpStatus;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("timed out")) return "timeout";
  if (message.includes("did not include completion content")) return "empty_response";
  return "request_failed";
}

class RetryableRateLimit extends Error {
  constructor(readonly delayMs: number) {
    super("retryable_rate_limit");
    this.name = "RetryableRateLimit";
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

async function readResponseBody(
  response: Response,
  signal: AbortSignal,
  onChunk: (raw: string) => void,
): Promise<string> {
  const body = response.body;
  if (!body) return await response.text().catch(() => "");
  const decoder = new TextDecoder();
  let raw = "";
  const reader = body.getReader();
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      raw += decoder.decode(result.value, { stream: true });
      onChunk(raw);
    }
    raw += decoder.decode();
    onChunk(raw);
  } catch (error) {
    if (signal.aborted) return raw;
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  return raw;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parsePartialUsage(raw: string): RunUsage | null {
  const parsed = parseJsonObject(raw);
  if (parsed) {
    const fromObject = parseUsage(parsed.usage) ?? parseUsage(parsed);
    if (fromObject) return fromObject;
  }
  const inputMatch = raw.match(/"(?:input|prompt)_tokens"\s*:\s*(\d+)/);
  const outputMatch = raw.match(/"(?:output|completion)_tokens"\s*:\s*(\d+)/);
  if (!inputMatch && !outputMatch) return null;
  return {
    ...(inputMatch ? { inputTokens: Number(inputMatch[1]) } : {}),
    ...(outputMatch ? { outputTokens: Number(outputMatch[1]) } : {}),
  };
}

export function responseText(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string") return body.output_text;
  const output = body.output;
  if (!Array.isArray(output)) return "";
  const chunks: string[] = [];
  for (const item of output) {
    if (item === null || typeof item !== "object") continue;
    const outputItem = item as Record<string, unknown>;
    if (outputItem.type !== "message") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part === null || typeof part !== "object") continue;
      const outputPart = part as Record<string, unknown>;
      if (outputPart.type !== "output_text") continue;
      const text = outputPart.text;
      if (typeof text === "string") chunks.push(text);
    }
  }
  return chunks.join("");
}

export function chatCompletionText(body: Record<string, unknown>): string {
  const choices = body.choices;
  if (!Array.isArray(choices)) return "";
  const chunks: string[] = [];
  for (const choice of choices) {
    if (choice === null || typeof choice !== "object") continue;
    const message = (choice as Record<string, unknown>).message;
    if (message === null || typeof message !== "object") continue;
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") {
      chunks.push(content);
      continue;
    }
    // Some providers return content as an array of parts.
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part === null || typeof part !== "object") continue;
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") chunks.push(text);
      }
    }
  }
  return chunks.join("");
}

function parseUsage(raw: unknown): RunUsage | null {
  if (raw === null || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const input =
    typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : typeof usage.input_tokens === "number"
        ? usage.input_tokens
        : undefined;
  const output =
    typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : typeof usage.output_tokens === "number"
        ? usage.output_tokens
        : undefined;
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
  return input === undefined && output === undefined
    ? null
    : {
        ...(input === undefined ? {} : { inputTokens: input }),
        ...(output === undefined ? {} : { outputTokens: output }),
        ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
      };
}
