/**
 * Sent messages + "waiting on" (2026-09-18): mail I sent that nobody has
 * answered. The other half of the reply axis (reply-state.ts is "do I owe
 * a reply"; this is "who owes me one") — Superhuman's "waiting on", Bond's
 * two-way tracking, Inbox Zero's Reply Zero.
 *
 * Two sources fill `SentMessage`:
 *   1. every send that goes out through Klorn (reply route, compose) —
 *      recorded at send time, zero extra Gmail calls;
 *   2. a throttled scan of the Gmail Sent folder (every account, latest
 *      page, at most every 30 minutes per user) so mail sent from Gmail
 *      directly counts too.
 *
 * "Waiting" = the latest thing I sent in a thread is at least `minDays`
 * old and no message from someone else arrived in that thread after it.
 * The local mirror is INBOX-only, so an answer that Gmail filed elsewhere
 * (archived by a filter) is not seen — a stated limit.
 */

import { prisma } from "../db.js";
import { senderEmail } from "../notify/notification-format.js";
import { captureError } from "../sentry.js";
import { listGmailMailbox } from "./gmail-mailbox.js";

export interface SentMessageInput {
  gmailId: string;
  threadId: string | null;
  to: string;
  subject: string;
  sentAt: Date;
  /** "primary" or a LinkedInboxAccount id — where a live read must go. */
  inbox: string;
}

/**
 * Upsert one sent message. Fail-soft: a bookkeeping miss must never fail a
 * send that already went out, and the periodic scan re-records anyway.
 */
export async function recordSentMessage(userId: string, input: SentMessageInput): Promise<void> {
  try {
    await prisma.sentMessage.upsert({
      where: { userId_gmailId: { userId, gmailId: input.gmailId } },
      create: { userId, ...input },
      update: {
        threadId: input.threadId,
        to: input.to,
        subject: input.subject,
        sentAt: input.sentAt,
        inbox: input.inbox,
      },
    });
  } catch (err) {
    console.warn("[SENT] record failed:", err instanceof Error ? err.message : err);
    captureError(err, { tags: { scope: "sent-messages.record" }, extra: { userId } });
  }
}

const SENT_SYNC_INTERVAL_MS = 30 * 60_000;
const lastSentSyncAt = new Map<string, number>();

/**
 * Scan the Sent folder of every connected account (one page each) and
 * record what is there. Throttled per user so the scheduler can call it
 * every tick. Returns the number of rows recorded (0 when throttled, not
 * connected, or failed — failures are captured, never thrown).
 */
export async function syncSentMessages(userId: string, now = Date.now()): Promise<number> {
  const last = lastSentSyncAt.get(userId) ?? 0;
  if (now - last < SENT_SYNC_INTERVAL_MS) return 0;
  lastSentSyncAt.set(userId, now);
  try {
    const page = await listGmailMailbox(userId, "sent", undefined, "all");
    if (!page) return 0;
    for (const row of page.items) {
      await recordSentMessage(userId, {
        gmailId: row.gmailId,
        threadId: row.threadId,
        to: row.to,
        subject: row.subject,
        sentAt: new Date(row.receivedAt),
        inbox: row.inbox,
      });
    }
    return page.items.length;
  } catch (err) {
    console.warn("[SENT] sync failed:", err instanceof Error ? err.message : err);
    captureError(err, { tags: { scope: "sent-messages.sync" }, extra: { userId } });
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
 * my own copies (a CC to self) never count. Oldest wait first.
 */
export function computeWaitingOn(
  sent: readonly SentRow[],
  replies: readonly ReplyRow[],
  opts: { now: Date; minDays: number; userEmail: string | null },
): WaitingOnItem[] {
  const me = opts.userEmail?.trim().toLowerCase() || null;
  const latestByThread = new Map<string, SentRow>();
  for (const row of sent) {
    if (!row.threadId) continue;
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
    select: { gmailId: true, threadId: true, to: true, subject: true, sentAt: true, inbox: true },
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
