import { beforeEach, describe, expect, it, vi } from "vitest";

const created: Array<Record<string, unknown>> = [];
let createShouldFail = false;
let aggregateResult: Record<string, unknown> = {};
let groupByResult: Array<Record<string, unknown>> = [];
let countResult = 0;
const aggregateCalls: Array<Record<string, unknown>> = [];
const groupByCalls: Array<Record<string, unknown>> = [];
const countCalls: Array<Record<string, unknown>> = [];

vi.mock("../db.js", () => ({
  prisma: {
    llmUsageLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (createShouldFail) throw new Error("db down");
        created.push(args.data);
        return args.data;
      }),
      aggregate: vi.fn(async (args: Record<string, unknown>) => {
        aggregateCalls.push(args);
        return aggregateResult;
      }),
      groupBy: vi.fn(async (args: Record<string, unknown>) => {
        groupByCalls.push(args);
        return groupByResult;
      }),
      count: vi.fn(async (args: Record<string, unknown>) => {
        countCalls.push(args);
        return countResult;
      }),
    },
  },
}));

const capturedErrors: unknown[] = [];
vi.mock("../sentry.js", () => ({
  captureError: vi.fn((err: unknown) => {
    capturedErrors.push(err);
  }),
}));

beforeEach(() => {
  created.length = 0;
  createShouldFail = false;
  capturedErrors.length = 0;
  aggregateCalls.length = 0;
  groupByCalls.length = 0;
  countCalls.length = 0;
  aggregateResult = {
    _count: { _all: 0 },
    _sum: {
      promptTokens: null,
      cachedPromptTokens: null,
      completionTokens: null,
      totalTokens: null,
      estimatedCostCents: null,
    },
  };
  groupByResult = [];
  countResult = 0;
});

