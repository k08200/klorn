import { afterEach, describe, expect, it, vi } from "vitest";

// The OpenAI SDK's default request timeout is 10 minutes (x 2 retries). A hung
// provider then held a judge call, a summary or a chat turn for up to half an
// hour on the shared event loop's async work. Every client now gets an
// explicit timeout: 60 s for cloud providers, 5 min for a self-hosted local
// model, LLM_REQUEST_TIMEOUT_MS overriding both.

async function loadProviders(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value ?? "");
  return import("../providers/index.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function timeoutOf(provider: { client: unknown } | null | undefined): number | undefined {
  return (provider?.client as { timeout?: number } | null | undefined)?.timeout;
}

describe("LLM client request timeout", () => {
  it("gives cloud clients a 60 s timeout, not the SDK's 10 minutes", async () => {
    const { getProvider, getProviderChain } = await loadProviders({
      OPENROUTER_API_KEY: "env-key",
      OPENAI_COMPAT_BASE_URL: undefined,
      LLM_REQUEST_TIMEOUT_MS: undefined,
    });

    expect(timeoutOf(getProvider("openrouter"))).toBe(60_000);
    const chain = getProviderChain({ openRouterApiKey: "user-key", openAiApiKey: "sk-user" });
    for (const provider of chain.filter((p) => p.client)) {
      expect(timeoutOf(provider), provider.name).toBe(60_000);
    }
  });

  it("gives a self-hosted local model 5 minutes", async () => {
    const { getProvider } = await loadProviders({
      OPENAI_COMPAT_BASE_URL: "http://localhost:11434/v1",
    });

    expect(timeoutOf(getProvider("openai-compat"))).toBe(300_000);
  });

  it("lets LLM_REQUEST_TIMEOUT_MS override both, and ignores an unusable value", async () => {
    const tuned = await loadProviders({
      OPENROUTER_API_KEY: "env-key",
      OPENAI_COMPAT_BASE_URL: "http://localhost:11434/v1",
      LLM_REQUEST_TIMEOUT_MS: "20000",
    });
    expect(timeoutOf(tuned.getProvider("openrouter"))).toBe(20_000);
    expect(timeoutOf(tuned.getProvider("openai-compat"))).toBe(20_000);

    const bad = await loadProviders({
      OPENROUTER_API_KEY: "env-key",
      LLM_REQUEST_TIMEOUT_MS: "soon",
    });
    expect(timeoutOf(bad.getProvider("openrouter"))).toBe(60_000);
  });
});

describe("llmRequestTimeoutMs bounds", () => {
  it("clamps to [1 s, the largest setTimeout delay] and says once when a value is unusable", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { llmRequestTimeoutMs } = await import("../llm/llm-timeout.js");

    vi.stubEnv("LLM_REQUEST_TIMEOUT_MS", "60"); // seconds by mistake
    expect(llmRequestTimeoutMs(60_000)).toBe(1000);
    vi.stubEnv("LLM_REQUEST_TIMEOUT_MS", "99999999999");
    expect(llmRequestTimeoutMs(60_000)).toBe(2_147_483_647);
    vi.stubEnv("LLM_REQUEST_TIMEOUT_MS", "soon");
    expect(llmRequestTimeoutMs(60_000)).toBe(60_000);
    expect(llmRequestTimeoutMs(60_000)).toBe(60_000);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("a timed-out request fails over like an unreachable one", () => {
  it("classifies the SDK's APIConnectionTimeoutError as a connection error", async () => {
    const { APIConnectionTimeoutError } = await import("openai");
    const { isConnectionError } = await import("../llm/model-fallback.js");

    expect(isConnectionError(new APIConnectionTimeoutError())).toBe(true);
  });
});

describe("Gemini native requests time out too", () => {
  it("aborts a request whose response never starts, with a connection-class error", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { createCompletionNonStreaming } = await import("../providers/gemini-native.js");
      const { isConnectionError } = await import("../llm/model-fallback.js");
      const pending = createCompletionNonStreaming(
        { model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] } as never,
        "key",
      ).catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(60_000);
      const err = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(err).toBeInstanceOf(Error);
      expect(isConnectionError(err)).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("embeddings", () => {
  it("bound a request at 30 s: they sit on the judge's hot path and fall back to lexical ranking", async () => {
    vi.resetModules();
    const ctor = vi.fn();
    vi.doMock("openai", () => ({
      default: class {
        embeddings = { create: vi.fn(async () => ({ data: [{ embedding: [1, 0] }] })) };
        constructor(options: unknown) {
          ctor(options);
        }
      },
    }));
    vi.stubEnv("EMBEDDING_MODEL", "nomic-embed-text");
    vi.stubEnv("LLM_REQUEST_TIMEOUT_MS", "");
    try {
      const { embedText } = await import("../embedding.js");
      await embedText("hello");
      expect(ctor).toHaveBeenCalledWith(expect.objectContaining({ timeout: 30_000 }));
    } finally {
      vi.doUnmock("openai");
    }
  });
});
