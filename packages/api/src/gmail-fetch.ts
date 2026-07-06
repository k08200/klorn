/**
 * Gmail API fetch + message parsing (M3 decomposition, extracted from
 * email-sync.ts). Turns Gmail API responses into the GmailRawEmail shape the
 * persist layer consumes, including attachment text extraction. No DB writes;
 * must NOT import email-sync.ts (would cycle).
 */

import { type gmail_v1, google } from "googleapis";
import { extractAttachmentContent, isReadableEmailAttachment } from "./email-attachment-text.js";
import { htmlToPlainText } from "./email-text.js";
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

  // Recursive MIME walk: real mail nests text parts arbitrarily deep
  // (multipart/mixed → multipart/alternative → text/*). The old one-level
  // walk missed those, leaving body="" for a lot of legitimate mail.
  const MAX_MIME_DEPTH = 10;
  const walkParts = (parts: gmail_v1.Schema$MessagePart[], depth: number) => {
    if (depth > MAX_MIME_DEPTH) return;
    for (const part of parts) {
      if (part.mimeType === "text/plain" && part.body?.data && !body) {
        body = decodePartBody(part.body.data);
      }
      if (part.mimeType === "text/html" && part.body?.data && !htmlBody) {
        htmlBody = decodePartBody(part.body.data);
      }
      if (part.parts) walkParts(part.parts, depth + 1);
    }
  };

  if (payload?.parts) {
    walkParts(payload.parts, 0);
  } else if (payload?.body?.data) {
    const decoded = decodePartBody(payload.body.data);
    if (payload.mimeType === "text/html") {
      htmlBody = decoded;
    } else {
      body = decoded;
    }
  }

  // HTML-only mail: project the HTML into plain text so `body` is never null
  // for content-bearing mail — a null body used to exclude the email from
  // summarization forever ("Klorn has not analyzed this email yet").
  if (!body && htmlBody) {
    body = htmlToPlainText(htmlBody);
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
 * Fetch + parse full detail for each given Gmail message id, with bounded
 * concurrency. Extracted verbatim from the fetchGmailEmails inner loop so both
 * the snapshot path and the History gap-fill path share identical isolation:
 *   NotFound (deleted between list and get) → skip (null);
 *   AuthError → throw so the caller can flag a reconnect;
 *   anything else → console.warn + captureError, drop just this one (null).
 * Semaphore.all preserves input order, so the surviving array stays in the
 * caller's id order. Nulls are filtered out.
 */
async function fetchMessageDetails(
  gmail: gmail_v1.Gmail,
  ids: string[],
  userId: string,
): Promise<GmailRawEmail[]> {
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
}

/**
 * Fetch emails from Gmail API and return raw data.
 * Handles pagination and full body extraction.
 */
export async function fetchGmailEmails(
  userId: string,
  maxResults = 30,
  query?: string,
  // When set, fetch from THIS OAuth client (a linked secondary inbox) instead of
  // the user's primary Google account. Multi-account sync passes it in.
  authClient?: InstanceType<typeof google.auth.OAuth2> | null,
): Promise<GmailRawEmail[] | null> {
  const auth = authClient ?? (await getAuthedClient(userId));
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

    // Fetch + parse each message with bounded concurrency (order preserved).
    return await fetchMessageDetails(gmail, ids, userId);
  } catch (err) {
    if (isGoogleAuthError(err)) {
      // CRITICAL: only touch the PRIMARY token when this fetch actually used it.
      // For a linked secondary inbox (authClient passed in), a revoked linked
      // token must NOT invalidate the user's healthy primary Google connection
      // — markGoogleTokenForReconnect keys on userId alone. Let the linked-inbox
      // caller handle its own revocation (it surfaces as "Gmail not connected").
      if (!authClient) {
        await markGoogleTokenForReconnect(userId);
      }
      return null;
    }
    throw err;
  }
}

