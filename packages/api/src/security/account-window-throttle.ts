/**
 * A fixed-window attempt counter keyed on a normalized account address: the
 * window is anchored at the first attempt, and the key is locked for the rest
 * of the window once `maxAttempts` were counted. Shared by the per-account
 * login throttle (login-throttle.ts), the per-address register throttle
 * (register-throttle.ts) and the per-address reset-mail window
 * (password-reset-throttle.ts); each module states its own threshold and
 * tradeoffs.
 *
 * The map holds a digest of each address, never the address itself.
 *
 * Cost under a flood of new addresses (the API runs on one 0.1-CPU
 * instance). The map is kept in window-start order: a key whose window
 * restarts is moved to the back, so expired windows sit at the front. Nothing
 * is swept while the map is under its cap (an expired window is dropped when
 * its key is next read). A new window that finds the map full makes room in
 * one walk from the front: it drops expired windows, and if that is not
 * enough evicts the windows that started first until EVICTION_BATCH_SHARE of
 * the cap is free. So a walk happens at most once per that many new keys, and
 * its cost is shared by them, including the deleted slots V8's Map skips at
 * its front. A clock that steps back can leave an expired window behind a
 * live one until it reaches the front; the cap still bounds the map.
 *
 * In-process, like notify/sms-limiter.ts: a restart resets the counters, which
 * only ever fails open, and more than one replica multiplies the threshold by
 * the replica count (single-instance Render deployment today).
 */

import { createHash } from "node:crypto";

export interface AccountWindowThrottleOptions {
  /** Attempts a key may make per window before it is locked. */
  maxAttempts: number;
  windowMs: number;
  /**
   * Hard ceiling on tracked keys. When a new window finds the map full and
   * dropping expired windows is not enough, the windows that started first
   * are evicted — the limiter fails open rather than letting unique-key floods
   * grow the map without bound.
   */
  maxTracked: number;
}

export interface AccountWindowThrottle {
  /** Milliseconds until the key's lock expires; 0 when it is not locked. */
  remainingMs(key: string): number;
  /** Count one attempt. Call synchronously right after `remainingMs`, before any await. */
  record(key: string): void;
  clear(key: string): void;
  /** Test helper: drop every window. */
  reset(): void;
  /** Test helper: current number of tracked windows. */
  trackedCount(): number;
  /** Test helper: windows examined while making room so far. */
  sweepVisitsForTests(): number;
  /** Test helper: walks over the map (each starts at its front) so far. */
  sweepPassesForTests(): number;
}

interface AttemptWindow {
  /** Attempts since the window started */
  readonly count: number;
  /** Epoch ms of the first attempt in the current window */
  readonly windowStartedAt: number;
}

/** Characters of the base64url SHA-256 kept per key (132 bits). */
const KEY_DIGEST_CHARS = 22;

/**
 * Share of the cap one walk frees when a new window finds the map full: 500
 * windows at a 50k cap. The evicted windows are the oldest, the ones the next
 * new keys would have evicted one by one.
 */
const EVICTION_BATCH_SHARE = 0.01;

/** Fixed-size key: the map never holds the address itself. */
function digestKey(key: string): string {
  return createHash("sha256").update(key).digest("base64url").slice(0, KEY_DIGEST_CHARS);
}

export function createAccountWindowThrottle(
  options: AccountWindowThrottleOptions,
): AccountWindowThrottle {
  const { maxAttempts, windowMs, maxTracked } = options;
  /** The size one walk brings a full map down to. */
  const sizeAfterRoom = maxTracked - Math.max(1, Math.ceil(maxTracked * EVICTION_BATCH_SHARE));
  /** Insertion order is window-start order: see the module doc. */
  const windows = new Map<string, AttemptWindow>();
  let sweepVisits = 0;
  let sweepPasses = 0;

  const isExpired = (w: AttemptWindow, now: number) => now - w.windowStartedAt >= windowMs;

  /** One walk from the front: drop expired windows, then evict the oldest live ones. */
  const makeRoom = (now: number) => {
    sweepPasses++;
    for (const [key, w] of windows) {
      sweepVisits++;
      if (!isExpired(w, now) && windows.size <= sizeAfterRoom) return;
      windows.delete(key);
    }
  };

  const startWindow = (digest: string, now: number) => {
    windows.delete(digest);
    if (windows.size >= maxTracked) makeRoom(now);
    windows.set(digest, { count: 1, windowStartedAt: now });
  };

  return {
    remainingMs(key) {
      const digest = digestKey(key);
      const now = Date.now();
      const w = windows.get(digest);
      if (!w) return 0;
      if (isExpired(w, now)) {
        windows.delete(digest);
        return 0;
      }
      if (w.count < maxAttempts) return 0;
      return w.windowStartedAt + windowMs - now;
    },
    record(key) {
      const digest = digestKey(key);
      const now = Date.now();
      const w = windows.get(digest);
      if (!w || isExpired(w, now)) {
        startWindow(digest, now);
        return;
      }
      // Same window: `set` on an existing key keeps its place in the order.
      windows.set(digest, { count: w.count + 1, windowStartedAt: w.windowStartedAt });
    },
    clear(key) {
      windows.delete(digestKey(key));
    },
    reset() {
      windows.clear();
    },
    trackedCount() {
      return windows.size;
    },
    sweepVisitsForTests() {
      return sweepVisits;
    },
    sweepPassesForTests() {
      return sweepPasses;
    },
  };
}
