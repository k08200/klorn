/**
 * Sent-history import (2026-11-01, docs/design/attention-engine-v3.md §3(2)).
 *
 * The 30-minute Sent scan (sent-messages.ts) reads only the newest page, so
 * the relationship snapshot cannot see anyone the user wrote to more than
 * ~50 sends ago. This imports, once per Google inbox the scan reads (the
 * primary account and every linked GOOGLE inbox not waiting for a reconnect),
 * the newest SENT_HISTORY_CAP sent mails of the last SENT_HISTORY_WINDOW_DAYS:
 *   - headers only (`format: "metadata"`, To / Subject / Date, field mask),
 *     never a body or snippet; `gmail.readonly` already covers it;
 *   - stateless: each run lists the window's ids (newest first, stopping at
 *     the cap) and fetches the oldest ones SentMessage does not have yet. The
 *     rows ARE the progress, so a crash or a redeploy resumes where it stopped,
 *     and a gap the scan left (more than a page of sends while a token was
 *     dead) is filled. No cursor and no second-granular `before:` date;
 *   - bounded: at most SENT_HISTORY_BATCH metadata fetches per run, two at a
 *     time (Gmail allows 250 quota units per user per second; a fetch costs 5),
 *     a page cap and a RUN_DEADLINE_MS deadline per run, one run per user at a
 *     time and MAX_CONCURRENT_IMPORTS users at once;
 *   - failures: a failed fetch pauses that inbox (not the user) for
 *     FAILURE_PAUSE_MS. A message whose fetch failed MAX_FETCH_ATTEMPTS times
 *     (or that has no usable date) is skipped from then on and the inbox can
 *     still finish without it; the count is logged, never the id;
 *   - finished once: when everything listed is recorded, the inbox's grant row
 *     gets `sentHistoryImportedAt`. A reconnect or re-link resets it (it may
 *     be another Google account), so that account is imported again;
 *   - labelled: every row goes through recordSentMessage with the
 *     sent-origin-classifier label as a create-only origin, so mail Klorn sent
 *     before #1591 (unattended replies, mailto unsubscribes) never reads as
 *     the user's own.
 *
 * SENT_HISTORY_BACKFILL_ENABLED, OFF by default (accepts `cohort`). Off, a run
 * returns before any database read or Gmail call. Read per call, so a flip
 * needs no redeploy. The scheduler calls it detached after the Sent scan, so
 * it never spends the per-user tick budget of the serial user loop.
 */

import { google } from "googleapis";
import { featureOpenTo } from "../config.js";
import { prisma } from "../db.js";
import { getAuthedClient, getAuthedInboxClient } from "./gmail.js";
import { reportSentError } from "./sent-errors.js";
import { fetchHeaders, type HistoryRow, listMissing } from "./sent-history-fetch.js";
import { recordSentMessage } from "./sent-messages.js";
import { classifySentRows } from "./sent-origin-classifier.js";

export {
  SENT_HISTORY_BATCH,
  SENT_HISTORY_CAP,
  SENT_HISTORY_WINDOW_DAYS,
} from "./sent-history-fetch.js";

type OAuth2 = InstanceType<typeof google.auth.OAuth2>;

export const SENT_HISTORY_BACKFILL_FLAG = "SENT_HISTORY_BACKFILL_ENABLED";
/** After a failed fetch (quota, network, auth) the inbox waits this long. */
const FAILURE_PAUSE_MS = 30 * 60_000;
/** Wall-clock budget of one run (it is detached; this bounds its slot). */
const RUN_DEADLINE_MS = 2 * 60_000;
/** Failed fetches of one message before the import stops asking for it. */
const MAX_FETCH_ATTEMPTS = 3;
/** A user with nothing left to import is looked up again after this long. */
const DONE_RECHECK_MS = 6 * 60 * 60_000;
const MAX_CONCURRENT_IMPORTS = 2;
const PRIMARY = "primary";

const importing = new Set<string>();
/** userId, or `${userId}:${inbox}` → time until which it waits after a failure. */
const pausedUntil = new Map<string, number>();
/** userId → time until which a user with no unfinished inbox is not queried. */
const doneUntil = new Map<string, number>();
/** `${userId}:${inbox}:${gmailId}` → failed fetch attempts. */
const failedAttempts = new Map<string, number>();

/** Test seam — the guards are module state. */
export function resetSentHistoryImportForTests(): void {
  importing.clear();
  pausedUntil.clear();
  doneUntil.clear();
  failedAttempts.clear();
}

export interface ImportOptions {
  /** Wall-clock budget of this run; RUN_DEADLINE_MS by default. */
  deadlineMs?: number;
}

/**
 * Import the next batch of one unfinished inbox. Safe to call every tick and
 * never throws. Returns the number of rows written.
 */
