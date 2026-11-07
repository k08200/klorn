/**
 * Sent messages + "waiting on" (2026-09-18): mail I sent that nobody has
 * answered. The other half of the reply axis (reply-state.ts is "do I owe
 * a reply"; this is "who owes me one") — Superhuman's "waiting on", Bond's
 * two-way tracking, Inbox Zero's Reply Zero.
 *
 * Two sources fill `SentMessage`:
 *   1. every send that goes out through Klorn (reply route, compose, the
 *      agent executor, auto replies, mailto unsubscribes) — recorded at send
 *      time with its `origin`, zero extra Gmail calls;
 *   2. a throttled scan of the Gmail Sent folder (every account, latest
 *      page, at most every 30 minutes per user) so mail sent from Gmail
 *      directly counts too;
 *   3. a one-time import of the last 12 months of the Sent folder
 *      (sent-history-import.ts, SENT_HISTORY_BACKFILL_ENABLED, default OFF).
 * Rows the scan or the import create are labelled by sent-origin-classifier.ts.
 *
 * "Waiting" = the latest thing I sent in a thread is at least `minDays`
 * old and no message from someone else arrived in that thread after it.
 * The local mirror is INBOX-only, so an answer that Gmail filed elsewhere
 * (archived by a filter) is not seen — a stated limit.
 */

import { prisma } from "../db.js";
import { senderEmail } from "../notify/notification-format.js";
import { listGmailMailbox, type MailboxItemWire } from "./gmail-mailbox.js";
import { UNKNOWN_DATE } from "./mailbox-dates.js";
import { reportSentError } from "./sent-errors.js";
import { clampSentField } from "./sent-fields.js";
import { classifySentRows } from "./sent-origin-classifier.js";

/**
 * Who sent a recorded mail:
 *   - "user": a manual send through Klorn;
 *   - "approved": the agent drafted it and the user approved these exact
 *     bytes (chat approve → outbox → executor);
 *   - "auto_reply": an autonomous reply the user never saw before it left;
 *   - "unsubscribe": a mailto unsubscribe request.
 * Null = seen only by the Sent-folder scan, with no proof that Klorn sent it
 * (counted as the user's own mail; legacy rows were labelled by migration
 * 20261101000000_sent_message_origin_backfill). Relationship evidence is null,
 * "user" and "approved"; "auto_reply" and "unsubscribe" never are.
 */
export type SentOrigin = "user" | "approved" | "auto_reply" | "unsubscribe";

export interface SentMessageInput {
  gmailId: string;
  threadId: string | null;
  to: string;
  subject: string;
  sentAt: Date;
  /** "primary" or a LinkedInboxAccount id — where a live read must go. */
  inbox: string;
  /** Set by Klorn's own send paths; the Sent-folder scan leaves it out. */
  origin?: SentOrigin;
  /**
   * Set by the Sent-folder scan and the history import from
   * sent-origin-classifier.ts: written when the row is created, never on
   * update, so it cannot overwrite a label recorded at send time.
   */
  inferredOrigin?: SentOrigin;
}

/**
 * Upsert one sent message. Fail-soft: a bookkeeping miss must never fail a
 * send that already went out, and the periodic scan re-records anyway.
 * A record without an origin (the scan) never writes one on update, so a
 * later scan cannot erase what Klorn recorded at send time. `to` and
 * `subject` are stored truncated to SENT_FIELD_MAX. Returns whether the row
 * was written.
 */
export async function recordSentMessage(userId: string, input: SentMessageInput): Promise<boolean> {
  const { origin, inferredOrigin, ...rest } = input;
  const fields = { ...rest, to: clampSentField(rest.to), subject: clampSentField(rest.subject) };
  const originField = origin ? { origin } : {};
  const createOrigin = origin ?? inferredOrigin;
  const createOriginField = createOrigin ? { origin: createOrigin } : {};
  const upsert = () =>
    prisma.sentMessage.upsert({
      where: { userId_gmailId: { userId, gmailId: fields.gmailId } },
      create: { ...fields, ...createOriginField, userId },
      update: {
        threadId: fields.threadId,
        to: fields.to,
        subject: fields.subject,
        sentAt: fields.sentAt,
        inbox: fields.inbox,
        ...originField,
      },
    });
  try {
    try {
      await upsert();
    } catch (err) {
      // The Sent scan can insert the same row between this upsert's read and
      // its insert. Once more: the row now exists, so the update path runs
      // and the origin still lands.
      if (!isUniqueConflict(err)) throw err;
      await upsert();
    }
    return true;
  } catch (err) {
    reportSentError("sent-messages.record", err, userId);
    return false;
  }
}

function isUniqueConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

const SENT_SYNC_INTERVAL_MS = 30 * 60_000;
const lastSentSyncAt = new Map<string, number>();

/** Which of these gmailIds the user already has a row for. */
export async function recordedGmailIds(userId: string, gmailIds: string[]): Promise<Set<string>> {
  if (gmailIds.length === 0) return new Set();
  const existing = await prisma.sentMessage.findMany({
    where: { userId, gmailId: { in: gmailIds } },
    select: { gmailId: true },
  });
  return new Set(existing.map((r) => r.gmailId));
}

type ScannedRow = Omit<SentMessageInput, "origin" | "inferredOrigin">;

function toScannedRow(item: MailboxItemWire): ScannedRow | null {
  const sentAt = new Date(item.receivedAt);
  // NaN, or the mailbox's "date unknown" epoch: never record a made-up sentAt.
  if (Number.isNaN(sentAt.getTime()) || sentAt.getTime() === UNKNOWN_DATE.getTime()) return null;
  return {
    gmailId: item.gmailId,
    threadId: item.threadId,
    to: clampSentField(item.to),
    subject: clampSentField(item.subject),
    sentAt,
    inbox: item.inbox,
  };
}

/**
 * Labels for the rows the scan is about to create, or null when they cannot be
 * read. The classifier is deliberately not behind the import's flag: a
 * Gmail-native mailto unsubscribe found by the scan is an unsubscribe too.
 */
async function labelFreshRows(
  userId: string,
  fresh: readonly ScannedRow[],
): Promise<Map<string, SentOrigin> | null> {
  if (fresh.length === 0) return new Map();
  try {
    return await classifySentRows(
      userId,
      fresh.map(({ gmailId, to, subject, sentAt, inbox }) => ({
        gmailId,
        to,
        subject,
        sentAt,
        inbox,
      })),
    );
  } catch (err) {
    reportSentError("sent-messages.classify", err, userId);
    return null;
  }
}

/**
 * Scan the Sent folder of every connected account (one page each) and
 * record what is there, labelling the rows it creates (sent-origin-classifier).
 * If the labels cannot be read, the rows already recorded are still updated
 * and the new ones wait for the next scan (they stay in the newest page): a
 * new row is never written unlabelled because of a classifier error.
 * Throttled per user so the scheduler can call it every tick. Returns the
 * number of rows written (0 when throttled, not connected, or failed —
 * failures are captured, never thrown).
 */
export async function syncSentMessages(userId: string, now = Date.now()): Promise<number> {
  const last = lastSentSyncAt.get(userId) ?? 0;
  if (now - last < SENT_SYNC_INTERVAL_MS) return 0;
  lastSentSyncAt.set(userId, now);
  try {
    const page = await listGmailMailbox(userId, "sent", undefined, "all");
    if (!page) return 0;
    const rows = page.items.flatMap((item) => toScannedRow(item) ?? []);
    const known = await recordedGmailIds(
      userId,
      rows.map((r) => r.gmailId),
    );
    const labels = await labelFreshRows(
      userId,
      rows.filter((r) => !known.has(r.gmailId)),
    );
    let written = 0;
    for (const row of rows) {
      const isNew = !known.has(row.gmailId);
      if (isNew && labels === null) continue;
      const inferredOrigin = isNew ? labels?.get(row.gmailId) : undefined;
      const ok = await recordSentMessage(userId, inferredOrigin ? { ...row, inferredOrigin } : row);
      if (ok) written += 1;
    }
    return written;
  } catch (err) {
    reportSentError("sent-messages.sync", err, userId);
    return 0;
  }
}

