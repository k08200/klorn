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
 * Cost: the map is kept in window-start order (a key whose window restarts is
 * moved to the back), so expired windows are always at the front. A new window
 * drops expired windows from the front and stops at the first live one, and at
 * the cap evicts from the front: each window is examined about once over its
 * life, so a flood of new addresses costs constant work per request instead of
 * a scan of the whole map. A clock that steps back can leave an expired window
 * behind a live one until it reaches the front; the cap still bounds the map.
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
   * Hard ceiling on tracked keys. When a new window would exceed it (after
   * dropping expired windows), the windows that started first are evicted —
   * the limiter fails open rather than letting unique-key floods grow the map
   * without bound.
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
  /** Test helper: windows examined by expiry sweeps and cap eviction so far. */
  sweepVisitsForTests(): number;
}

interface AttemptWindow {
  /** Attempts since the window started */
  readonly count: number;
  /** Epoch ms of the first attempt in the current window */
  readonly windowStartedAt: number;
}

/** Characters of the base64url SHA-256 kept per key (132 bits). */
const KEY_DIGEST_CHARS = 22;

/** Fixed-size key: the map never holds the address itself. */
function digestKey(key: string): string {
  return createHash("sha256").update(key).digest("base64url").slice(0, KEY_DIGEST_CHARS);
}

export function createAccountWindowThrottle(
  options: AccountWindowThrottleOptions,
): AccountWindowThrottle {
  const { maxAttempts, windowMs, maxTracked } = options;
  /** Insertion order is window-start order: see the module doc. */
  const windows = new Map<string, AttemptWindow>();
  let sweepVisits = 0;

  const isExpired = (w: AttemptWindow, now: number) => now - w.windowStartedAt >= windowMs;

  /** Drop expired windows from the front; stop at the first live one. */
  const dropExpiredFromFront = (now: number) => {
    for (const [key, w] of windows) {
      sweepVisits++;
      if (!isExpired(w, now)) return;
      windows.delete(key);
    }
  };

  /** Evict the windows that started first until one more fits under the cap. */
  const evictOldestToFit = () => {
    for (const key of windows.keys()) {
      if (windows.size < maxTracked) return;
      sweepVisits++;
      windows.delete(key);
    }
  };

  const startWindow = (digest: string, now: number) => {
    windows.delete(digest);
    dropExpiredFromFront(now);
    evictOldestToFit();
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
  };
}
