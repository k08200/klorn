/**
 * The bytes of one stored attachment row, fetched again from the mailbox it came
 * from. No producer stores attachment bytes (Gmail never did); the download,
 * inline-image, convert and OCR routes all come through here.
 *
 *   - Gmail (primary or a linked Google inbox): attachments.get with the row's
 *     handle, exactly as the routes did before.
 *   - IMAP (iCloud, Naver, the app-password presets, generic): BODY[<partKey>] of the
 *     message's UID over the action session layer (one queue per account, global
 *     session cap, auth cooldown, time limits), while INBOX still has the
 *     UIDVALIDITY the UID was stored under. When INBOX cannot serve it (renumbered,
 *     or the message was moved out in another client) and the row has the message's
 *     stored Message-ID, the message is looked up by that exact Message-ID in the
 *     account's trusted \Archive, \All, \Sent, \Trash and \Junk folders
 *     (imap-message-locate.ts), one mailbox lock at a time, and served from there.
 *   - Outlook: Graph `$value` of the row's attachment id.
 *
 * openAttachmentSource resolves the message's mailbox once (a route reading
 * several parts of one message answers "not connected" before touching any row);
 * fetchStoredAttachmentBytes is that plus one part.
 *
 * Ownership is the caller's: it found the row by (id, userId). Every lookup here
 * is scoped by userId as well, and the message id must belong to the row's own
 * mailbox, so a row can never fetch from another user's or another mailbox's
 * server. IMAP and Outlook bytes are capped at MAX_ATTACHMENT_DOWNLOAD_BYTES.
 */

import type { ImapFlow } from "imapflow";
import { prisma } from "../db.js";
import { resolveMailClient } from "./gmail.js";
import { envelopeMessageId } from "./imap-envelope.js";
import { parseImapMessageId } from "./imap-message-id.js";
import { locateByMessageId } from "./imap-message-locate.js";
import { IMAP_PROVIDERS, type ImapProviderKey } from "./imap-providers.js";
import { compareUidValidity } from "./imap-uidvalidity.js";
import { fetchOutlookAttachmentBytes } from "./outlook-attachments.js";
import { resolveOutlookBearer } from "./outlook-token.js";
import { findCheckedAccount, sessionAccountFor } from "./providers/imap-account.js";
import { createMailboxSwitch } from "./providers/imap-mailbox-switch.js";
import { runAccountTask, withImapClient } from "./providers/imap-session.js";

/** Above iCloud's 20 MB message limit with transfer-encoding slack. */
export const MAX_ATTACHMENT_DOWNLOAD_BYTES = 32 * 1024 * 1024;

/** An IMAP section number ("2", "1.3"): what imap-attachments.ts writes as partKey. */
const IMAP_SECTION = /^[1-9][0-9]{0,3}(\.[1-9][0-9]{0,3}){0,9}$/;

const INBOX = "INBOX";

/** The message a part belongs to, as its row stores it. */
export interface StoredMessageRef {
  gmailId: string;
  linkedInboxAccountId: string | null;
  /** IMAP rows only (imap-sync.ts); absent or null = INBOX lookup only. */
  messageIdHeader?: string | null;
}

/** One part of that message. */
export interface StoredPartRef {
  gmailAttachmentId: string;
  partKey: string | null;
}

export interface StoredAttachmentRef extends StoredPartRef {
  email: StoredMessageRef;
}

type Failure<S> = { ok: false; status: S; error: string };

export type AttachmentBytes = { ok: true; bytes: Buffer } | Failure<404 | 409 | 413 | 502>;

/** One part from an opened source: "not connected" was already decided by opening it. */
export type PartBytes = { ok: true; bytes: Buffer } | Failure<404 | 413 | 502>;

export type AttachmentSource =
  | { ok: true; fetch: (part: StoredPartRef) => Promise<PartBytes> }
  | Failure<409>;

const NOT_FOUND: Failure<404> = { ok: false, status: 404, error: "Attachment body not found" };
const TOO_LARGE: Failure<413> = {
  ok: false,
  status: 413,
  error: "Attachment is too large to download here",
};
/** Every IMAP provider: Naver, iCloud, generic and the app-password presets. */
const IMAP_KEYS: ReadonlySet<string> = new Set<string>(Object.keys(IMAP_PROVIDERS));

export async function fetchStoredAttachmentBytes(
  userId: string,
  row: StoredAttachmentRef,
): Promise<AttachmentBytes> {
  const source = await openAttachmentSource(userId, row.email);
  return source.ok ? source.fetch(row) : source;
}

/** The message's own mailbox, resolved once for any number of its parts. */
export async function openAttachmentSource(
  userId: string,
  email: StoredMessageRef,
): Promise<AttachmentSource> {
  const linkedId = email.linkedInboxAccountId;
  const provider = linkedId
    ? (
        await prisma.linkedInboxAccount.findFirst({
          where: { id: linkedId, userId },
          select: { provider: true },
        })
      )?.provider
    : "GOOGLE";
  if (provider === "OUTLOOK" && linkedId) return openOutlook(userId, linkedId, email);
  if (provider && IMAP_KEYS.has(provider) && linkedId) {
    return openImap(userId, linkedId, provider as ImapProviderKey, email);
  }
  // GOOGLE, and a stale linked id (resolveMailClient then answers null, as before).
  return openGmail(userId, email);
}

