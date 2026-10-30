/**
 * Failover when the Anthropic env key cannot serve.
 *
 * Same semantics as the other providers, with two Anthropic-specific shapes
 * mapped onto them:
 *  - an empty prepaid balance (normalized to a 402 by the adapter) is credit
 *    exhaustion: cool the provider down and move to the next one — it must not
 *    be rethrown as an operator fault, which would drop every judge call to the
 *    keyword fallback (PUSH structurally unreachable) for as long as the
 *    balance stays empty;
 *  - 529 overloaded is capacity, not a fault: move on, no cooldown (the SDK
 *    already retried it with backoff).
 * A rejected env key (401) still fails loudly, exactly like OpenRouter's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("createCompletion failover from the Anthropic env provider", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function fakeProvider(name: string, call: (params: unknown, model: string) => Promise<unknown>) {
    return {
      name,
      quotaKey: `${name}:env`,
      client: null,
      defaultModel: `${name}-model`,
      supportsTools: true,
      resolveModel: () => `${name}-model`,
      call,
    };
  }

  function ok(text: string) {
    return {
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  function mockChain(chain: unknown[]) {
    vi.doMock("../providers/index.js", () => ({
      getProvider: () => null,
      getProviderChain: () => chain,
    }));
    vi.doMock("../db.js", () => ({
      prisma: {
        globalCostLedger: { findUnique: async () => null, upsert: async () => ({ cents: 0 }) },
        llmCostLedger: {
          findUnique: async () => null,
          upsert: async () => ({ cents: 0 }),
          update: async () => ({ cents: 0 }),
        },
        llmUsageLog: { create: async () => ({}) },
      },
      db: {},
    }));
  }

  function statusError(status: number, message: string, name = "Error") {
    const err = new Error(message) as Error & { status: number };
    err.status = status;
    err.name = name;
    return err;
  }

  it("fails over on exhausted prepaid credit and cools the provider down", async () => {
    const anthropicCall = vi.fn(async () => {
      throw statusError(
        402,
        "402 Anthropic prepaid credit exhausted — 400 Your credit balance is too low",
        "AnthropicCreditExhaustedError",
      );
    });
    mockChain([
      fakeProvider("anthropic", anthropicCall),
      fakeProvider("gemini", async () => ok("from gemini")),
    ]);
    const { createCompletion } = await import("../llm/openai.js");
    const { isProviderUnavailable } = await import("../llm/model-fallback.js");

    const res = await createCompletion({ model: "claude-haiku-5-5", messages: [] });
    expect(res.choices[0].message.content).toBe("from gemini");
    expect(isProviderUnavailable("anthropic:env")).toBe(true);

    // While cooling down the dead provider is skipped, not re-dialled.
    await createCompletion({ model: "claude-haiku-5-5", messages: [] });
    expect(anthropicCall).toHaveBeenCalledTimes(1);
  });

  it("fails over on 529 overloaded without a cooldown", async () => {
    const anthropicCall = vi.fn(async () => {
      throw statusError(529, '529 {"type":"error","error":{"type":"overloaded_error"}}');
    });
    mockChain([
      fakeProvider("anthropic", anthropicCall),
      fakeProvider("gemini", async () => ok("from gemini")),
    ]);
    const { createCompletion } = await import("../llm/openai.js");
    const { isProviderUnavailable } = await import("../llm/model-fallback.js");

    const res = await createCompletion({ model: "claude-haiku-5-5", messages: [] });
    expect(res.choices[0].message.content).toBe("from gemini");
    expect(isProviderUnavailable("anthropic:env")).toBe(false);
    await createCompletion({ model: "claude-haiku-5-5", messages: [] });
    expect(anthropicCall).toHaveBeenCalledTimes(2);
  });

  it("does not mistake a 529 whose request id contains 402 for credit exhaustion", async () => {
    mockChain([
      fakeProvider("anthropic", async () => {
        throw statusError(
          529,
          '529 {"type":"error","error":{"type":"overloaded_error"},"request_id":"req_011CUx402abc"}',
        );
      }),
      fakeProvider("gemini", async () => ok("from gemini")),
    ]);
    const { createCompletion } = await import("../llm/openai.js");
    const { isProviderUnavailable } = await import("../llm/model-fallback.js");
    await createCompletion({ model: "claude-haiku-5-5", messages: [] });
    expect(isProviderUnavailable("anthropic:env")).toBe(false);
  });

  it("still fails loudly on a 400 that merely contains the digits 402", async () => {
    mockChain([
      fakeProvider("anthropic", async () => {
        throw statusError(400, "400 prompt is too long: 1402153 tokens > 1000000 maximum");
      }),
      fakeProvider("gemini", async () => ok("from gemini")),
    ]);
    const { createCompletion } = await import("../llm/openai.js");
    const { isProviderUnavailable } = await import("../llm/model-fallback.js");
    await expect(createCompletion({ model: "claude-haiku-5-5", messages: [] })).rejects.toThrow(
      /prompt is too long/,
    );
    expect(isProviderUnavailable("anthropic:env")).toBe(false);
  });

  it("fails over the vision path on 529 overloaded too", async () => {
    mockChain([
      fakeProvider("gemini", async () => {
        throw statusError(529, "529 overloaded_error");
      }),
      fakeProvider("anthropic", async () => ok("from anthropic")),
    ]);
    const { createVisionCompletion } = await import("../llm/openai.js");
    const res = await createVisionCompletion({ model: "m", messages: [] });
    expect(res.choices[0].message.content).toBe("from anthropic");
  });

  it("still fails loudly when the env key itself is rejected (401)", async () => {
    mockChain([
      fakeProvider("anthropic", async () => {
        throw statusError(401, "401 invalid x-api-key");
      }),
      fakeProvider("gemini", async () => ok("from gemini")),
    ]);
    const { createCompletion } = await import("../llm/openai.js");
    await expect(createCompletion({ model: "claude-haiku-5-5", messages: [] })).rejects.toThrow(
      /401/,
    );
  });
});

describe("credit-error classification ignores a stray 402", () => {
  it.each([
    '529 {"type":"error","error":{"type":"overloaded_error"},"request_id":"req_011CUx402abc"}',
    "400 prompt is too long: 1402153 tokens > 1000000 maximum",
  ])("%s is not a credit error", async (text) => {
    const { isCreditError, isCreditExhaustionError } = await import("../llm/model-fallback.js");
    expect(isCreditError(new Error(text))).toBe(false);
    expect(isCreditExhaustionError(new Error(text))).toBe(false);
  });

  it("still recognises a 402 by status or by a leading 402", async () => {
    const { isCreditError, isCreditExhaustionError } = await import("../llm/model-fallback.js");
    const byStatus = Object.assign(new Error("Payment Required"), { status: 402 });
    expect(isCreditError(byStatus)).toBe(true);
    expect(isCreditExhaustionError(byStatus)).toBe(true);
    expect(isCreditExhaustionError(new Error("402 Insufficient credits"))).toBe(true);
    expect(isCreditError(new Error("insufficient credits on this key"))).toBe(true);
  });
});
