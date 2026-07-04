import { describe, expect, it } from "vitest";
import {
  CURATED_MODEL_IDS,
  CURATED_MODELS,
  DEFAULT_CHAT_MODEL,
  isCuratedModel,
} from "../model-catalog.js";

describe("model catalog (chat surface, frontier-only)", () => {
  it("recommends Claude Sonnet 5 first and lists only frontier models", () => {
    expect(CURATED_MODELS[0].id).toBe("anthropic/claude-sonnet-5");
    expect(DEFAULT_CHAT_MODEL).toBe("anthropic/claude-sonnet-5");
    expect(CURATED_MODEL_IDS).toContain("openai/gpt-5.4");
    expect(CURATED_MODEL_IDS).toContain("google/gemini-3.5-flash");
    expect(CURATED_MODEL_IDS).toContain("x-ai/grok-4.3");
    expect(CURATED_MODEL_IDS).toContain("anthropic/claude-opus-4.8");
    // Budget/legacy SKUs are NOT user-selectable for chat.
    expect(CURATED_MODEL_IDS).not.toContain("google/gemini-2.5-flash");
    expect(CURATED_MODEL_IDS).not.toContain("openai/gpt-4o");
  });

  it("accepts a curated id and rejects anything else", () => {
    expect(isCuratedModel("anthropic/claude-sonnet-5")).toBe(true);
    expect(isCuratedModel("openai/gpt-4o")).toBe(false);
    expect(isCuratedModel("google/gemma-4-31b-it:free")).toBe(false);
    expect(isCuratedModel("")).toBe(false);
    expect(isCuratedModel(null)).toBe(false);
  });
});
