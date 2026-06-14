/**
 * In-memory snapshot of the last good OpenRouter catalog.
 *
 * The daily catalog check (openrouter-catalog-check.ts) already fetches the
 * full /api/v1/models list; this module retains that snapshot so the dispatch
 * path (openai.ts) can do a pre-flight lease check before sending a request.
 *
 * Why a separate module: openrouter-catalog-check.ts imports model constants
 * from openai.ts. Having openai.ts read the cache from here (instead of from
 * the check module) keeps the dependency graph a DAG — no import cycle.
 *
 * The whole point is to be cheap and fail-open. A cold or empty cache means
 * "unknown", and unknown must never block a dispatch — the reactive 404 path
 * in createCompletion still handles a genuinely-gone model correctly; this
 * only lets us skip the doomed round-trip when we already know it's gone.
 */

let cachedCatalogIds: ReadonlySet<string> | null = null;

/**
 * Store the catalog snapshot from a successful fetch. An empty set is treated
 * as a failed/unknown fetch and is never cached — caching it would make every
 * model look absent and pre-empt every dispatch to the fallback chain.
 */
export function setCachedCatalogIds(ids: ReadonlySet<string>): void {
  if (ids.size === 0) return;
  cachedCatalogIds = ids;
}

/** The cached catalog ids, or null if no successful fetch has happened yet. */
export function getCachedCatalogIds(): ReadonlySet<string> | null {
  return cachedCatalogIds;
}

/**
 * Whether `model` is known to be absent from the OpenRouter catalog. Returns
 * false (fail-open) when:
 *  - the cache is cold/empty (we don't know), or
 *  - the id isn't OpenRouter-namespaced (no "/" — e.g. a Gemini-direct route
 *    that wouldn't appear in the OpenRouter catalog anyway).
 * Only returns true when we have a real catalog and the id is genuinely not in
 * it.
 */
export function isModelKnownAbsent(model: string): boolean {
  const ids = cachedCatalogIds;
  if (ids === null || ids.size === 0) return false;
  if (!model.includes("/")) return false;
  return !ids.has(model);
}

/** Test-only: clear the cached snapshot. */
export function __resetCatalogCache(): void {
  cachedCatalogIds = null;
}
