/**
 * createCompletion / createVisionCompletion must record every failed provider
 * dispatch (#1319) — without changing what the caller sees: the same error
 * object still propagates, failover still happens, and no LlmUsageLog row is
 * written for a call that never succeeded.
 */

import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeCall = (params: unknown, model: string) => Promise<unknown>;

interface FakeProvider {
  name: "openrouter" | "gemini";
  quotaKey: string;
  defaultModel: string;
  supportsTools: boolean;
  client: null;
  resolveModel: (m: string) => string;
  call: FakeCall;
  ownedByUser?: boolean;
}

const chain: FakeProvider[] = [];

vi.mock("../providers/index.js", () => ({
  getProvider: vi.fn(() => null),
  getProviderChain: vi.fn(() => chain),
}));

const recordedUsage: Array<Record<string, unknown>> = [];
vi.mock("../billing/llm-usage.js", () => ({
  recordLlmUsage: vi.fn(async (input: Record<string, unknown>) => {
    recordedUsage.push(input);
  }),
  estimatePrebillCents: vi.fn(() => 0),
  trueUpCostLedgers: vi.fn(async () => {}),
}));

vi.mock("../db.js", () => ({
  prisma: {
    llmCostLedger: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
    globalCostLedger: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ cents: 0 })),
    },
  },
  db: {},
}));

function makeProvider(name: "openrouter" | "gemini", call: FakeCall): FakeProvider {
  return {
    name,
    quotaKey: `${name}:env`,
    defaultModel: "fake-default",
    supportsTools: name === "openrouter",
    client: null,
    resolveModel: (m: string) => (name === "gemini" ? "gemini-2.5-flash" : m),
    call,
  };
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const COMPLETION = {
  id: "cmpl-1",
  choices: [{ message: { role: "assistant", content: "ok" } }],
  usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
};

const PARAMS: ChatCompletionCreateParamsNonStreaming = {
  model: "google/gemma-4-31b-it",
  messages: [{ role: "user", content: "Dear Bob, the secret plan" }],
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  chain.length = 0;
  recordedUsage.length = 0;
  vi.restoreAllMocks();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { clearFallbackState } = await import("../llm/model-fallback.js");
  clearFallbackState();
  const { __resetLlmFailureLog } = await import("../llm/llm-failure-log.js");
  __resetLlmFailureLog();
});

function failureLogLines(): string[] {
  return warnSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[LLM-FAILURE]"));
}

describe("createCompletion — failed provider calls are recorded", () => {
  it("records an env provider's hard failure and rethrows the SAME error", async () => {
    const boom = httpError(401, "401 User not found");
    chain.push(
      makeProvider("gemini", async () => {
        throw boom;
      }),
    );
    const { createCompletion } = await import("../llm/openai.js");
    const { getLlmFailureCounts } = await import("../llm/llm-failure-log.js");

    await expect(createCompletion(PARAMS)).rejects.toBe(boom);

    expect(getLlmFailureCounts()).toEqual([
      { provider: "gemini", total: 1, byLabel: { "401 auth rejected": 1 } },
    ]);
    const lines = failureLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"code":"auth_rejected"');
    expect(lines[0]).toContain('"model":"gemini-2.5-flash"');
    expect(lines[0]).not.toContain("secret plan");
    // A failed call is not usage: no LlmUsageLog row.
    expect(recordedUsage).toEqual([]);
  });

  it("logs the failed hop of a recovered failover but keeps it out of the top-error tally", async () => {
    chain.push(
      makeProvider("openrouter", async () => {
        throw httpError(429, "429 Too many requests");
      }),
    );
    chain.push(makeProvider("gemini", async () => COMPLETION));
    const { createCompletion } = await import("../llm/openai.js");
    const { getLlmFailureCounts } = await import("../llm/llm-failure-log.js");

    const result = await createCompletion(PARAMS);

    expect(result).toBe(COMPLETION);
    const lines = failureLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"code":"rate_limited"');
    // Recovered by the next provider: not what broke anything.
    expect(getLlmFailureCounts()).toEqual([]);
    expect(recordedUsage).toHaveLength(1);
    expect(recordedUsage[0]).toMatchObject({ provider: "gemini" });
  });

  it("does not count a playground visitor's own key failing — not fleet capacity", async () => {
    const boom = httpError(401, "401 User not found");
    chain.push(
      makeProvider("openrouter", async () => {
        throw boom;
      }),
    );
    const { createCompletion } = await import("../llm/openai.js");
    const { getLlmFailureCounts } = await import("../llm/llm-failure-log.js");

    await expect(
      createCompletion(PARAMS, { credentials: { playgroundOnly: true } as never }),
    ).rejects.toBe(boom);
    expect(getLlmFailureCounts()).toEqual([]);
    expect(failureLogLines()).toEqual([]);
  });

  it("tallies every failed hop when the whole call fails", async () => {
    chain.push(
      makeProvider("openrouter", async () => {
        throw httpError(429, "429 Too many requests");
      }),
    );
    chain.push(
      makeProvider("gemini", async () => {
        throw httpError(429, "429 Too many requests");
      }),
    );
    const { createCompletion } = await import("../llm/openai.js");
    const { getLlmFailureCounts } = await import("../llm/llm-failure-log.js");

    await expect(createCompletion(PARAMS)).rejects.toThrow();

    const providers = getLlmFailureCounts()
      .map((c) => c.provider)
      .sort();
    expect(providers).toEqual(["gemini", "openrouter"]);
  });
});

describe("createVisionCompletion — failed provider calls are recorded", () => {
  it("logs the failed hop, returns the next provider's result, and tallies nothing", async () => {
    chain.push(
      makeProvider("gemini", async () => {
        throw httpError(402, "402 Insufficient credits");
      }),
    );
    chain.push(makeProvider("openrouter", async () => COMPLETION));
    const { createVisionCompletion } = await import("../llm/openai.js");
    const { getLlmFailureCounts } = await import("../llm/llm-failure-log.js");

    const result = await createVisionCompletion(PARAMS);

    expect(result).toBe(COMPLETION);
    expect(failureLogLines()).toHaveLength(1);
    expect(getLlmFailureCounts()).toEqual([]);
  });

  it("tallies the failed hop when no provider recovers", async () => {
    const boom = httpError(402, "402 Insufficient credits");
    chain.push(
      makeProvider("gemini", async () => {
        throw boom;
      }),
    );
    const { createVisionCompletion } = await import("../llm/openai.js");
    const { getLlmFailureCounts } = await import("../llm/llm-failure-log.js");

    await expect(createVisionCompletion(PARAMS)).rejects.toThrow();

    expect(getLlmFailureCounts()).toEqual([
      { provider: "gemini", total: 1, byLabel: { "402 credits exhausted": 1 } },
    ]);
  });
});