/** Test seam — the throttle is module state. */
export function resetSentSyncThrottleForTests(): void {
  lastSentSyncAt.clear();
}

export interface WaitingOnItem {
  gmailId: string;
  threadId: string;
  to: string;
  subject: string;
  /** ISO — when I sent it. */
  sentAt: string;
  daysWaiting: number;
  inbox: string;
}

export interface SentRow {
  gmailId: string;
  threadId: string | null;
  to: string;
  subject: string;
  sentAt: Date;
  inbox: string;
  origin?: string | null;
}

export interface ReplyRow {
  threadId: string | null;
  receivedAt: Date | null;
  from: string | null;
}

const DAY_MS = 86_400_000;

/**
 * The pure rule, exported for its tests. Per thread only the LATEST thing I
 * sent counts; a thread is waiting when that message is at least `minDays`
 * old and nothing from someone else arrived after it. Notes to myself and
 * my own copies (a CC to self) never count, and neither does a mailto
 * unsubscribe: no list answers one. Oldest wait first.
 */
export function computeWaitingOn(
  sent: readonly SentRow[],
  replies: readonly ReplyRow[],
  opts: { now: Date; minDays: number; userEmail: string | null },
): WaitingOnItem[] {
  const me = opts.userEmail?.trim().toLowerCase() || null;
  const latestByThread = new Map<string, SentRow>();
  for (const row of sent) {
    if (!row.threadId || row.origin === "unsubscribe") continue;
    const current = latestByThread.get(row.threadId);
    if (!current || row.sentAt > current.sentAt) latestByThread.set(row.threadId, row);
  }
  const cutoff = opts.now.getTime() - opts.minDays * DAY_MS;
  const out: WaitingOnItem[] = [];
  for (const row of latestByThread.values()) {
    if (row.sentAt.getTime() > cutoff) continue;
    const recipient = senderEmail(row.to).toLowerCase();
    if (!recipient || (me && recipient === me)) continue;
    const answered = replies.some(
      (reply) =>
        reply.threadId === row.threadId &&
        reply.receivedAt !== null &&
        reply.receivedAt > row.sentAt &&
        !(me && senderEmail(reply.from ?? "").toLowerCase() === me),
    );
    if (answered) continue;
    out.push({
      gmailId: row.gmailId,
      threadId: row.threadId as string,
      to: row.to,
      subject: row.subject,
      sentAt: row.sentAt.toISOString(),
      daysWaiting: Math.floor((opts.now.getTime() - row.sentAt.getTime()) / DAY_MS),
      inbox: row.inbox,
    });
  }
  return out.sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : 0));
}

export const WAITING_ON_DEFAULT_MIN_DAYS = 2;
const WAITING_ON_WINDOW_DAYS = 30;

/** Two queries (sent rows in the window, replies in those threads) + the rule. */
export async function waitingOnThreads(
  userId: string,
  opts: { minDays?: number; now?: Date } = {},
): Promise<WaitingOnItem[]> {
  const now = opts.now ?? new Date();
  const minDays = opts.minDays ?? WAITING_ON_DEFAULT_MIN_DAYS;
  const since = new Date(now.getTime() - WAITING_ON_WINDOW_DAYS * DAY_MS);
  const sent = await prisma.sentMessage.findMany({
    where: { userId, sentAt: { gte: since }, threadId: { not: null } },
    select: {
      gmailId: true,
      threadId: true,
      to: true,
      subject: true,
      sentAt: true,
      inbox: true,
      origin: true,
    },
  });
  if (!sent.length) return [];
  const threadIds = [...new Set(sent.map((s) => s.threadId).filter((t): t is string => !!t))];
  const [replies, user] = await Promise.all([
    prisma.emailMessage.findMany({
      where: { userId, threadId: { in: threadIds }, receivedAt: { gte: since } },
      select: { threadId: true, receivedAt: true, from: true },
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
  ]);
  return computeWaitingOn(sent, replies, { now, minDays, userEmail: user?.email ?? null });
}
