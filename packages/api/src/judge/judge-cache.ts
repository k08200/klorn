/**
 * Judge feature cache — an exact prompt→result cache for the LLM scorer.
 *
 * The judge runs at temperature 0 (deterministic): the SAME prompt to the SAME
 * model always yields the same feature vector. So a byte-identical judge call —
 * a re-synced email, a backfill re-classification, or genuinely identical
 * transactional/newsletter mail that slipped past the marketing fast-path — can
 * reuse the previous result instead of paying for another LLM call. This is the
 * cheapest COGS lever on the hot path (cf. the $1/day cost cap): a cache hit is
 * a full LLM call avoided.
 *
 * Correctness: the key includes the model AND the full prompt (which already
 * encodes the email + all per-user context — corrections, sender facts, traits),
 * so two users only share a cache entry when their prompt is genuinely identical.
 * Caching is only sound at temperature 0; the caller must not cache a sampled
 * (temperature > 0) call.
 *
 * Bounded in-process LRU (per dyno, lost on restart — fine for a best-effort
 * cost cache). Semantic near-duplicate caching (embedding.ts) can layer on top
 * later; this exact layer is correct with zero risk of serving a wrong result.
 */

import { createHash } from "node:crypto";
import type { TierFeatures } from "./tier-policy.js";

export interface CachedJudgeResult {
  features: TierFeatures;
  reason: string;
}

function cacheMax(): number {
  const parsed = Number(process.env.JUDGE_CACHE_MAX);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5000;
}

// Insertion order == LRU order (Map preserves it); a get re-inserts to refresh.
const cache = new Map<string, CachedJudgeResult>();

/** Stable key over (model, full prompt). Same inputs → same key. */
export function judgeCacheKey(model: string, prompt: string): string {
  return createHash("sha256").update(`${model}\n${prompt}`).digest("hex");
}

/** Cached result for this key, or null. Returns a fresh object (no aliasing). */
export function getCachedJudgeFeatures(key: string): CachedJudgeResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  // LRU touch: move to most-recently-used.
  cache.delete(key);
  cache.set(key, hit);
  return { features: { ...hit.features }, reason: hit.reason };
}

/** Store a result, evicting the least-recently-used entry when full. */
export function setCachedJudgeFeatures(key: string, value: CachedJudgeResult): void {
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= cacheMax()) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { features: { ...value.features }, reason: value.reason });
}

/** Test-only: clear cache state between cases. */
export function __resetJudgeCache(): void {
  cache.clear();
}
