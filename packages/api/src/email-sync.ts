/**
 * Email Sync & AI Summarization Service
 *
 * Handles:
 * 1. Gmail → DB sync (persist emails locally for search/thread/AI)
 * 2. AI-powered summarization + classification
 * 3. Thread grouping by Gmail threadId
 * 4. Incremental sync (only fetch new emails)
 */

import { type gmail_v1, google } from "googleapis";
import { upsertAttentionForEmailJudgement } from "./attention-mirror.js";
import { extractAndUpsertCommitmentsFromText } from "./commitment-ingestion.js";
import { prisma } from "./db.js";
import { scheduleAgentForActionableEmail } from "./email-action-trigger.js";
import { extractAttachmentContent, isReadableEmailAttachment } from "./email-attachment-text.js";
import {
  analyzePendingEmailAttachments,
  type RawEmailAttachment,
  upsertEmailAttachments,
} from "./email-attachments.js";
import { classifyNeedsReplyFromSignals, classifyPriority } from "./email-priority.js";
import { getAuthedClient, isGoogleAuthError, markGoogleTokenForReconnect } from "./gmail.js";
import { buildJudgeContext } from "./judge-context.js";
import { createCompletion, MODEL, openai } from "./openai.js";
import { judgeEmail, type PocTier } from "./poc-judge.js";
import { resolveUserEmail } from "./resolve-user-email.js";
import { captureError } from "./sentry.js";
import { wrapUntrusted } from "./untrusted.js";

// extractEmailAddress lives in ./email-address.js; re-export preserved here for
// back-compat (judge-context and tests import it via ./email-sync.js).
export { extractEmailAddress } from "./email-address.js";
// Back-compat barrel: priority/reply classification moved to ./email-priority.js
// (M3 decomposition). External importers and tests still resolve these through
// ./email-sync.js, so re-export them here.
export {
  classifyNeedsReplyFromSignals,
  classifyPriority,
  classifyPriorityDetailed,
  type NeedsReplyClassification,
  type PriorityClassification,
} from "./email-priority.js";
// Auto-reply moved to ./email-reply.js (M3 step 4).
export { checkAutoReplyRules, generateSmartReply } from "./email-reply.js";
// AI summarization moved to ./email-summarize.js (M3 step 2).
export { parseAiSummary, summarizeUnsummarizedEmails } from "./email-summarize.js";
// Thread grouping moved to ./email-threads.js (M3 step 3).
export { type EmailThread, getEmailThreads } from "./email-threads.js";

// ─── Gmail → DB Sync ──────────────────────────────────────────────────────

interface GmailRawEmail {
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
    receivedAt: dateStr ? new Date(dateStr) : new Date(),
    attachments,
  };
}

/**
 * Fetch emails from Gmail API and return raw data.
 * Handles pagination and full body extraction.
 */
async function fetchGmailEmails(
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
    const messages = res.data.messages || [];

    const emails: GmailRawEmail[] = [];

    for (const msg of messages) {
      if (!msg.id) continue;

      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full",
      });

      emails.push(await parseGmailMessageDetail(gmail, msg.id, detail.data));
    }

    return emails;
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      return null;
    }
    throw err;
  }
}

