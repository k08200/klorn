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
import { checkImapRow } from "./imap-connection.js";
import { parseImapMessageId } from "./imap-message-id.js";
import { clearPollBackoff, isPollBackedOff, notePollBackoff } from "./imap-poll-backoff.js";
import {
  clearPollFailure,
  pollFailureKind,
  shouldReportPollFailure,
} from "./imap-poll-failures.js";
import type { ImapProviderConfig } from "./imap-providers.js";
import { syncImapInbox, syncImapMessage } from "./imap-sync.js";
import { canonicalUidValidity } from "./imap-uidvalidity.js";
import { sanitizeLogText } from "./log-text.js";
import {
  isCredentialCoolingDown,
  isImapAuthFailure,
  startCredentialCooldown,
} from "./providers/imap-session.js";

export interface ImapSyncAggregate {
  fetched: number;
  inserted: number;
  classified: number;
  errors: number;
}

/**
 * The accounts whose poll is running right now (every provider). A tick that finds an
 * account here skips it: the same mailbox is never logged into twice at once, and a
 * stuck account blocks neither the other accounts nor the next tick.
 */
const pollsInFlight = new Set<string>();

/** The credential the shared auth cooldown is keyed by: the same string the actions use. */
const credentialKeyOf = (rowId: string, passwordCipher: string): string =>
  `${rowId}:${passwordCipher}`;

/**
 * A generic row stays out of the poll while its login is known to be rejected (the
 * durable `needsReconnect` flag set below and cleared by a successful reconnect, or the
 * in-process cooldown it shares with the actions: a revoked password is not sent to
 * the host again on every tick) and while it is backed off after failing in another way
 * (imap-poll-backoff.ts: a stalling host costs a serial tick up to ~105 s).
 */
function isPausedForPolling(
  row: { id: string; needsReconnect?: boolean | null },
  credentialKey: string,
): boolean {
  return (
    row.needsReconnect === true || isCredentialCoolingDown(credentialKey) || isPollBackedOff(row.id)
  );
}

/**
 * A generic poll failed. Log one capped line (the text came from a server the user
 * chose), stop sending a rejected password, and report to Sentry once per account and
 * failure kind instead of on every tick. Never throws.
 */
