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
  ownedByUser?: boolean;
}

// Mutable chain the mocked registry hands back to openai.ts
const chain: FakeProvider[] = [];

vi.mock("../providers/index.js", () => ({
  getProvider: vi.fn(() => null),
  getProviderChain: vi.fn(() => chain),
}));

// Spy on the ledger — the real module is unit-tested separately.
const recorded: Array<Record<string, unknown>> = [];
// Hoisted so we can assert the servedByUserKey flag createCompletion forwards.
const trueUpSpy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../llm-usage.js", () => ({
  recordLlmUsage: vi.fn(async (input: Record<string, unknown>) => {
    recorded.push(input);
  }),
  estimatePrebillCents: vi.fn(() => 0),
  trueUpCostLedgers: trueUpSpy,
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
  trueUpSpy.mockClear();
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

  it("flags servedByUserKey on the true-up when the user's OWN key served the call", async () => {
    // BYOK happy path: the served provider is user-owned, so the true-up is
    // told to charge Klorn's ledgers nothing.
    const userProvider = makeProvider("openrouter", "openrouter:user:u9", async () => COMPLETION);
    userProvider.ownedByUser = true;
    chain.push(userProvider);
    const { createCompletion } = await import("../openai.js");

    await createCompletion(PARAMS, { userId: "u9" });

    expect(trueUpSpy).toHaveBeenCalledTimes(1);
    expect(trueUpSpy.mock.calls[0]?.[0]).toMatchObject({ servedByUserKey: true });
  });

  it("does NOT flag servedByUserKey when the call fell through to an env provider", async () => {
    // BYOK key hits its own rate limit (429) → fails over to Klorn's env
    // provider → Klorn paid → the true-up must bill it (servedByUserKey false).
    // This is the cost-hole guard, end to end: a failed user key can't make
    // env spend invisible. Only the SUCCESSFUL provider reaches the true-up.
    chain.push(
      makeProvider("openrouter", "openrouter:user:u9", async () => {
        throw { status: 429, message: "Key limit exceeded" };
      }),
      makeProvider("gemini", "gemini:env", async () => COMPLETION),
    );
    chain[0].ownedByUser = true; // the user key (which rate-limits and fails over)
    const { createCompletion } = await import("../openai.js");

    await createCompletion(PARAMS, { userId: "u9" });

    expect(trueUpSpy).toHaveBeenCalledTimes(1);
    expect(trueUpSpy.mock.calls[0]?.[0]).toMatchObject({ servedByUserKey: false });
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

  it("defaults the ledger source to background (matches the per-user gate)", async () => {
    // Vision is a worker-triggered batch: the gate charges the background
    // bucket (priority ?? "background"), so the usage ledger must agree —
    // otherwise the same call gates as background but bills as foreground.
    chain.push(makeProvider("gemini", "gemini:env-vision", async () => COMPLETION));
    const { createVisionCompletion } = await import("../openai.js");

    await createVisionCompletion(PARAMS, { userId: "user-3" });

    expect(recorded[0]).toMatchObject({ source: "background" });
  });

  it("honors an explicit foreground priority on the ledger", async () => {
    chain.push(makeProvider("gemini", "gemini:env-vision", async () => COMPLETION));
    const { createVisionCompletion } = await import("../openai.js");

    await createVisionCompletion(PARAMS, { userId: "user-4", priority: "foreground" });

    expect(recorded[0]).toMatchObject({ source: "foreground" });
  });

  it("retries the paid slug when the :free vision SKU is 404 (OpenRouter-only chain)", async () => {
    // Real incident: VISION_MODEL defaults to google/gemini-2.5-flash:free and
    // OpenRouter 404s that SKU ("This model is unavailable for free — use this
    // slug instead: google/gemini-2.5-flash"). The fix strips :free and retries
    // the paid slug on the SAME provider instead of hard-failing → VISION_FAILED.
    const seen: string[] = [];
    chain.push(
      makeProvider("openrouter", "openrouter:env-vision", async (_p, model) => {
        seen.push(model);
        if (model.endsWith(":free")) {
          throw new Error(
            "404 This model is unavailable for free. The paid version is available now - use this slug instead: google/gemini-2.5-flash",
          );
        }
        return COMPLETION;
      }),
    );
    const { createVisionCompletion, VISION_MODEL } = await import("../openai.js");
    // Test premise: the default vision SKU is the :free one that 404s.
    expect(VISION_MODEL.endsWith(":free")).toBe(true);
    const paid = VISION_MODEL.replace(/:free$/, "");

    const result = await createVisionCompletion(PARAMS, { userId: "user-5" });

    expect(result).toBe(COMPLETION);
    // First the :free SKU (404), then the stripped paid slug (served).
    expect(seen).toEqual([VISION_MODEL, paid]);
    // Ledger records the model that actually served — the paid slug.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ provider: "openrouter", model: paid });
  });

  it("falls through to env Gemini when a BYOK key's :free 404 → paid retry has no credit", async () => {
    // BYOK OpenRouter key leads the chain (userOwned first). Its :free SKU 404s,
    // the paid retry 402s (no credit) → we fail over to env Gemini's native key
    // (separate quota) so a keyless/credit-less path still degrades gracefully.
    const userOR = makeProvider("openrouter", "openrouter:user:u6", async (_p, model) => {
      if (model.endsWith(":free")) {
        throw new Error("404 This model is unavailable for free");
      }
      throw { status: 402, message: "insufficient credits" };
    });
    userOR.ownedByUser = true;
    chain.push(
      userOR,
      makeProvider("gemini", "gemini:env-vision", async () => COMPLETION),
    );
    const { createVisionCompletion } = await import("../openai.js");

    const result = await createVisionCompletion(PARAMS, { userId: "u6" });

    expect(result).toBe(COMPLETION);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ provider: "gemini", model: "gemini-2.5-flash" });
  });
});
