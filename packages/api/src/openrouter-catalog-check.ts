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

import { AGENT_MODEL, JUDGE_MODEL, MODEL, VISION_MODEL } from "./openai.js";
import { OPENROUTER_FALLBACK_CHAIN } from "./openrouter-fallback-chain.js";
import { captureError } from "./sentry.js";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 15_000;
const MS_PER_DAY = 86_400_000;
/**
 * How far ahead of a model's `expiration_date` to start warning. The diff
 * (disappeared) fires at delisting, which can lag the actual retirement;
 * the catalog also publishes a sunset date *while the model is still listed
 * and served*. This window turns that pre-delisting signal into lead time.
 */
const EXPIRY_WARN_WINDOW_DAYS = 14;

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
 * Extract id -> `expiration_date` for every catalog entry that carries a
 * non-null sunset date. OpenRouter publishes this on models scheduled for
 * retirement while they are still listed and served, so it is an earlier
 * signal than the presence diff (which only fires once the id is delisted).
 */
export function parseCatalogExpirations(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (body === null || typeof body !== "object") return out;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    if (entry === null || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    const exp = (entry as { expiration_date?: unknown }).expiration_date;
    if (typeof id === "string" && typeof exp === "string" && exp.length > 0) {
      out.set(id, exp);
    }
  }
  return out;
}

/** A depended-on model with a published sunset date. */
export interface ExpiringModel {
  model: string;
  expirationDate: string;
  daysLeft: number;
}

/**
 * Depended-on models whose published `expiration_date` falls within
 * `windowDays` of `now` (including already-past dates — expired-but-still-
 * listed is the loudest case). Entries with an unparseable date are skipped,
 * not guessed. Sorted soonest-first.
 */
