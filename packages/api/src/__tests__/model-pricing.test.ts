/**
 * Per-model pricing for estimateModelCostUsd.
 *
 * The previous implementation ignored the model argument and priced EVERY
 * paid model at gemini-flash rates ($0.15/$0.60 per M) — undercounting a
 * claude-sonnet call (~$3/$15 per M) by ~20x and defeating the daily cost
 * caps. These tests pin the model-aware table: real rates per family,
 * conservative (sonnet-level) default for unknown models.
 */

import { describe, expect, it } from "vitest";
import { estimateModelCostUsd } from "../llm/model-fallback.js";

const M = 1_000_000;

describe("estimateModelCostUsd — model-aware pricing", () => {
  it("prices a :free-suffixed id like its family (no $0 shortcut without the proxy lane)", () => {
    const free = estimateModelCostUsd("google/gemma-4-31b-it:free", M, M);
    expect(free).toBeGreaterThan(0);
    expect(free).toBeCloseTo(estimateModelCostUsd("google/gemma-4-31b-it", M, M), 9);
  });

  it("returns 0 for zero tokens on a paid model", () => {
    expect(estimateModelCostUsd("claude-sonnet-5", 0, 0)).toBe(0);
  });

  it("prices claude-sonnet-4-6 at ~$3/M input and ~$15/M output", () => {
    expect(estimateModelCostUsd("claude-sonnet-4-6", M, 0)).toBeCloseTo(3, 5);
    expect(estimateModelCostUsd("claude-sonnet-4-6", 0, M)).toBeCloseTo(15, 5);
  });

  it("prices Claude Sonnet 5 at its $2/$10 list price, native or vendor-prefixed", () => {
    for (const id of ["claude-sonnet-5", "anthropic/claude-sonnet-5"]) {
      expect(estimateModelCostUsd(id, M, 0), id).toBeCloseTo(2, 5);
      expect(estimateModelCostUsd(id, 0, M), id).toBeCloseTo(10, 5);
    }
  });

  it("no longer flat-rates sonnet at flash prices (the ~20x undercount)", () => {
    const sonnet = estimateModelCostUsd("claude-sonnet-4-6", 10_000, 2_000);
    const flash = estimateModelCostUsd("google/gemini-2.5-flash", 10_000, 2_000);
    expect(sonnet).toBeGreaterThan(flash * 5);
  });

  it("orders claude tiers: haiku < sonnet < opus", () => {
    const haiku = estimateModelCostUsd("anthropic/claude-haiku-4.5", M, M);
    const sonnet = estimateModelCostUsd("anthropic/claude-sonnet-4-6", M, M);
    const opus = estimateModelCostUsd("anthropic/claude-opus-4.8", M, M);
    expect(haiku).toBeLessThan(sonnet);
    expect(sonnet).toBeLessThan(opus);
  });

  it("prices gemini flash-lite below flash", () => {
    const lite = estimateModelCostUsd("google/gemini-2.5-flash-lite", M, M);
    const flash = estimateModelCostUsd("google/gemini-2.5-flash", M, M);
    expect(lite).toBeLessThan(flash);
  });

  it("gives every code/render.yaml model a positive model-specific price", () => {
    const seen = [
      "claude-sonnet-5", // CHAT_MODEL (render.yaml) + catalog
      "claude-haiku-5-5", // in-code default + AGENT/JUDGE/VISION_MODEL (render.yaml) + catalog
      "claude-opus-4-8", // catalog
      "gemini-2.5-flash", // GEMINI_FALLBACK_MODEL default (self-host)
      "google/gemini-2.5-pro",
      "meta-llama/llama-3.3-70b-instruct",
      "deepseek/deepseek-r1",
    ];
    for (const model of seen) {
      expect(estimateModelCostUsd(model, M, M), model).toBeGreaterThan(0);
    }
  });

  it("prices unknown models at a conservative default (>= sonnet tier, not flash)", () => {
    const unknown = estimateModelCostUsd("mystery-vendor/next-gen-9000", M, M);
    const sonnet = estimateModelCostUsd("claude-sonnet-4-6", M, M);
    const flash = estimateModelCostUsd("google/gemini-2.5-flash", M, M);
    expect(unknown).toBeGreaterThanOrEqual(sonnet);
    expect(unknown).toBeGreaterThan(flash);
  });

  it("is case-insensitive on the model id", () => {
    expect(estimateModelCostUsd("Anthropic/Claude-Sonnet-5", M, 0)).toBeCloseTo(2, 5);
    expect(estimateModelCostUsd("CLAUDE-SONNET-4-6", M, 0)).toBeCloseTo(3, 5);
  });
});
