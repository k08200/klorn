/**
 * Table-backed IMAP account fan-out (Phase 0b for Naver, generalized to
 * per-provider in Phase 2 — docs/providers/multi-provider-plan.md).
 *
 * IMAP credentials live in LinkedInboxAccount rows, one row per connected
 * mailbox — that is what makes each provider multi-account. Which providers
 * exist (hosts, dedup prefixes, copy) lives in imap-providers.ts.
 *
 * Separated from imap-sync.ts so the fan-out is unit-testable: this module
 * owns row selection, credential decryption, and aggregation; imap-sync.ts
 * owns the actual IMAP conversation.
 */

import { decryptToken } from "../crypto-tokens.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import { rejectImapRow } from "./imap-connection.js";
import type { ImapProviderConfig } from "./imap-providers.js";
import { syncImapInbox } from "./imap-sync.js";

export interface ImapSyncAggregate {
  fetched: number;
  inserted: number;
  classified: number;
  errors: number;
}

/**
 * Sync every row the user has for one provider. Returns null when there are
 * none (the scheduler treats that as "nothing to log"). Accounts run serially
 * — IMAP providers rate-limit multiple LOGINs from one IP — and one account's
 * failure counts an error but never blocks the next.
 */
export async function syncImapAccountsForUser(
  userId: string,
  provider: ImapProviderConfig,
): Promise<ImapSyncAggregate | null> {
  const scope = provider.logScope;
  const rows = await prisma.linkedInboxAccount.findMany({
    where: { userId, provider: provider.provider },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return null;

  const total: ImapSyncAggregate = { fetched: 0, inserted: 0, classified: 0, errors: 0 };
  for (const row of rows) {
    // Connection-boundary guards shared with the flag actions (imap-connection
    // .ts): a row without credentials is half-migrated or hand-edited — skipped
    // silently (it surfaces as needsReconnect through the UI), never thrown; a
    // host outside the allowlist, or one pinned to the other provider, must
    // never open a TLS connection.
    const rejection = rejectImapRow(row, provider);
    if (rejection === "missing-credentials") continue;
    if (rejection === "host-not-allowlisted") {
      console.warn(
        `[${scope}] poll skipped — host not allowlisted for row ${row.id}: ${row.imapHost}`,
      );
      continue;
    }
    if (rejection === "host-provider-mismatch") {
      console.warn(
        `[${scope}] poll skipped — host does not match provider for row ${row.id}: ${row.imapHost}`,
      );
      continue;
    }
    try {
      // rejectImapRow returned null, so all three columns are present.
      const result = await syncImapInbox({
        provider,
        userId,
        email: row.email as string,
        password: decryptToken(row.imapPasswordCipher as string),
        host: row.imapHost as string,
        linkedInboxAccountId: row.id,
      });
      total.fetched += result.fetched;
      total.inserted += result.inserted;
      total.classified += result.classified;
      total.errors += result.errors;
      // Stamp the last successful check (not just last new mail) so the UI's
      // "Synced Xm ago" is real — same contract as the Gmail linked-inbox path.
      await prisma.linkedInboxAccount.updateMany({
        where: { id: row.id, userId },
        data: { lastSyncedAt: new Date() },
      });
    } catch (err) {
      total.errors += 1;
      // console first — captureError is a no-op without a Sentry DSN, and a
      // silent per-account failure here would strand one mailbox invisibly.
      console.warn(`[${scope}] sync failed for row ${row.id}:`, err);
      captureError(err, {
        tags: { scope: `${scope}.account-sync` },
        extra: { userId, linkedInboxAccountId: row.id },
      });
    }
  }
  return total;
}
