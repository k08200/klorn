/**
 * Gmail API fetch + message parsing (M3 decomposition, extracted from
 * email-sync.ts). Turns Gmail API responses into the GmailRawEmail shape the
 * persist layer consumes, including attachment text extraction. No DB writes;
 * must NOT import email-sync.ts (would cycle).
 */

import { type gmail_v1, google } from "googleapis";
import { extractAttachmentContent, isReadableEmailAttachment } from "./email-attachment-text.js";
import type { RawEmailAttachment } from "./email-attachments.js";
import {
  getAuthedClient,
  isGoogleAuthError,
  isGoogleNotFoundError,
  markGoogleTokenForReconnect,
} from "./gmail.js";
import { Semaphore } from "./semaphore.js";
import { captureError } from "./sentry.js";

// Gmail has no batch endpoint for messages.get, so each message is a separate
// round-trip. Fetching them serially makes a 30-message sync take 30× the
// per-call latency; bound concurrency instead. 8 keeps well under Gmail's
// per-user quota (250 units/s; messages.get = 5 units → 50/s ceiling).
const GMAIL_FETCH_CONCURRENCY = 8;

export interface GmailRawEmail {
  gmailId: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  snippet: string;
  body: string;
  htmlBody: string;
  labels: string[];
  isRead: boolean;
  isStarred: boolean;
  receivedAt: Date;
  attachments: RawEmailAttachment[];
}

function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// A present-but-RFC-violating Date header yields an Invalid Date, which Prisma
// rejects on create — so the whole email would be dropped from the DB/inbox/
// firewall. Fall back to now() instead, so a malformed header degrades to a
// slightly-off timestamp rather than a silently missing message.
function parseReceivedAt(dateStr: string | null | undefined): Date {
  if (!dateStr) return new Date();
  const parsed = new Date(dateStr);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function collectParts(part: gmail_v1.Schema$MessagePart): gmail_v1.Schema$MessagePart[] {
  const parts = [part];
  for (const child of part.parts ?? []) {
    parts.push(...collectParts(child));
  }
  return parts;
}

async function extractAttachmentsFromPayload(
  gmail: gmail_v1.Gmail,
  messageId: string,
  payload: gmail_v1.Schema$MessagePart,
): Promise<RawEmailAttachment[]> {
  const attachments: RawEmailAttachment[] = [];
  const parts = collectParts(payload).filter((part) => part.filename || part.body?.attachmentId);

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const filename = part.filename?.trim();
    if (!filename) continue;

    const gmailAttachmentId = part.body?.attachmentId || `${messageId}:${index}:${filename}`;
    const mimeType = part.mimeType || "application/octet-stream";
    const size = typeof part.body?.size === "number" ? part.body.size : null;

    let contentText: string | null = null;
    const shouldFetch = isReadableEmailAttachment(filename, mimeType, size);
    if (shouldFetch) {
      try {
        let data = part.body?.data || "";
        if (!data && part.body?.attachmentId) {
          const attachment = await gmail.users.messages.attachments.get({
            userId: "me",
            messageId,
            id: part.body.attachmentId,
          });
          data = attachment.data.data || "";
        }
        if (data) {
          contentText = extractAttachmentContent(decodeBase64Url(data), filename, mimeType).text;
        }
      } catch {
        contentText = null;
      }
    }

    attachments.push({
      gmailAttachmentId,
      filename,
      mimeType,
      size,
      contentText,
    });
  }

  return attachments;
}

