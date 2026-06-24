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