async function handleGenericPollFailure(
  err: unknown,
  ctx: {
    provider: ImapProviderConfig;
    userId: string;
    rowId: string;
    credentialKey: string;
    /** The stored cipher the poll STARTED with: a flag is only written against that credential. */
    passwordCipher: string;
  },
): Promise<void> {
  const { provider, userId, rowId, credentialKey, passwordCipher } = ctx;
  const scope = provider.logScope;
  const kind = pollFailureKind(err);
  console.warn(`[${scope}] sync failed for row ${rowId} (${kind}): ${sanitizeLogText(err)}`);
  if (!isImapAuthFailure(err)) {
    notePollBackoff(rowId);
  } else {
    startCredentialCooldown(provider, rowId, credentialKey);
    try {
      // Conditional on the cipher the poll began with: a user who relinked while this
      // poll's login was being rejected has a NEW password, which must not be flagged.
      await prisma.linkedInboxAccount.updateMany({
        where: { id: rowId, userId, imapPasswordCipher: passwordCipher },
        data: { needsReconnect: true },
      });
    } catch (flagErr) {
      console.warn(
        `[${scope}] could not flag row ${rowId} for reconnect: ${sanitizeLogText(flagErr)}`,
      );
    }
  }
  if (shouldReportPollFailure(rowId, kind)) {
    captureError(err, {
      tags: { scope: `${scope}.account-sync` },
      extra: { userId, linkedInboxAccountId: rowId, failureKind: kind },
    });
  }
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
    const checked = checkImapRow(row, provider);
    if (!checked.ok) {
      if (checked.reason === "host-not-allowlisted") {
        console.warn(
          `[${scope}] poll skipped — host not allowlisted for row ${row.id}: ${row.imapHost}`,
        );
      } else if (checked.reason === "host-provider-mismatch") {
        console.warn(
          `[${scope}] poll skipped — host does not match provider for row ${row.id}: ${row.imapHost}`,
        );
      }
      continue;
    }
    // Generic IMAP only (step B4): the poll must not re-send a rejected password.
    const userHost = provider.hostPolicy === "user-supplied";
    const credentialKey = credentialKeyOf(row.id, checked.passwordCipher);
    if (pollsInFlight.has(row.id)) continue; // its previous poll is still running
    if (userHost && isPausedForPolling(row, credentialKey)) continue;
    pollsInFlight.add(row.id);
    try {
      const result = await syncImapInbox({
        provider,
        userId,
        email: checked.email,
        password: decryptToken(checked.passwordCipher),
        host: checked.host,
        linkedInboxAccountId: row.id,
        inboxUidValidity: canonicalUidValidity(row.inboxUidValidity),
        inboxUidValidityPending: canonicalUidValidity(row.inboxUidValidityPending),
        inboxUidValidityPendingAt: row.inboxUidValidityPendingAt,
        inboxUidValidityResetAt: row.inboxUidValidityResetAt,
      });
      total.fetched += result.fetched;
      total.inserted += result.inserted;
      total.classified += result.classified;
      total.errors += result.errors;
      // Stamp the last successful check (not just last new mail) so the UI's
      // "Synced Xm ago" is real — same contract as the Gmail linked-inbox path. A held
      // poll (UIDVALIDITY reset, step B2b) stored nothing, so it is not a sync: it does
      // not stamp, and for a generic row it does not re-arm the failure report either.
      // The host answered, held or not: a stall is over, whatever the poll then stored.
      if (userHost) clearPollBackoff(row.id);
      if (!result.held) {
        await prisma.linkedInboxAccount.updateMany({
          where: { id: row.id, userId },
          data: { lastSyncedAt: new Date() },
        });
        if (userHost) clearPollFailure(row.id);
      }
    } catch (err) {
      total.errors += 1;
      if (userHost) {
        await handleGenericPollFailure(err, {
          provider,
          userId,
          rowId: row.id,
          credentialKey,
          passwordCipher: checked.passwordCipher,
        });
        continue;
      }
      // console first — captureError is a no-op without a Sentry DSN, and a
      // silent per-account failure here would strand one mailbox invisibly.
      console.warn(`[${scope}] sync failed for row ${row.id}:`, err);
      captureError(err, {
        tags: { scope: `${scope}.account-sync` },
        extra: { userId, linkedInboxAccountId: row.id },
      });
    } finally {
      pollsInFlight.delete(row.id);
    }
  }
  return total;
}

/**
 * Ingest one message of a linked mailbox's INBOX by its message id, for the undo
 * routes (step B2): a MOVE back into INBOX gives the message a new UID, hence a new
 * id, and the route needs the row at once. Scoped to the user's own account of this
 * provider; the id must be exactly this mailbox's (`<idPrefix>:<email>:<uid>`).
 * Resolves with the row id, or null when the account, the id or the message is not
 * there. Throws on connection and database failures.
 */
export async function syncImapMessageForUser(
  userId: string,
  provider: ImapProviderConfig,
  linkedInboxAccountId: string,
  messageId: string,
): Promise<{ emailId: string } | null> {
  const row = await prisma.linkedInboxAccount.findFirst({
    where: { id: linkedInboxAccountId, userId, provider: provider.provider },
  });
  if (!row) return null;
  const checked = checkImapRow(row, provider);
  if (!checked.ok) return null;
  const uid = parseImapMessageId(messageId, provider.idPrefix, checked.email);
  if (uid === null) return null;
  return syncImapMessage({
    provider,
    userId,
    email: checked.email,
    password: decryptToken(checked.passwordCipher),
    host: checked.host,
    linkedInboxAccountId: row.id,
    uid,
  });
}
