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
import { prisma } from "./db.js";
import { persistGmailEmail } from "./email-firewall.js";
import {
  getAuthedClient,
  isGoogleAuthError,
  isGoogleNotFoundError,
  markGoogleTokenForReconnect,
} from "./gmail.js";
import { fetchGmailEmailById, fetchGmailEmails } from "./gmail-fetch.js";
import { resolveUserEmail } from "./resolve-user-email.js";
import { Semaphore } from "./semaphore.js";
import { captureError } from "./sentry.js";

// Reconcile refreshes read/star status with one messages.get per stored email.
// Bound concurrency so a few-hundred-email mailbox doesn't serialize hundreds of
// round-trips. Same quota headroom as the fetch path (Gmail 250 units/s).
const RECONCILE_CONCURRENCY = 8;
// Cap the per-tick read-status refresh (one Gmail messages.get + one updateMany
// per row) to the most recent N emails, so the reconcile cost is bounded by N
// rather than scaling linearly with total mailbox size every 30 min/user.
const RECONCILE_REFRESH_CAP = 500;

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
      // console first — captureError is silent without a Sentry DSN (self-host/
      // dev), and the sibling reconcile catch follows the same console discipline.
      console.warn(
        "[EMAIL-SYNC] persist failed (gmailId in Sentry extra):",
        err instanceof Error ? err.message : String(err),
      );
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
    orderBy: { receivedAt: "desc" },
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
      where: { userId, id: { in: toRemove } },
    });
    console.log(`[EMAIL-SYNC] Reconciled: removed ${removed} stale emails for user ${userId}`);
  }

  // Refresh read/star status for emails still in INBOX (bounded concurrency).
  // Cap to the most recent N (dbEmails is ordered receivedAt desc) so the
  // per-row Gmail get + updateMany cost can't scale with total mailbox size;
  // older read-state drift is rare and the next tick re-checks the top N again.
  const remainingGmailIds = dbEmails
    .filter((e) => inboxIds.has(e.gmailId))
    .map((e) => e.gmailId)
    .slice(0, RECONCILE_REFRESH_CAP);
  const updated = await refreshReadStatus(gmail, userId, remainingGmailIds);

  return { removed, updated };
}

/**
 * Refresh read/star/labels for each given Gmail id via a minimal messages.get,
 * with bounded concurrency. Returns the count of rows actually updated. A
 * message deleted between the list and the get is skipped silently — that is an
 * expected race, not a failure.
 */
async function refreshReadStatus(
  gmail: gmail_v1.Gmail,
  userId: string,
  gmailIds: string[],
): Promise<number> {
  const sem = new Semaphore(RECONCILE_CONCURRENCY);
  const results = await sem.all<number>(
    gmailIds.map((gmailId) => async () => {
      try {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: gmailId,
          format: "minimal",
        });
        const labelIds = detail.data.labelIds || [];
        const result = await prisma.emailMessage.updateMany({
          where: { userId, gmailId },
          data: {
            isRead: !labelIds.includes("UNREAD"),
            isStarred: labelIds.includes("STARRED"),
            labels: labelIds,
          },
        });
        return result.count > 0 ? 1 : 0;
      } catch (err) {
        // Deleted between list and get — expected race, skip silently.
        if (isGoogleNotFoundError(err)) return 0;
        // Anything else (transient 429/5xx under parallelism, a DB hiccup): skip
        // this one message so a single failure doesn't sink the whole reconcile,
        // but leave a signal — a bare swallow here would hide a quota or
        // connectivity problem behind an under-counted `updated`.
        console.warn(`[EMAIL-SYNC] refreshReadStatus skipped ${gmailId} for user ${userId}:`, err);
        captureError(err, {
          tags: { scope: "email.sync.reconcile.readstatus" },
          extra: { userId, gmailId },
        });
        return 0;
      }
    }),
  );
  return results.reduce((sum, n) => sum + n, 0);
}
