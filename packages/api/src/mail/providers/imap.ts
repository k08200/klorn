/**
 * IMAP implementation of MailProviderActions for NAVER and ICLOUD — step B1 of
 * docs/providers/unified-platform-plan.md. Covers exactly three actions, all
 * done with IMAP flags on INBOX and addressed by UID:
 *
 *   markAsRead / toggleRead  ->  \Seen
 *   toggleStar               ->  \Flagged
 *
 * Every other action (send, drafts, trash, archive and their inverses) is
 * spread in from `unsupportedMailActions` and answers `{ unsupported: true }`
 * (501 at the routes) exactly as before. Archive and trash are step B2: an IMAP
 * MOVE assigns a new UID, which needs a schema change first.
 *
 * This file validates and resolves; the connection work is in imap-session.ts,
 * which coalesces concurrent callers into one login per account, caps
 * concurrent sessions, and pauses an account after a rejected login.
 *
 * Result contract (types.ts):
 *   - `{ success: true }` ONLY when the server confirmed the flag by reading it
 *     back (imap-flags.ts).
 *   - `{ error }` for everything else the provider tried and failed: bad or
 *     foreign id, unusable account, auth rejection, transport failure, message
 *     gone from INBOX, flag not applied, a database failure. These actions
 *     never throw. Read and star are safe to fail softly because every caller
 *     writes the local row itself regardless of the result. That is NOT true of
 *     trash/archive (callers delete locally on `{ error }`), so B2 must revisit
 *     this choice — see outlook.ts.
 *   - Never `{ unsupported }` from these three actions.
 *
 * Auth failures mirror the poller (imap-accounts.ts): logged, and NOT flagged
 * `needsReconnect`. The IMAP poller does not flag either; Phase 0b deferred
 * flagging and the Naver/iCloud reconnect copy as one change
 * (multi-provider-plan.md), so this step does not half-implement it.
 *
 * Local state: after a confirmed change the EmailMessage row is updated scoped
 * by userId and message id, exactly like the Gmail path. The next poll reads
 * the same flags from the server, so it agrees with the mirror.
 */

import { decryptToken } from "../../crypto-tokens.js";
import { prisma } from "../../db.js";
import { captureError } from "../../sentry.js";
import { checkImapRow } from "../imap-connection.js";
import { parseImapMessageId } from "../imap-message-id.js";
import {
  IMAP_PROVIDERS,
  type ImapProviderConfig,
  type ImapProviderKey,
} from "../imap-providers.js";
import { type FlagChange, readChange, type ServerOutcome, starChange } from "./imap-flags.js";
import { type SessionAccount, submitFlagOp } from "./imap-session.js";
import type { MailActionFailure, MailProviderActions, SimpleMailActionResult } from "./types.js";
import { unsupportedMailActions } from "./unsupported.js";

interface ResolvedTarget {
  session: SessionAccount;
  uid: number;
}

/** The columns `resolveTarget` selects from LinkedInboxAccount. */
interface AccountRow {
  id: string;
  email: string | null;
  imapHost: string | null;
  imapPasswordCipher: string | null;
}

const fail = (error: string): MailActionFailure => ({ error });
const reconnectHint = (label: string) => `Reconnect your ${label} mailbox in Settings.`;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A database failure: log and report once, answer softly — actions never throw.
 *
 * Only the error's name and code are used, never its text: Prisma messages can
 * embed the query arguments, and for an IMAP row those include the gmailId,
 * which contains the mailbox address. The reported error is a fresh one built
 * from a fixed message, so the raw text cannot reach Sentry either.
 */