async function openGmail(userId: string, email: StoredMessageRef): Promise<AttachmentSource> {
  const auth = await resolveMailClient(userId, email.linkedInboxAccountId);
  if (!auth) return { ok: false, status: 409, error: "Gmail not connected" };
  const { google } = await import("googleapis");
  const gmail = google.gmail({ version: "v1", auth });
  return {
    ok: true,
    fetch: async (part) => {
      const res = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: email.gmailId,
        id: part.gmailAttachmentId,
      });
      const data = res.data.data;
      return data ? { ok: true, bytes: Buffer.from(data, "base64url") } : NOT_FOUND;
    },
  };
}

async function openOutlook(
  userId: string,
  linkedId: string,
  email: StoredMessageRef,
): Promise<AttachmentSource> {
  const bearer = await resolveOutlookBearer(userId, linkedId);
  if (!bearer) return { ok: false, status: 409, error: "Outlook not connected" };
  const prefix = `outlook:${bearer.email}:`;
  return {
    ok: true,
    fetch: async (part) => {
      if (!email.gmailId.startsWith(prefix)) return NOT_FOUND;
      const result = await fetchOutlookAttachmentBytes(
        bearer.accessToken,
        email.gmailId.slice(prefix.length),
        part.gmailAttachmentId,
        MAX_ATTACHMENT_DOWNLOAD_BYTES,
      );
      if ("bytes" in result) return { ok: true, bytes: result.bytes };
      if ("tooLarge" in result) return TOO_LARGE;
      return result.status === 404
        ? NOT_FOUND
        : { ok: false, status: 502, error: "Outlook failed" };
    },
  };
}

async function openImap(
  userId: string,
  linkedId: string,
  key: ImapProviderKey,
  email: StoredMessageRef,
): Promise<AttachmentSource> {
  const provider = IMAP_PROVIDERS[key];
  const checked = await findCheckedAccount(provider, userId, linkedId);
  if ("error" in checked) return { ok: false, status: 409, error: checked.error };
  const session = sessionAccountFor(provider, userId, checked);
  if ("error" in session) return { ok: false, status: 409, error: session.error };
  // The message id must name a UID on THIS account, or nothing is fetched.
  const uid = parseImapMessageId(email.gmailId, provider.idPrefix, checked.email);
  // Re-derived as the poller stored it, so the exact compare holds whatever the column has.
  const messageIdHeader = envelopeMessageId(email.messageIdHeader);
  return {
    ok: true,
    fetch: async (part) => {
      if (uid === null || !part.partKey || !IMAP_SECTION.test(part.partKey)) return NOT_FOUND;
      const target: ImapPartTarget = {
        uid,
        section: part.partKey,
        storedUidValidity: checked.inboxUidValidity,
        messageIdHeader,
      };
      const result = await runAccountTask(provider, session, ({ signal }) =>
        withImapClient(provider, session, (client) => downloadPart(client, target), signal),
      );
      // The session layer's own soft failure (busy, cooldown, timeout, transport) has no `ok`.
      return "ok" in result ? result : { ok: false, status: 502, error: result.error };
    },
  };
}

interface ImapPartTarget {
  uid: number;
  section: string;
  storedUidValidity: string | null;
  messageIdHeader: string | null;
}

/**
 * BODY[<section>] of the INBOX message `uid` while INBOX keeps its UIDVALIDITY, else
 * of the one message elsewhere with the stored Message-ID. One lock at a time,
 * released on every path.
 */
async function downloadPart(client: ImapFlow, target: ImapPartTarget): Promise<PartBytes> {
  const mailboxes = createMailboxSwitch(client);
  try {
    const live = await mailboxes.open(INBOX);
    // A renumbered INBOX reuses UIDs: never serve another message's part.
    if (compareUidValidity(target.storedUidValidity, live) === "match") {
      const inInbox = await downloadSelected(client, target.uid, target.section);
      if (inInbox) return inInbox;
    }
    if (!target.messageIdHeader) return NOT_FOUND;
    const moved = await locateByMessageId(client, mailboxes, target.messageIdHeader);
    if (moved === null) return NOT_FOUND;
    return (await downloadSelected(client, moved, target.section)) ?? NOT_FOUND;
  } finally {
    mailboxes.release();
  }
}

/** The part of `uid` in the selected mailbox, transfer-decoded by imapflow; null when absent. */
async function downloadSelected(
  client: ImapFlow,
  uid: number,
  section: string,
): Promise<PartBytes | null> {
  const { content } = await client.download(String(uid), section, {
    uid: true,
    maxBytes: MAX_ATTACHMENT_DOWNLOAD_BYTES + 1,
  });
  if (!content) return null;
  const bytes = await readStreamCapped(content, MAX_ATTACHMENT_DOWNLOAD_BYTES);
  return bytes ? { ok: true, bytes } : TOO_LARGE;
}

/** The stream's bytes, or null past `maxBytes` (leaving the loop destroys the stream). */
async function readStreamCapped(
  stream: AsyncIterable<Buffer | Uint8Array | string>,
  maxBytes: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
