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
 * Result contract (types.ts):
 *   - `{ success: true }` ONLY when the server confirmed the flag. STORE alone
 *     proves nothing — imapflow resolves true for a UID that no longer exists,
 *     and a server may ignore a flag — so the change is read back with a UID
 *     FETCH of FLAGS before it is reported.
 *   - `{ error }` for everything else the provider tried and failed: bad or
 *     foreign id, unusable account, auth rejection, transport failure, message
 *     gone from INBOX, flag not applied. Read and star are safe to fail softly
 *     because every caller writes the local row itself regardless of the
 *     result. That is NOT true of trash/archive (callers delete locally on
 *     `{ error }`), so B2 must revisit this choice — see outlook.ts.
 *   - Never `{ unsupported }` from these three actions.
 *
 * Auth failures mirror the poller (imap-accounts.ts): logged, captured nowhere
 * as a bug, and NOT flagged `needsReconnect`. The IMAP poller does not flag
 * either; Phase 0b deferred flagging and the Naver/iCloud reconnect copy as one
 * change (multi-provider-plan.md), so this step does not half-implement it.
 *
 * Local state: after a confirmed change the EmailMessage row is updated scoped
 * by userId and message id, exactly like the Gmail path. The next poll reads
 * the same flags from the server, so it agrees with the mirror.
 */

import type { ImapFlow } from "imapflow";

import { decryptToken } from "../../crypto-tokens.js";
import { prisma } from "../../db.js";
import { captureError } from "../../sentry.js";
import { createImapClient, type ImapRowRejection, rejectImapRow } from "../imap-connection.js";
import { parseImapMessageId } from "../imap-message-id.js";
import {
  IMAP_PROVIDERS,
  type ImapProviderConfig,
  type ImapProviderKey,
} from "../imap-providers.js";
import type { MailActionFailure, MailProviderActions, SimpleMailActionResult } from "./types.js";
import { unsupportedMailActions } from "./unsupported.js";

// A user is waiting on the route: fail fast rather than imapflow's defaults
// (90 s connect, 16 s greeting, 300 s socket inactivity).
export const IMAP_ACTION_CONNECT_TIMEOUT_MS = 10_000;
export const IMAP_ACTION_GREETING_TIMEOUT_MS = 10_000;
export const IMAP_ACTION_SOCKET_TIMEOUT_MS = 15_000;

const INBOX = "INBOX";
const FLAG_SEEN = "\\Seen";
const FLAG_FLAGGED = "\\Flagged";

interface FlagChange {
  flag: string;
  /** true = add the flag, false = remove it. */
  set: boolean;
  /** The EmailMessage columns that mirror it. */
  local: { isRead: boolean } | { isStarred: boolean };
}

const readChange = (isRead: boolean): FlagChange => ({
  flag: FLAG_SEEN,
  set: isRead,
  local: { isRead },
});
const starChange = (starred: boolean): FlagChange => ({
  flag: FLAG_FLAGGED,
  set: starred,
  local: { isStarred: starred },
});

interface AccountRow {
  id: string;
  email: string | null;
  imapHost: string | null;
  imapPasswordCipher: string | null;
}

/** What the server said once the change was read back. */
type ServerOutcome = "confirmed" | "refused" | "missing" | "unconfirmed";

const fail = (error: string): MailActionFailure => ({ error });
const reconnectHint = (label: string) => `Reconnect your ${label} mailbox in Settings.`;

