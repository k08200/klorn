/**
 * A fixed-window attempt counter keyed on a normalized account address: the
 * window is anchored at the first attempt, and the key is locked for the rest
 * of the window once `maxAttempts` were counted. Shared by the per-account
 * login throttle (login-throttle.ts) and the per-address register throttle
 * (register-throttle.ts); each module states its own threshold and tradeoffs.
 *
 * In-process, like notify/sms-limiter.ts: a restart resets the counters, which
 * only ever fails open, and more than one replica multiplies the threshold by
 * the replica count (single-instance Render deployment today).
 */

export interface AccountWindowThrottleOptions {
  /** Attempts a key may make per window before it is locked. */
  maxAttempts: number;
  windowMs: number;
  /**
   * Hard ceiling on tracked keys. When exceeded (after dropping expired
   * windows), the oldest windows are evicted first — the limiter fails open
   * rather than letting unique-key floods grow the map without bound. The
   * eviction scan is O(cap) and only runs on inserts while at the cap.
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
}

interface AttemptWindow {
  /** Attempts since the window started */
  count: number;
  /** Epoch ms of the first attempt in the current window */
  windowStartedAt: number;
}

export function createAccountWindowThrottle(
  options: AccountWindowThrottleOptions,
): AccountWindowThrottle {
  const { maxAttempts, windowMs, maxTracked } = options;
  const windows = new Map<string, AttemptWindow>();

  const isExpired = (w: AttemptWindow, now: number) => now - w.windowStartedAt >= windowMs;

  const sweepExpired = (now: number) => {
    for (const [key, w] of windows) {
      if (isExpired(w, now)) windows.delete(key);
    }
  };

  /** Evict oldest-inserted windows until the map fits under the hard cap. */
  const evictToCap = () => {
    for (const key of windows.keys()) {
      if (windows.size <= maxTracked - 1) return;
      windows.delete(key);
    }
  };

  return {
    remainingMs(key) {
      const now = Date.now();
      const w = windows.get(key);
      if (!w) return 0;
      if (isExpired(w, now)) {
        windows.delete(key);
        return 0;
      }
      if (w.count < maxAttempts) return 0;
      return w.windowStartedAt + windowMs - now;
    },
    record(key) {
      const now = Date.now();
      const w = windows.get(key);
      if (!w || isExpired(w, now)) {
        if (windows.size >= maxTracked) {
          sweepExpired(now);
          evictToCap();
        }
        windows.set(key, { count: 1, windowStartedAt: now });
        return;
      }
      windows.set(key, { count: w.count + 1, windowStartedAt: w.windowStartedAt });
    },
    clear(key) {
      windows.delete(key);
    },
    reset() {
      windows.clear();
    },
    trackedCount() {
      return windows.size;
    },
  };
}
