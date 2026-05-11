import { google } from "googleapis";
import { decryptOptional, decryptToken, encryptOptional, encryptToken } from "./crypto-tokens.js";
import { prisma } from "./db.js";
import { wrapUntrusted } from "./untrusted.js";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:8000/api/auth/google/callback";

export interface GmailDraftAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export function getOAuth2Client(): InstanceType<typeof google.auth.OAuth2> {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

export function getAuthUrl(userId?: string) {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state: userId || undefined,
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
    ],
  });
}

/** Google login OAuth URL — requests profile + email + Gmail + Calendar for one-click setup */
export function getLoginAuthUrl(signedState: string) {
  const oauth2 = getOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state: signedState,
    scope: [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
    ],
  });
}

/** Get Google user profile from access token */
export async function getGoogleUserInfo(
  accessToken: string,
): Promise<{ email: string; name: string; picture: string }> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error("Failed to fetch Google user info");
  return res.json() as Promise<{ email: string; name: string; picture: string }>;
}

export async function getAuthedClient(
  userId: string,
): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  const token = await prisma.userToken.findFirst({
    where: { userId, provider: "google" },
  });

  if (!token) return null;

  const accessTokenPlain = token.accessToken ? decryptToken(token.accessToken) : "";
  const refreshTokenPlain = decryptOptional(token.refreshToken);

  // Must have a refresh_token to maintain long-lived connection
  if (!refreshTokenPlain) {
    const isExpired = token.expiresAt && token.expiresAt.getTime() < Date.now();
    if (isExpired || !accessTokenPlain) {
      console.warn(
        `[GOOGLE] No refresh_token and token expired for user ${userId} — needs reconnect`,
      );
      return null;
    }
    console.warn(
      `[GOOGLE] No refresh_token for user ${userId} — token will expire and sync will fail`,
    );
  }

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({
    access_token: accessTokenPlain,
    refresh_token: refreshTokenPlain,
    expiry_date: token.expiresAt ? token.expiresAt.getTime() : undefined,
  });

  // Auto-refresh expired tokens — persist BOTH access and refresh tokens (encrypted at rest)
  oauth2.on("tokens", async (newTokens) => {
    const data: { accessToken: string; expiresAt: Date | null; refreshToken?: string | null } = {
      accessToken: encryptToken(newTokens.access_token ?? ""),
      expiresAt: newTokens.expiry_date ? new Date(newTokens.expiry_date) : null,
    };
    // Google sometimes returns a new refresh_token — always persist it
    if (newTokens.refresh_token) {
      data.refreshToken = encryptOptional(newTokens.refresh_token);
    }
    await prisma.userToken.update({
      where: { id: token.id },
      data,
    });
    console.log(
      `[GOOGLE] Token refreshed for user ${userId}${newTokens.refresh_token ? " (new refresh_token saved)" : ""}`,
    );
  });

  return oauth2;
}

// Gmail tool functions for Eve

export async function listEmails(userId: string, maxResults = 10) {
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected. Please connect your Gmail first." };

  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    labelIds: ["INBOX"],
  });

  const messages = res.data.messages || [];
  const emails = [];

  for (const msg of messages.slice(0, maxResults)) {
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: msg.id ?? "",
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

    const headers = detail.data.payload?.headers || [];
    emails.push({
      id: msg.id,
      from: headers.find((h) => h.name === "From")?.value || "",
      subject: wrapUntrusted(headers.find((h) => h.name === "Subject")?.value, "email:subject"),
      date: headers.find((h) => h.name === "Date")?.value || "",
      snippet: wrapUntrusted(detail.data.snippet, "email:snippet"),
    });
  }

  return { emails };
}

export async function readEmail(userId: string, emailId: string) {
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.get({
    userId: "me",
    id: emailId,
    format: "full",
  });

  const headers = res.data.payload?.headers || [];
  const parts = res.data.payload?.parts || [];

  let body = "";
  const textPart = parts.find((p) => p.mimeType === "text/plain");
  if (textPart?.body?.data) {
    body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
  } else if (res.data.payload?.body?.data) {
    body = Buffer.from(res.data.payload.body.data, "base64").toString("utf-8");
  }

  return {
    id: emailId,
    from: headers.find((h) => h.name === "From")?.value || "",
    to: headers.find((h) => h.name === "To")?.value || "",
    subject: wrapUntrusted(headers.find((h) => h.name === "Subject")?.value, "email:subject"),
    date: headers.find((h) => h.name === "Date")?.value || "",
    body: wrapUntrusted(body, "email:body"),
  };
}

