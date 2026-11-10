import type { AuthProvidersResponse } from "@klorn/contract";

/**
 * Last-known /api/auth/providers response, kept in localStorage.
 *
 * The provider lane is server-driven, so on a cold visit Apple/Naver can only
 * appear after the probe returns — which pushes the email form down mid-read.
 * Seeding react-query with the previous answer makes the lane render at its
 * real height on first paint for every repeat visit; the live query still runs
 * and overwrites this, so a deployment that turns a provider on or off
 * corrects itself.
 *
 * The stored timestamp is part of the contract, not bookkeeping: react-query
 * needs it as `initialDataUpdatedAt`. Without it a seed counts as fetched
 * just-now on EVERY mount, so the query never goes stale and never refetches —
 * the list then freezes for the cache's whole lifetime no matter what the
 * server says. That shipped in #1195 and hid Apple for a day after it was
 * enabled in production.
 */
const STORAGE_KEY = "klorn.auth.providers.v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CachedProviders {
  /** Epoch ms the value was fetched — feeds react-query's initialDataUpdatedAt. */
  at: number;
  value: AuthProvidersResponse;
}

function isProvidersResponse(value: unknown): value is AuthProvidersResponse {
  if (typeof value !== "object" || value === null) return false;
  const providers = (value as { providers?: unknown }).providers;
  return (
    Array.isArray(providers) &&
    providers.every(
      (p) => typeof p === "object" && p !== null && typeof (p as { id?: unknown }).id === "string",
    )
  );
}

export function readCachedProviders(): CachedProviders | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { at, value } = parsed as Partial<CachedProviders>;
    if (typeof at !== "number" || Date.now() - at > MAX_AGE_MS) return undefined;
    return isProvidersResponse(value) ? { at, value } : undefined;
  } catch {
    // Private mode, quota, or hand-edited garbage — the probe is the source of
    // truth anyway, so a bad cache must never break the login page.
    return undefined;
  }
}

export function writeCachedProviders(value: AuthProvidersResponse): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // Non-fatal: the lane just pays the probe latency again next visit.
  }
}
