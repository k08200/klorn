/**
 * The synthetic provider message id of an IMAP row: `<idPrefix>:<email>:<uid>`.
 *
 * imap-sync.ts writes it into `EmailMessage.gmailId` (the persisted dedup key —
 * see the idPrefix note in imap-providers.ts), and IMAP actions read it back to
 * address the server by UID. Writer and parser live together so they cannot
 * drift, and the parser is deliberately strict: it is the boundary between a
 * stored string and a command sent to a mail server.
 */

import { IMAP_PROVIDERS } from "./imap-providers.js";

/** RFC 3501: a UID is a non-zero 32-bit unsigned integer. */
export const MAX_IMAP_UID = 4_294_967_295;

// Canonical decimal only: no sign, no leading zero, no whitespace, no range or
// list syntax. Ten digits is the width of MAX_IMAP_UID.
const CANONICAL_UID = /^[1-9][0-9]{0,9}$/;

export function formatImapMessageId(idPrefix: string, email: string, uid: number): string {
  return `${imapMessageIdHead(idPrefix, email)}${uid}`;
}

/** `<idPrefix>:<email>:`, the part every id of one mailbox shares. */
export function imapMessageIdHead(idPrefix: string, email: string): string {
  return `${idPrefix}:${email}:`;
}

const IMAP_ID_PREFIXES = Object.values(IMAP_PROVIDERS).map((p) => `${p.idPrefix}:`);

/**
 * True when a stored message id was minted by an IMAP provider (any mailbox, a
 * tombstone included). Such an id names a message only under one UIDVALIDITY, so
 * after a repair (step B2b) the same id can name a new message; Gmail ids never do.
 */
export function isImapMessageId(id: string): boolean {
  return IMAP_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * The UID a stored message id addresses on THIS mailbox, or null when the id is
 * not exactly `<idPrefix>:<email>:<canonical uid>`. The email is supplied by
 * the caller from the account row (never taken from the id), so an id minted for
 * another mailbox, another provider or another format never parses.
 */
export function parseImapMessageId(
  messageId: unknown,
  idPrefix: string,
  email: string,
): number | null {
  if (typeof messageId !== "string") return null;
  const head = imapMessageIdHead(idPrefix, email);
  if (!messageId.startsWith(head)) return null;
  const digits = messageId.slice(head.length);
  if (!CANONICAL_UID.test(digits)) return null;
  const uid = Number(digits);
  return uid <= MAX_IMAP_UID ? uid : null;
}
