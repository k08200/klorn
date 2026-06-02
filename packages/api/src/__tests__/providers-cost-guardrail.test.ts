/**
 * Cost guardrail tests for the provider startup warning. The actual
 * console.warn side-effect happens at module load time in
 * providers/index.ts; we test the pure predicate so future model-ID shapes
 * (new vendors, new free-tier naming conventions) don't silently regress.
 *
 * Real incident this guards against: 2026-06-02, founder set
 * CHAT_MODEL/AGENT_MODEL to `google/gemini-2.5-flash` (no :free) thinking
 * the bare model ID was free. OpenRouter routed to the paid catalog and
 * billed. The predicate flips that into a startup-time warning instead of
 * a billing-statement surprise.
 */

import { describe, expect, it } from "vitest";
import { isLikelyPaidOpenRouterModel } from "../providers/index.js";

describe("isLikelyPaidOpenRouterModel", () => {
  it.each([
    "google/gemini-2.5-flash",
    "google/gemini-2.5-pro",
    "anthropic/claude-3-5-sonnet",
    "openai/gpt-4o",
    "meta-llama/llama-3.3-70b-instruct",
  ])("flags vendor-prefixed paid ID: %s", (value) => {
    expect(isLikelyPaidOpenRouterModel(value)).toBe(true);
  });

  it.each([
    "google/gemini-2.5-flash:free",
    "google/gemma-4-31b-it:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "deepseek/deepseek-r1:free",
  ])("does not flag ID with :free suffix: %s", (value) => {
    expect(isLikelyPaidOpenRouterModel(value)).toBe(false);
  });

  it.each([
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "claude-3-5-sonnet", // hypothetical bare Anthropic SDK route
  ])("does not flag bare model IDs (Gemini-direct / other native routes): %s", (value) => {
    expect(isLikelyPaidOpenRouterModel(value)).toBe(false);
  });

  it("does not flag empty string", () => {
    expect(isLikelyPaidOpenRouterModel("")).toBe(false);
  });
});
