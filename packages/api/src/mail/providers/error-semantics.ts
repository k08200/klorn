/**
 * What a provider's `{ error }` means to a caller that falls back on it.
 *
 * Gmail and Outlook answer `{ error }` for the NOT-CONNECTED class only (missing
 * linked id, no usable token, a 401 or 403) and throw for everything else. The
 * trash and archive routes rely on that: on `{ error }` they remove the local row,
 * because the account cannot be reached and the row is all Klorn has.
 *
 * The IMAP providers (Naver, iCloud, generic IMAP) answer `{ error }` for EVERY
 * failure: a refused or unconfirmed MOVE, a UID that no longer names the message, a
 * renumbered mailbox, a busy or unreachable server. The message is still in the
 * mailbox, so a caller must not hide or delete its row on that answer (step B2).
 */

import type { InboxProviderName } from "../inbox-credentials.js";

const IMAP_FAMILY: ReadonlySet<InboxProviderName> = new Set(["NAVER", "ICLOUD", "IMAP"]);

export function isImapFamily(provider: InboxProviderName): boolean {
  return IMAP_FAMILY.has(provider);
}
