/**
 * Claude pricing in the cost ledgers.
 *
 * Rates are Anthropic's list prices (platform.claude.com/docs/en/about-claude/
 * pricing, read 2026-10-24). Two things the old table got wrong for the
 * current family: Haiku 5.5 was priced as Haiku 4.5 (10x over), which at
 * ~1,100 calls/day trips the $1/day cap ten times too early; and prompt-cache
 * reads/writes were billed as ordinary input, so a cache-heavy workload was
 * over-billed on reads and under-billed on writes (1.25x / 2x).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const recordCostUsage = vi.hoisted(() => vi.fn());
const recordGlobalCostUsage = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({ prisma: {}, db: {} }));
vi.mock("../billing/cost-guard.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordCostUsage,
  recordGlobalCostUsage,
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { trueUpCostLedgers } from "../billing/llm-usage.js";
import {
  estimateModelCostUsd,
  promptCacheUsageOf,
  resolveModelRateUsdPerMTok,
} from "../llm/model-fallback.js";

const M = 1_000_000;

beforeEach(() => {
  recordCostUsage.mockReset();
  recordGlobalCostUsage.mockReset();
});

describe("resolveModelRateUsdPerMTok — Claude family", () => {
  it.each([
    ["claude-haiku-5-5", 0.1, 0.5],
    ["anthropic/claude-haiku-5.5", 0.1, 0.5],
    ["claude-haiku-4-5", 1, 5],
    ["claude-sonnet-5-5", 2, 10],
    ["anthropic/claude-sonnet-4-6", 3, 15],
    ["claude-opus-5-5", 4, 20],
    ["claude-fable-5-1", 10, 50],
    // Review fix: no Mythos row meant the $3/$15 default (3.3x under-billed).
    ["claude-mythos-5-1", 10, 50],
    // Live OpenRouter chat-catalog models keep their (higher) family price in
    // this change — re-pricing them moves production caps; separate change.
    ["anthropic/claude-sonnet-5", 3, 15],
    ["anthropic/claude-opus-4.8", 15, 75],
  ])("%s → $%s in / $%s out per MTok", (model, input, output) => {
    const rate = resolveModelRateUsdPerMTok(model);
    expect(rate.input).toBe(input);
    expect(rate.output).toBe(output);
  });

  it("leaves non-Claude rows untouched", () => {
    expect(resolveModelRateUsdPerMTok("google/gemini-2.5-flash")).toMatchObject({
      input: 0.3,
      output: 2.5,
    });
    expect(resolveModelRateUsdPerMTok("gemini-2.5-flash-lite")).toMatchObject({
      input: 0.25,
      output: 1.5,
    });
  });
});

describe("estimateModelCostUsd — prompt caching", () => {
  it("prices Claude cache reads at the read rate and the rest at base input", () => {
    // 1,000 prompt tokens of which 600 were read from cache.
    const cost = estimateModelCostUsd("claude-haiku-5-5", 1000, 100, { readTokens: 600 });
    expect(cost).toBeCloseTo((400 * 0.1 + 600 * 0.01 + 100 * 0.5) / M, 12);
  });

  it("prices 5-minute writes at 1.25x and 1-hour writes at 2x base input", () => {
    const cost = estimateModelCostUsd("claude-haiku-5-5", 1000, 0, {
      writeTokens: 1000,
      write1hTokens: 400,
    });
    expect(cost).toBeCloseTo((600 * 0.1 * 1.25 + 400 * 0.1 * 2) / M, 12);
  });

  it("uses Sonnet 5.5's 0.05x read multiplier", () => {
    const cost = estimateModelCostUsd("claude-sonnet-5-5", 1000, 0, { readTokens: 1000 });
    expect(cost).toBeCloseTo((1000 * 2 * 0.05) / M, 12);
  });

  it("keeps billing a non-Claude model's cached tokens as full input (unchanged behaviour)", () => {
    const withCache = estimateModelCostUsd("google/gemini-2.5-flash", 1000, 0, {
      readTokens: 600,
    });
    expect(withCache).toBeCloseTo(estimateModelCostUsd("google/gemini-2.5-flash", 1000, 0), 12);
  });

  it("switches Haiku 5.5 to its long-context prices above 100,000 prompt tokens", () => {
    expect(estimateModelCostUsd("claude-haiku-5-5", 150_000, 1000)).toBeCloseTo(
      (150_000 * 0.5 + 1000 * 2.5) / M,
      12,
    );
    expect(estimateModelCostUsd("claude-haiku-5-5", 100_000, 0)).toBeCloseTo(
      (100_000 * 0.1) / M,
      12,
    );
  });

  it("never prices cache detail above the prompt total (defensive clamp)", () => {
    const cost = estimateModelCostUsd("claude-haiku-5-5", 100, 0, { readTokens: 5000 });
    expect(cost).toBeCloseTo((100 * 0.01) / M, 12);
  });
});

describe("trueUpCostLedgers with cache detail", () => {
  it("settles a cached Claude call at the cache-aware cost", async () => {
    await trueUpCostLedgers({
      userId: "u1",
      model: "claude-haiku-5-5",
      prebilledCents: 0,
      usage: {
        prompt_tokens: 90_000,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 80_000, cache_write_tokens: 0 },
      },
    });
    const [, deltaCents] = recordCostUsage.mock.calls[0];
    // 10k uncached × $0.10/M + 80k reads × $0.01/M = $0.0018 = 0.18¢
    // (billed as plain input it would have been 0.9¢)
    expect(deltaCents).toBeCloseTo(0.18, 6);
  });

  it("applies the long-context tier to a prompt over 100k tokens, cache reads included", async () => {
    await trueUpCostLedgers({
      userId: "u1",
      model: "claude-haiku-5-5",
      prebilledCents: 0,
      usage: {
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 900_000 },
      },
    });
    const [, deltaCents] = recordCostUsage.mock.calls[0];
    // 100k uncached × $0.50/M + 900k reads × $0.05/M = $0.095 = 9.5¢
    expect(deltaCents).toBeCloseTo(9.5, 6);
  });
});

describe("promptCacheUsageOf", () => {
  it("reads the cache breakdown from an OpenAI-shape usage block", () => {
    expect(
      promptCacheUsageOf({
        prompt_tokens: 10,
        prompt_tokens_details: {
          cached_tokens: 4,
          cache_write_tokens: 3,
          cache_write_1h_tokens: 1,
        },
      }),
    ).toEqual({ readTokens: 4, writeTokens: 3, write1hTokens: 1 });
  });

  it("is empty when the provider reports no cache detail", () => {
    expect(promptCacheUsageOf(undefined)).toEqual({});
    expect(promptCacheUsageOf({ prompt_tokens: 10 })).toEqual({});
  });
});
