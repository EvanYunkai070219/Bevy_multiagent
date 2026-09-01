/** Estimates model spend from token counts and published provider rates. */
import type { AppConfig } from "./config.js";
import type { RunUsage } from "./types.js";

const PER_MILLION = 1_000_000;

const UTC_DAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** Rates in US dollars per million tokens, which is how providers quote them. */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion: number;
  source: "config" | "provider";
  contextWindow?: number;
}

export interface CostEstimate {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

/**
 * Estimate what a turn cost.
 *
 * Cached input is billed at a fraction of the normal prompt rate -- often a
 * thirtieth -- so charging every input token at the full rate would overstate
 * spend by an order of magnitude. `inputTokens` already includes the cached
 * portion, so the uncached remainder is what pays full price.
 */
export function estimateCost(
  usage: RunUsage | null,
  pricing: ModelPricing | null,
): CostEstimate | null {
  if (usage === null || pricing === null) return null;

  const input = usage.inputTokens ?? 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  const uncached = Math.max(input - cached, 0);
  const output = usage.outputTokens ?? 0;

  const inputCost =
    (uncached * pricing.inputPerMillion) / PER_MILLION +
    (cached * pricing.cachedInputPerMillion) / PER_MILLION;
  const outputCost = (output * pricing.outputPerMillion) / PER_MILLION;

  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

function readRate(source: Record<string, unknown>, key: string): number | null {
  const raw = source[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pick the rate table in force today.
 *
 * Some models are cheaper on weekends, published as `overrides` keyed by UTC
 * weekday. Ignoring them would make the estimate wrong by a factor of two on
 * exactly the days somebody is most likely to be demoing.
 */
function ratesForToday(
  pricing: Record<string, unknown>,
  now: Date,
): Record<string, unknown> {
  const overrides = pricing.overrides;
  if (!Array.isArray(overrides)) return pricing;
  const today = UTC_DAYS[now.getUTCDay()];
  for (const entry of overrides) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    const days = candidate.utc_days;
    if (!Array.isArray(days)) continue;
    if (days.some((day) => String(day).toLowerCase() === today)) {
      return { ...pricing, ...candidate };
    }
  }
  return pricing;
}

/** Map one entry of OpenRouter's public model list into our rate shape. */
export function parseOpenRouterModel(
  entry: unknown,
  now: Date = new Date(),
): ModelPricing | null {
  if (entry === null || typeof entry !== "object") return null;
  const model = entry as Record<string, unknown>;
  const rawPricing = model.pricing;
  if (rawPricing === null || typeof rawPricing !== "object") return null;

  const rates = ratesForToday(rawPricing as Record<string, unknown>, now);
  const prompt = readRate(rates, "prompt");
  const completion = readRate(rates, "completion");
  if (prompt === null || completion === null) return null;

  const cacheRead = readRate(rates, "input_cache_read");
  const contextLength = model.context_length;

  return {
    inputPerMillion: prompt * PER_MILLION,
    outputPerMillion: completion * PER_MILLION,
    cachedInputPerMillion: (cacheRead ?? prompt) * PER_MILLION,
    source: "provider",
    ...(typeof contextLength === "number" && contextLength > 0
      ? { contextWindow: contextLength }
      : {}),
  };
}

const OPENROUTER_HOST = "openrouter.ai";
const MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_TIMEOUT_MS = 5_000;

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export function isOpenRouter(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === OPENROUTER_HOST;
  } catch {
    return false;
  }
}

/**
 * Look up published rates for the configured model.
 *
 * The model list is public, so this never sends the API key. Every failure
 * path returns null: rates are a convenience, and a provider being unreachable
 * must not stop the platform from starting.
 */
export async function fetchOpenRouterPricing(options: {
  baseUrl: string;
  modelId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: Date;
}): Promise<ModelPricing | null> {
  if (!isOpenRouter(options.baseUrl) || !options.modelId) return null;

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== "function") return null;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(MODELS_URL, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return null;
    const entry = body.data.find(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        (item as Record<string, unknown>).id === options.modelId,
    );
    if (entry === undefined) return null;
    return parseOpenRouterModel(entry, options.now);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Decide which rates to use.
 *
 * The lookup and the explicit configuration are independent: the lookup also
 * reports the model's context window, so it still runs when rates are
 * configured by hand. Configured rates simply win on the numbers.
 */
export async function resolvePricing(
  config: AppConfig,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; now?: Date } = {},
): Promise<ModelPricing | null> {
  const fetched = config.arkPricingLookup
    ? await fetchOpenRouterPricing({
        baseUrl: config.arkBaseUrl,
        modelId: config.arkModel,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
      })
    : null;

  const input = config.arkPriceInput;
  const output = config.arkPriceOutput;
  if (input === null || output === null) {
    if (input !== null || output !== null || config.arkPriceCachedInput !== null) {
      // Half a rate table produces a confidently wrong number, which is worse
      // than showing no number at all.
      console.warn(
        "[launchpad] Ignoring partial rate configuration: set both ARK_PRICE_INPUT and ARK_PRICE_OUTPUT.",
      );
    }
    return fetched;
  }

  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cachedInputPerMillion: config.arkPriceCachedInput ?? input,
    source: "config",
    ...(fetched?.contextWindow === undefined
      ? {}
      : { contextWindow: fetched.contextWindow }),
  };
}
