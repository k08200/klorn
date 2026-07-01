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
  getAuthedInboxAccount,
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
// Postgres caps a statement at 65535 bind parameters. Keep any IN / NOT IN list
// well under that; an INBOX larger than this falls back to an in-Node diff so a
// single huge NOT IN can never crash the reconcile.
const INBOX_PARAM_CAP = 10000;

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
  // Set when re-syncing a message that belongs to a LINKED secondary inbox
  // (undo after untrash/unarchive). Fetch + self-detection + the stored tag all
  // use that account; omitted = primary (unchanged behavior).
  linkedInboxAccountId?: string | null,
): Promise<{ synced: number; newCount: number; emailId: string; source: "gmail" }> {
  const linked = linkedInboxAccountId
    ? await getAuthedInboxAccount(userId, linkedInboxAccountId)
    : null;
  if (linkedInboxAccountId && !linked) throw new Error("Gmail not connected");

  const rawEmail = await fetchGmailEmailById(userId, gmailId, linked?.client ?? null);
  if (!rawEmail) throw new Error("Gmail not connected");

  const persisted = await persistGmailEmail(userId, rawEmail, {
    userEmail: linked?.email ?? null,
    linkedInboxAccountId: linked?.id ?? null,
  });
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
  // Multi-account: when set, sync a LINKED secondary inbox using its own OAuth
  // client, and stamp every persisted email with its account id. Omitted =
  // primary Google account (unchanged behavior).
  linkedInbox?: { id: string; email: string; client: InstanceType<typeof google.auth.OAuth2> },
): Promise<{ synced: number; newCount: number; source: "gmail" }> {
  const rawEmails = await fetchGmailEmails(userId, maxResults, query, linkedInbox?.client);
  if (!rawEmails) throw new Error("Gmail not connected");

  // For a linked inbox, "self" (self-reply detection in the firewall) is that
  // inbox's own address, not the primary user's email.
  const userEmail = linkedInbox?.email ?? (await resolveUserEmail(userId));
  const linkedInboxAccountId = linkedInbox?.id ?? null;
  let newCount = 0;

  for (const email of rawEmails) {
    try {
      const persisted = await persistGmailEmail(userId, email, { userEmail, linkedInboxAccountId });
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
 * Resolve the EMAIL attention items mirroring the given EmailMessage ids. Called
 * when those emails leave the INBOX (archived/trashed in Gmail) so a handled
 * email also leaves the attention queue — otherwise the AttentionItem is orphaned
 * OPEN and the priority amplifier keeps surfacing it (the stale-PUSH accumulation
 * bug). Only OPEN/SNOOZED are touched, so a terminal user decision (already
 * RESOLVED/DISMISSED) is preserved. Chunked for the bind-param cap.
 */
async function resolveAttentionForDeletedEmails(userId: string, emailIds: string[]): Promise<void> {
  for (let i = 0; i < emailIds.length; i += INBOX_PARAM_CAP) {
    await prisma.attentionItem.updateMany({
      where: {
        userId,
        source: "EMAIL",
        sourceId: { in: emailIds.slice(i, i + INBOX_PARAM_CAP) },
        status: { in: ["OPEN", "SNOOZED"] },
      },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
  }
}

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

  // An empty INBOX listing is almost always a transient Gmail hiccup, not the
  // user archiving every message. Treating it as "all stale" would wipe the
  // entire local mirror, so skip this tick rather than mass-delete. (Trade-off:
  // a genuinely-empty INBOX keeps its now-stale rows until one message returns.)
  if (inboxIds.size === 0) {
    return { removed: 0, updated: 0 };
  }
  const inboxIdList = Array.from(inboxIds);

  // Remove DB rows no longer in INBOX. For a normal-sized INBOX, let Postgres do
  // the diff with NOT IN — no need to load the whole mailbox into Node. For a
  // pathologically large INBOX a single NOT IN would exceed the 65535 bind-param
  // ceiling, so fall back to diffing stored gmailIds in Node and deleting the
  // (usually tiny) stale set by id, in chunks. No query exceeds INBOX_PARAM_CAP.
  // CRITICAL: scope every reconcile query to PRIMARY-account rows only
  // (linkedInboxAccountId: null). inboxIdList was built from the primary
  // account's INBOX (getAuthedClient above), so linked-inbox rows — whose
  // gmailIds come from a DIFFERENT account and are never in this list — would
  // ALL match `gmailId notIn inboxIdList` and be wiped. The gap only bites once
  // MULTI_INBOX_SYNC_ENABLED is on, but it would silently delete every linked
  // inbox's mail on the first reconcile tick, so guard it before the flag flips.
  const primaryScope = { userId, linkedInboxAccountId: null } as const;
  let removed = 0;
  if (inboxIdList.length <= INBOX_PARAM_CAP) {
    // Resolve the attention items of the rows we're about to delete BEFORE the
    // delete, so an archived/trashed email leaves the attention queue instead of
    // orphaning an OPEN item the priority amplifier keeps surfacing forever.
    const stale = await prisma.emailMessage.findMany({
      where: { ...primaryScope, gmailId: { notIn: inboxIdList } },
      select: { id: true },
    });
    await resolveAttentionForDeletedEmails(
      userId,
      stale.map((r) => r.id),
    );
    const res = await prisma.emailMessage.deleteMany({
      where: { ...primaryScope, gmailId: { notIn: inboxIdList } },
    });
    removed = res.count;
  } else {
    const stored = await prisma.emailMessage.findMany({
      where: primaryScope,
      select: { id: true, gmailId: true },
    });
    const staleIds = stored.filter((e) => !inboxIds.has(e.gmailId)).map((e) => e.id);
    await resolveAttentionForDeletedEmails(userId, staleIds);
    for (let i = 0; i < staleIds.length; i += INBOX_PARAM_CAP) {
      const res = await prisma.emailMessage.deleteMany({
        where: { userId, id: { in: staleIds.slice(i, i + INBOX_PARAM_CAP) } },
      });
      removed += res.count;
    }
  }
  if (removed > 0) {
    console.log(`[EMAIL-SYNC] Reconciled: removed ${removed} stale emails for user ${userId}`);
  }

  // Refresh read/star status for the most recent N rows (bounded). After the
  // delete above, every remaining row for the user is in INBOX, so the
  // most-recent N are exactly the rows worth re-checking — no INBOX-sized IN
  // clause needed, and the per-row Gmail get + updateMany cost stays capped at N.
  // Same primary-only scope: these gmailIds are re-checked against the primary
  // Gmail client below, so a linked-inbox gmailId would 404 there (wasted slot)
  // or, on a cross-account id collision, mis-update the wrong row.
  const remaining = await prisma.emailMessage.findMany({
    where: primaryScope,
    select: { gmailId: true },
    orderBy: { receivedAt: "desc" },
    take: RECONCILE_REFRESH_CAP,
  });
  const updated = await refreshReadStatus(
    gmail,
    userId,
    remaining.map((e) => e.gmailId),
  );

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
