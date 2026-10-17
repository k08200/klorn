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
