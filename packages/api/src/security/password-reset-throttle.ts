/**
 * Per-address limits on POST /api/auth/forgot-password, keyed on the
 * normalized email.
 *
 * The route's per-IP limit (5/15min) cannot see requests for one address
 * spread over many sources, and every request used to mail a new link and
 * overwrite the stored token, killing the link from the previous mail. Two
 * rules bound that:
 *
 * 1. A window of PASSWORD_RESET_MAX_REQUESTS per PASSWORD_RESET_WINDOW_MS per
 *    address (account-window-throttle.ts). Requests are counted for every
 *    address alike, before the account lookup and before any await (the
 *    login-throttle.ts idiom), so concurrent requests cannot all slip past the
 *    check. An exhausted window answers the same 200 `{ success: true }` as
 *    every other request and sends nothing: forgot-password never says
 *    anything about an address, so it does not answer a per-address 429
 *    either. The window is as long as a link lives, so while an address is
 *    locked the link in its newest mail stays valid (a lock never touches the
 *    stored token).
 * 2. Link reuse: a request while the stored link is younger than
 *    PASSWORD_RESET_REUSE_MS keeps that link and mails nothing. A double
 *    submit, or a "send again" while the first mail is still in transit, would
 *    otherwise make the mail that arrives first a dead link; and a request from
 *    someone else right after the owner's own does not invalidate it. Only the
 *    token hash is stored (one-time-token.ts), so the same link cannot be
 *    mailed twice: the owner uses the first mail. After PASSWORD_RESET_REUSE_MS
 *    a request mails a fresh link and retires the old one, as before.
 *
 * Residual: anyone can spend an address's window, and then the owner gets no
 * new mail until it ends; the newest mailed link still works meanwhile.
 * In-process, so a restart resets the counters (fails open) and replicas
 * multiply the threshold (single-instance Render deployment today).
 */

import { createAccountWindowThrottle } from "./account-window-throttle.js";

export const PASSWORD_RESET_MAX_REQUESTS = 5;
/** How long a mailed reset link is valid. */
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
export const PASSWORD_RESET_WINDOW_MS = PASSWORD_RESET_TOKEN_TTL_MS;
export const PASSWORD_RESET_REUSE_MS = 5 * 60 * 1000;
export const PASSWORD_RESET_MAX_TRACKED = 50_000;

const throttle = createAccountWindowThrottle({
  maxAttempts: PASSWORD_RESET_MAX_REQUESTS,
  windowMs: PASSWORD_RESET_WINDOW_MS,
  maxTracked: PASSWORD_RESET_MAX_TRACKED,
});

/** Milliseconds until the address's reset-mail lock expires; 0 when it is not locked. */
export function passwordResetThrottleRemainingMs(normalizedEmail: string): number {
  return throttle.remainingMs(normalizedEmail);
}

/** Count one forgot-password request. Call synchronously right after the check, before any await. */
export function recordPasswordResetRequest(normalizedEmail: string): void {
  throttle.record(normalizedEmail);
}

/**
 * Whether the stored reset link was issued less than PASSWORD_RESET_REUSE_MS
 * ago and is still unexpired, read from its expiry (issued = expiry − TTL).
 */
export function resetLinkIsFresh(
  stored: { resetToken: string | null; resetTokenExp: Date | null },
  now: number = Date.now(),
): boolean {
  if (!stored.resetToken || !stored.resetTokenExp) return false;
  const expiresAt = stored.resetTokenExp.getTime();
  if (expiresAt <= now) return false;
  const issuedAt = expiresAt - PASSWORD_RESET_TOKEN_TTL_MS;
  return now - issuedAt < PASSWORD_RESET_REUSE_MS;
}

/** Test helper: drop all in-memory windows. */
export function _resetPasswordResetThrottleForTests(): void {
  throttle.reset();
}