function isAuthFailure(err: unknown): boolean {
  const e = err as { authenticationFailed?: unknown; serverResponseCode?: unknown } | null;
  return e?.authenticationFailed === true || e?.serverResponseCode === "AUTHENTICATIONFAILED";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasFlag(flags: Set<string> | string[] | undefined, flag: string): boolean {
  if (!flags) return false;
  return Array.isArray(flags) ? flags.includes(flag) : flags.has(flag);
}

/** The caller's own account of this provider, or null. Never crosses users. */
function findAccount(
  userId: string,
  linkedInboxAccountId: string,
  provider: ImapProviderConfig,
): Promise<AccountRow | null> {
  return prisma.linkedInboxAccount.findFirst({
    where: { id: linkedInboxAccountId, userId, provider: provider.provider },
    select: { id: true, email: true, imapHost: true, imapPasswordCipher: true },
  });
}

function decryptPassword(row: AccountRow, provider: ImapProviderConfig): string | null {
  try {
    return decryptToken(row.imapPasswordCipher as string);
  } catch (err) {
    console.warn(
      `[${provider.logScope}] action skipped — stored password unreadable for row ${row.id}: ${errorMessage(err)}`,
    );
    return null;
  }
}

/** Close the session whatever happened; LOGOUT failing falls back to a hard close. */
async function endSession(client: ImapFlow): Promise<void> {
  try {
    await client.logout();
  } catch {
    // The connection is already gone or broken; the hard close below is the
    // recovery, and there is nothing a caller could do with this error.
  } finally {
    client.close();
  }
}

async function withInbox<T>(
  provider: ImapProviderConfig,
  account: { email: string; host: string; password: string },
  run: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = createImapClient({
    host: account.host,
    email: account.email,
    password: account.password,
    socketTimeout: IMAP_ACTION_SOCKET_TIMEOUT_MS,
    connectionTimeout: IMAP_ACTION_CONNECT_TIMEOUT_MS,
    greetingTimeout: IMAP_ACTION_GREETING_TIMEOUT_MS,
  });
  // imapflow emits 'error' for socket failures outside a pending command; with
  // no listener Node throws it, and nothing in the process catches that.
  client.on("error", (err: unknown) => {
    console.warn(`[${provider.logScope}] action connection error: ${errorMessage(err)}`);
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(INBOX);
    try {
      return await run(client);
    } finally {
      lock.release();
    }
  } finally {
    await endSession(client);
  }
}

/** STORE the flag by UID, then read it back: success means the server holds it. */
async function storeAndConfirm(
  client: ImapFlow,
  uid: number,
  change: FlagChange,
): Promise<ServerOutcome> {
  const range = String(uid);
  const stored = change.set
    ? await client.messageFlagsAdd(range, [change.flag], { uid: true })
    : await client.messageFlagsRemove(range, [change.flag], { uid: true });
  if (!stored) return "refused";
  const after = await client.fetchOne(range, { flags: true }, { uid: true });
  if (!after) return "missing";
  return hasFlag(after.flags, change.flag) === change.set ? "confirmed" : "unconfirmed";
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

function connectionError(
  err: unknown,
  provider: ImapProviderConfig,
  rowId: string,
  userId: string,
): MailActionFailure {
  if (isAuthFailure(err)) {
    console.warn(`[${provider.logScope}] action refused — login rejected for row ${rowId}`);
    return fail(
      `${provider.label} rejected the saved app password. ${reconnectHint(provider.label)}`,
    );
  }
  console.warn(`[${provider.logScope}] action failed for row ${rowId}: ${errorMessage(err)}`);
  captureError(err, {
    tags: { scope: `${provider.logScope}.action` },
    extra: { userId, linkedInboxAccountId: rowId },
  });
  return fail(`Could not reach ${provider.label}. Try again shortly.`);
}

function rejectionError(reason: ImapRowRejection, label: string): MailActionFailure {
  return fail(
    reason === "missing-credentials"
      ? `${label} mailbox credentials are missing. ${reconnectHint(label)}`
      : `${label} mailbox is not connected.`,
  );
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
  const row = await findAccount(userId, linkedInboxAccountId, provider);
  if (!row) return fail(`${provider.label} mailbox is not connected.`);

  const rejection = rejectImapRow(row, provider);
  if (rejection) {
    console.warn(`[${provider.logScope}] action skipped — ${rejection} for row ${row.id}`);
    return rejectionError(rejection, provider.label);
  }
  const email = row.email as string;
  const uid = parseImapMessageId(messageId, provider.idPrefix, email);
  if (uid === null) return fail(`That message does not belong to this ${provider.label} mailbox.`);

  const password = decryptPassword(row, provider);
  if (password === null) return fail(reconnectHint(provider.label));

  let outcome: ServerOutcome;
  try {
    outcome = await withInbox(
      provider,
      { email, host: row.imapHost as string, password },
      (client) => storeAndConfirm(client, uid, change),
    );
  } catch (err) {
    return connectionError(err, provider, row.id, userId);
  }
  if (outcome !== "confirmed") return outcomeError(outcome, provider.label);

  // Mirror the Gmail path: local state follows only a confirmed server change.
  await prisma.emailMessage.updateMany({
    where: { userId, gmailId: messageId },
    data: change.local,
  });
  return { success: true };
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