async function parseGmailMessageDetail(
  gmail: gmail_v1.Gmail,
  messageId: string,
  detail: gmail_v1.Schema$Message,
): Promise<GmailRawEmail> {
  const headers = detail.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

  let body = "";
  let htmlBody = "";
  const payload = detail.payload;
  const decodePartBody = (data: string): string => decodeBase64Url(data).toString("utf-8");
  const attachments: RawEmailAttachment[] = [];

  if (payload?.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        body = decodePartBody(part.body.data);
      }
      if (part.mimeType === "text/html" && part.body?.data) {
        htmlBody = decodePartBody(part.body.data);
      }
      if (part.parts) {
        for (const sub of part.parts) {
          if (sub.mimeType === "text/plain" && sub.body?.data && !body) {
            body = decodePartBody(sub.body.data);
          }
          if (sub.mimeType === "text/html" && sub.body?.data && !htmlBody) {
            htmlBody = decodePartBody(sub.body.data);
          }
        }
      }
    }
  } else if (payload?.body?.data) {
    const decoded = decodePartBody(payload.body.data);
    if (payload.mimeType === "text/html") {
      htmlBody = decoded;
    } else {
      body = decoded;
    }
  }

  if (payload) {
    attachments.push(...(await extractAttachmentsFromPayload(gmail, messageId, payload)));
  }

  const labelIds = detail.labelIds || [];
  const dateStr = getHeader("Date");

  return {
    gmailId: messageId,
    threadId: detail.threadId || messageId,
    from: getHeader("From"),
    to: getHeader("To"),
    cc: getHeader("Cc"),
    subject: getHeader("Subject"),
    snippet: detail.snippet || "",
    body,
    htmlBody,
    labels: labelIds,
    isRead: !labelIds.includes("UNREAD"),
    isStarred: labelIds.includes("STARRED"),
    receivedAt: parseReceivedAt(dateStr),
    attachments,
  };
}

/**
 * Fetch emails from Gmail API and return raw data.
 * Handles pagination and full body extraction.
 */
export async function fetchGmailEmails(
  userId: string,
  maxResults = 30,
  query?: string,
): Promise<GmailRawEmail[] | null> {
  const auth = await getAuthedClient(userId);
  if (!auth) return null;

  const gmail = google.gmail({ version: "v1", auth });

  const listParams: {
    userId: string;
    maxResults: number;
    labelIds?: string[];
    q?: string;
  } = {
    userId: "me",
    maxResults,
  };

  if (query) {
    listParams.q = query;
  } else {
    listParams.labelIds = ["INBOX"];
  }

  try {
    const res = await gmail.users.messages.list(listParams);
    const ids = (res.data.messages || [])
      .map((msg) => msg.id)
      .filter((id): id is string => Boolean(id));

    // Fetch + parse each message with bounded concurrency. Semaphore.all
    // preserves input order, so the surviving array stays in list (newest-first)
    // order exactly as the old serial loop produced it.
    const sem = new Semaphore(GMAIL_FETCH_CONCURRENCY);
    const fetched = await sem.all<GmailRawEmail | null>(
      ids.map((id) => async () => {
        try {
          const detail = await gmail.users.messages.get({
            userId: "me",
            id,
            format: "full",
          });
          return await parseGmailMessageDetail(gmail, id, detail.data);
        } catch (err) {
          // Deleted between list and get — expected race, skip silently.
          if (isGoogleNotFoundError(err)) return null;
          // Auth failure must abort the whole batch so the caller can flag a
          // reconnect (handled by the outer catch below).
          if (isGoogleAuthError(err)) throw err;
          // Anything else (transient 429/5xx, a single unparseable message):
          // drop just this one rather than sinking the whole batch — it stays
          // in the inbox and is retried next sync. Never silent.
          console.warn(`[GMAIL-FETCH] Skipped message ${id} for user ${userId}:`, err);
          captureError(err, {
            tags: { scope: "gmail.fetch.message" },
            extra: { userId, gmailId: id },
          });
          return null;
        }
      }),
    );
    return fetched.filter((e): e is GmailRawEmail => e !== null);
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return null;
    }
    throw err;
  }
}

export async function fetchGmailEmailById(
  userId: string,
  gmailId: string,
): Promise<GmailRawEmail | null> {
  const auth = await getAuthedClient(userId);
  if (!auth) return null;

  const gmail = google.gmail({ version: "v1", auth });

  try {
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: gmailId,
      format: "full",
    });
    return parseGmailMessageDetail(gmail, gmailId, detail.data);
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return null;
    }
    throw err;
  }
}
