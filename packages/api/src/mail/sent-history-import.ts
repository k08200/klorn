/**
 * Sent-history import (2026-11-01, docs/design/attention-engine-v3.md §3(2)).
 *
 * The 30-minute Sent scan (sent-messages.ts) reads only the newest page, so
 * the relationship snapshot cannot see anyone the user wrote to more than
 * ~50 sends ago. This imports, once per Google inbox the scan reads (the
 * primary account and every linked GOOGLE inbox), the newest SENT_HISTORY_CAP
 * sent mails of the last SENT_HISTORY_WINDOW_DAYS:
 *   - headers only (`format: "metadata"`, To / Subject / Date), never a body;
 *     `gmail.readonly` already covers it, so no new scope;
 *   - stateless: each run lists the window's ids (newest first, stopping at
 *     the cap) and fetches the oldest ones SentMessage does not have yet. The
 *     rows ARE the progress, so a crash or a redeploy resumes where it stopped,
 *     a gap the scan left (more than a page of sends while a token was dead) is
 *     filled, and no cursor or second-granular `before:` date is kept;
 *   - bounded: at most SENT_HISTORY_BATCH metadata fetches per run, two at a
 *     time (Gmail allows 250 quota units per user per second; a fetch costs 5),
 *     one run per user at a time and MAX_CONCURRENT_IMPORTS users at once;
 *   - finished once: when every listed id is recorded, the inbox's grant row
 *     gets `sentHistoryImportedAt` and is never listed again. A reconnect
 *     creates a new grant row, so a re-linked account is imported again;
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
import { Semaphore } from "../semaphore.js";
import { captureError } from "../sentry.js";
import { getAuthedClient, getAuthedInboxClient, isGoogleNotFoundError } from "./gmail.js";
import { recordSentMessage, type SentMessageInput } from "./sent-messages.js";
import { classifySentRows } from "./sent-origin-classifier.js";

type OAuth2 = InstanceType<typeof google.auth.OAuth2>;
type Gmail = ReturnType<typeof google.gmail>;

export const SENT_HISTORY_BACKFILL_FLAG = "SENT_HISTORY_BACKFILL_ENABLED";
export const SENT_HISTORY_WINDOW_DAYS = 365;
/** Newest sent mails considered per inbox (founder decision, 2026-11-01). */
export const SENT_HISTORY_CAP = 2_000;
/** Metadata fetches per run: one run per email-sync tick per user. */
export const SENT_HISTORY_BATCH = 100;
/** messages.list maximum; ids only, 5 quota units per page. */
const LIST_PAGE_SIZE = 500;
/** In-flight metadata fetches per import: at most ~10 units/s at Gmail's latency. */
const GET_CONCURRENCY = 2;
/** Detached work: a hung request must not hold an import slot forever. */
const GMAIL_CALL_TIMEOUT_MS = 20_000;
/** After a failed fetch (quota, network, auth) the user waits this long. */
const FAILURE_PAUSE_MS = 30 * 60_000;
const MAX_CONCURRENT_IMPORTS = 2;
const METADATA_HEADERS = ["To", "Subject", "Date"];
const DAY_MS = 86_400_000;
const PRIMARY = "primary";

const importing = new Set<string>();
const pausedUntil = new Map<string, number>();

/** Test seam — the guards are module state. */
export function resetSentHistoryImportForTests(): void {
  importing.clear();
  pausedUntil.clear();
}

/**
 * Import the next batch of one unfinished inbox. Safe to call every tick and
 * never throws. Returns the number of rows recorded.
 */
export async function importSentHistory(userId: string, now = Date.now()): Promise<number> {
  let claimed = false;
  try {
    if (!featureOpenTo(userId, [SENT_HISTORY_BACKFILL_FLAG])) return 0;
    if (importing.has(userId) || importing.size >= MAX_CONCURRENT_IMPORTS) return 0;
    if ((pausedUntil.get(userId) ?? 0) > now) return 0;
    importing.add(userId);
    claimed = true;
    return await importNextBatch(userId, now);
  } catch (err) {
    pause(userId, now, err);
    return 0;
  } finally {
    if (claimed) importing.delete(userId);
  }
}

function pause(userId: string, now: number, err: unknown): void {
  pausedUntil.set(userId, now + FAILURE_PAUSE_MS);
  console.warn("[SENT-HISTORY] batch failed:", err instanceof Error ? err.message : err);
  captureError(err, { tags: { scope: "sent-history.import" }, extra: { userId } });
}

