/**
 * Verifies that createCompletion / createVisionCompletion record the
 * provider+model that ACTUALLY served the request (post-failover) to the
 * usage ledger, without changing the functions' public behavior.
 */

import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeCall = (params: unknown, model: string) => Promise<unknown>;

interface FakeProvider {
  name: "anthropic" | "gemini";
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
// Model-aware pre-bill stub: the model a provider resolves to (Gemini's
// `gemini-2.5-flash`) estimates differently from any other id. This lets the
// vision path assert that the ledger row pre-bills the model that ACTUALLY
// dispatched, not the requested `params.model`.
const SERVED_MODEL_PREBILL_CENTS = 3;
const OTHER_MODEL_PREBILL_CENTS = 7;
vi.mock("../billing/llm-usage.js", () => ({
  recordLlmUsage: vi.fn(async (input: Record<string, unknown>) => {
    recorded.push(input);
  }),
  estimatePrebillCents: vi.fn((model: string) =>
    model === "gemini-2.5-flash" ? SERVED_MODEL_PREBILL_CENTS : OTHER_MODEL_PREBILL_CENTS,
  ),
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
    // The global ceiling is DB-backed too (GlobalCostLedger) — an empty ledger
    // means "nothing spent today", so the gate stays open in these tests.
    globalCostLedger: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({ cents: 0 })),
    },
  },
  db: {},
}));

function makeProvider(
  name: "anthropic" | "gemini",
  quotaKey: string,
  call: FakeCall,
): FakeProvider {
  return {
    name,
    quotaKey,
    defaultModel: "fake-default",
    supportsTools: name === "anthropic",
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
  model: "claude-haiku-5-5",
  messages: [{ role: "user", content: "hi" }],
};

beforeEach(async () => {
  chain.length = 0;
  recorded.length = 0;
  trueUpSpy.mockClear();
  const { clearFallbackState } = await import("../llm/model-fallback.js");
  clearFallbackState();
});

describe("createCompletion — usage ledger threading", () => {
  it("records the first provider+model when the first call succeeds", async () => {
    chain.push(makeProvider("anthropic", "anthropic:env", async () => COMPLETION));
    const { createCompletion } = await import("../llm/openai.js");

    const result = await createCompletion(PARAMS);

    expect(result).toBe(COMPLETION);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      userId: null,
      source: "foreground",
      usage: COMPLETION.usage,
    });
  });

  it("records the FAILOVER provider+model, not the requested one", async () => {
    chain.push(
      makeProvider("anthropic", "anthropic:env", async () => {
        throw { status: 429, message: "Key limit exceeded" };
      }),
      makeProvider("gemini", "gemini:env", async () => COMPLETION),
    );
    const { createCompletion } = await import("../llm/openai.js");

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
    chain.push(makeProvider("anthropic", "anthropic:env", async () => stream()));
    const { createCompletion } = await import("../llm/openai.js");

    await createCompletion({ ...PARAMS, stream: true });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      usage: null,
    });
  });

  it("records nothing when every provider fails", async () => {
    chain.push(
      makeProvider("anthropic", "anthropic:env", async () => {
        throw { status: 429, message: "Key limit exceeded" };
      }),
    );
    const { createCompletion, AllProvidersExhaustedError } = await import("../llm/openai.js");

    await expect(createCompletion(PARAMS)).rejects.toBeInstanceOf(AllProvidersExhaustedError);
    expect(recorded).toHaveLength(0);
  });

  it("flags servedByUserKey on the true-up when the user's OWN key served the call", async () => {
    // BYOK happy path: the served provider is user-owned, so the true-up is
    // told to charge Klorn's ledgers nothing.
    const userProvider = makeProvider("anthropic", "anthropic:user:u9", async () => COMPLETION);
    userProvider.ownedByUser = true;
    chain.push(userProvider);
    const { createCompletion } = await import("../llm/openai.js");

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
      makeProvider("anthropic", "anthropic:user:u9", async () => {
        throw { status: 429, message: "Key limit exceeded" };
      }),
      makeProvider("gemini", "gemini:env", async () => COMPLETION),
    );
    chain[0].ownedByUser = true; // the user key (which rate-limits and fails over)
    const { createCompletion } = await import("../llm/openai.js");

    await createCompletion(PARAMS, { userId: "u9" });

    expect(trueUpSpy).toHaveBeenCalledTimes(1);
    expect(trueUpSpy.mock.calls[0]?.[0]).toMatchObject({ servedByUserKey: false });
  });
});

