/**
 * A broken BYOK key must not take the request down with it.
 *
 * The chain puts a user's own key ahead of the shared env key precisely so the
 * env key can serve when the user's cannot. Only key-LIMIT errors (403/429)
 * ever failed over, though: any other failure on a user-owned provider — a
 * revoked key answering 401, a malformed one answering 400 — hit the
 * "don't mask it with a provider swap" rethrow and became a hard 503.
 *
 * The visible shape of that bug (2026-08-10): reply drafts, the one surface
 * that passes user credentials, failed for a day while classification — which
 * passes none and therefore runs on the env key — kept working normally.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("createCompletion when a user-owned key fails", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function fakeProvider(
    name: string,
    scope: string,
    call: (params: unknown, model: string) => Promise<unknown>,
    ownedByUser = false,
  ) {
    return {
      name,
      quotaKey: `${name}:${scope}`,
      client: null,
      defaultModel: `${name}-model`,
      supportsTools: true,
      resolveModel: () => `${name}-model`,
      call,
      ownedByUser,
    };
  }

  function mockChain(chain: unknown[]) {
    vi.doMock("../providers/index.js", () => ({
      getProvider: () => null,
      getProviderChain: () => chain,
    }));
    vi.doMock("../llm/model-fallback.js", async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      isProviderUnavailable: () => false,
    }));
    // Both ledgers: the per-user one is only consulted once a userId is passed,
    // which every BYOK case here does.
    vi.doMock("../db.js", () => ({
      prisma: {
        globalCostLedger: { findUnique: async () => null, upsert: async () => ({ cents: 0 }) },
        llmCostLedger: {
          findUnique: async () => null,
          upsert: async () => ({ cents: 0 }),
          update: async () => ({ cents: 0 }),
        },
      },
      db: {},
    }));
  }

  it("falls over to the env key when the user's own Anthropic key is rejected (401)", async () => {
    const rejected = Object.assign(new Error("invalid x-api-key"), { status: 401 });
    const userCall = vi.fn().mockRejectedValue(rejected);
    const envCall = vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] });

    mockChain([
      fakeProvider("anthropic", "user:u1", userCall, true),
      fakeProvider("anthropic", "env", envCall),
    ]);

    const { createCompletion } = await import("../llm/openai.js");
    const result = (await createCompletion(
      { model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] },
      { userId: "u1" },
    )) as { choices: Array<{ message: { content: string } }> };

    expect(result.choices[0].message.content).toBe("ok");
    expect(userCall).toHaveBeenCalledTimes(1);
    expect(envCall).toHaveBeenCalledTimes(1);
  });

  it("falls over on a malformed user key (400) too — the reason does not matter", async () => {
    const bad = Object.assign(new Error("invalid api key format"), { status: 400 });
    const userCall = vi.fn().mockRejectedValue(bad);
    const envCall = vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] });

    mockChain([
      fakeProvider("anthropic", "user:u1", userCall, true),
      fakeProvider("gemini", "env", envCall),
    ]);

    const { createCompletion } = await import("../llm/openai.js");
    const result = (await createCompletion(
      { model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] },
      { userId: "u1" },
    )) as { choices: Array<{ message: { content: string } }> };

    expect(result.choices[0].message.content).toBe("ok");
    expect(envCall).toHaveBeenCalledTimes(1);
  });

  it("still hard-fails an ENV key rejection — that is an operator fault, not something to mask", async () => {
    const rejected = Object.assign(new Error("invalid x-api-key"), { status: 401 });
    const envCall = vi.fn().mockRejectedValue(rejected);
    const neverCall = vi.fn();

    mockChain([
      fakeProvider("anthropic", "env", envCall),
      fakeProvider("gemini", "env", neverCall),
    ]);

    const { createCompletion } = await import("../llm/openai.js");
    await expect(
      createCompletion({
        model: "claude-haiku-5-5",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("invalid x-api-key");
    expect(neverCall).not.toHaveBeenCalled();
  });

  it("surfaces the user key's own error when it is the ONLY provider left", async () => {
    const rejected = Object.assign(new Error("invalid x-api-key"), { status: 401 });
    const userCall = vi.fn().mockRejectedValue(rejected);

    mockChain([fakeProvider("anthropic", "user:u1", userCall, true)]);

    const { createCompletion } = await import("../llm/openai.js");
    await expect(
      createCompletion(
        { model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] },
        { userId: "u1" },
      ),
    ).rejects.toThrow("invalid x-api-key");
  });
});