export async function fetchGmailEmailById(
  userId: string,
  gmailId: string,
  // When set, fetch from a specific LINKED inbox's client instead of the primary
  // account. Required for undo-after-untrash/unarchive on a linked inbox: the id
  // only exists in that account, so a primary fetch would 404.
  authClient?: InstanceType<typeof google.auth.OAuth2> | null,
): Promise<GmailRawEmail | null> {
  const auth = authClient ?? (await getAuthedClient(userId));
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
      if (authClient) {
        // Linked-inbox auth error: must NOT invalidate the primary token
        // (markGoogleTokenForReconnect keys on userId alone). Unlike the batch
        // fan-out — whose caller logs the linked "Gmail not connected" — this
        // single-message undo path returns a bare 502 with no operator signal,
        // so leave the trace here (tagged by account) instead of vanishing.
        console.warn(
          `[GMAIL-FETCH] linked-inbox auth error for user ${userId} (gmailId ${gmailId}); primary token left intact`,
        );
        captureError(err, {
          tags: { scope: "gmail.fetch.by-id.linked-auth" },
          extra: { userId, gmailId },
        });
      } else {
        await markGoogleTokenForReconnect(userId);
      }
      return null;
    }
    throw err;
  }
}

export interface GmailHistoryResult {
  emails: GmailRawEmail[];
  // The account's current Gmail historyId AFTER this slice; store it as the next
  // watermark. Null when Gmail returned no historyId (nothing to advance to).
  newHistoryId: string | null;
  // startHistoryId aged out of Gmail's ~7-day history retention: the caller must
  // fall back to a full snapshot and re-baseline the watermark via getProfile.
  expired: boolean;
}

/**
 * Incremental gap-fill via the Gmail History API. Given the last-stored
 * `startHistoryId`, list every message ADDED to INBOX since then (paginating
 * `messagesAdded` across `nextPageToken`) and return full parsed details for
 * each unique id — the messages a top-30 `messages.list` snapshot would drop
 * when >30 arrive between syncs. Returns null on a no-auth/auth failure (flags a
 * primary reconnect only when no linked authClient was passed).
 */
export async function fetchGmailHistory(
  userId: string,
  startHistoryId: string,
  // When set, page from THIS OAuth client (a linked secondary inbox) instead of
  // the user's primary Google account. Mirrors fetchGmailEmails.
  authClient?: InstanceType<typeof google.auth.OAuth2> | null,
): Promise<GmailHistoryResult | null> {
  const auth = authClient ?? (await getAuthedClient(userId));
  if (!auth) return null;

  const gmail = google.gmail({ version: "v1", auth });

  const ids = new Set<string>();
  let newHistoryId: string | null = null;
  try {
    let pageToken: string | undefined;
    do {
      const res = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        labelId: "INBOX",
        pageToken,
      });
      for (const record of res.data.history || []) {
        for (const added of record.messagesAdded || []) {
          const id = added.message?.id;
          if (id) ids.add(id);
        }
      }
      if (res.data.historyId) newHistoryId = res.data.historyId;
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  } catch (err) {
    // startHistoryId aged out of Gmail's ~7-day retention: expected, not an
    // error — signal the caller to snapshot + re-baseline.
    if (isGoogleNotFoundError(err)) {
      return { emails: [], newHistoryId: null, expired: true };
    }
    if (isGoogleAuthError(err)) {
      // Only touch the PRIMARY token when this used it (see fetchGmailEmails).
      if (!authClient) await markGoogleTokenForReconnect(userId);
      return null;
    }
    throw err;
  }

  const emails = await fetchMessageDetails(gmail, [...ids], userId);
  return { emails, newHistoryId, expired: false };
}

/**
 * The account's CURRENT Gmail historyId, read from users.getProfile. Used to
 * baseline the watermark on the first sync and after an expired-history reset,
 * so the next sync can switch to the incremental History path. Returns null on a
 * no-auth/auth failure or when the profile carries no historyId.
 */
export async function fetchCurrentHistoryId(
  userId: string,
  authClient?: InstanceType<typeof google.auth.OAuth2> | null,
): Promise<string | null> {
  const auth = authClient ?? (await getAuthedClient(userId));
  if (!auth) return null;

  const gmail = google.gmail({ version: "v1", auth });
  try {
    const res = await gmail.users.getProfile({ userId: "me" });
    return res.data.historyId ?? null;
  } catch (err) {
    if (isGoogleAuthError(err)) {
      if (!authClient) await markGoogleTokenForReconnect(userId);
      return null;
    }
    throw err;
  }
}