function databaseFailure(
  err: unknown,
  provider: ImapProviderConfig,
  ids: { userId: string; rowId: string },
  what: string,
): void {
  const e = err as { name?: unknown; code?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : "NonError";
  const code = typeof e?.code === "string" ? ` ${e.code}` : "";
  console.warn(`[${provider.logScope}] ${what} for row ${ids.rowId} (${name}${code})`);
  const safe = new Error(`${provider.logScope} ${what} (${name}${code})`);
  safe.name = name;
  captureError(safe, {
    tags: { scope: `${provider.logScope}.action-db` },
    extra: { userId: ids.userId, linkedInboxAccountId: ids.rowId },
  });
}

function decryptPassword(
  cipher: string,
  rowId: string,
  provider: ImapProviderConfig,
): string | null {
  try {
    return decryptToken(cipher);
  } catch (err) {
    console.warn(
      `[${provider.logScope}] action skipped — stored password unreadable for row ${rowId}: ${errorMessage(err)}`,
    );
    return null;
  }
}

/**
 * The caller's own account, the UID the message id addresses on it, and the
 * decrypted credentials — or the soft failure to return. Nothing here opens a
 * connection.
 */
async function resolveTarget(
  provider: ImapProviderConfig,
  userId: string,
  linkedInboxAccountId: string,
  messageId: string,
): Promise<ResolvedTarget | MailActionFailure> {
  let row: AccountRow | null;
  try {
    // The caller's own account of this provider only — never crosses users.
    row = await prisma.linkedInboxAccount.findFirst({
      where: { id: linkedInboxAccountId, userId, provider: provider.provider },
      select: { id: true, email: true, imapHost: true, imapPasswordCipher: true },
    });
  } catch (err) {
    databaseFailure(
      err,
      provider,
      { userId, rowId: linkedInboxAccountId },
      "account lookup failed",
    );
    return fail(`Could not look up your ${provider.label} mailbox. Try again shortly.`);
  }
  if (!row) return fail(`${provider.label} mailbox is not connected.`);

  const checked = checkImapRow(row, provider);
  if (!checked.ok) {
    console.warn(`[${provider.logScope}] action skipped — ${checked.reason} for row ${row.id}`);
    return fail(
      checked.reason === "missing-credentials"
        ? `${provider.label} mailbox credentials are missing. ${reconnectHint(provider.label)}`
        : `${provider.label} mailbox is not connected.`,
    );
  }
  const uid = parseImapMessageId(messageId, provider.idPrefix, checked.email);
  if (uid === null) return fail(`That message does not belong to this ${provider.label} mailbox.`);

  const password = decryptPassword(checked.passwordCipher, row.id, provider);
  if (password === null) return fail(reconnectHint(provider.label));

  return {
    uid,
    session: {
      userId,
      rowId: row.id,
      email: checked.email,
      host: checked.host,
      password,
      credentialKey: `${row.id}:${checked.passwordCipher}`,
    },
  };
}

function outcomeError(
  outcome: Exclude<ServerOutcome, "confirmed">,
  label: string,
): MailActionFailure {
  return fail(
    outcome === "missing"
      ? `The message is no longer in your ${label} INBOX.`
      : `${label} did not confirm the change.`,
  );
}

/** Mirror the Gmail path: local state follows only a confirmed server change. */
async function mirrorLocally(
  provider: ImapProviderConfig,
  ids: { userId: string; rowId: string },
  messageId: string,
  change: FlagChange,
): Promise<SimpleMailActionResult> {
  const { userId } = ids;
  try {
    await prisma.emailMessage.updateMany({
      where: { userId, gmailId: messageId },
      data: change.local,
    });
  } catch (err) {
    databaseFailure(err, provider, ids, "local update failed after a confirmed change");
    return fail(
      `Changed on ${provider.label}, but the local copy could not be updated. The next sync will catch up.`,
    );
  }
  return { success: true };
}

async function changeFlag(
  provider: ImapProviderConfig,
  userId: string,
  messageId: string,
  linkedInboxAccountId: string | null | undefined,
  change: FlagChange,
): Promise<SimpleMailActionResult> {
  // The primary inbox (null id) is always Google; an IMAP action without its
  // linked row id is the not-connected class.
  if (!linkedInboxAccountId) {
    return fail(`${provider.label} actions need the linked mailbox id.`);
  }
  const target = await resolveTarget(provider, userId, linkedInboxAccountId, messageId);
  if ("error" in target) return target;

  const result = await submitFlagOp(provider, target.session, { uid: target.uid, change });
  if (typeof result !== "string") return result;
  if (result !== "confirmed") return outcomeError(result, provider.label);
  return mirrorLocally(provider, { userId, rowId: target.session.rowId }, messageId, change);
}

export function imapMailActions(providerKey: ImapProviderKey): MailProviderActions {
  const provider = IMAP_PROVIDERS[providerKey];
  return {
    ...unsupportedMailActions(providerKey),
    markAsRead: (userId, messageId, linkedInboxAccountId) =>
      changeFlag(provider, userId, messageId, linkedInboxAccountId, readChange(true)),
    toggleRead: (userId, messageId, isRead, linkedInboxAccountId) =>
      changeFlag(provider, userId, messageId, linkedInboxAccountId, readChange(isRead)),
    toggleStar: (userId, messageId, starred, linkedInboxAccountId) =>
      changeFlag(provider, userId, messageId, linkedInboxAccountId, starChange(starred)),
  };
}
