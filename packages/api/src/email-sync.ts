/**
 * Email Sync & AI Summarization Service
 *
 * Handles:
 * 1. Gmail → DB sync (persist emails locally for search/thread/AI)
 * 2. AI-powered summarization + classification
 * 3. Thread grouping by Gmail threadId
 * 4. Incremental sync (only fetch new emails)
 */

import { google } from "googleapis";
import { prisma } from "./db.js";
import { persistGmailEmail } from "./email-firewall.js";
import { getAuthedClient, isGoogleAuthError, markGoogleTokenForReconnect } from "./gmail.js";
import { fetchGmailEmailById, fetchGmailEmails } from "./gmail-fetch.js";
import { resolveUserEmail } from "./resolve-user-email.js";
import { captureError } from "./sentry.js";

// extractEmailAddress lives in ./email-address.js; re-export preserved here for
// back-compat (judge-context and tests import it via ./email-sync.js).
export { extractEmailAddress } from "./email-address.js";
// Persist + firewall (judge/push/backfill) moved to ./email-firewall.js (M3 step 6).
export { backfillEmailAttentionItems, judgeAndMirrorEmail } from "./email-firewall.js";
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
