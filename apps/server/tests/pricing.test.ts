/** Covers cost estimation and OpenRouter rate parsing. */
import { describe, expect, it } from "vitest";
import {
  estimateCost,
  fetchOpenRouterPricing,
  isOpenRouter,
  parseOpenRouterModel,
  resolvePricing,
} from "../src/pricing.js";
import { loadConfig } from "../src/config.js";
import type { ModelPricing } from "../src/pricing.js";

const RATES: ModelPricing = {
  inputPerMillion: 0.04,
  outputPerMillion: 0.08,
  cachedInputPerMillion: 0.008,
  source: "provider",
};

describe("estimateCost", () => {
  it("charges cached input at the cheaper rate", () => {
    const result = estimateCost(
      { inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: 0 },
      RATES,
    );
    // 100k uncached at 0.04/M + 900k cached at 0.008/M
    expect(result?.inputCost).toBeCloseTo(0.004 + 0.0072, 10);
    expect(result?.outputCost).toBe(0);
    expect(result?.totalCost).toBeCloseTo(0.0112, 10);
  });

  it("treats every input token as uncached when nothing was cached", () => {
    const result = estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      RATES,
    );
    expect(result?.inputCost).toBeCloseTo(0.04, 10);
    expect(result?.outputCost).toBeCloseTo(0.08, 10);
    expect(result?.totalCost).toBeCloseTo(0.12, 10);
  });

  it("handles a fully cached prompt", () => {
    const result = estimateCost(
      { inputTokens: 500_000, cachedInputTokens: 500_000, outputTokens: 0 },
      RATES,
    );
    expect(result?.inputCost).toBeCloseTo(0.004, 10);
  });

  it("never charges negative uncached tokens when cached exceeds input", () => {
    const result = estimateCost(
      { inputTokens: 100, cachedInputTokens: 500, outputTokens: 0 },
      RATES,
    );
    expect(result?.inputCost).toBeGreaterThanOrEqual(0);
    expect(result?.totalCost).toBeGreaterThanOrEqual(0);
  });

  it("returns zeros for empty usage", () => {
    expect(estimateCost({}, RATES)).toEqual({
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
    });
  });

  it("returns null without rates", () => {
    expect(estimateCost({ inputTokens: 100 }, null)).toBeNull();
  });

  it("returns null without usage", () => {
    expect(estimateCost(null, RATES)).toBeNull();
  });
});

const ENTRY = {
  id: "deepseek/deepseek-v4-flash-0731",
  context_length: 1_310_720,
  pricing: {
    prompt: "0.00000004",
    completion: "0.00000008",
    input_cache_read: "0.000000008",
  },
};

describe("parseOpenRouterModel", () => {
  it("converts per-token rates to per-million", () => {
    const pricing = parseOpenRouterModel(ENTRY);
    expect(pricing?.inputPerMillion).toBeCloseTo(0.04, 10);
    expect(pricing?.outputPerMillion).toBeCloseTo(0.08, 10);
    expect(pricing?.cachedInputPerMillion).toBeCloseTo(0.008, 10);
    expect(pricing?.contextWindow).toBe(1_310_720);
    expect(pricing?.source).toBe("provider");
  });

  it("falls back to the prompt rate when no cache rate is published", () => {
    const pricing = parseOpenRouterModel({
      ...ENTRY,
      pricing: { prompt: "0.00000004", completion: "0.00000008" },
    });
    expect(pricing?.cachedInputPerMillion).toBeCloseTo(0.04, 10);
  });

  it("returns null for an unusable entry", () => {
    expect(parseOpenRouterModel(null)).toBeNull();
    expect(parseOpenRouterModel({ id: "x" })).toBeNull();
    expect(parseOpenRouterModel({ id: "x", pricing: { prompt: "nope" } })).toBeNull();
  });

  it("applies the override matching the current UTC day", () => {
    const withOverrides = {
      ...ENTRY,
      pricing: {
        ...ENTRY.pricing,
        overrides: [
          {
            utc_days: ["saturday", "sunday"],
            prompt: "0.00000002",
            completion: "0.00000004",
            input_cache_read: "0.000000004",
          },
        ],
      },
    };
    // 2026-08-29 is a Saturday.
    const weekend = parseOpenRouterModel(
      withOverrides,
      new Date("2026-08-29T12:00:00Z"),
    );
    expect(weekend?.inputPerMillion).toBeCloseTo(0.02, 10);
    expect(weekend?.cachedInputPerMillion).toBeCloseTo(0.004, 10);

    // 2026-08-26 is a Wednesday.
    const weekday = parseOpenRouterModel(
      withOverrides,
      new Date("2026-08-26T12:00:00Z"),
    );
    expect(weekday?.inputPerMillion).toBeCloseTo(0.04, 10);
  });

  it("keeps the base rates when no override matches today", () => {
    const pricing = parseOpenRouterModel(
      {
        ...ENTRY,
        pricing: {
          ...ENTRY.pricing,
          overrides: [{ utc_days: ["monday"], prompt: "0.00000002" }],
        },
      },
      new Date("2026-08-26T12:00:00Z"),
    );
    expect(pricing?.inputPerMillion).toBeCloseTo(0.04, 10);
  });
});

