import { describe, expect, it } from "vitest";
import {
  CURATED_MODEL_IDS,
  CURATED_MODELS,
  DEFAULT_CHAT_MODEL,
  isCuratedModel,
} from "../llm/model-catalog.js";
import { resolveModelRateUsdPerMTok } from "../llm/model-fallback.js";

describe("model catalog (chat surface, Claude-only)", () => {
  it("recommends Claude Haiku 5.5 first and lists only native Claude ids", () => {
    expect(CURATED_MODELS[0].id).toBe("claude-haiku-5-5");
    expect(DEFAULT_CHAT_MODEL).toBe("claude-haiku-5-5");
    expect(CURATED_MODEL_IDS).toEqual(["claude-haiku-5-5", "claude-sonnet-5", "claude-opus-4-8"]);
    expect(CURATED_MODELS.map((m) => m.label)).toEqual([
      "Claude Haiku 5.5",
      "Claude Sonnet 5",
      "Claude Opus 4.8",
    ]);
    // A non-Claude id would be served as the provider's default Claude model,
    // so the picker would lie about what answers.
    for (const id of CURATED_MODEL_IDS) expect(id).toMatch(/^claude-/);
  });

  it("accepts a curated id and rejects anything else", () => {
    expect(isCuratedModel("claude-sonnet-5")).toBe(true);
    // The retired vendor-prefixed catalog ids are no longer selectable.
    expect(isCuratedModel("anthropic/claude-sonnet-5")).toBe(false);
    expect(isCuratedModel("openai/gpt-5.4")).toBe(false);
    expect(isCuratedModel("google/gemma-4-31b-it:free")).toBe(false);
    expect(isCuratedModel("")).toBe(false);
    expect(isCuratedModel(null)).toBe(false);
  });

  it("prices every curated id from its own MODEL_RATES row, never the unknown-model default", () => {
    // An id that matches no row resolves to the shared DEFAULT_MODEL_RATE object.
    const unknownDefault = resolveModelRateUsdPerMTok("no-such-model-xyz");
    for (const id of CURATED_MODEL_IDS) {
      expect(resolveModelRateUsdPerMTok(id), id).not.toBe(unknownDefault);
    }
    // And the SKU row, not its (pricier) family row.
    expect(resolveModelRateUsdPerMTok("claude-haiku-5-5")).toMatchObject({
      input: 0.1,
      output: 0.5,
    });
    expect(resolveModelRateUsdPerMTok("claude-sonnet-5")).toMatchObject({ input: 2, output: 10 });
    expect(resolveModelRateUsdPerMTok("claude-opus-4-8")).toMatchObject({ input: 5, output: 25 });
  });
});
