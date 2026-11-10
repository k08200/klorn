/**
 * Inline (cid:) images for LIVE folder messages (2026-09-08).
 *
 * The DB-backed reading pane resolves src="cid:…" through the attachment
 * rows the sync captured (GET /api/email/:id/inline/:cid). Folder rows —
 * Sent / Drafts / Archived — are never synced, so their logos and banners
 * degraded to alt text. This walks the live MIME tree for the matching
 * Content-ID instead; image/* only, for the same reason as the DB route:
 * reflecting a sender-declared type under our origin is an XSS foothold.
 */

import { type gmail_v1, google } from "googleapis";
import { extractContentId } from "./gmail-fetch.js";

type OAuth2 = InstanceType<typeof google.auth.OAuth2>;

/** Where the bytes live: a small part carries them inline (`data`), a
 *  large one points at an attachment id to fetch. */
export interface InlinePart {
  mimeType: string;
  attachmentId: string | null;
  data: string | null;
}

/**
 * The image/* part whose Content-ID matches `cid`, searched depth-first
 * through nested multiparts (multipart/related inside multipart/alternative
 * is the common shape). Pure — exported for its tests.
 */
export function findInlinePart(
  part: gmail_v1.Schema$MessagePart | undefined,
  cid: string,
): InlinePart | null {
  if (!part) return null;
  const mimeType = part.mimeType ?? "";
  if (extractContentId(part) === cid && mimeType.startsWith("image/")) {
    const attachmentId = part.body?.attachmentId ?? null;
    const data = part.body?.data ?? null;
    if (attachmentId || data) return { mimeType, attachmentId, data };
  }
  for (const child of part.parts ?? []) {
    const hit = findInlinePart(child, cid);
    if (hit) return hit;
  }
  return null;
}

export interface InlineImage {
  bytes: Buffer;
  mimeType: string;
}

/**
 * Bytes + declared MIME type for one inline image of a live message. Null
 * when the message has no such image/* part (a plain 404 for the client,
 * which renders a transparent placeholder). Throws on Gmail transport
 * errors — the route maps those to 404 with an operator log line.
 */
export async function fetchInlineImage(
  auth: OAuth2,
  messageId: string,
  cid: string,
): Promise<InlineImage | null> {
  const gmail = google.gmail({ version: "v1", auth });
  const message = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const part = findInlinePart(message.data.payload, cid);
  if (!part) return null;
  const data = part.data ?? (await fetchAttachmentData(gmail, messageId, part.attachmentId));
  if (!data) return null;
  return { bytes: Buffer.from(data, "base64url"), mimeType: part.mimeType };
}

async function fetchAttachmentData(
  gmail: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string | null,
): Promise<string | null> {
  if (!attachmentId) return null;
  const res = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });
  return res.data.data ?? null;
}
