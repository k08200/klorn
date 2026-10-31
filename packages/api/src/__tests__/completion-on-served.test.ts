/**
 * createCompletion's onServed reports the provider and model that actually
 * served the call after failover. The v3 facts store persists this as
 * provenance; createCompletion's return value carries no provider name.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("createCompletion onServed", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function fakeProvider(
    name: string,
    call: (params: unknown, model: string) => Promise<unknown>,
    ownedByUser = false,
  ) {
    return {
      name,
      quotaKey: `${name}:env`,
      client: null,
      defaultModel: `${name}-model`,
      supportsTools: true,
      ownedByUser,
      resolveModel: () => `${name}-model`,
      call,
    };
  }

  const ok = () => ({
    id: "x",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

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

  it("reports the provider that served after a failover, once", async () => {
    const overloaded = Object.assign(new Error("529 overloaded"), { status: 529 });
    mockChain([
      fakeProvider("anthropic", async () => {
        throw overloaded;
      }),
      fakeProvider("gemini", async () => ok()),
    ]);
    const { createCompletion } = await import("../llm/openai.js");
    const onServed = vi.fn();
    await createCompletion({ model: "claude-haiku-5-5", messages: [] }, { onServed });
    expect(onServed).toHaveBeenCalledTimes(1);
    expect(onServed).toHaveBeenCalledWith({
      provider: "gemini",
      model: "gemini-model",
      ownedByUser: false,
    });
  });

  it("is not called when every provider fails", async () => {
    const overloaded = Object.assign(new Error("529 overloaded"), { status: 529 });
    mockChain([
      fakeProvider("anthropic", async () => {
        throw overloaded;
      }),
    ]);
    const { createCompletion } = await import("../llm/openai.js");
    const onServed = vi.fn();
    await expect(
      createCompletion({ model: "claude-haiku-5-5", messages: [] }, { onServed }),
    ).rejects.toThrow();
    expect(onServed).not.toHaveBeenCalled();
  });
});