/** Unfinished inboxes, primary first; "primary" or a LinkedInboxAccount id. */
async function pendingInboxes(userId: string): Promise<string[]> {
  const [token, linked] = await Promise.all([
    prisma.userToken.findFirst({
      where: { userId, provider: "google" },
      select: { sentHistoryImportedAt: true },
    }),
    prisma.linkedInboxAccount.findMany({
      where: { userId, provider: "GOOGLE", sentHistoryImportedAt: null },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const primary = token && token.sentHistoryImportedAt === null ? [PRIMARY] : [];
  return [...primary, ...linked.map((l) => l.id)];
}

async function importNextBatch(userId: string, now: number): Promise<number> {
  for (const inbox of await pendingInboxes(userId)) {
    const auth = await (inbox === PRIMARY
      ? getAuthedClient(userId)
      : getAuthedInboxClient(userId, inbox));
    // An unusable token (needs reconnect) must not stall the inboxes after it.
    if (!auth) continue;
    return importInboxBatch(userId, inbox, auth, now);
  }
  return 0;
}

async function importInboxBatch(
  userId: string,
  inbox: string,
  auth: OAuth2,
  now: number,
): Promise<number> {
  const gmail = google.gmail({ version: "v1", auth });
  const listing = await listMissing(gmail, userId, now);
  const { rows, failure } = await fetchHeaders(gmail, inbox, listing.missing);
  const labels = await classifySentRows(
    userId,
    rows.map(({ gmailId, to, subject, sentAt }) => ({ gmailId, to, subject, sentAt, inbox })),
  );
  for (const row of rows) {
    const inferredOrigin = labels.get(row.gmailId);
    await recordSentMessage(userId, inferredOrigin ? { ...row, inferredOrigin } : row);
  }
  if (failure) {
    pause(userId, now, failure);
  } else if (listing.complete) {
    await markImported(userId, inbox, now);
    console.log(`[SENT-HISTORY] import finished for ${userId} (${inbox})`);
  }
  return rows.length;
}

interface Listing {
  /** The oldest ids of the capped window not in SentMessage yet, at most SENT_HISTORY_BATCH. */
  missing: string[];
  /** `missing` is all of what is left. */
  complete: boolean;
}

async function listMissing(gmail: Gmail, userId: string, now: number): Promise<Listing> {
  const after = Math.floor((now - SENT_HISTORY_WINDOW_DAYS * DAY_MS) / 1000);
  const missing: string[] = [];
  let listed = 0;
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list(
      {
        userId: "me",
        q: `in:sent after:${after}`,
        maxResults: Math.min(LIST_PAGE_SIZE, SENT_HISTORY_CAP - listed),
        ...(pageToken ? { pageToken } : {}),
      },
      { timeout: GMAIL_CALL_TIMEOUT_MS },
    );
    const ids = (res.data.messages ?? []).flatMap((m) => (m.id ? [m.id] : []));
    listed += ids.length;
    missing.push(...(await notRecorded(userId, ids)));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && listed < SENT_HISTORY_CAP);
  // Gmail lists newest first; import oldest first. Where an unattended reply
  // and a manual one share a claim's window, the earlier is then recorded
  // before the later is classified (the classifier's one-row-per-claim rule).
  return {
    missing: [...missing].reverse().slice(0, SENT_HISTORY_BATCH),
    complete: missing.length <= SENT_HISTORY_BATCH,
  };
}

async function notRecorded(userId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const existing = await prisma.sentMessage.findMany({
    where: { userId, gmailId: { in: ids } },
    select: { gmailId: true },
  });
  const known = new Set(existing.map((r) => r.gmailId));
  return ids.filter((id) => !known.has(id));
}

type HistoryRow = Omit<SentMessageInput, "origin" | "inferredOrigin">;

/**
 * Headers of each id, two at a time. A message deleted since the listing (404)
 * is skipped; any other failure stops the batch and is returned, so the inbox
 * is not marked finished while something is still missing.
 */
async function fetchHeaders(
  gmail: Gmail,
  inbox: string,
  ids: string[],
): Promise<{ rows: HistoryRow[]; failure: unknown }> {
  const sem = new Semaphore(GET_CONCURRENCY);
  let failure: unknown = null;
  const rows = await sem.all<HistoryRow | null>(
    ids.map((id) => async () => {
      if (failure) return null;
      try {
        const res = await gmail.users.messages.get(
          { userId: "me", id, format: "metadata", metadataHeaders: METADATA_HEADERS },
          { timeout: GMAIL_CALL_TIMEOUT_MS },
        );
        return toHistoryRow(res.data, id, inbox);
      } catch (err) {
        if (!isGoogleNotFoundError(err)) failure ??= err;
        return null;
      }
    }),
  );
  return { rows: rows.filter((r): r is HistoryRow => r !== null), failure };
}

interface MetadataMessage {
  id?: string | null;
  threadId?: string | null;
  internalDate?: string | null;
  payload?: { headers?: { name?: string | null; value?: string | null }[] } | null;
}

function header(message: MetadataMessage, name: string): string {
  const headers = message.payload?.headers ?? [];
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * One row, dated like the Sent scan (Gmail's internalDate) so both write the
 * same sentAt; the Date header only when internalDate is missing. A message
 * with neither is skipped rather than recorded at the epoch.
 */
function toHistoryRow(message: MetadataMessage, id: string, inbox: string): HistoryRow | null {
  const internal = Number(message.internalDate);
  const sentAtMs = Number.isFinite(internal) ? internal : Date.parse(header(message, "Date"));
  if (!Number.isFinite(sentAtMs)) return null;
  return {
    gmailId: message.id ?? id,
    threadId: message.threadId ?? null,
    to: header(message, "To"),
    subject: header(message, "Subject"),
    sentAt: new Date(sentAtMs),
    inbox,
  };
}

async function markImported(userId: string, inbox: string, now: number): Promise<void> {
  const data = { sentHistoryImportedAt: new Date(now) };
  if (inbox === PRIMARY) {
    await prisma.userToken.updateMany({ where: { userId, provider: "google" }, data });
  } else {
    await prisma.linkedInboxAccount.updateMany({ where: { id: inbox, userId }, data });
  }
}
