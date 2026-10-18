/**
 * TanStack Query with an offline cache. Successful reads are persisted
 * (Preferences on native, localStorage in the browser) for 24 h, so a cold
 * start without network still shows the last Today and Mail it saw — with the
 * offline banner — instead of a blank screen. The cache is keyed to the
 * signed-in user (`buster`), encrypted at rest with a device-only key
 * (platform/cache-crypto.ts), and wiped — key included — on sign-out.
 */
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { QueryClient } from "@tanstack/react-query";
import type { PersistQueryClientOptions } from "@tanstack/react-query-persist-client";
import { APP_VERSION } from "../config";
import { cacheKey, forgetCacheKey, openCache, sealCache } from "../platform/cache-crypto";
import { type KeyValueStore, kv } from "../platform/kv";
import { isApiError } from "./client";

export const CACHE_KEY = "klorn-query-cache-v2";
/** The plaintext cache builds before encryption wrote; dropped on first read. */
export const LEGACY_CACHE_KEY = "klorn-query-cache-v1";
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: CACHE_MAX_AGE_MS,
        // Show the cache first and fetch in the background; a dead network
        // never blocks rendering what we already have.
        networkMode: "offlineFirst",
        retry: (count, err) => {
          if (isApiError(err) && (err.kind === "unauthorized" || err.status === 404)) return false;
          // No network: one quick retry, then show the cache with the offline banner.
          if (isApiError(err) && err.isOffline) return count < 1;
          return count < 2;
        },
        refetchOnWindowFocus: true,
      },
    },
  });
}

/**
 * The persister's storage: sealed on write, opened on read. A value that does
 * not open (an old plaintext cache, a key lost to a backup restore or a
 * sign-out, tampering) is removed and reads as "no cache". Without a key
 * nothing is written at all.
 */
export const encryptedCacheStore: KeyValueStore = {
  async getItem(key) {
    // The persister reads once, at launch: the place to drop a pre-encryption cache.
    await kv.removeItem(LEGACY_CACHE_KEY);
    const stored = await kv.getItem(key);
    if (!stored) return null;
    const secret = await cacheKey();
    if (!secret) return null;
    const plain = await openCache(stored, secret);
    if (plain === null) await kv.removeItem(key);
    return plain;
  },
  async setItem(key, value) {
    const secret = await cacheKey();
    if (!secret) return;
    await kv.setItem(key, await sealCache(value, secret));
  },
  removeItem: (key) => kv.removeItem(key),
};

export const persister = createAsyncStoragePersister({
  storage: encryptedCacheStore,
  key: CACHE_KEY,
  throttleTime: 1000,
});

export function persistOptions(userKey: string): Omit<PersistQueryClientOptions, "queryClient"> {
  return {
    persister,
    maxAge: CACHE_MAX_AGE_MS,
    buster: `${APP_VERSION}:${userKey}`,
    dehydrateOptions: {
      shouldDehydrateQuery: (query) =>
        query.state.status === "success" && query.meta?.persist !== false,
    },
  };
}

export async function clearPersistedCache(): Promise<void> {
  await kv.removeItem(CACHE_KEY);
  await kv.removeItem(LEGACY_CACHE_KEY);
  await forgetCacheKey();
}
