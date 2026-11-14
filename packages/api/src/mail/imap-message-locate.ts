/**
 * Where a stored IMAP message went after it left INBOX, found by its RFC 5322
 * Message-ID (EmailMessage.messageIdHeader). Used by attachment-bytes.ts when the
 * stored INBOX UID no longer serves the message: the user archived or moved it in
 * another client, so the local row is still there. (Klorn's own archive/trash
 * deletes the row, so those never get here.)
 *
 * Where it looks, in this order and nowhere else: the account's one trusted folder
 * for \Archive, \All, \Sent, \Trash, then \Junk (imap-folders.ts: a SPECIAL-USE
 * flag the server reported, never INBOX, never \Noselect, never a name guess).
 *
 * What it accepts: IMAP `SEARCH HEADER Message-ID` is a case-insensitive SUBSTRING
 * match, so every candidate's envelope is fetched and kept only when its Message-ID
 * equals the stored one exactly (case-sensitive, after the trimming the poller
 * applied: envelopeMessageId). The first folder with exactly one such message
 * answers. A folder with two (one Message-ID naming two different messages), or
 * with more candidates than MAX_LOOKUP_CANDIDATES, ends the lookup with nothing: a
 * Message-ID is chosen by the sender, so an ambiguous one is never resolved by
 * looking further. At most five folders and five envelopes per folder, so a hostile
 * header cannot make it scan a mailbox.
 *
 * A folder that cannot be opened or searched is skipped; a lost connection ends the
 * lookup (the session layer reports it).
 *
 * One mailbox at a time: every folder is opened through the caller's MailboxSwitch
 * (imapflow's getMailboxLock waits forever for a second lock), and the folder that
 * answered is left selected for the caller's download. The caller releases it.
 */

import type { ImapFlow } from "imapflow";
import { envelopeMessageId } from "./imap-envelope.js";
import { findTrustedFolder, type LookupRole } from "./providers/imap-folders.js";
import type { MailboxSwitch } from "./providers/imap-mailbox-switch.js";

/** The folders a moved message is looked for in, in order. */
export const MESSAGE_LOOKUP_ROLES: readonly LookupRole[] = [
  "\\Archive",
  "\\All",
  "\\Sent",
  "\\Trash",
  "\\Junk",
];

/** More SEARCH hits than this in one folder and the folder is not resolved. */
export const MAX_LOOKUP_CANDIDATES = 5;

type FolderVerdict = { kind: "none" } | { kind: "one"; uid: number } | { kind: "ambiguous" };

const NONE: FolderVerdict = { kind: "none" };
const AMBIGUOUS: FolderVerdict = { kind: "ambiguous" };

/**
 * The UID of the one message whose Message-ID is exactly `messageId`, with its
 * folder selected on `mailboxes`; null when no folder resolves it. Rejects as
 * imapflow does; the caller's MailboxSwitch release still applies.
 */
export async function locateByMessageId(
  client: ImapFlow,
  mailboxes: MailboxSwitch,
  messageId: string,
): Promise<number | null> {
  const folders = await client.list();
  const paths = MESSAGE_LOOKUP_ROLES.map((role) => findTrustedFolder(folders, role));
  // One folder may carry two roles; it is searched once.
  for (const path of new Set(paths)) {
    if (path === null) continue;
    const verdict = await verdictForFolder(client, mailboxes, path, messageId);
    if (verdict.kind === "one") return verdict.uid;
    if (verdict.kind === "ambiguous") return null;
  }
  return null;
}

/**
 * One folder's answer. A folder the server will not open or search (a refused
 * SELECT, a failed SEARCH) is skipped so the next role folder can still answer;
 * a lost connection is not a folder's problem and is rethrown.
 */
async function verdictForFolder(
  client: ImapFlow,
  mailboxes: MailboxSwitch,
  path: string,
  messageId: string,
): Promise<FolderVerdict> {
  try {
    await mailboxes.open(path);
    return await exactMatchInSelected(client, messageId);
  } catch (err) {
    if (client.usable === false) throw err;
    return NONE;
  }
}

/** SEARCH the selected folder, then keep only candidates whose envelope matches exactly. */
async function exactMatchInSelected(client: ImapFlow, messageId: string): Promise<FolderVerdict> {
  const hits = await client.search({ header: { "message-id": messageId } }, { uid: true });
  if (!Array.isArray(hits) || hits.length === 0) return NONE;
  if (hits.length > MAX_LOOKUP_CANDIDATES) return AMBIGUOUS;
  const candidates = new Set(hits);
  const messages = await client.fetchAll(hits, { uid: true, envelope: true }, { uid: true });
  const exact = new Set(
    messages
      .filter((msg) => candidates.has(msg.uid))
      .filter((msg) => envelopeMessageId(msg.envelope?.messageId) === messageId)
      .map((msg) => msg.uid),
  );
  if (exact.size === 0) return NONE;
  const [uid] = exact;
  return exact.size === 1 && uid !== undefined ? { kind: "one", uid } : AMBIGUOUS;
}