describe("recordLlmUsage — happy path", () => {
  it("writes one row with actual provider usage and the pre-bill estimate", async () => {
    const { recordLlmUsage } = await import("../llm-usage.js");
    await recordLlmUsage({
      userId: "user-1",
      provider: "openrouter",
      model: "google/gemma-4-31b-it:free",
      source: "background",
      estimatedCostCents: 3,
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      userId: "user-1",
      provider: "openrouter",
      model: "google/gemma-4-31b-it:free",
      source: "background",
      estimatedCostCents: 3,
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      usageMissing: false,
    });
    expect(capturedErrors).toHaveLength(0);
  });

  it("records system calls with userId=null", async () => {
    const { recordLlmUsage } = await import("../llm-usage.js");
    await recordLlmUsage({
      userId: null,
      provider: "gemini",
      model: "gemini-2.5-flash",
      source: "foreground",
      estimatedCostCents: 0,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    expect(created).toHaveLength(1);
    expect(created[0].userId).toBeNull();
  });

  it("records cached prompt tokens from prompt_tokens_details", async () => {
    const { recordLlmUsage } = await import("../llm-usage.js");
    await recordLlmUsage({
      userId: "user-1",
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      source: "background",
      estimatedCostCents: 1,
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 100,
        total_tokens: 2100,
        prompt_tokens_details: { cached_tokens: 1500 },
      },
    });

    expect(created[0]).toMatchObject({
      promptTokens: 2000,
      cachedPromptTokens: 1500,
      usageMissing: false,
    });
  });

  it("defaults cachedPromptTokens to 0 when the provider reports no details", async () => {
    const { recordLlmUsage } = await import("../llm-usage.js");
    await recordLlmUsage({
      userId: "user-1",
      provider: "openrouter",
      model: "google/gemma-4-31b-it:free",
      source: "background",
      estimatedCostCents: 0,
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    });

    expect(created[0]).toMatchObject({ cachedPromptTokens: 0 });
  });

  it("derives totalTokens from prompt+completion when the provider omits it", async () => {
    const { recordLlmUsage } = await import("../llm-usage.js");
    await recordLlmUsage({
      userId: "user-1",
      provider: "openrouter",
      model: "m",
      source: "foreground",
      estimatedCostCents: 0,
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });

    expect(created[0]).toMatchObject({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
      usageMissing: false,
    });
  });
});

describe("recordLlmUsage — missing usage (defensive path)", () => {
  it("records zeros + usageMissing=true when usage is undefined", async () => {
    const { recordLlmUsage } = await import("../llm-usage.js");
    await recordLlmUsage({
      userId: "user-1",
      provider: "openrouter",
      model: "m",
      source: "foreground",
      estimatedCostCents: 1,
      usage: undefined,
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      usageMissing: true,
      estimatedCostCents: 1,
    });
  });

  it("records usageMissing=true when usage exists but has no token fields", async () => {
    const { recordLlmUsage } = await import("../llm-usage.js");
    await recordLlmUsage({
      userId: null,
      provider: "gemini",
      model: "m",
      source: "background",
      estimatedCostCents: 0,
      usage: {},
    });

    expect(created[0]).toMatchObject({ usageMissing: true, totalTokens: 0 });
  });
});

describe("recordLlmUsage — ledger failure never propagates", () => {
  it("swallows DB write errors and reports them to Sentry", async () => {
    createShouldFail = true;
    const { recordLlmUsage } = await import("../llm-usage.js");

    await expect(
      recordLlmUsage({
        userId: "user-1",
        provider: "openrouter",
        model: "m",
        source: "foreground",
        estimatedCostCents: 0,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    ).resolves.toBeUndefined();

    expect(created).toHaveLength(0);
    expect(capturedErrors).toHaveLength(1);
  });
});

describe("estimatePrebillCents", () => {
  it("matches the cost-gate pre-bill (free model → 0¢)", async () => {
    const { estimatePrebillCents } = await import("../llm-usage.js");
    expect(estimatePrebillCents("google/gemma-4-31b-it:free")).toBe(0);
  });

  it("charges a non-zero nominal-token floor for paid models (0\u00a2 pre-bill regression)", async () => {
    const { estimatePrebillCents } = await import("../llm-usage.js");
    const model = "anthropic/claude-sonnet-4";
    expect(estimatePrebillCents(model)).toBeGreaterThanOrEqual(1);
  });
});

describe("getUsageSummary — aggregation", () => {
  it("returns totals + per-model breakdown for all users by default", async () => {
    aggregateResult = {
      _count: { _all: 12 },
      _sum: {
        promptTokens: 1000,
        cachedPromptTokens: 400,
        completionTokens: 200,
        totalTokens: 1200,
        estimatedCostCents: 5,
      },
    };
    groupByResult = [
      {
        provider: "openrouter",
        model: "google/gemma-4-31b-it:free",
        _count: { _all: 10 },
        _sum: {
          promptTokens: 900,
          cachedPromptTokens: 0,
          completionTokens: 150,
          totalTokens: 1050,
          estimatedCostCents: 0,
        },
      },
      {
        provider: "gemini",
        model: "gemini-2.5-flash",
        _count: { _all: 2 },
        _sum: {
          promptTokens: 100,
          cachedPromptTokens: 400,
          completionTokens: 50,
          totalTokens: 150,
          estimatedCostCents: 5,
        },
      },
    ];
    countResult = 3;

    const { getUsageSummary } = await import("../llm-usage.js");
    const summary = await getUsageSummary(undefined, 7);

    expect(summary.sinceDays).toBe(7);
    expect(summary.userId).toBeNull();
    expect(summary.totals).toEqual({
      calls: 12,
      promptTokens: 1000,
      cachedPromptTokens: 400,
      completionTokens: 200,
      totalTokens: 1200,
      estimatedCostCents: 5,
      usageMissingCalls: 3,
      cacheHitRate: 0.4,
    });
    expect(summary.byModel).toEqual([
      {
        provider: "openrouter",
        model: "google/gemma-4-31b-it:free",
        calls: 10,
        promptTokens: 900,
        cachedPromptTokens: 0,
        completionTokens: 150,
        totalTokens: 1050,
        estimatedCostCents: 0,
      },
      {
        provider: "gemini",
        model: "gemini-2.5-flash",
        calls: 2,
        promptTokens: 100,
        cachedPromptTokens: 400,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCostCents: 5,
      },
    ]);

    // No userId filter when none is given
    const where = (aggregateCalls[0] as { where: Record<string, unknown> }).where;
    expect(where.userId).toBeUndefined();
    expect(where.createdAt).toBeDefined();
  });

  it("scopes every query to the user when userId is provided", async () => {
    const { getUsageSummary } = await import("../llm-usage.js");
    const summary = await getUsageSummary("user-9", 30);

    expect(summary.userId).toBe("user-9");
    for (const call of [aggregateCalls[0], groupByCalls[0], countCalls[0]]) {
      const where = (call as { where: Record<string, unknown> }).where;
      expect(where.userId).toBe("user-9");
    }
    // The missing-usage count additionally filters usageMissing=true
    const countWhere = (countCalls[0] as { where: Record<string, unknown> }).where;
    expect(countWhere.usageMissing).toBe(true);
  });

  it("normalizes null sums to 0 and falls back to the default window on bad input", async () => {
    const { getUsageSummary } = await import("../llm-usage.js");
    const summary = await getUsageSummary(undefined, Number.NaN);

    expect(summary.sinceDays).toBeGreaterThan(0);
    expect(summary.totals).toEqual({
      calls: 0,
      promptTokens: 0,
      cachedPromptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostCents: 0,
      usageMissingCalls: 0,
      cacheHitRate: 0,
    });
  });
});