export function dependedModelsExpiringSoon(
  expirations: ReadonlyMap<string, string>,
  depended: ReadonlyArray<string>,
  now: Date,
  windowDays: number = EXPIRY_WARN_WINDOW_DAYS,
): ExpiringModel[] {
  const nowMs = now.getTime();
  const out: ExpiringModel[] = [];
  for (const model of new Set(depended)) {
    const raw = expirations.get(model);
    if (raw === undefined) continue;
    const expMs = new Date(raw).getTime();
    if (Number.isNaN(expMs)) continue;
    const daysLeft = Math.floor((expMs - nowMs) / MS_PER_DAY);
    if (daysLeft <= windowDays) {
      out.push({ model, expirationDate: raw, daysLeft });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
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
export function dependedModels(): string[] {
  const models = new Set<string>(OPENROUTER_FALLBACK_CHAIN);
  // CHAT/AGENT/JUDGE/VISION are OpenRouter-first; only vendor-prefixed ids
  // exist in the catalog (bare "gemini-2.5-flash" is a Gemini-direct route).
  // JUDGE_MODEL especially must be watched: it's the firewall's paid tier
  // judge, and its silent retirement is the highest-consequence drift we
  // have — the keyword fallback structurally cannot emit PUSH.
  for (const m of [MODEL, AGENT_MODEL, JUDGE_MODEL, VISION_MODEL]) {
    if (m.includes("/")) models.add(m);
  }
  return [...models];
}

/** A change in the depended-on model set between two catalog checks. */
export interface CatalogDrift {
  /** Models missing now that were present (or unknown) on the previous run. */
  newlyMissing: string[];
  /** Models that were missing on the previous run and are present again now. */
  recovered: string[];
  /** Models still missing, unchanged since the previous run (noise to suppress). */
  unchanged: string[];
}

/**
 * Diff the current missing-models set against the previous run's. This turns a
 * standing "X is missing" snapshot into transition events — the difference
 * between "alert every day until someone fixes the env" (archaeology) and
 * "alert the day the SKU vanished, and again the day it comes back" (a log
 * line). `previous === null` means no prior run, so everything missing now is
 * reported as newly missing.
 */
export function classifyCatalogDrift(
  previous: ReadonlySet<string> | null,
  current: ReadonlyArray<string>,
): CatalogDrift {
  const currentSet = new Set(current);
  const newlyMissing = previous ? current.filter((m) => !previous.has(m)) : [...current];
  const unchanged = previous ? current.filter((m) => previous.has(m)) : [];
  const recovered = previous ? [...previous].filter((m) => !currentSet.has(m)) : [];
  return { newlyMissing, recovered, unchanged };
}

/**
 * Last run's missing set, kept in memory to detect transitions. Null until the
 * first run with a valid catalog (a failed/empty fetch leaves it untouched so a
 * fetch error never masquerades as "everything recovered"). In-memory only: a
 * process restart re-emits one alert for any still-missing model, which is
 * acceptable noise versus the cost of a persistent snapshot table.
 */
let previousMissing: Set<string> | null = null;

/** Test-only: reset the in-memory drift baseline. */
export function __resetCatalogDriftState(): void {
  previousMissing = null;
}

/**
 * Fetch the catalog and warn about any depended-on model that has vanished.
 * Never throws — a failed check is logged and retried on the next scheduled
 * run. Returns the missing models for observability/testing.
 */
export async function runOpenRouterCatalogCheck(now: Date = new Date()): Promise<string[]> {
  try {
    const res = await fetch(CATALOG_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      console.warn(`[CATALOG-CHECK] OpenRouter /models returned ${res.status}; skipping check`);
      return [];
    }
    const body = await res.json();
    const catalogIds = parseCatalogIds(body);
    if (catalogIds.size === 0) {
      console.warn("[CATALOG-CHECK] OpenRouter catalog empty/unparseable; skipping check");
      return [];
    }

    const missing = diffChainAgainstCatalog(dependedModels(), catalogIds);
    const { newlyMissing, recovered, unchanged } = classifyCatalogDrift(previousMissing, missing);
    // Only advance the baseline on a valid catalog — the early returns above
    // keep `previousMissing` intact when the fetch failed or came back empty.
    previousMissing = new Set(missing);

    if (newlyMissing.length > 0) {
      const message = `OpenRouter catalog no longer lists: ${newlyMissing.join(", ")} — retired or renamed upstream. The fallback chain will absorb it, but update the matching env (OPENROUTER_FALLBACK_CHAIN / AGENT_MODEL / JUDGE_MODEL / VISION_MODEL) to stop burning a failed call per cycle.`;
      console.warn(`[CATALOG-CHECK] ${message}`);
      captureError(new Error(message), {
        tags: { scope: "openrouter.catalog_check", drift: "retired" },
        extra: { newlyMissing, stillMissing: unchanged },
      });
    }
    if (recovered.length > 0) {
      console.log(`[CATALOG-CHECK] Back in catalog: ${recovered.join(", ")} — drift resolved.`);
      captureError(new Error(`OpenRouter catalog lists again: ${recovered.join(", ")}`), {
        tags: { scope: "openrouter.catalog_check", drift: "recovered" },
        extra: { recovered },
      });
    }
    if (newlyMissing.length === 0 && recovered.length === 0) {
      if (unchanged.length > 0) {
        // Standing breakage already alerted on its retirement day — stay quiet.
        console.log(`[CATALOG-CHECK] Still missing (already alerted): ${unchanged.join(", ")}`);
      } else {
        console.log(
          `[CATALOG-CHECK] All ${dependedModels().length} depended-on models present in OpenRouter catalog`,
        );
      }
    }

    // Pre-delisting signal: a depended-on model still listed but carrying a
    // sunset date inside the warning window. This is the lead time the
    // presence diff can't give — it only fires once the id is gone.
    const expiring = dependedModelsExpiringSoon(parseCatalogExpirations(body), dependedModels(), now);
    if (expiring.length > 0) {
      const detail = expiring
        .map((e) => `${e.model} (${e.daysLeft <= 0 ? "expired" : `${e.daysLeft}d`}, ${e.expirationDate})`)
        .join(", ");
      const message = `OpenRouter has published a sunset date for: ${detail}. Still listed and served for now — migrate the matching env (AGENT_MODEL / JUDGE_MODEL / VISION_MODEL / OPENROUTER_FALLBACK_CHAIN) before the date, not after the 404.`;
      console.warn(`[CATALOG-CHECK] ${message}`);
      captureError(new Error(message), {
        tags: { scope: "openrouter.catalog_check", signal: "expiring" },
        extra: { expiring },
      });
    }
    return missing;
  } catch (err) {
    console.warn("[CATALOG-CHECK] Catalog fetch failed; will retry next run:", err);
    return [];
  }
}