/** RFC 5321 hard limit — reject before any parsing to keep validation O(1). */
const MAX_RECIPIENT_LENGTH = 320;

/**
 * Loose email address validator — we only need to catch agent hallucinations
 * where `to` is a bare domain ("accounts.google.com") or otherwise clearly not
 * an address. Gmail itself does strict RFC validation on send. Implemented
 * with string ops rather than regex because `to` is LLM-generated and we
 * want no regex backtracking on adversarial inputs (CodeQL js/polynomial-redos).
 */
function extractAddress(raw: string): string {
  const trimmed = raw.trim();
  // "Name <addr@host>" form — take whatever is inside the final angle brackets
  if (trimmed.endsWith(">")) {
    const open = trimmed.lastIndexOf("<");
    if (open !== -1) return trimmed.slice(open + 1, -1).trim();
  }
  return trimmed;
}

function looksLikeEmailAddress(raw: string): boolean {
  if (raw.length > MAX_RECIPIENT_LENGTH) return false;
  const addr = extractAddress(raw);
  if (addr.length === 0 || addr.length > MAX_RECIPIENT_LENGTH) return false;
  const at = addr.indexOf("@");
  if (at <= 0 || at !== addr.lastIndexOf("@")) return false; // need exactly one @, not at start
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return false;
  if (!domain.includes(".")) return false;
  // No whitespace in either part
  for (const part of [local, domain]) {
    for (let i = 0; i < part.length; i++) {
      const ch = part.charCodeAt(i);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) return false;
    }
  }
  return true;
}

/** Local-parts / subdomains that should never receive an auto-reply — responses
 *  either bounce or land in an unmonitored inbox (security-alert /
 *  transactional domains). Matched against extracted address parts, not the
 *  raw input, so there's no regex-on-user-input risk. */
const NO_REPLY_TOKENS = [
  "no-reply",
  "noreply",
  "do-not-reply",
  "donotreply",
  "mailer-daemon",
  "postmaster",
  "notification",
  "notifications",
  "alert",
  "alerts",
  "security",
];

export function isNoReplyAddress(raw: string): boolean {
  const addr = extractAddress(raw).toLowerCase();
  const at = addr.indexOf("@");
  if (at === -1) return false;
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  // Check local-part exact match OR any leading subdomain label
  if (NO_REPLY_TOKENS.includes(local)) return true;
  for (const label of domain.split(".")) {
    if (NO_REPLY_TOKENS.includes(label)) return true;
  }
  return false;
}

function encodeSubject(subject: string): string {
  return `=?UTF-8?B?${Buffer.from(safeHeaderValue(subject)).toString("base64")}?=`;
}

function safeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function wrapBase64(value: string): string {
  return value.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function safeAsciiFilename(filename: string): string {
  const fallback = filename
    .replace(/[\r\n"]/g, "")
    .replace(/[^\x20-\x7E]+/g, "_")
    .trim();
  return fallback || "attachment";
}

function buildPlainTextRawEmail(
  to: string,
  subject: string,
  body: string,
  attachments: GmailDraftAttachment[] = [],
): string {
  if (attachments.length === 0) {
    return Buffer.from(
      [
        `To: ${safeHeaderValue(to)}`,
        `Subject: ${encodeSubject(subject)}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        body,
      ].join("\r\n"),
    ).toString("base64url");
  }

  const boundary = `jigeum_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const parts = [
    `To: ${safeHeaderValue(to)}`,
    `Subject: ${encodeSubject(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ];

  for (const attachment of attachments) {
    const filename = safeHeaderValue(attachment.filename || "attachment");
    const asciiFilename = safeAsciiFilename(filename);
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType || "application/octet-stream"}; name="${asciiFilename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "",
      wrapBase64(attachment.content.toString("base64")),
    );
  }

  parts.push(`--${boundary}--`, "");
  return Buffer.from(parts.join("\r\n")).toString("base64url");
}

export async function sendEmail(userId: string, to: string, subject: string, body: string) {
  if (!looksLikeEmailAddress(to)) {
    return {
      error: `올바른 이메일 주소가 아니에요: "${to}". 도메인(accounts.google.com 등)이 아닌 전체 주소(local@domain)가 필요해요.`,
    };
  }
  if (isNoReplyAddress(to)) {
    return {
      error: `이 주소(${to})는 답장을 받지 않는 시스템 발신자예요 (보안 알림·공지 등). 답장을 보내지 않습니다.`,
    };
  }

  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });

  const raw = buildPlainTextRawEmail(to, subject, body);

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  return { success: true, messageId: res.data.id };
}

export async function createEmailDraft(
  userId: string,
  to: string,
  subject: string,
  body: string,
  threadId?: string | null,
  attachments: GmailDraftAttachment[] = [],
) {
  if (!looksLikeEmailAddress(to)) {
    return {
      error: `올바른 이메일 주소가 아니에요: "${to}". 도메인(accounts.google.com 등)이 아닌 전체 주소(local@domain)가 필요해요.`,
    };
  }
  if (isNoReplyAddress(to)) {
    return {
      error: `이 주소(${to})는 답장을 받지 않는 시스템 발신자예요. Gmail 초안을 만들지 않습니다.`,
    };
  }

  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  const raw = buildPlainTextRawEmail(to, subject, body, attachments);
  const res = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw,
        ...(threadId ? { threadId } : {}),
      },
    },
  });

  return {
    success: true,
    draftId: res.data.id,
    messageId: res.data.message?.id,
    url: "https://mail.google.com/mail/u/0/#drafts",
  };
}

/** Mark a Gmail message as read (remove UNREAD label) */
export async function markAsRead(userId: string, gmailMessageId: string) {
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  await gmail.users.messages.modify({
    userId: "me",
    id: gmailMessageId,
    requestBody: { removeLabelIds: ["UNREAD"] },
  });

  // Also update local DB
  await prisma.emailMessage.updateMany({
    where: { userId, gmailId: gmailMessageId },
    data: { isRead: true },
  });

  return { success: true };
}

/** Trash a Gmail message (move to Trash) */
export async function trashEmail(userId: string, gmailMessageId: string) {
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  await gmail.users.messages.trash({ userId: "me", id: gmailMessageId });

  await prisma.emailMessage.deleteMany({
    where: { userId, gmailId: gmailMessageId },
  });

  return { success: true };
}

/** Archive a Gmail message (remove INBOX label) */
export async function archiveEmail(userId: string, gmailMessageId: string) {
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  await gmail.users.messages.modify({
    userId: "me",
    id: gmailMessageId,
    requestBody: { removeLabelIds: ["INBOX"] },
  });

  await prisma.emailMessage.deleteMany({
    where: { userId, gmailId: gmailMessageId },
  });

  return { success: true };
}

/** Toggle star on Gmail (add/remove STARRED label) */
export async function toggleStarGmail(userId: string, gmailMessageId: string, starred: boolean) {
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  await gmail.users.messages.modify({
    userId: "me",
    id: gmailMessageId,
    requestBody: starred ? { addLabelIds: ["STARRED"] } : { removeLabelIds: ["STARRED"] },
  });

  await prisma.emailMessage.updateMany({
    where: { userId, gmailId: gmailMessageId },
    data: { isStarred: starred },
  });

  return { success: true };
}

/** Toggle read/unread on Gmail */
export async function toggleReadGmail(userId: string, gmailMessageId: string, isRead: boolean) {
  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected." };

  const gmail = google.gmail({ version: "v1", auth });
  await gmail.users.messages.modify({
    userId: "me",
    id: gmailMessageId,
    requestBody: isRead ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] },
  });

  await prisma.emailMessage.updateMany({
    where: { userId, gmailId: gmailMessageId },
    data: { isRead },
  });

  return { success: true };
}

export async function classifyEmails(userId: string, maxResults = 10) {
  const result = await listEmails(userId, maxResults);
  if ("error" in result) return result;

  const { classifyEmailBatch, sortByPriority } = await import("./email-classifier.js");
  const labels = await classifyEmailBatch(
    result.emails.map((e) => ({
      id: e.id,
      from: e.from || "",
      subject: e.subject || "",
      snippet: e.snippet || "",
    })),
  );

  const classified = result.emails.map((email, i) => ({
    ...email,
    priority: labels[i].priority,
    category: labels[i].category,
    needsReply: labels[i].needsReply,
    reason: labels[i].reason,
  }));

  const sorted = sortByPriority(classified);

  const summary = {
    high: sorted.filter((e) => e.priority === "high").length,
    medium: sorted.filter((e) => e.priority === "medium").length,
    low: sorted.filter((e) => e.priority === "low").length,
  };

  return { emails: sorted, summary };
}

// ─── Push Notifications (Gmail watch + Pub/Sub) ──────────────────────────

/**
 * Register a Gmail push watch so Google posts INBOX changes to the configured
 * Pub/Sub topic. Requires GMAIL_PUBSUB_TOPIC env var in the form
 * "projects/<gcp-project>/topics/<topic>". The Gmail service account
 * (gmail-api-push@system.gserviceaccount.com) must have
 * roles/pubsub.publisher on the topic — see ops docs / GCP console.
 *
 * Watches expire after 7 days and must be renewed by calling this again.
 * The expiration is persisted on UserToken.gmailWatchExpiresAt so the
 * renewal cron can find watches approaching expiry.
 * Returns { historyId, expiration } on success.
 */
export async function registerGmailWatch(
  userId: string,
): Promise<{ historyId: string; expiration: string } | { error: string }> {
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) return { error: "GMAIL_PUBSUB_TOPIC not configured" };

  const auth = await getAuthedClient(userId);
  if (!auth) return { error: "Gmail not connected" };

  const gmail = google.gmail({ version: "v1", auth });
  try {
    const res = await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName: topic,
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      },
    });
    const expirationMs = res.data.expiration ? Number(res.data.expiration) : null;
    if (expirationMs && !Number.isNaN(expirationMs)) {
      await prisma.userToken.updateMany({
        where: { userId, provider: "google" },
        data: { gmailWatchExpiresAt: new Date(expirationMs) },
      });
    }
    return {
      historyId: String(res.data.historyId ?? ""),
      expiration: String(res.data.expiration ?? ""),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Gmail watch failed: ${msg}` };
  }
}

/** Stop the Gmail push watch for a user. Idempotent. */
export async function stopGmailWatch(userId: string): Promise<{ ok: boolean; error?: string }> {
  const auth = await getAuthedClient(userId);
  if (!auth) return { ok: false, error: "Gmail not connected" };

  const gmail = google.gmail({ version: "v1", auth });
  try {
    await gmail.users.stop({ userId: "me" });
    await prisma.userToken.updateMany({
      where: { userId, provider: "google" },
      data: { gmailWatchExpiresAt: null },
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Renew Gmail watches that are about to expire (within 24h). Safe to call
 * repeatedly — users.watch is idempotent and extends the expiration.
 * Skipped when GMAIL_PUBSUB_TOPIC is not configured.
 */
export async function renewExpiringGmailWatches(): Promise<{ renewed: number; failed: number }> {
  if (!process.env.GMAIL_PUBSUB_TOPIC) return { renewed: 0, failed: 0 };

  const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tokens = await prisma.userToken.findMany({
    where: {
      provider: "google",
      gmailWatchExpiresAt: { not: null, lte: cutoff },
    },
    select: { userId: true },
  });

  let renewed = 0;
  let failed = 0;
  for (const t of tokens) {
    const result = await registerGmailWatch(t.userId);
    if ("error" in result) {
      console.warn(`[GMAIL-WATCH] Renew failed for ${t.userId}: ${result.error}`);
      failed++;
    } else {
      renewed++;
    }
  }
  return { renewed, failed };
}

// Tool definitions for function calling
export const GMAIL_TOOLS: {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}[] = [
  {
    type: "function" as const,
    function: {
      name: "list_emails",
      description: "List recent emails from the user's Gmail inbox",
      parameters: {
        type: "object",
        properties: {
          max_results: {
            type: "number",
            description: "Number of emails to fetch (default 10, max 20)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_email",
      description: "Read the full content of a specific email by its ID",
      parameters: {
        type: "object",
        properties: {
          email_id: {
            type: "string",
            description: "The Gmail message ID to read",
          },
        },
        required: ["email_id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "classify_emails",
      description:
        "Classify and prioritize inbox emails by urgency (high/medium/low) and category (billing, meeting, engineering, conversation, automated, other). Returns sorted list with high-priority first.",
      parameters: {
        type: "object",
        properties: {
          max_results: {
            type: "number",
            description: "Number of emails to classify (default 10)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_email",
      description: "Send an email on behalf of the user",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject line" },
          body: { type: "string", description: "Email body text" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "mark_read",
      description: "Mark an email as read in Gmail and local DB",
      parameters: {
        type: "object",
        properties: {
          email_id: {
            type: "string",
            description: "The Gmail message ID to mark as read",
          },
        },
        required: ["email_id"],
      },
    },
  },
];