const LIST = {
  data: [
    { id: "other/model", pricing: { prompt: "0.000001", completion: "0.000002" } },
    ENTRY,
  ],
};

const okFetch = (body: unknown) => async () => ({
  ok: true,
  json: async () => body,
});

describe("isOpenRouter", () => {
  it("recognises the OpenRouter base URL", () => {
    expect(isOpenRouter("https://openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouter("https://OpenRouter.ai/api/v1/")).toBe(true);
  });

  it("rejects other providers", () => {
    expect(isOpenRouter("https://ark.cn-beijing.volces.com/api/v3")).toBe(false);
    expect(isOpenRouter("not a url")).toBe(false);
  });
});

describe("fetchOpenRouterPricing", () => {
  it("finds the configured model in the list", async () => {
    const pricing = await fetchOpenRouterPricing({
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "deepseek/deepseek-v4-flash-0731",
      fetchImpl: okFetch(LIST),
    });
    expect(pricing?.inputPerMillion).toBeCloseTo(0.04, 10);
    expect(pricing?.contextWindow).toBe(1_310_720);
  });

  it("returns null when the model is absent", async () => {
    const pricing = await fetchOpenRouterPricing({
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "nobody/nothing",
      fetchImpl: okFetch(LIST),
    });
    expect(pricing).toBeNull();
  });

  it("returns null for a non-OpenRouter base URL without calling fetch", async () => {
    let called = false;
    const pricing = await fetchOpenRouterPricing({
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      modelId: "ep-test",
      fetchImpl: async () => {
        called = true;
        return { ok: true, json: async () => LIST };
      },
    });
    expect(pricing).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null instead of throwing when the request fails", async () => {
    const pricing = await fetchOpenRouterPricing({
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "deepseek/deepseek-v4-flash-0731",
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(pricing).toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    const pricing = await fetchOpenRouterPricing({
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "deepseek/deepseek-v4-flash-0731",
      fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    });
    expect(pricing).toBeNull();
  });

  it("returns null on a malformed body", async () => {
    const pricing = await fetchOpenRouterPricing({
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "deepseek/deepseek-v4-flash-0731",
      fetchImpl: okFetch({ nope: true }),
    });
    expect(pricing).toBeNull();
  });

  it("gives up after the timeout rather than hanging", async () => {
    const pricing = await fetchOpenRouterPricing({
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "deepseek/deepseek-v4-flash-0731",
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    });
    expect(pricing).toBeNull();
  });
});

const openRouterEnv = {
  NODE_ENV: "test",
  ARK_MODEL: "deepseek/deepseek-v4-flash-0731",
  ARK_BASE_URL: "https://openrouter.ai/api/v1",
} as const;

describe("resolvePricing", () => {
  it("uses the fetched rates when nothing is configured", async () => {
    const pricing = await resolvePricing(loadConfig({ ...openRouterEnv }), {
      fetchImpl: okFetch(LIST),
    });
    expect(pricing?.source).toBe("provider");
    expect(pricing?.inputPerMillion).toBeCloseTo(0.04, 10);
    expect(pricing?.contextWindow).toBe(1_310_720);
  });

  it("lets configured rates override the fetched ones but keeps the context window", async () => {
    const pricing = await resolvePricing(
      loadConfig({
        ...openRouterEnv,
        ARK_PRICE_INPUT: "1",
        ARK_PRICE_OUTPUT: "2",
      }),
      { fetchImpl: okFetch(LIST) },
    );
    expect(pricing?.source).toBe("config");
    expect(pricing?.inputPerMillion).toBe(1);
    expect(pricing?.outputPerMillion).toBe(2);
    // Cached rate falls back to the input rate when not configured.
    expect(pricing?.cachedInputPerMillion).toBe(1);
    expect(pricing?.contextWindow).toBe(1_310_720);
  });

  it("skips the lookup when it is disabled", async () => {
    let called = false;
    const pricing = await resolvePricing(
      loadConfig({ ...openRouterEnv, ARK_PRICING_LOOKUP: "false" }),
      {
        fetchImpl: async () => {
          called = true;
          return { ok: true, json: async () => LIST };
        },
      },
    );
    expect(called).toBe(false);
    expect(pricing).toBeNull();
  });

  it("ignores a half-configured rate pair", async () => {
    const pricing = await resolvePricing(
      loadConfig({
        NODE_ENV: "test",
        ARK_MODEL: "ep-test",
        ARK_PRICE_INPUT: "1",
      }),
      { fetchImpl: okFetch(LIST) },
    );
    expect(pricing).toBeNull();
  });

  it("returns null when the lookup fails and nothing is configured", async () => {
    const pricing = await resolvePricing(loadConfig({ ...openRouterEnv }), {
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(pricing).toBeNull();
  });
});
