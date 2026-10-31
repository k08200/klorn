/**
 * playgroundOnly credentials must fail CLOSED: the public playground passes a
 * visitor's own key, and a bad/empty key must NEVER fall through to the
 * server's env OpenRouter/Gemini/compat providers (a zero-auth billing-theft
 * vector). These tests pin that the env providers — fully configured here —
 * are excluded whenever playgroundOnly is set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getProviderChain with playgroundOnly", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    // Fully configure every server provider so a leak would be visible.
    vi.stubEnv("OPENAI_COMPAT_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "env-openrouter-key");
    vi.stubEnv("GEMINI_API_KEY", "env-gemini-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns ONLY the visitor's provider, never the env providers", async () => {
    const { getProviderChain } = await import("../providers/index.js");
    const chain = getProviderChain({
      openRouterApiKey: "visitor-key",
      quotaScope: "playground:1.2.3.4",
      playgroundOnly: true,
    });
    expect(chain.map((p) => p.name)).toEqual(["openrouter"]);
    // The single provider is scoped to the visitor, not the env key.
    expect(chain[0].quotaKey).toContain("user:playground:1.2.3.4");
    expect(chain[0].quotaKey).not.toBe("openrouter:env");
  });

  it("fails CLOSED to an empty chain when no visitor key is supplied", async () => {
    const { getProviderChain } = await import("../providers/index.js");
    const chain = getProviderChain({ playgroundOnly: true, quotaScope: "playground:1.2.3.4" });
    expect(chain).toEqual([]);
  });

  it("does NOT exclude env providers for a normal (non-playground) BYOK call", async () => {
    const { getProviderChain } = await import("../providers/index.js");
    const chain = getProviderChain({ openRouterApiKey: "visitor-key", quotaScope: "user-123" });
    // Regression guard: ordinary logged-in BYOK still gets env fallback.
    expect(chain.map((p) => p.name)).toContain("openai-compat");
    expect(chain.some((p) => p.quotaKey === "openrouter:env")).toBe(true);
  });

  it("tags ONLY the user-key provider as ownedByUser — env fallthroughs stay billable", async () => {
    const { getProviderChain } = await import("../providers/index.js");
    const chain = getProviderChain({ openRouterApiKey: "visitor-key", quotaScope: "user-123" });
    // The user's own provider is tagged so the cost ledgers charge it $0; every
    // env fallthrough provider must stay untagged so Klorn's real spend on a
    // BYOK-key failure is still billed (the cost-hole guard).
    const userProvider = chain.find((p) => p.quotaKey === "openrouter:user:user-123");
    expect(userProvider?.ownedByUser).toBe(true);
    for (const p of chain.filter((p) => p.quotaKey !== "openrouter:user:user-123")) {
      expect(p.ownedByUser).not.toBe(true);
    }
  });
});

describe("getProviderChain — visitor Anthropic key (playground)", () => {
  const createAnthropicClient = vi.fn(() => ({ fake: true }));
  const createAnthropicCompletion = vi.fn(async () => ({ choices: [] }));

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    createAnthropicClient.mockClear();
    createAnthropicCompletion.mockClear();
    vi.stubEnv("OPENROUTER_API_KEY", "env-openrouter-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env-server-key");
    // The operator's workspace id belongs to Klorn's key, never a visitor's.
    vi.stubEnv("ANTHROPIC_WORKSPACE_ID", "wrkspc_klorn");
    vi.doMock("../providers/anthropic-native.js", () => ({
      createAnthropicClient,
      createAnthropicCompletion,
      streamAnthropicCompletion: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.doUnmock("../providers/anthropic-native.js");
    vi.unstubAllEnvs();
  });

  it("returns ONLY the visitor's anthropic provider, scoped and user-owned", async () => {
    const { getProviderChain } = await import("../providers/index.js");
    const chain = getProviderChain({
      anthropicApiKey: "sk-ant-visitor",
      quotaScope: "playground",
      playgroundOnly: true,
    });
    expect(chain.map((p) => p.name)).toEqual(["anthropic"]);
    expect(chain[0].quotaKey).toBe("anthropic:user:playground");
    expect(chain[0].ownedByUser).toBe(true);
  });

  it("maps both id spellings to the native Claude id", async () => {
    const { getProviderChain } = await import("../providers/index.js");
    const [provider] = getProviderChain({
      anthropicApiKey: "sk-ant-visitor",
      playgroundOnly: true,
    });
    expect(provider.resolveModel("anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(provider.resolveModel("claude-fable-5-1")).toBe("claude-fable-5-1");
  });

  it("builds the visitor client with the visitor key, no workspace header, no SDK retries", async () => {
    const { getProviderChain } = await import("../providers/index.js");
    const [provider] = getProviderChain({
      anthropicApiKey: "sk-ant-visitor",
      playgroundOnly: true,
    });
    await provider.call({ messages: [] } as never, "claude-haiku-5-5");
    expect(createAnthropicClient).toHaveBeenCalledTimes(1);
    const [key, , workspaceId, maxRetries] = createAnthropicClient.mock.calls[0] as unknown[];
    expect(key).toBe("sk-ant-visitor");
    expect(workspaceId).toBeNull();
    expect(maxRetries).toBe(0);
  });
});