async function fetchGmailEmailById(userId: string, gmailId: string): Promise<GmailRawEmail | null> {
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

async function persistGmailEmail(
  userId: string,
  email: GmailRawEmail,
  options: { userEmail?: string | null } = {},
): Promise<{ emailId: string; isNew: boolean }> {
  const existing = await prisma.emailMessage.findUnique({
    where: { userId_gmailId: { userId, gmailId: email.gmailId } },
  });

  if (existing) {
    await prisma.emailMessage.update({
      where: { id: existing.id },
      data: {
        isRead: email.isRead,
        isStarred: email.isStarred,
        labels: email.labels,
      },
    });
    if (email.attachments.length > 0) {
      await upsertEmailAttachments({
        userId,
        emailId: existing.id,
        attachments: email.attachments,
      });
    }
    return { emailId: existing.id, isNew: false };
  }

  const userEmail = options.userEmail ?? (await resolveUserEmail(userId));
  const priority = classifyPriority(email.from, email.subject, email.labels);
  const replyNeeded = classifyNeedsReplyFromSignals({
    from: email.from,
    subject: email.subject,
    labels: email.labels,
    priority,
    userEmail,
  });

  const createdEmail = await prisma.emailMessage.create({
    data: {
      userId,
      gmailId: email.gmailId,
      threadId: email.threadId,
      from: email.from,
      to: email.to,
      cc: email.cc || null,
      subject: email.subject,
      snippet: email.snippet,
      body: email.body || null,
      htmlBody: email.htmlBody || null,
      labels: email.labels,
      isRead: email.isRead,
      isStarred: email.isStarred,
      priority,
      needsReply: replyNeeded.needsReply,
      needsReplyReason: replyNeeded.reason,
      needsReplyConfidence: replyNeeded.confidence,
      receivedAt: email.receivedAt,
    },
  });
  if (email.attachments.length > 0) {
    await upsertEmailAttachments({
      userId,
      emailId: createdEmail.id,
      attachments: email.attachments,
    });
    analyzePendingEmailAttachments(userId, email.attachments.length).catch((err) => {
      captureError(err, {
        tags: { scope: "email_attachment.analysis" },
        extra: { userId, emailId: createdEmail.id, gmailId: email.gmailId },
      });
    });
  }
  const commitmentText = [email.subject, email.body || email.snippet].filter(Boolean).join("\n\n");
  if (commitmentText.trim()) {
    extractAndUpsertCommitmentsFromText({
      userId,
      sourceType: "EMAIL",
      sourceId: createdEmail.id,
      threadId: email.threadId,
      text: commitmentText,
      contextTitle: email.subject,
      referenceDate: email.receivedAt,
      senderEmail: email.from,
    }).catch((err) => {
      captureError(err, {
        tags: { scope: "commitment.email_ingestion" },
        extra: { userId, emailId: createdEmail.id, gmailId: email.gmailId },
      });
    });
  }

  // POC firewall: classify the email into SILENT/QUEUE/PUSH/AUTO and mirror
  // it to an AttentionItem so the firewall route surfaces it. Fire-and-forget
  // so sync never blocks on the LLM. If this rejects (or the process dies
  // mid-flight) the email is persisted but has no AttentionItem — the
  // backfill sweep (backfillEmailAttentionItems, run by the scheduler) is the
  // safety net that re-judges any email left without one.
  judgeAndMirrorEmail(userId, {
    id: createdEmail.id,
    gmailId: email.gmailId,
    from: email.from,
    subject: email.subject,
    snippet: email.snippet,
    labels: email.labels,
    receivedAt: email.receivedAt,
  })
    .then((tier) => {
      // Actionable tiers (PUSH/QUEUE) trigger an immediate agent run so the
      // user sees a draft proposal without waiting for the cron. Debounced
      // inside the trigger to bound LLM cost.
      scheduleAgentForActionableEmail(userId, tier);
    })
    .catch((err) => {
      captureError(err, {
        tags: { scope: "poc-judge.email_sync" },
        extra: { userId, emailId: createdEmail.id, gmailId: email.gmailId },
      });
    });

  return { emailId: createdEmail.id, isNew: true };
}

interface JudgeableEmailRow {
  id: string;
  gmailId: string;
  from: string;
  subject: string;
  snippet: string | null;
  labels: string[];
  receivedAt: Date;
}

/**
 * Classify one stored email into a tier and mirror it to an AttentionItem.
 * Shared by the inline sync path and the backfill sweep. buildJudgeContext
 * never throws and judgeEmail falls back to keyword features when the LLM is
 * down, so the only way this produces no AttentionItem is the upsert itself
 * throwing — in which case the next backfill pass retries it.
 */
export async function judgeAndMirrorEmail(
  userId: string,
  email: JudgeableEmailRow,
): Promise<PocTier> {
  const judgeContext = await buildJudgeContext(userId, {
    from: email.from,
    excludeEmailId: email.id,
  });
  const judgement = await judgeEmail(
    {
      from: email.from,
      subject: email.subject,
      snippet: email.snippet,
      labels: email.labels,
    },
    userId,
    judgeContext,
  );
  await upsertAttentionForEmailJudgement({ userId, ...email }, judgement);

  // The whole point of the firewall: a PUSH tier should actually interrupt
  // you. Until now nothing did — email pushes fired only off the separate
  // keyword `classifyPriority === URGENT` heuristic, so the smart judge could
  // (correctly) tier an email PUSH and the notification never went out. Wire
  // the judge's PUSH decision to a real push. Best-effort: never block or
  // fail classification on the notification.
  if (judgement.tier === "PUSH") {
    await pushForFirewallEmail(userId, email).catch((err) =>
      captureError(err, {
        tags: { scope: "firewall-push" },
        extra: { userId, emailId: email.id },
      }),
    );
  }
  return judgement.tier;
}

// A push for a PUSH-tier email only fires for genuinely recent mail. The
// backfill sweep re-judges emails that arrived while the dyno slept; tiering
// a days-old email in the firewall is right, but firing a stale "urgent" push
// for it is not.
const FIREWALL_PUSH_RECENCY_MS = 6 * 60 * 60 * 1000;
const PUSH_DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Shared notification title with the urgent-priority sweep
// (automation-scheduler.ts) so the two dedup against each other: whichever
// fires first writes "Urgent email" + "[gmailId]", and the other skips. An
// email that is both keyword-URGENT and judge-PUSH gets exactly one push.
const FIREWALL_PUSH_TITLE = "Urgent email";

function senderDisplayName(from: string): string {
  const angle = from.indexOf("<");
  const name = angle > 0 ? from.slice(0, angle).trim().replace(/^"|"$/g, "") : from.trim();
  return name || from;
}

/**
 * Send a push for an email the judge tiered PUSH. Recency-guarded (never push
 * backfilled old mail) and deduped (shared marker with the urgent-priority
 * sweep so an email never gets two pushes). sendPushNotification applies the
 * quiet-hours / rate-limit / Telegram gates, so we don't re-check them here.
 */
async function pushForFirewallEmail(userId: string, email: JudgeableEmailRow): Promise<void> {
  if (Date.now() - email.receivedAt.getTime() > FIREWALL_PUSH_RECENCY_MS) return;

  const already = await prisma.notification.findFirst({
    where: {
      userId,
      type: "email",
      title: FIREWALL_PUSH_TITLE,
      message: { contains: `[${email.gmailId}]` },
      createdAt: { gte: new Date(Date.now() - PUSH_DEDUP_WINDOW_MS) },
    },
    select: { id: true },
  });
  if (already) return;

  const sender = senderDisplayName(email.from);
  const body = `${sender}: ${email.subject || "(no subject)"}`.slice(0, 200);

  // Bell row carries the [gmailId] dedup marker (read back by both this path
  // and the urgent-priority sweep).
  const notification = await prisma.notification.create({
    data: {
      userId,
      type: "email",
      title: FIREWALL_PUSH_TITLE,
      message: `${body} [${email.gmailId}]`,
    },
  });

  const [{ pushNotification }, { sendPushNotification }, { findOpenEmailAttentionItemId }] =
    await Promise.all([
      import("./websocket.js"),
      import("./push.js"),
      import("./attention-override.js"),
    ]);

  pushNotification(userId, {
    id: notification.id,
    type: "email",
    title: FIREWALL_PUSH_TITLE,
    message: body,
    createdAt: notification.createdAt.toISOString(),
  });

  const attentionItemId = await findOpenEmailAttentionItemId(userId, email.id);
  await sendPushNotification(
    userId,
    {
      title: `Klorn — ${sender}`,
      body: email.subject || "(no subject)",
      url: "/inbox/firewall",
      attentionItemId: attentionItemId ?? undefined,
    },
    "email_urgent",
  );
}

const BACKFILL_LOOKBACK_DAYS = 14;
const BACKFILL_LOOKBACK_MS = BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
const BACKFILL_SCAN_LIMIT = 200;
const BACKFILL_BATCH = 10;

/**
 * Re-judge recently-synced emails that have no AttentionItem.
 *
 * The inline judge (above) is fire-and-forget: a transient LLM/DB failure, or
 * a dyno killed mid-flight (free-tier sleep), strands the email — it shows in
 * the mail view but never appears in the firewall tiers, and can't even be
 * re-tiered (no row → no override target). This sweep is the durable safety
 * net. Bounded per call (BACKFILL_BATCH) so a large backlog (e.g. mail that
 * arrived while the instance slept) drains over a few scheduler ticks instead
 * of bursting the paid judge model. A no-op once caught up. Returns the count
 * re-judged.
 */
export async function backfillEmailAttentionItems(userId: string): Promise<number> {
  const cutoff = new Date(Date.now() - BACKFILL_LOOKBACK_MS);
  const recent = (await prisma.emailMessage.findMany({
    where: { userId, receivedAt: { gte: cutoff } },
    select: {
      id: true,
      gmailId: true,
      from: true,
      subject: true,
      snippet: true,
      labels: true,
      receivedAt: true,
    },
    orderBy: { receivedAt: "desc" },
    take: BACKFILL_SCAN_LIMIT,
  })) as JudgeableEmailRow[];
  if (recent.length === 0) return 0;

  const judged = (await prisma.attentionItem.findMany({
    where: { userId, source: "EMAIL", sourceId: { in: recent.map((e) => e.id) } },
    select: { sourceId: true },
  })) as Array<{ sourceId: string }>;
  const judgedIds = new Set(judged.map((a) => a.sourceId));

  // Oldest-first within the batch so a backlog drains in arrival order.
  const unjudged = recent
    .filter((e) => !judgedIds.has(e.id))
    .reverse()
    .slice(0, BACKFILL_BATCH);

  let done = 0;
  for (const email of unjudged) {
    try {
      await judgeAndMirrorEmail(userId, email);
      done++;
    } catch (err) {
      captureError(err, {
        tags: { scope: "email-backfill" },
        extra: { userId, emailId: email.id },
      });
    }
  }
  return done;
}

export async function syncEmailByGmailId(
  userId: string,
  gmailId: string,
): Promise<{ synced: number; newCount: number; emailId: string; source: "gmail" }> {
  const rawEmail = await fetchGmailEmailById(userId, gmailId);
  if (!rawEmail) throw new Error("Gmail not connected");

  const persisted = await persistGmailEmail(userId, rawEmail);
  return {
    synced: 1,
    newCount: persisted.isNew ? 1 : 0,
    emailId: persisted.emailId,
    source: "gmail",
  };
}

/**
 * Sync Gmail → DB. Only inserts new emails, updates existing ones.
 * Returns count of new + updated emails.
 */
export async function syncEmails(
  userId: string,
  maxResults = 30,
  query?: string,
): Promise<{ synced: number; newCount: number; source: "gmail" }> {
  const rawEmails = await fetchGmailEmails(userId, maxResults, query);
  if (!rawEmails) throw new Error("Gmail not connected");

  const userEmail = await resolveUserEmail(userId);
  let newCount = 0;

  for (const email of rawEmails) {
    try {
      const persisted = await persistGmailEmail(userId, email, { userEmail });
      if (persisted.isNew) newCount++;
    } catch (err) {
      // Isolate per-email failures: one malformed message (an unparseable Date
      // header, or a P2002 unique race with a concurrent gmail-push sync) must
      // not throw out of the loop and strand every email after it in the batch.
      // (The backfill loop above already uses this pattern.)
      captureError(err, {
        tags: { scope: "email.sync.persist", userId },
        extra: { gmailId: email.gmailId },
      });
    }
  }

  return { synced: rawEmails.length, newCount, source: "gmail" };
}

// ─── Gmail ↔ DB Reconciliation ────────────────────────────────────────────

/**
 * Reconcile local DB with Gmail.
 * Removes DB emails that no longer exist in Gmail INBOX (deleted/archived/trashed).
 * Updates read/star status for remaining emails.
 */
export async function reconcileEmails(
  userId: string,
): Promise<{ removed: number; updated: number }> {
  const auth = await getAuthedClient(userId);
  if (!auth) throw new Error("Gmail not connected");

  const gmail = google.gmail({ version: "v1", auth });

  // Get ALL current INBOX message IDs from Gmail (lightweight list call)
  const inboxIds = new Set<string>();
  let pageToken: string | undefined;
  try {
    do {
      const res = await gmail.users.messages.list({
        userId: "me",
        labelIds: ["INBOX"],
        maxResults: 500,
        pageToken,
      });
      for (const msg of res.data.messages || []) {
        if (msg.id) inboxIds.add(msg.id);
      }
      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  } catch (err) {
    if (isGoogleAuthError(err)) {
      await markGoogleTokenForReconnect(userId);
      throw new Error("Gmail not connected");
    }
    throw err;
  }

  // Get all DB emails for this user
  const dbEmails = await prisma.emailMessage.findMany({
    where: { userId },
    select: { id: true, gmailId: true, isRead: true },
  });

  // Remove DB emails no longer in Gmail INBOX
  let removed = 0;
  const toRemove: string[] = [];
  for (const dbEmail of dbEmails) {
    if (!inboxIds.has(dbEmail.gmailId)) {
      toRemove.push(dbEmail.id);
      removed++;
    }
  }

  if (toRemove.length > 0) {
    await prisma.emailMessage.deleteMany({
      where: { id: { in: toRemove } },
    });
    console.log(`[EMAIL-SYNC] Reconciled: removed ${removed} stale emails for user ${userId}`);
  }

  // For remaining emails still in INBOX, batch-update read status
  let updated = 0;
  const remainingGmailIds = dbEmails.filter((e) => inboxIds.has(e.gmailId)).map((e) => e.gmailId);

  // Check read status for remaining emails (batch of 50)
  for (let i = 0; i < remainingGmailIds.length; i += 50) {
    const batch = remainingGmailIds.slice(i, i + 50);
    for (const gmailId of batch) {
      try {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: gmailId,
          format: "minimal",
        });
        const labelIds = detail.data.labelIds || [];
        const isRead = !labelIds.includes("UNREAD");
        const isStarred = labelIds.includes("STARRED");

        const result = await prisma.emailMessage.updateMany({
          where: { userId, gmailId },
          data: { isRead, isStarred, labels: labelIds },
        });
        if (result.count > 0) updated++;
      } catch {
        // Message might have been deleted between list and get — skip
      }
    }
  }

  return { removed, updated };
}
