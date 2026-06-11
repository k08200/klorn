/**
 * Local/OpenAI-compatible provider (Ollama, LM Studio, vLLM, ...) tests:
 *  - isConnectionError classification (model-fallback.ts)
 *  - chain construction + ordering (providers/index.ts, env-driven, so each
 *    test re-imports the module with stubbed env)
 *  - createCompletion failover: local endpoint down → next provider, with
 *    no cooldown marking
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isConnectionError } from "../model-fallback.js";

describe("isConnectionError", () => {
  it.each([
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("getaddrinfo ENOTFOUND ollama.local"), { code: "ENOTFOUND" }),
    new Error("fetch failed"),
    new Error("Connection error."),
    new Error("socket hang up"),
    Object.assign(new Error("APIConnectionError"), {
      cause: Object.assign(new Error("inner"), { code: "ECONNRESET" }),
    }),
  ])("classifies transport failure: %s", (err) => {
    expect(isConnectionError(err)).toBe(true);
  });

  it.each([
    new Error("429 rate limit exceeded"),
    new Error("402 insufficient credits"),
    new Error("invalid JSON response"),
    null,
    undefined,
  ])("does not classify non-transport error: %s", (err) => {
    expect(isConnectionError(err)).toBe(false);
  });
});

describe("provider chain with OPENAI_COMPAT_BASE_URL", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function chainNames(): Promise<string[]> {
    const { getProviderChain } = await import("../providers/index.js");
    return getProviderChain().map((p) => p.name);
  }

  it("is absent when OPENAI_COMPAT_BASE_URL is unset", async () => {
    vi.stubEnv("OPENAI_COMPAT_BASE_URL", "");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(await chainNames()).toEqual(["openrouter"]);
  });

  it("leads the chain by default (local-first privacy)", async () => {
    vi.stubEnv("OPENAI_COMPAT_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("GEMINI_API_KEY", "test-key-2");
    expect(await chainNames()).toEqual(["openai-compat", "openrouter", "gemini"]);
  });

  it("moves to the end with OPENAI_COMPAT_PRIORITY=last", async () => {
    vi.stubEnv("OPENAI_COMPAT_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("OPENAI_COMPAT_PRIORITY", "last");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(await chainNames()).toEqual(["openrouter", "openai-compat"]);
  });

  it("works as the ONLY provider (fully local self-host)", async () => {
    vi.stubEnv("OPENAI_COMPAT_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(await chainNames()).toEqual(["openai-compat"]);
  });

  it("always resolves caller models to the operator's local model", async () => {
    vi.stubEnv("OPENAI_COMPAT_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("OPENAI_COMPAT_MODEL", "qwen3:8b");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    const { getProviderChain } = await import("../providers/index.js");
    const compat = getProviderChain()[0];
    expect(compat.resolveModel("google/gemma-4-31b-it:free")).toBe("qwen3:8b");
    expect(compat.resolveModel("gemini-2.5-flash")).toBe("qwen3:8b");
  });
});

describe("createCompletion failover when the local endpoint is down", () => {
  const markKeyLimited = vi.hoisted(() => vi.fn());

  beforeEach(() => {
    vi.resetModules();
    markKeyLimited.mockClear();
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

  it("falls over to the next provider on ECONNREFUSED without marking a cooldown", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
      code: "ECONNREFUSED",
    });
    const compatCall = vi.fn().mockRejectedValue(refused);
    const cloudCall = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
    });

    vi.doMock("../providers/index.js", () => ({
      getProvider: () => null,
      getProviderChain: () => [
        fakeProvider("openai-compat", compatCall),
        fakeProvider("openrouter", cloudCall),
      ],
    }));
    vi.doMock("../model-fallback.js", async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      markKeyLimited,
      isProviderUnavailable: () => false,
    }));
    vi.doMock("../db.js", () => ({ prisma: {}, db: {} }));

    const { createCompletion } = await import("../openai.js");
    const result = (await createCompletion({
      model: "google/gemma-4-31b-it:free",
      messages: [{ role: "user", content: "hi" }],
    })) as { choices: Array<{ message: { content: string } }> };

    expect(result.choices[0].message.content).toBe("ok");
    expect(compatCall).toHaveBeenCalledTimes(1);
    expect(cloudCall).toHaveBeenCalledTimes(1);
    expect(markKeyLimited).not.toHaveBeenCalled();
  });

  it("still hard-fails on connection errors from cloud providers (no masking)", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), {
      code: "ECONNREFUSED",
    });
    const cloudCall = vi.fn().mockRejectedValue(refused);
    const neverCall = vi.fn();

    vi.doMock("../providers/index.js", () => ({
      getProvider: () => null,
      getProviderChain: () => [
        fakeProvider("openrouter", cloudCall),
        fakeProvider("gemini", neverCall),
      ],
    }));
    vi.doMock("../model-fallback.js", async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      markKeyLimited,
      isProviderUnavailable: () => false,
    }));
    vi.doMock("../db.js", () => ({ prisma: {}, db: {} }));

    const { createCompletion } = await import("../openai.js");
    await expect(
      createCompletion({
        model: "google/gemma-4-31b-it:free",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(neverCall).not.toHaveBeenCalled();
  });
});
