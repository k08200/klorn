/**
 * Proactive OpenRouter catalog check.
 *
 * The fallback chain (openrouter-fallback-chain.ts) handles model retirement
 * reactively — the first agent cycle after a retirement eats a 404, then walks
 * to the next model. That works, but the operator only finds out from logs
 * after the fact, and a silent *rename* looks identical to a retirement from
 * the caller's side.
 *
 * This module closes that gap with a daily diff: fetch OpenRouter's public
 * /api/v1/models catalog and verify every model we depend on (the fallback
 * chain plus the configured chat/agent models) still exists upstream. When
 * something disappears we warn loudly and capture to Sentry — before any
 * agent cycle has to discover it the hard way.
 *
 * Deliberately minimal: detection only, no alias/auto-remap layer. The chain
 * already keeps the agent alive through a retirement; this just turns
 * "mystery 404s in the logs" into "named alert the same day the SKU vanished."
 */

import { AGENT_MODEL, MODEL } from "./openai.js";
import { OPENROUTER_FALLBACK_CHAIN } from "./openrouter-fallback-chain.js";
import { captureError } from "./sentry.js";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 15_000;

/** Extract the set of model ids from the /api/v1/models response body. */
export function parseCatalogIds(body: unknown): Set<string> {
  const ids = new Set<string>();
  if (body === null || typeof body !== "object") return ids;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return ids;
  for (const entry of data) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as { id?: unknown }).id === "string"
    ) {
      ids.add((entry as { id: string }).id);
    }
  }
  return ids;
}

/**
 * Models from `chain` that are absent from the catalog. An empty catalog is
 * treated as "fetch failed / unknown" and reports nothing — alerting that
 * every model vanished at once would be noise, not signal.
 */
export function diffChainAgainstCatalog(
  chain: ReadonlyArray<string>,
  catalogIds: ReadonlySet<string>,
): string[] {
  if (catalogIds.size === 0) return [];
  return [...new Set(chain)].filter((model) => !catalogIds.has(model));
}

/** All OpenRouter model ids this deployment depends on. */
function dependedModels(): string[] {
  const models = new Set<string>(OPENROUTER_FALLBACK_CHAIN);
  // CHAT_MODEL / AGENT_MODEL are OpenRouter-first; only vendor-prefixed ids
  // exist in the catalog (bare "gemini-2.5-flash" is a Gemini-direct route).
  for (const m of [MODEL, AGENT_MODEL]) {
    if (m.includes("/")) models.add(m);
  }
  return [...models];
}

/**
 * Fetch the catalog and warn about any depended-on model that has vanished.
 * Never throws — a failed check is logged and retried on the next scheduled
 * run. Returns the missing models for observability/testing.
 */
export async function runOpenRouterCatalogCheck(): Promise<string[]> {
  try {
    const res = await fetch(CATALOG_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`[CATALOG-CHECK] OpenRouter /models returned ${res.status}; skipping check`);
      return [];
    }
    const catalogIds = parseCatalogIds(await res.json());
    if (catalogIds.size === 0) {
      console.warn("[CATALOG-CHECK] OpenRouter catalog empty/unparseable; skipping check");
      return [];
    }

    const missing = diffChainAgainstCatalog(dependedModels(), catalogIds);
    if (missing.length > 0) {
      const message = `OpenRouter catalog no longer lists: ${missing.join(", ")} — retired or renamed upstream. The fallback chain will absorb it, but update OPENROUTER_FALLBACK_CHAIN / AGENT_MODEL to stop burning a failed call per cycle.`;
      console.warn(`[CATALOG-CHECK] ${message}`);
      captureError(new Error(message), {
        tags: { scope: "openrouter.catalog_check" },
        extra: { missing },
      });
    } else {
      console.log(
        `[CATALOG-CHECK] All ${dependedModels().length} depended-on models present in OpenRouter catalog`,
      );
    }
    return missing;
  } catch (err) {
    console.warn("[CATALOG-CHECK] Catalog fetch failed; will retry next run:", err);
    return [];
  }
}
