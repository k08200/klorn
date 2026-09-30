/**
 * The one failure policy for a linked calendar account, shared by the conflict
 * checks (pim/calendar.ts) and the linked sync (pim/calendar-sync.ts), so the
 * two cannot drift.
 *
 * A Google auth error is a condition of the account (the user revoked access or
 * the token died), not a bug: it flags the account for reconnect, is warned
 * about once per account per window, and is never sent to Sentry, where it would
 * page on every cycle for something only the user can fix. Any other failure is
 * warned about and captured, with the domain only and never the full address
 * (PII).
 */

import { isGoogleAuthError, markLinkedCalendarForReconnect } from "../mail/gmail.js";
import { captureError } from "../sentry.js";

/** How long an account's auth failure stays quiet in the log after it is first warned about. */
export const LINKED_AUTH_WARN_WINDOW_MS = 60 * 60 * 1000;

const lastAuthWarnAt = new Map<string, number>();

export function _resetLinkedCalendarFailureLogForTests(): void {
  lastAuthWarnAt.clear();
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
}

function shouldWarnAuthFailure(linkedAccountId: string, now: number): boolean {
  const last = lastAuthWarnAt.get(linkedAccountId);
  if (last !== undefined && now - last < LINKED_AUTH_WARN_WINDOW_MS) return false;
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

export async function handleLinkedCalendarFailure(failure: LinkedCalendarFailure): Promise<void> {
  const { userId, linkedAccountId, email, err, scope, action } = failure;

  if (isGoogleAuthError(err)) {
    await flagForReconnect(userId, linkedAccountId);
    if (shouldWarnAuthFailure(linkedAccountId, Date.now())) {
      console.warn(
        `[CALENDAR] linked-account ${action} needs a re-link (skipped): ${describeError(err)}`,
      );
    }
    return;
  }

  console.warn(`[CALENDAR] linked-account ${action} failed (skipped): ${describeError(err)}`);
  captureError(err, {
    tags: { scope },
    // Domain only — never send the full linked email (PII) to Sentry.
    extra: { userId, accountDomain: email.split("@")[1] ?? "unknown" },
  });
}
