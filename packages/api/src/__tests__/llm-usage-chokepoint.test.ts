/**
 * Verifies that createCompletion / createVisionCompletion record the
 * provider+model that ACTUALLY served the request (post-failover) to the
 * usage ledger, without changing the functions' public behavior.
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
}

// Mutable chain the mocked registry hands back to openai.ts
const chain: FakeProvider[] = [];

vi.mock("../providers/index.js", () => ({
  getProvider: vi.fn(() => null),
  getProviderChain: vi.fn(() => chain),
}));

// Spy on the ledger — the real module is unit-tested separately.
const recorded: Array<Record<string, unknown>> = [];
vi.mock("../llm-usage.js", () => ({
  recordLlmUsage: vi.fn(async (input: Record<string, unknown>) => {
    recorded.push(input);
  }),
  estimatePrebillCents: vi.fn(() => 0),
}));

// openai.ts pulls cost-guard (which pulls db.js) in via enforceCostGates.
// No DATABASE_URL in unit tests, so stub the prisma surface it touches.
vi.mock("../db.js", () => ({
  prisma: {
    llmCostLedger: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
  },
  db: {},
}));

function makeProvider(
  name: "openrouter" | "gemini",
  quotaKey: string,
  call: FakeCall,
): FakeProvider {
  return {
    name,
    quotaKey,
    defaultModel: "fake-default",
    supportsTools: name === "openrouter",
    client: null,
    resolveModel: (m: string) => (name === "gemini" ? "gemini-2.5-flash" : m),
    call,
  };
}

const COMPLETION = {
  id: "cmpl-1",
  choices: [{ message: { role: "assistant", content: "ok" } }],
  usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
};

const PARAMS: ChatCompletionCreateParamsNonStreaming = {
  model: "google/gemma-4-31b-it:free",
  messages: [{ role: "user", content: "hi" }],
};

beforeEach(async () => {
  chain.length = 0;
  recorded.length = 0;
  const { clearFallbackState } = await import("../model-fallback.js");
  clearFallbackState();
});

describe("createCompletion — usage ledger threading", () => {
  it("records the first provider+model when the first call succeeds", async () => {
    chain.push(makeProvider("openrouter", "openrouter:env", async () => COMPLETION));
    const { createCompletion } = await import("../openai.js");

    const result = await createCompletion(PARAMS);

    expect(result).toBe(COMPLETION);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      provider: "openrouter",
      model: "google/gemma-4-31b-it:free",
      userId: null,
      source: "foreground",
      usage: COMPLETION.usage,
    });
  });

  it("records the FAILOVER provider+model, not the requested one", async () => {
    chain.push(
      makeProvider("openrouter", "openrouter:env-failing", async () => {
        throw { status: 429, message: "Key limit exceeded" };
      }),
      makeProvider("gemini", "gemini:env", async () => COMPLETION),
    );
    const { createCompletion } = await import("../openai.js");

    await createCompletion(PARAMS, { userId: "user-1", priority: "background" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      provider: "gemini",
      model: "gemini-2.5-flash",
      userId: "user-1",
      source: "background",
    });
  });

  it("records a usage-less row for streaming responses (v1 limitation)", async () => {
    async function* stream() {
      yield { choices: [{ delta: { content: "ok" } }] };
    }
    chain.push(makeProvider("openrouter", "openrouter:env-stream", async () => stream()));
    const { createCompletion } = await import("../openai.js");

    await createCompletion({ ...PARAMS, stream: true });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      provider: "openrouter",
      model: "google/gemma-4-31b-it:free",
      usage: null,
    });
  });

  it("records nothing when every provider fails", async () => {
    chain.push(
      makeProvider("openrouter", "openrouter:env-dead", async () => {
        throw { status: 429, message: "Key limit exceeded" };
      }),
    );
    const { createCompletion, AllProvidersExhaustedError } = await import("../openai.js");

    await expect(createCompletion(PARAMS)).rejects.toBeInstanceOf(AllProvidersExhaustedError);
    expect(recorded).toHaveLength(0);
  });
});

describe("createVisionCompletion — usage ledger threading", () => {
  it("records the provider+model that served the vision call", async () => {
    chain.push(makeProvider("gemini", "gemini:env-vision", async () => COMPLETION));
    const { createVisionCompletion } = await import("../openai.js");

    await createVisionCompletion(PARAMS, { userId: "user-2" });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      provider: "gemini",
      model: "gemini-2.5-flash",
      userId: "user-2",
      usage: COMPLETION.usage,
    });
  });
});
