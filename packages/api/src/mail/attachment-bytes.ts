/**
 * The bytes of one stored attachment row, fetched again from the mailbox it came
 * from. No producer stores attachment bytes (Gmail never did); the download,
 * inline-image and convert routes all come through here.
 *
 *   - Gmail (primary or a linked Google inbox): attachments.get with the row's
 *     handle, exactly as the routes did before.
 *   - IMAP (iCloud, Naver, generic): BODY[<partKey>] of the message's UID over the
 *     action session layer (one queue per account, global session cap, auth
 *     cooldown, time limits), only while INBOX still has the UIDVALIDITY the UID
 *     was stored under.
 *   - Outlook: Graph `$value` of the row's attachment id.
 *
 * Ownership is the caller's: it found the row by (id, userId). Every lookup here
 * is scoped by userId as well, and the message id must belong to the row's own
 * mailbox, so a row can never fetch from another user's or another mailbox's
 * server. IMAP and Outlook bytes are capped at MAX_ATTACHMENT_DOWNLOAD_BYTES.
 */

import type { ImapFlow } from "imapflow";
import { prisma } from "../db.js";
import { resolveMailClient } from "./gmail.js";
import { parseImapMessageId } from "./imap-message-id.js";
import { IMAP_PROVIDERS, type ImapProviderKey } from "./imap-providers.js";
import { compareUidValidity, liveUidValidity } from "./imap-uidvalidity.js";
import { fetchOutlookAttachmentBytes } from "./outlook-attachments.js";
import { resolveOutlookBearer } from "./outlook-token.js";
import { findCheckedAccount, sessionAccountFor } from "./providers/imap-account.js";
import { runAccountTask, withImapClient } from "./providers/imap-session.js";

/** Above iCloud's 20 MB message limit with transfer-encoding slack. */
export const MAX_ATTACHMENT_DOWNLOAD_BYTES = 32 * 1024 * 1024;

/** An IMAP section number ("2", "1.3"): what imap-attachments.ts writes as partKey. */
const IMAP_SECTION = /^[1-9][0-9]{0,3}(\.[1-9][0-9]{0,3}){0,9}$/;

export interface StoredAttachmentRef {
  gmailAttachmentId: string;
  partKey: string | null;
  email: { gmailId: string; linkedInboxAccountId: string | null };
}

export type AttachmentBytes =
  | { ok: true; bytes: Buffer }
  | { ok: false; status: 404 | 409 | 413 | 502; error: string };

const NOT_FOUND: AttachmentBytes = { ok: false, status: 404, error: "Attachment body not found" };
const TOO_LARGE: AttachmentBytes = {
  ok: false,
  status: 413,
  error: "Attachment is too large to download here",
};
const IMAP_KEYS: ReadonlySet<string> = new Set<ImapProviderKey>(["NAVER", "ICLOUD", "IMAP"]);

export async function fetchStoredAttachmentBytes(
  userId: string,
  row: StoredAttachmentRef,
): Promise<AttachmentBytes> {
  const linkedId = row.email.linkedInboxAccountId;
  const provider = linkedId
    ? (
        await prisma.linkedInboxAccount.findFirst({
          where: { id: linkedId, userId },
          select: { provider: true },
        })
      )?.provider
    : "GOOGLE";
  if (provider === "OUTLOOK" && linkedId) return outlookBytes(userId, linkedId, row);
  if (provider && IMAP_KEYS.has(provider) && linkedId) {
    return imapBytes(userId, linkedId, provider as ImapProviderKey, row);
  }
  // GOOGLE, and a stale linked id (resolveMailClient then answers null, as before).
  return gmailBytes(userId, row);
}

async function gmailBytes(userId: string, row: StoredAttachmentRef): Promise<AttachmentBytes> {
  const auth = await resolveMailClient(userId, row.email.linkedInboxAccountId);
  if (!auth) return { ok: false, status: 409, error: "Gmail not connected" };
  const { google } = await import("googleapis");
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId: row.email.gmailId,
    id: row.gmailAttachmentId,
  });
  const data = res.data.data;
  return data ? { ok: true, bytes: Buffer.from(data, "base64url") } : NOT_FOUND;
}

async function outlookBytes(
  userId: string,
  linkedId: string,
  row: StoredAttachmentRef,
): Promise<AttachmentBytes> {
  const bearer = await resolveOutlookBearer(userId, linkedId);
  if (!bearer) return { ok: false, status: 409, error: "Outlook not connected" };
  const prefix = `outlook:${bearer.email}:`;
  if (!row.email.gmailId.startsWith(prefix)) return NOT_FOUND;
  const result = await fetchOutlookAttachmentBytes(
    bearer.accessToken,
    row.email.gmailId.slice(prefix.length),
    row.gmailAttachmentId,
    MAX_ATTACHMENT_DOWNLOAD_BYTES,
  );
  if ("bytes" in result) return { ok: true, bytes: result.bytes };
  if ("tooLarge" in result) return TOO_LARGE;
  return result.status === 404 ? NOT_FOUND : { ok: false, status: 502, error: "Outlook failed" };
}

async function imapBytes(
  userId: string,
  linkedId: string,
  key: ImapProviderKey,
  row: StoredAttachmentRef,
): Promise<AttachmentBytes> {
  const provider = IMAP_PROVIDERS[key];
  const checked = await findCheckedAccount(provider, userId, linkedId);
  if ("error" in checked) return { ok: false, status: 409, error: checked.error };
  const uid = parseImapMessageId(row.email.gmailId, provider.idPrefix, checked.email);
  if (uid === null || !row.partKey || !IMAP_SECTION.test(row.partKey)) return NOT_FOUND;
  const session = sessionAccountFor(provider, userId, checked);
  if ("error" in session) return { ok: false, status: 409, error: session.error };
  const section = row.partKey;
  const result = await runAccountTask(provider, session, ({ signal }) =>
    withImapClient(
      provider,
      session,
      (client) => downloadSection(client, uid, section, checked.inboxUidValidity),
      signal,
    ),
  );
  // The session layer's own soft failure (busy, cooldown, timeout, transport) has no `ok`.
  return "ok" in result ? result : { ok: false, status: 502, error: result.error };
}

/** BODY[<section>] of the INBOX message `uid`, transfer-decoded by imapflow. */
async function downloadSection(
  client: ImapFlow,
  uid: number,
  section: string,
  storedUidValidity: string | null,
): Promise<AttachmentBytes> {
  const lock = await client.getMailboxLock("INBOX");
  try {
    // A renumbered INBOX reuses UIDs: never serve another message's part.
    const live = liveUidValidity(client.mailbox);
    if (compareUidValidity(storedUidValidity, live) !== "match") return NOT_FOUND;
    const { content } = await client.download(String(uid), section, {
      uid: true,
      maxBytes: MAX_ATTACHMENT_DOWNLOAD_BYTES + 1,
    });
    if (!content) return NOT_FOUND;
    const bytes = await readStreamCapped(content, MAX_ATTACHMENT_DOWNLOAD_BYTES);
    return bytes ? { ok: true, bytes } : TOO_LARGE;
  } finally {
    lock.release();
  }
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
