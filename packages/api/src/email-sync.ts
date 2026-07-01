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
import {
  fetchCurrentHistoryId,
  fetchGmailEmailById,
  fetchGmailEmails,
  fetchGmailHistory,
  type GmailRawEmail,
} from "./gmail-fetch.js";
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

type LinkedInbox = {
  id: string;
  email: string;
  client: InstanceType<typeof google.auth.OAuth2>;
};

/** Read the account's stored Gmail historyId watermark (null on first sync). */
async function readStoredHistoryId(
  userId: string,
  linkedInbox?: LinkedInbox,
): Promise<string | null> {
  if (linkedInbox) {
    // Scope by userId too (not just the id) so a mismatched (userId, id) pair
    // from a future caller can't read another user's watermark — defense in
    // depth matching getAuthedInboxClient's `{ id, userId }` filter.
    const row = await prisma.linkedInboxAccount.findFirst({
      where: { id: linkedInbox.id, userId },
      select: { historyId: true },
    });
    return row?.historyId ?? null;
  }
  const token = await prisma.userToken.findFirst({
    where: { userId, provider: "google" },
    select: { historyId: true },
  });
  return token?.historyId ?? null;
}

/** Advance the account's stored watermark to a NEW, non-null historyId. */
async function storeHistoryId(
  userId: string,
  historyId: string,
  linkedInbox?: LinkedInbox,
): Promise<void> {
  if (linkedInbox) {
    // updateMany (not update) so we can scope by { id, userId } — a compound
    // non-unique filter — and never advance another user's watermark.
    await prisma.linkedInboxAccount.updateMany({
      where: { id: linkedInbox.id, userId },
      data: { historyId },
    });
    return;
  }
  await prisma.userToken.updateMany({
    where: { userId, provider: "google" },
    data: { historyId },
  });
}

/**
 * Persist a batch of raw emails with per-email isolation. One malformed message
 * (an unparseable Date header, or a P2002 unique race with a concurrent
 * gmail-push sync) must not throw out of the loop and strand every email after
 * it. persistGmailEmail is an idempotent upsert, so an isolated failure is
 * safely re-attempted on the next sync. Returns the count of NEW emails.
 */
async function persistEmailBatch(
  userId: string,
  emails: GmailRawEmail[],
  userEmail: string | null,
  linkedInboxAccountId: string | null,
): Promise<number> {
  let newCount = 0;
  for (const email of emails) {
    try {
      const persisted = await persistGmailEmail(userId, email, { userEmail, linkedInboxAccountId });
      if (persisted.isNew) newCount++;
    } catch (err) {
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
  return newCount;
}

/**
 * Snapshot path: a bounded top-N `messages.list` fetch (first sync or after an
 * expired watermark). Persists, then baselines the watermark from getProfile so
 * the NEXT sync switches to the incremental History path and stops dropping the
 * >N messages a snapshot misses. Returns the sync result.
 */
async function syncSnapshot(
  userId: string,
  maxResults: number,
  query: string | undefined,
  userEmail: string | null,
  linkedInbox: LinkedInbox | undefined,
): Promise<{ synced: number; newCount: number; source: "gmail" }> {
  const rawEmails = await fetchGmailEmails(userId, maxResults, query, linkedInbox?.client);
  if (!rawEmails) throw new Error("Gmail not connected");

  const newCount = await persistEmailBatch(userId, rawEmails, userEmail, linkedInbox?.id ?? null);

  // Baseline the watermark ONLY after the snapshot persisted. A search query is
  // not an INBOX baseline, so never re-baseline off a filtered fetch.
  if (!query) {
    const currentHistoryId = await fetchCurrentHistoryId(userId, linkedInbox?.client);
    if (currentHistoryId) await storeHistoryId(userId, currentHistoryId, linkedInbox);
  }

  return { synced: rawEmails.length, newCount, source: "gmail" };
}

/**
 * Sync Gmail → DB, history-aware and per-account (primary or linked inbox).
 *
 * The old single-page top-30 `messages.list` PERMANENTLY missed any message
 * beyond the newest 30 when >30 arrived between syncs (Pub/Sub drop or a slept
 * process): reconcile only deletes/refreshes KNOWN rows, so unseen ids were
 * never gap-filled. This routes through the Gmail History API from a stored
 * watermark so every INBOX addition is fetched. Only inserts new emails / updates
 * existing ones. Returns count of new + total processed emails.
 *
 * CRITICAL ordering: persist FIRST, advance the watermark ONLY after the
 * fetch+persist completes without a thrown error — persistGmailEmail is
 * idempotent, so re-processing on the next sync is safe if we didn't advance.
 */
export async function syncEmails(
  userId: string,
  maxResults = 30,
  query?: string,
  // Multi-account: when set, sync a LINKED secondary inbox using its own OAuth
  // client, and stamp every persisted email with its account id. Omitted =
  // primary Google account (unchanged behavior).
  linkedInbox?: LinkedInbox,
): Promise<{ synced: number; newCount: number; source: "gmail" }> {
  // For a linked inbox, "self" (self-reply detection in the firewall) is that
  // inbox's own address, not the primary user's email.
  const userEmail = linkedInbox?.email ?? (await resolveUserEmail(userId));

  // A search query is an ad-hoc filtered fetch, not INBOX incremental sync —
  // keep it on the direct snapshot path with no watermark side effects.
  const storedHistoryId = query ? null : await readStoredHistoryId(userId, linkedInbox);

  // First sync (no watermark): snapshot to populate + baseline for next time.
  if (!storedHistoryId) {
    return syncSnapshot(userId, maxResults, query, userEmail, linkedInbox);
  }

  // Incremental: gap-fill every INBOX addition since the stored watermark.
  const history = await fetchGmailHistory(userId, storedHistoryId, linkedInbox?.client);
  if (!history) throw new Error("Gmail not connected"); // auth failure

  // Watermark aged out of Gmail's ~7-day retention → snapshot + re-baseline.
  if (history.expired) {
    return syncSnapshot(userId, maxResults, query, userEmail, linkedInbox);
  }

  const newCount = await persistEmailBatch(
    userId,
    history.emails,
    userEmail,
    linkedInbox?.id ?? null,
  );

  // Advance the watermark ONLY after a clean persist, and only to a real id.
  if (history.newHistoryId) await storeHistoryId(userId, history.newHistoryId, linkedInbox);

  return { synced: history.emails.length, newCount, source: "gmail" };
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
  let removed = 0;
  if (inboxIdList.length <= INBOX_PARAM_CAP) {
    // Resolve the attention items of the rows we're about to delete BEFORE the
    // delete, so an archived/trashed email leaves the attention queue instead of
    // orphaning an OPEN item the priority amplifier keeps surfacing forever.
    const stale = await prisma.emailMessage.findMany({
      where: { userId, gmailId: { notIn: inboxIdList } },
      select: { id: true },
    });
    await resolveAttentionForDeletedEmails(
      userId,
      stale.map((r) => r.id),
    );
    const res = await prisma.emailMessage.deleteMany({
      where: { userId, gmailId: { notIn: inboxIdList } },
    });
    removed = res.count;
  } else {
    const stored = await prisma.emailMessage.findMany({
      where: { userId },
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
  const remaining = await prisma.emailMessage.findMany({
    where: { userId },
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
