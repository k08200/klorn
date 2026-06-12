/**
 * gemini-native usage mapping — cached-token visibility.
 *
 * Gemini reports implicit-cache hits as usageMetadata.cachedContentTokenCount.
 * The provider must surface it in the OpenAI-shape
 * usage.prompt_tokens_details.cached_tokens so the LlmUsageLog ledger can
 * record real cache hit rates instead of guessing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompletionNonStreaming } from "../providers/gemini-native.js";

function geminiResponse(usageMetadata: Record<string, number>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: "{}" }] } }],
      usageMetadata,
    }),
    text: async () => "",
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createCompletionNonStreaming — usage mapping", () => {
  it("maps cachedContentTokenCount into prompt_tokens_details.cached_tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        geminiResponse({
          promptTokenCount: 1200,
          candidatesTokenCount: 80,
          totalTokenCount: 1280,
          cachedContentTokenCount: 900,
        }),
      ),
    );

    const completion = await createCompletionNonStreaming(
      { model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] },
      "test-key",
    );

    const usage = completion.usage as unknown as {
      prompt_tokens: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
    expect(usage.prompt_tokens).toBe(1200);
    expect(usage.prompt_tokens_details?.cached_tokens).toBe(900);
  });

  it("defaults cached_tokens to 0 when Gemini omits the field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        geminiResponse({ promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 }),
      ),
    );

    const completion = await createCompletionNonStreaming(
      { model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] },
      "test-key",
    );

    const usage = completion.usage as unknown as {
      prompt_tokens_details?: { cached_tokens?: number };
    };
    expect(usage.prompt_tokens_details?.cached_tokens).toBe(0);
  });
});
