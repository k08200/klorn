import { describe, expect, it } from "vitest";
import { CURATED_MODEL_IDS, CURATED_MODELS, isCuratedModel } from "../model-catalog.js";

describe("model catalog", () => {
  it("lists only multimodal, firewall-capable models with flash recommended first", () => {
    expect(CURATED_MODELS[0].id).toBe("google/gemini-2.5-flash");
    expect(CURATED_MODEL_IDS).toContain("openai/gpt-4o");
    expect(CURATED_MODEL_IDS).toContain("anthropic/claude-sonnet-4");
    expect(CURATED_MODEL_IDS).toContain("google/gemini-2.5-pro");
  });

  it("accepts a curated id and rejects anything else", () => {
    expect(isCuratedModel("openai/gpt-4o")).toBe(true);
    expect(isCuratedModel("google/gemma-4-31b-it:free")).toBe(false);
    expect(isCuratedModel("anthropic/claude-3.7-sonnet")).toBe(false);
    expect(isCuratedModel("")).toBe(false);
    expect(isCuratedModel(null)).toBe(false);
  });
});
