/**
 * The one failure policy for a linked calendar account, shared by the conflict
 * checks (pim/calendar.ts) and the linked sync (pim/calendar-sync.ts), so the
 * two cannot drift.
 *
 * A revoked grant, Google's or Microsoft's, is a condition of the account (the
 * user revoked access or the token died), not a bug: it flags the account for
 * reconnect, is warned about once per account per window, and is never sent to
 * Sentry, where it would page on every cycle for something only the user can fix.
 * Any other failure is warned about and captured, with the domain only and never
 * the full address (PII).
 *
 * "Revoked grant" is matched precisely, on purpose stricter than main's
 * `isGoogleAuthError`, which also matches any message containing "expired",
 * "unauthorized", "revoked" or "invalid token": an unrelated "request expired"
 * would then be flagged as a revoked account and hidden from Sentry.
 *
 * CalDAV (ICLOUD, NAVER; review fix 2026-10-02): a failure that is not a 401 is
 * warned about every time but sent to Sentry once per account per failure kind
 * (`caldavErrorClass`) per process. The provider backs the account off after it
 * (pim/caldav/caldav-backoff.ts), and a stalled server used to raise one event
 * per account every sync tick. Google and Outlook pass their own provider and keep
 * the policy above, unchanged.
 */

import { markLinkedCalendarForReconnect } from "../mail/gmail.js";
import { captureError } from "../sentry.js";
import { caldavErrorClass } from "./caldav/caldav-errors.js";
import { isCaldavProviderKey } from "./caldav/caldav-providers.js";
import type { CalendarProviderName } from "./calendar-rows.js";

/** How long an account's auth failure stays quiet in the log after it is first warned about. */
export const LINKED_AUTH_WARN_WINDOW_MS = 60 * 60 * 1000;

const lastAuthWarnAt = new Map<string, number>();
/** "<account>:<kind>" pairs already sent to Sentry (CalDAV only). */
const reportedCaldavFailures = new Set<string>();
const MAX_TRACKED_CALDAV_FAILURES = 10_000;

export function _resetLinkedCalendarFailureLogForTests(): void {
  lastAuthWarnAt.clear();
  reportedCaldavFailures.clear();
}

export function _linkedCalendarFailureLogSizeForTests(): number {
  return lastAuthWarnAt.size;
}

/**
 * The OAuth error codes that mean only the user can fix the account: Google's
 * revoked or withdrawn grant, and Microsoft's `interaction_required` (a refresh
 * that now needs MFA or a conditional-access prompt, step C4).
 */
const REVOKED_GRANT_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "unauthorized_client",
  "interaction_required",
]);
const REVOKED_GRANT_MESSAGE = /^(invalid_grant|unauthorized_client|interaction_required)\b/;
const HTTP_UNAUTHORIZED = 401;

/**
 * True for HTTP 401 (googleapis' `response.status` or `code`, or the `status` of
 * a Microsoft Graph error), or an OAuth `invalid_grant` / `unauthorized_client` /
 * `interaction_required` code (in the response body, the error code, or at the
 * start of the message, which is how google-auth-library reports a failed
 * refresh). Nothing else: a message that merely mentions "expired" is not a
 * revoked grant.
 */
export function isRevokedGrantError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    response?: { status?: unknown; data?: { error?: unknown } };
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (
    e.response?.status === HTTP_UNAUTHORIZED ||
    e.status === HTTP_UNAUTHORIZED ||
    Number(e.code) === HTTP_UNAUTHORIZED
  ) {
    return true;
  }
  const bodyCode = e.response?.data?.error;
  for (const code of [bodyCode, e.code]) {
    if (typeof code === "string" && REVOKED_GRANT_CODES.has(code)) return true;
  }
  return typeof e.message === "string" && REVOKED_GRANT_MESSAGE.test(e.message);
}

export interface LinkedCalendarFailure {
  readonly userId: string;
  readonly linkedAccountId: string;
  readonly email: string;
  readonly err: unknown;
  /** Sentry scope tag for a failure that is not an auth error. */
  readonly scope: string;
  /** What was being done, for the log line ("sync", "free/busy"). */
  readonly action: string;
  /** The account's provider: ICLOUD and NAVER get the CalDAV Sentry dedupe. */
  readonly provider?: CalendarProviderName;
}

function shouldWarnAuthFailure(linkedAccountId: string, now: number): boolean {
  // Drop accounts whose window has passed, so the log cannot grow without bound
  // over a long-lived process.
  for (const [id, warnedAt] of lastAuthWarnAt) {
    if (now - warnedAt >= LINKED_AUTH_WARN_WINDOW_MS) lastAuthWarnAt.delete(id);
  }
  if (lastAuthWarnAt.has(linkedAccountId)) return false;
  lastAuthWarnAt.set(linkedAccountId, now);
  return true;
}

/** Best-effort: a DB blip in the flag write must not abort the caller's loop or hide the condition. */
async function flagForReconnect(userId: string, linkedAccountId: string): Promise<void> {
  await markLinkedCalendarForReconnect(userId, linkedAccountId).catch((markErr) => {
    console.error(
      `[CALENDAR] Failed to flag linked calendar ${linkedAccountId} for reconnect:`,
      markErr,
    );
    captureError(markErr, { tags: { scope: "calendar.linked.mark-reconnect" } });
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True the first time this account fails this way in this process (CalDAV). */
function firstCaldavFailure(linkedAccountId: string, err: unknown): boolean {
  const key = `${linkedAccountId}:${caldavErrorClass(err)}`;
  if (reportedCaldavFailures.has(key)) return false;
  if (reportedCaldavFailures.size >= MAX_TRACKED_CALDAV_FAILURES) {
    const oldest = reportedCaldavFailures.values().next().value;
    if (oldest !== undefined) reportedCaldavFailures.delete(oldest);
  }
  reportedCaldavFailures.add(key);
  return true;
}

export async function handleLinkedCalendarFailure(failure: LinkedCalendarFailure): Promise<void> {
  const { userId, linkedAccountId, email, err, scope, action } = failure;

  if (isRevokedGrantError(err)) {
    await flagForReconnect(userId, linkedAccountId);
    if (shouldWarnAuthFailure(linkedAccountId, Date.now())) {
      console.warn(
        `[CALENDAR] linked-account ${action} needs a re-link (skipped): ${describeError(err)}`,
      );
    }
    return;
  }

  console.warn(`[CALENDAR] linked-account ${action} failed (skipped): ${describeError(err)}`);
  const caldav = failure.provider !== undefined && isCaldavProviderKey(failure.provider);
  if (caldav && !firstCaldavFailure(linkedAccountId, err)) return;
  captureError(err, {
    tags: { scope },
    // Domain only — never send the full linked email (PII) to Sentry.
    extra: { userId, accountDomain: email.split("@")[1] ?? "unknown" },
  });
}
