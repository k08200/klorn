/**
 * Finding the caller's own IMAP account row and turning it into credentials a
 * session may use — shared by the flag actions (imap.ts, step B1) and by send,
 * drafts and reply headers (imap-send.ts, step B3), so both resolve an account
 * the same way and fail with the same words.
 *
 * Two stages, because the flag actions parse the message id between them and
 * must do so before the password is decrypted:
 *   1. `findCheckedAccount` — the row, scoped to the user and the provider, with
 *      the SSRF allowlist and host pin re-checked. No secret is read.
 *   2. `sessionAccountFor` — decrypts the stored app password.
 * Neither opens a connection. `resolveTarget` is both stages plus the strict parse
 * of the message id between them, for the actions that address one INBOX UID.
 *
 * The row's stored INBOX UIDVALIDITY (step B2) travels with the credentials: the
 * session compares it with the live value before any action touches a UID.
 */

import { decryptToken } from "../../crypto-tokens.js";
import { prisma } from "../../db.js";
import { captureError } from "../../sentry.js";
import { checkImapRow } from "../imap-connection.js";
import { parseImapMessageId } from "../imap-message-id.js";
import type { ImapProviderConfig } from "../imap-providers.js";
import { canonicalUidValidity } from "../imap-uidvalidity.js";
import { errorMessage, fail } from "./action-failure.js";
import type { SessionAccount } from "./imap-session.js";
import type { MailActionFailure } from "./types.js";

/** The columns `findCheckedAccount` selects from LinkedInboxAccount. */
interface AccountRow {
  id: string;
  email: string | null;
  imapHost: string | null;
  imapPasswordCipher: string | null;
  inboxUidValidity: string | null;
}

/** A row that passed the credential, allowlist and host-pin checks. */
export interface CheckedAccount {
  id: string;
  email: string;
  host: string;
  passwordCipher: string;
  /** The INBOX UIDVALIDITY the poller stored, or null when none is (or it is not a valid value). */
  inboxUidValidity: string | null;
}

export const reconnectHint = (label: string) => `Reconnect your ${label} mailbox in Settings.`;

/**
 * A database failure: log and report once, answer softly — actions never throw.
 *
 * Only the error's name and code are used, never its text: Prisma messages can
 * embed the query arguments, and for an IMAP row those include the gmailId,
 * which contains the mailbox address. The reported error is a fresh one built
 * from a fixed message, so the raw text cannot reach Sentry either.
 */
export function databaseFailure(
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
 * The caller's own account of this provider, or the soft failure to return.
 * Reads no secret and opens no connection.
 */
export async function findCheckedAccount(
  provider: ImapProviderConfig,
  userId: string,
  linkedInboxAccountId: string,
): Promise<CheckedAccount | MailActionFailure> {
  let row: AccountRow | null;
  try {
    // The caller's own account of this provider only — never crosses users.
    row = await prisma.linkedInboxAccount.findFirst({
      where: { id: linkedInboxAccountId, userId, provider: provider.provider },
      select: {
        id: true,
        email: true,
        imapHost: true,
        imapPasswordCipher: true,
        inboxUidValidity: true,
      },
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
  return {
    id: row.id,
    email: checked.email,
    host: checked.host,
    passwordCipher: checked.passwordCipher,
    inboxUidValidity: canonicalUidValidity(row.inboxUidValidity),
  };
}

/**
 * Credentials for a session on a checked account. `credentialKey` (row id plus
 * the stored cipher) is what the auth cooldown is keyed by, so every path that
 * builds its account here shares one cooldown.
 */
export function sessionAccountFor(
  provider: ImapProviderConfig,
  userId: string,
  checked: CheckedAccount,
): SessionAccount | MailActionFailure {
  const password = decryptPassword(checked.passwordCipher, checked.id, provider);
  if (password === null) return fail(reconnectHint(provider.label));
  return {
    userId,
    rowId: checked.id,
    email: checked.email,
    host: checked.host,
    password,
    credentialKey: `${checked.id}:${checked.passwordCipher}`,
    inboxUidValidity: checked.inboxUidValidity,
  };
}

export interface ResolvedTarget {
  session: SessionAccount;
  uid: number;
}

/**
 * The caller's own account, the UID the message id addresses on it, and the
 * decrypted credentials — or the soft failure to return. Nothing here opens a
 * connection, and a malformed id is refused before the password is decrypted.
 */
export async function resolveTarget(
  provider: ImapProviderConfig,
  userId: string,
  linkedInboxAccountId: string,
  messageId: string,
): Promise<ResolvedTarget | MailActionFailure> {
  const checked = await findCheckedAccount(provider, userId, linkedInboxAccountId);
  if ("error" in checked) return checked;
  const uid = parseImapMessageId(messageId, provider.idPrefix, checked.email);
  if (uid === null) return fail(`That message does not belong to this ${provider.label} mailbox.`);

  const session = sessionAccountFor(provider, userId, checked);
  if ("error" in session) return session;
  return { uid, session };
}