describe("createVisionCompletion — usage ledger threading", () => {
  it("records the provider+model that served the vision call", async () => {
    chain.push(makeProvider("gemini", "gemini:env-vision", async () => COMPLETION));
    const { createVisionCompletion } = await import("../llm/openai.js");

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
    const { createVisionCompletion } = await import("../llm/openai.js");

    await createVisionCompletion(PARAMS, { userId: "user-3" });

    expect(recorded[0]).toMatchObject({ source: "background" });
  });

  it("honors an explicit foreground priority on the ledger", async () => {
    chain.push(makeProvider("gemini", "gemini:env-vision", async () => COMPLETION));
    const { createVisionCompletion } = await import("../llm/openai.js");

    await createVisionCompletion(PARAMS, { userId: "user-4", priority: "foreground" });

    expect(recorded[0]).toMatchObject({ source: "foreground" });
  });

  it("pre-bills the model the vision provider ACTUALLY dispatched, not params.model", async () => {
    // Vision runs on VISION_MODEL resolved per provider, never on the caller's
    // params.model. The ledger row's pre-bill must price that dispatched model
    // — pricing params.model would record a cost for a model that never ran.
    const seen: string[] = [];
    chain.push(
      makeProvider("gemini", "gemini:env", async (_p, model) => {
        seen.push(model);
        return COMPLETION;
      }),
    );
    const { createVisionCompletion } = await import("../llm/openai.js");

    const result = await createVisionCompletion(
      { ...PARAMS, model: "some/requested-model" },
      { userId: "user-5" },
    );

    expect(result).toBe(COMPLETION);
    expect(seen).toEqual(["gemini-2.5-flash"]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ provider: "gemini", model: "gemini-2.5-flash" });
    expect(recorded[0]?.estimatedCostCents).toBe(SERVED_MODEL_PREBILL_CENTS);
    expect(trueUpSpy.mock.calls[0]?.[0]).toMatchObject({
      model: "gemini-2.5-flash",
      prebilledCents: SERVED_MODEL_PREBILL_CENTS,
      servedByUserKey: false,
    });
  });

  it("falls through to env Gemini when a BYOK key has no credit (402)", async () => {
    // The user's own Anthropic key leads the chain (user-owned first) but 402s
    // → we fail over to env Gemini's native key (separate quota) so a
    // credit-less key still degrades gracefully. Klorn paid for that call, so
    // the true-up must bill it: servedByUserKey false, nothing pre-billed
    // (the gate skipped the pre-bill because a user key was in the chain).
    const userKey = makeProvider("anthropic", "anthropic:user:u6", async () => {
      throw { status: 402, message: "insufficient credits" };
    });
    userKey.ownedByUser = true;
    chain.push(
      userKey,
      makeProvider("gemini", "gemini:env", async () => COMPLETION),
    );
    const { createVisionCompletion } = await import("../llm/openai.js");

    const result = await createVisionCompletion(PARAMS, { userId: "u6" });

    expect(result).toBe(COMPLETION);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ provider: "gemini", model: "gemini-2.5-flash" });
    expect(trueUpSpy).toHaveBeenCalledTimes(1);
    expect(trueUpSpy.mock.calls[0]?.[0]).toMatchObject({
      servedByUserKey: false,
      prebilledCents: 0,
    });
  });
});
