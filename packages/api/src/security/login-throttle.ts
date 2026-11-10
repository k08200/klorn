/**
 * Per-account login throttle, keyed on the normalized email.
 *
 * The per-IP rate limit (10/15min on POST /login) cannot see a distributed
 * brute force that rotates source addresses against a single account. This
 * fixed window (anchored at the first attempt) counts login ATTEMPTS per
 * account regardless of origin and locks the account for the remainder of
 * the window once the threshold is hit; a successful login clears it.
 *
 * Attempts are recorded BEFORE credential verification, in the same
 * synchronous section as the throttle check. The check+record pair never
 * yields to the event loop, so a concurrent wave against one account cannot
 * read a stale count past the threshold (TOCTOU) — at most
 * LOGIN_THROTTLE_MAX_FAILURES guesses enter verification per window.
 *
 * Tradeoffs, deliberately accepted:
 * - In-process (same as notify/sms-limiter.ts): restarts reset the counters,
 *   which only ever fails open. If the API ever runs >1 replica, each
 *   replica tracks its own window, multiplying the effective threshold by
 *   the replica count (single-instance Render deployment today).
 * - Unknown emails are counted too, and the locked response mirrors the
 *   per-IP limiter's, so lockout state never becomes an account-existence
 *   oracle.
 * - Residual lockout-DoS: an attacker who knows a victim's email can still
 *   lock the account by burning 30 attempts. The threshold is intentionally
 *   3x the per-IP limit so a single source address can never trip it alone —
 *   the attack requires 3+ coordinated IPs per 15-minute episode, and every
 *   locked attempt is logged at the route for detection.
 */

export const LOGIN_THROTTLE_MAX_FAILURES = 30;
export const LOGIN_THROTTLE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Hard ceiling on tracked accounts. When exceeded (after dropping expired
 * windows), the oldest windows are evicted first — the limiter fails open
 * rather than letting unique-email floods grow the map without bound. The
 * eviction scan is O(cap) and only runs on inserts while at the cap.
 */
export const LOGIN_THROTTLE_MAX_TRACKED = 50_000;

interface AttemptWindow {
  /** Attempts since the window started */
  count: number;
  /** Epoch ms of the first attempt in the current window */
  windowStartedAt: number;
}

const windows = new Map<string, AttemptWindow>();

function isExpired(w: AttemptWindow, now: number): boolean {
  return now - w.windowStartedAt >= LOGIN_THROTTLE_WINDOW_MS;
}

function sweepExpired(now: number): void {
  for (const [key, w] of windows) {
    if (isExpired(w, now)) windows.delete(key);
  }
}

/** Evict oldest-inserted windows until the map fits under the hard cap. */
function evictToCap(): void {
  for (const key of windows.keys()) {
    if (windows.size <= LOGIN_THROTTLE_MAX_TRACKED - 1) return;
    windows.delete(key);
  }
}

/**
 * Milliseconds until the account's current lock expires; 0 when the account
 * is not locked. Never mutates state beyond dropping an expired window.
 */
export function loginThrottleRemainingMs(normalizedEmail: string): number {
  const now = Date.now();
  const w = windows.get(normalizedEmail);
  if (!w) return 0;
  if (isExpired(w, now)) {
    windows.delete(normalizedEmail);
    return 0;
  }
  if (w.count < LOGIN_THROTTLE_MAX_FAILURES) return 0;
  return w.windowStartedAt + LOGIN_THROTTLE_WINDOW_MS - now;
}

export function isLoginThrottled(normalizedEmail: string): boolean {
  return loginThrottleRemainingMs(normalizedEmail) > 0;
}

/**
 * Count one login attempt. Call synchronously right after the throttle
 * check, before any await — see the module docstring for why.
 */
export function recordLoginAttempt(normalizedEmail: string): void {
  const now = Date.now();
  const w = windows.get(normalizedEmail);
  if (!w || isExpired(w, now)) {
    if (windows.size >= LOGIN_THROTTLE_MAX_TRACKED) {
      sweepExpired(now);
      evictToCap();
    }
    windows.set(normalizedEmail, { count: 1, windowStartedAt: now });
    return;
  }
  windows.set(normalizedEmail, { count: w.count + 1, windowStartedAt: w.windowStartedAt });
}

/** A successful login clears the account's window. */
export function clearLoginAttempts(normalizedEmail: string): void {
  windows.delete(normalizedEmail);
}

/** Test helper: drop all in-memory windows. */
export function _resetLoginThrottleForTests(): void {
  windows.clear();
}

/** Test helper: current number of tracked windows. */
export function _loginThrottleTrackedCountForTests(): number {
  return windows.size;
}
