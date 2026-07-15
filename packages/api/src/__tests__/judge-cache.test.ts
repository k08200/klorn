import { afterEach, describe, expect, it } from "vitest";
import {
  __resetJudgeCache,
  getCachedJudgeFeatures,
  judgeCacheKey,
  setCachedJudgeFeatures,
} from "../judge/judge-cache.js";
import type { TierFeatures } from "../judge/tier-policy.js";

const feat = (confidence: number): TierFeatures => ({
  confidence,
  senderTrust: 0.5,
  reversibility: 0.5,
  urgency: 0.5,
});

afterEach(() => {
  __resetJudgeCache();
  delete process.env.JUDGE_CACHE_MAX;
});

describe("judgeCacheKey", () => {
  it("is stable for identical (model, prompt) and differs on either", () => {
    const a = judgeCacheKey("gemini", "prompt-1");
    expect(judgeCacheKey("gemini", "prompt-1")).toBe(a);
    expect(judgeCacheKey("gemini", "prompt-2")).not.toBe(a);
    expect(judgeCacheKey("gpt", "prompt-1")).not.toBe(a);
  });
});

describe("get/set", () => {
  it("round-trips a stored result and returns a non-aliased copy", () => {
    const key = judgeCacheKey("m", "p");
    const stored = { features: feat(0.9), reason: "urgent" };
    setCachedJudgeFeatures(key, stored);
    const got = getCachedJudgeFeatures(key);
    expect(got).toEqual({ features: feat(0.9), reason: "urgent" });
    // Mutating the returned object must not corrupt the cache.
    got!.features.confidence = 0.1;
    expect(getCachedJudgeFeatures(key)?.features.confidence).toBe(0.9);
  });

  it("returns null on a miss", () => {
    expect(getCachedJudgeFeatures(judgeCacheKey("m", "absent"))).toBeNull();
  });
});

describe("LRU eviction", () => {
  it("evicts the least-recently-used entry past JUDGE_CACHE_MAX", () => {
    process.env.JUDGE_CACHE_MAX = "2";
    const k1 = judgeCacheKey("m", "1");
    const k2 = judgeCacheKey("m", "2");
    const k3 = judgeCacheKey("m", "3");
    setCachedJudgeFeatures(k1, { features: feat(0.1), reason: "1" });
    setCachedJudgeFeatures(k2, { features: feat(0.2), reason: "2" });
    // Touch k1 so k2 becomes the LRU.
    getCachedJudgeFeatures(k1);
    setCachedJudgeFeatures(k3, { features: feat(0.3), reason: "3" });
    expect(getCachedJudgeFeatures(k2)).toBeNull(); // evicted
    expect(getCachedJudgeFeatures(k1)).not.toBeNull();
    expect(getCachedJudgeFeatures(k3)).not.toBeNull();
  });
});
