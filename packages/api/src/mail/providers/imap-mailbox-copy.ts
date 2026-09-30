/**
 * Storing a message in a mailbox folder over IMAP — the Sent copy of a message
 * sent through SMTP, and a draft (step B3 of
 * docs/providers/unified-platform-plan.md).
 *
 * Folders are found by role, never by name: a mailbox's Sent folder is "Sent
 * Messages" on iCloud and something else (or localized) elsewhere. imapflow's
 * `list()` reports the role from the server's SPECIAL-USE flags (RFC 6154) and,
 * when the server sends none, from well-known folder names. A role guessed only
 * from a decorated name ("Sent Items" beside the real "Sent Messages") is not
 * trusted, and a folder the server marks unselectable is never a target.
 *
 * Does Naver or iCloud SMTP file a copy in Sent by itself? Neither provider's
 * documentation says (Apple's "iCloud Mail server settings" page and Naver's
 * "IMAP/SMTP 설정 및 해제 방법" page are both silent), and mail clients that
 * submit over SMTP to iCloud store their own copy with an IMAP APPEND. Rather
 * than assume, the sender asks the server: it searches Sent for the message's
 * own Message-ID and APPENDs only when it is not there, so a server that does
 * save a copy gets no duplicate and one that does not gets exactly one.
 */

import type { ImapFlow } from "imapflow";

export type SpecialUseFolder = "\\Sent" | "\\Drafts";

/** A copy in Sent is a message the user already has: stored as read. */
export const SENT_COPY_FLAGS: readonly string[] = ["\\Seen"];
/** RFC 3501 `\Draft`; `\Seen` keeps a draft out of the unread count. */
export const DRAFT_FLAGS: readonly string[] = ["\\Draft", "\\Seen"];

const UNSELECTABLE_FLAGS = ["\\Noselect", "\\NonExistent"] as const;
/**
 * How imapflow learned a folder's role that we accept: the server said so
 * (`extension`), the name is exactly a well-known one (`name`), or a configured
 * hint (`user`). Its looser `name-guess` tier (a known name wrapped in generic
 * words) is not: storing mail in the wrong folder is worse than not storing it.
 */
const TRUSTED_ROLE_SOURCES: readonly string[] = ["extension", "name", "user"];

function isTrustedRole(source: string | undefined): boolean {
  return source === undefined || TRUSTED_ROLE_SOURCES.includes(source);
}

/** The path of the folder with this role, or null when the mailbox has none. */
export async function findSpecialUseFolder(
  client: ImapFlow,
  role: SpecialUseFolder,
): Promise<string | null> {
  const folders = await client.list();
  const match = folders.find(
    (folder) =>
      folder.specialUse === role &&
      isTrustedRole(folder.specialUseSource) &&
      !UNSELECTABLE_FLAGS.some((flag) => folder.flags?.has(flag)),
  );
  return match?.path ?? null;
}

/** Is a message with this Message-ID already in the folder? */
export async function messageAlreadyStored(
  client: ImapFlow,
  path: string,
  messageId: string,
): Promise<boolean> {
  const lock = await client.getMailboxLock(path);
  try {
    const hits = await client.search({ header: { "message-id": messageId } }, { uid: true });
    return Array.isArray(hits) && hits.length > 0;
  } finally {
    lock.release();
  }
}

/** APPEND `mime` to the folder. False when the server did not confirm storing it. */
export async function appendMessage(
  client: ImapFlow,
  path: string,
  mime: Buffer,
  flags: readonly string[],
  date: Date,
): Promise<boolean> {
  const stored = await client.append(path, mime, [...flags], date);
  return stored !== false && stored !== undefined;
}