export async function importSentHistory(
  userId: string,
  now = Date.now(),
  opts: ImportOptions = {},
): Promise<number> {
  let claimed = false;
  try {
    if (!featureOpenTo(userId, [SENT_HISTORY_BACKFILL_FLAG])) return 0;
    pruneExpired(now);
    if (doneUntil.has(userId) || pausedUntil.has(userId)) return 0;
    if (importing.has(userId) || importing.size >= MAX_CONCURRENT_IMPORTS) return 0;
    importing.add(userId);
    claimed = true;
    const deadline = Date.now() + (opts.deadlineMs ?? RUN_DEADLINE_MS);
    return await importNextBatch(userId, now, deadline);
  } catch (err) {
    pausedUntil.set(userId, now + FAILURE_PAUSE_MS);
    reportSentError("sent-history.import", err, userId);
    return 0;
  } finally {
    if (claimed) importing.delete(userId);
  }
}

function pruneExpired(now: number): void {
  for (const map of [pausedUntil, doneUntil]) {
    for (const [key, until] of map) if (until <= now) map.delete(key);
  }
}

const inboxKey = (userId: string, inbox: string) => `${userId}:${inbox}`;

/** Unfinished inboxes, primary first; "primary" or a LinkedInboxAccount id. */
async function pendingInboxes(userId: string): Promise<string[]> {
  const token = await prisma.userToken.findFirst({
    where: { userId, provider: "google" },
    select: { sentHistoryImportedAt: true },
  });
  const linked = await prisma.linkedInboxAccount.findMany({
    where: { userId, provider: "GOOGLE", sentHistoryImportedAt: null, needsReconnect: false },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const primary = token && token.sentHistoryImportedAt === null ? [PRIMARY] : [];
  return [...primary, ...linked.map((l) => l.id)];
}

async function importNextBatch(userId: string, now: number, deadline: number): Promise<number> {
  const inboxes = await pendingInboxes(userId);
  if (inboxes.length === 0) {
    doneUntil.set(userId, now + DONE_RECHECK_MS);
    return 0;
  }
  for (const inbox of inboxes) {
    // A paused or unusable inbox must not stall the ones after it.
    if (pausedUntil.has(inboxKey(userId, inbox))) continue;
    const auth = await (inbox === PRIMARY
      ? getAuthedClient(userId)
      : getAuthedInboxClient(userId, inbox));
    if (!auth) continue;
    return importInboxBatch(userId, inbox, auth, now, deadline);
  }
  return 0;
}

async function importInboxBatch(
  userId: string,
  inbox: string,
  auth: OAuth2,
  now: number,
  deadline: number,
): Promise<number> {
  const key = inboxKey(userId, inbox);
  const attemptsOf = (gmailId: string) => failedAttempts.get(`${key}:${gmailId}`) ?? 0;
  const gmail = google.gmail({ version: "v1", auth });
  const listing = await listMissing(gmail, userId, {
    now,
    deadline,
    isExhausted: (gmailId) => attemptsOf(gmailId) >= MAX_FETCH_ATTEMPTS,
  });
  if (listing.exhausted > 0) {
    console.warn(
      `[SENT-HISTORY] skipping ${listing.exhausted} message(s) after ${MAX_FETCH_ATTEMPTS} failed fetches`,
    );
  }
  const fetched = await fetchHeaders(gmail, inbox, listing.missing, deadline);
  for (const id of fetched.failedIds) failedAttempts.set(`${key}:${id}`, attemptsOf(id) + 1);
  if (fetched.error) {
    pausedUntil.set(key, now + FAILURE_PAUSE_MS);
    reportSentError("sent-history.fetch", fetched.error, userId);
  }
  const written = await recordLabelled(userId, key, fetched.rows, now);
  if (written === null) return 0;
  if (listing.complete && !fetched.cut && written === fetched.rows.length) {
    await markImported(userId, inbox, now);
    console.log(`[SENT-HISTORY] import finished for ${userId} (${inbox})`);
  }
  return written;
}

/**
 * Label and write the rows; the number written, or null when the labels
 * could not be read (the inbox pauses and nothing is written unlabelled).
 */
async function recordLabelled(
  userId: string,
  key: string,
  rows: HistoryRow[],
  now: number,
): Promise<number | null> {
  let labels: Awaited<ReturnType<typeof classifySentRows>>;
  try {
    labels = await classifySentRows(
      userId,
      rows.map(({ gmailId, to, subject, sentAt, inbox }) => ({
        gmailId,
        to,
        subject,
        sentAt,
        inbox,
      })),
    );
  } catch (err) {
    pausedUntil.set(key, now + FAILURE_PAUSE_MS);
    reportSentError("sent-history.classify", err, userId);
    return null;
  }
  let written = 0;
  for (const row of rows) {
    const inferredOrigin = labels.get(row.gmailId);
    if (await recordSentMessage(userId, inferredOrigin ? { ...row, inferredOrigin } : row)) {
      written += 1;
      failedAttempts.delete(`${key}:${row.gmailId}`);
    }
  }
  return written;
}

async function markImported(userId: string, inbox: string, now: number): Promise<void> {
  const data = { sentHistoryImportedAt: new Date(now) };
  if (inbox === PRIMARY) {
    await prisma.userToken.updateMany({ where: { userId, provider: "google" }, data });
  } else {
    await prisma.linkedInboxAccount.updateMany({ where: { id: inbox, userId }, data });
  }
  const prefix = `${inboxKey(userId, inbox)}:`;
  for (const id of failedAttempts.keys()) if (id.startsWith(prefix)) failedAttempts.delete(id);
}
