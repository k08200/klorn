/**
 * The first poll of a freshly connected IMAP inbox (iCloud, Naver, generic),
 * started right after connect instead of waiting up to one scheduler interval
 * (imap-scheduler.ts, 5 min) — an IMAP-only user otherwise finishes onboarding
 * into an empty inbox.
 *
 * It is the scheduler's own fan-out narrowed to the one new row, so every
 * guard still holds: the per-account in-flight lock (a tick that lands while
 * this runs skips the row), the generic-host backoff, the SSRF/host checks and
 * the session deadline. That lock is per process, so the poll only starts in a
 * process that also runs the scheduler — where background work is disabled
 * the next tick elsewhere picks the row up, as before.
 *
 * Fire-and-forget: the connect response never waits on, or fails because of,
 * the poll. A failure is logged and reported, never swallowed.
 */

import { notifyConversationsUpdated } from "../notify/conversations-updated.js";
import { isBackgroundAgentsDisabled } from "../scheduler-heartbeat.js";
import { captureError } from "../sentry.js";
import { syncImapAccountsForUser } from "./imap-accounts.js";
import type { ImapProviderConfig } from "./imap-providers.js";

/** True when the first poll was started here; false when the scheduler will do it. */
export function startFirstImapSync(
  userId: string,
  provider: ImapProviderConfig,
  rowId: string,
): boolean {
  if (isBackgroundAgentsDisabled()) return false;
  void syncImapAccountsForUser(userId, provider, { rowId })
    .then((result) => {
      if (result && result.inserted > 0) notifyConversationsUpdated(userId);
    })
    .catch((err) => {
      console.warn(`[${provider.logScope}] first sync failed for row ${rowId}:`, err);
      captureError(err, {
        tags: { scope: "imap-first-sync" },
        extra: { userId, linkedInboxAccountId: rowId },
      });
    });
  return true;
}
