/**
 * Table-backed Outlook account fan-out — Phase 3B, mirroring
 * mail/imap-accounts.ts: this module owns row selection, token decryption +
 * refresh, cursor persistence, and aggregation; outlook-sync.ts owns the
 * Graph conversation.
 *
 * Token lifecycle per row lives in outlook-token.ts (shared with the action
 * surface since Phase 3C): decrypt → refresh when expired → sync. Any auth
 * failure (undecryptable cipher, invalid_grant on refresh, 401/403 from
 * Graph) flags the row via markLinkedInboxForReconnect — the same durable
 * "Reconnect" prompt the Google linked path uses — and never blocks the
 * user's other accounts.
 */

import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { markLinkedInboxForReconnect } from "./gmail.js";
import { syncOutlookInbox } from "./outlook-sync.js";
import { resolveAccessToken } from "./outlook-token.js";
import { recordSyncError, syncSucceededFields } from "./sync-error-code.js";

export interface OutlookSyncAggregate {
  fetched: number;
  inserted: number;
  classified: number;
  errors: number;
}

/**
 * Sync every OUTLOOK row the user has. Returns null when there are none.
 * Accounts run serially (Graph throttles per app+mailbox); one account's
 * failure counts an error but never blocks the next.
 */
export async function syncOutlookAccountsForUser(
  userId: string,
): Promise<OutlookSyncAggregate | null> {
  const rows = await prisma.linkedInboxAccount.findMany({
    where: { userId, provider: "OUTLOOK" },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return null;

  const total: OutlookSyncAggregate = { fetched: 0, inserted: 0, classified: 0, errors: 0 };
  for (const row of rows) {
    if (!row.email) continue;
    try {
      const accessToken = await resolveAccessToken(userId, row);
      if (!accessToken) {
        // resolveAccessToken has flagged the row for reconnect where that applies.
        total.errors += 1;
        continue;
      }
      const result = await syncOutlookInbox({
        userId,
        email: row.email,
        accessToken,
        linkedInboxAccountId: row.id,
        cursor: row.historyId,
      });
      total.fetched += result.fetched;
      total.inserted += result.inserted;
      total.classified += result.classified;
      total.errors += result.errors;
      if (result.authFailed) {
        void markLinkedInboxForReconnect(userId, row.id, "OUTLOOK").catch((markErr) => {
          console.warn(`[outlook-accounts] reconnect mark failed for row ${row.id}:`, markErr);
        });
        await recordSyncError(userId, row.id, "auth");
        total.errors += 1;
        continue;
      }
      if (result.failure) {
        // Throttled or failed: not a successful check. Pages read before the failure
        // still count: their link is kept, so the next tick resumes after them.
        await recordSyncError(userId, row.id, result.failure);
        if (result.cursor) {
          await prisma.linkedInboxAccount.updateMany({
            where: { id: row.id, userId },
            data: { historyId: result.cursor },
          });
        }
        continue;
      }
      await prisma.linkedInboxAccount.updateMany({
        where: { id: row.id, userId },
        data: {
          // "Synced Xm ago" is the last successful CHECK, not last new mail.
          ...syncSucceededFields(),
          // Advance the delta cursor only when the sync learned a new link —
          // a throttled/failed tick keeps the old cursor and resumes.
          ...(result.cursor ? { historyId: result.cursor } : {}),
        },
      });
    } catch (err) {
      total.errors += 1;
      await recordSyncError(userId, row.id, "error");
      // console first — captureError is a no-op without a Sentry DSN.
      console.warn(`[outlook-accounts] sync failed for row ${row.id}:`, err);
      captureError(err, {
        tags: { scope: "outlook-accounts.account-sync" },
        extra: { userId, linkedInboxAccountId: row.id },
      });
    }
  }
  return total;
}
