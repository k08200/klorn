/**
 * Per-user cap on generic-IMAP connect attempts (step B4, design D5 in
 * docs/providers/unified-platform-plan.md). Every attempt opens a real outbound
 * connection to a host the user chose, so without a cap the connect route is a host
 * scanner and a credential-stuffing proxy against third-party servers.
 *
 * Fixed window anchored at the first attempt; attempts past the cap do not extend
 * it. In-process, with the same trade-offs as security/login-throttle.ts: a restart
 * resets it (which only fails open), and each replica counts alone (single instance
 * on Render today). Memory is bounded: past the tracked-user cap the oldest windows
 * are dropped first, which also fails open.
 */

export const GENERIC_IMAP_ATTEMPTS_PER_WINDOW = 10;
export const GENERIC_IMAP_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
export const GENERIC_IMAP_ATTEMPTS_MAX_TRACKED = 10_000;

interface AttemptWindow {
  count: number;
  startedAt: number;
}

export type AttemptDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

const windows = new Map<string, AttemptWindow>();

const isExpired = (window: AttemptWindow, now: number): boolean =>
  now - window.startedAt >= GENERIC_IMAP_ATTEMPT_WINDOW_MS;

function makeRoom(now: number): void {
  for (const [key, window] of windows) {
    if (isExpired(window, now)) windows.delete(key);
  }
  for (const key of windows.keys()) {
    if (windows.size < GENERIC_IMAP_ATTEMPTS_MAX_TRACKED) return;
    windows.delete(key);
  }
}

/** Count one attempt for `userId`, or refuse it. The check and the count never yield. */
export function takeGenericImapAttempt(userId: string, now: number = Date.now()): AttemptDecision {
  const current = windows.get(userId);
  if (current && !isExpired(current, now)) {
    if (current.count >= GENERIC_IMAP_ATTEMPTS_PER_WINDOW) {
      return {
        allowed: false,
        retryAfterMs: current.startedAt + GENERIC_IMAP_ATTEMPT_WINDOW_MS - now,
      };
    }
    windows.set(userId, { count: current.count + 1, startedAt: current.startedAt });
    return { allowed: true };
  }
  if (!current) makeRoom(now);
  windows.set(userId, { count: 1, startedAt: now });
  return { allowed: true };
}

/** Test hook: forget every window. */
export function resetGenericImapAttempts(): void {
  windows.clear();
}
