import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  embedText,
  embedTexts,
  isEmbeddingEnabled,
  rankBySimilarity,
} from "../embedding.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, -1 for opposite, 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("returns 0 (never NaN) for zero-magnitude or mismatched vectors", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("rankBySimilarity", () => {
  it("returns top-k candidate indices by cosine, descending", () => {
    const query = [1, 0];
    const candidates = [
      [0, 1], // orthogonal (0)
      [1, 0], // identical (1)
      [0.9, 0.1], // close (~0.99)
    ];
    expect(rankBySimilarity(query, candidates, 2)).toEqual([1, 2]);
  });

  it("skips null-vector candidates and clamps k", () => {
    const query = [1, 0];
    const candidates = [null, [1, 0], null, [0.5, 0.5]];
    expect(rankBySimilarity(query, candidates, 10)).toEqual([1, 3]);
    expect(rankBySimilarity(query, candidates, 0)).toEqual([]);
  });

  it("breaks score ties toward the earlier index (stable)", () => {
    const query = [1, 0];
    const candidates = [
      [1, 0],
      [1, 0],
    ];
    expect(rankBySimilarity(query, candidates, 1)).toEqual([0]);
  });
});

describe("embedding disabled (default: EMBEDDING_MODEL unset)", () => {
  it("isEmbeddingEnabled is false and embeds are inert (no network, all null)", async () => {
    // The test env sets no EMBEDDING_MODEL, so the module is OFF — this asserts
    // the safe default: callers get nulls and fall back to lexical retrieval.
    expect(isEmbeddingEnabled()).toBe(false);
    expect(await embedText("hello")).toBeNull();
    expect(await embedTexts(["a", "b"])).toEqual([null, null]);
    expect(await embedTexts([])).toEqual([]);
  });
});
