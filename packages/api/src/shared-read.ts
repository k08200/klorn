/**
 * Join concurrent reads of one key: while a read for `key` is in flight, a
 * second caller gets the same promise instead of starting another, so the
 * callers that miss a cache together cost one query, not one each. Nothing
 * is kept once the read settles (caching stays the caller's job), so the map
 * only ever holds reads in flight. A failed read rejects every caller that
 * joined it. A read still unsettled after `maxAgeMs` is no longer joined —
 * the next caller starts a fresh one — so one hung query cannot hold every
 * later caller of that key.
 */

/** Longer than any read these share should take (the pool waits 10 s for a connection). */
export const SHARED_READ_MAX_AGE_MS = 15_000;

interface InFlight<T> {
  promise: Promise<T>;
  startedAt: number;
}

export function createSharedRead<T>(
  maxAgeMs = SHARED_READ_MAX_AGE_MS,
): (key: string, read: () => Promise<T>) => Promise<T> {
  const inFlight = new Map<string, InFlight<T>>();
  return (key, read) => {
    const now = Date.now();
    const pending = inFlight.get(key);
    if (pending && now - pending.startedAt < maxAgeMs) return pending.promise;
    const promise: Promise<T> = read().finally(() => {
      // A newer read may have replaced this one; leave that one in place.
      if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
    });
    inFlight.set(key, { promise, startedAt: now });
    return promise;
  };
}
