/**
 * Replies the user sent from the mail provider itself (Gmail), stamped on the
 * judged mail they answered (DecisionLabel.providerRepliedAt), so the lane
 * report also sees users who keep answering mail in Gmail.
 *
 * Source: the Sent-folder scan (sent-messages.ts syncSentMessages) hands over
 * the rows it just created with no origin. A row Klorn sent was recorded at
 * send time with its origin, so the scan finds it already there; a row the
 * classifier labels (auto_reply, unsubscribe, approved) has an origin too.
 * The lookup below re-reads `origin: null` from the table, so a Klorn send
 * that recorded its origin while the scan ran is skipped as well. What is left
 * is a race of about a second per Klorn send, or a send whose record failed;
 * the report only counts a provider reply when Klorn recorded none for that
 * mail (lane-quality.ts), so a Klorn reply that slips through is not counted
 * twice.
 *
 * Match: the newest of the user's mail in the same Gmail thread and the same
 * account that arrived before the send, the mail a reply usually answers and
 * the one Klorn's own reply route stamps. A forward kept in the thread counts
 * too (Gmail does not tell them apart without reading headers). The user's
 * own copies in the mirror (a note to self carries SENT) are never targets.
 * The stamp time is the send's sentAt, so "replied within 24h" measures the
 * real delay, and the ledger refuses a time before the judgement
 * (stampProviderEngagement), which also bounds a sender's forged Date header.
 *
 * Never throws: this runs inside the scan, and a ledger miss must not fail it.
 */

import { prisma } from "../db.js";
import { stampProviderEngagement } from "../judge/decision-label.js";
import { reportSentError } from "./sent-errors.js";

export interface ProviderSend {
  threadId: string;
  /** "primary" or a LinkedInboxAccount id — Gmail thread ids are per account. */
  inbox: string;
  sentAt: Date;
}

export interface ThreadMail {
  id: string;
  threadId: string | null;
  receivedAt: Date;
  /** Null = the primary account. */
  linkedInboxAccountId: string | null;
}

export interface ReplyStamp {
  at: Date;
  emailId: string;
}

const inboxOf = (mail: ThreadMail): string => mail.linkedInboxAccountId ?? "primary";

/** The newest mail of the send's thread and account that arrived before it. */
function answeredBy(send: ProviderSend, mails: readonly ThreadMail[]): ThreadMail | null {
  let newest: ThreadMail | null = null;
  for (const mail of mails) {
    const before = mail.receivedAt.getTime() < send.sentAt.getTime();
    if (mail.threadId !== send.threadId || inboxOf(mail) !== send.inbox || !before) continue;
    if (!newest || mail.receivedAt > newest.receivedAt) newest = mail;
  }
  return newest;
}

/**
 * For each send, oldest first, the mail it answered (answeredBy). Sends that
 * answer nothing are left out. Oldest first because the ledger keeps the first
 * stamp, so a mail's earliest reply is the one recorded. Pure.
 */
export function matchProviderReplies(
  sends: readonly ProviderSend[],
  mails: readonly ThreadMail[],
): ReplyStamp[] {
  return [...sends]
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
    .flatMap((send) => {
      const mail = answeredBy(send, mails);
      return mail ? [{ at: send.sentAt, emailId: mail.id }] : [];
    });
}

/**
 * Stamp providerRepliedAt for the scan rows `gmailIds` that are the user's own
 * sends. Every query carries the userId, so a thread id shared with another
 * user's mailbox reaches nothing of theirs.
 */
export async function noteProviderReplies(
  userId: string,
  gmailIds: readonly string[],
): Promise<void> {
  if (gmailIds.length === 0) return;
  try {
    const rows = await prisma.sentMessage.findMany({
      where: { userId, gmailId: { in: [...gmailIds] }, origin: null, threadId: { not: null } },
      select: { threadId: true, inbox: true, sentAt: true },
    });
    const sends = rows.flatMap((row) => (row.threadId ? [{ ...row, threadId: row.threadId }] : []));
    if (sends.length === 0) return;
    const mails = await prisma.emailMessage.findMany({
      where: {
        userId,
        threadId: { in: [...new Set(sends.map((s) => s.threadId))] },
        NOT: { labels: { has: "SENT" } },
      },
      select: { id: true, threadId: true, receivedAt: true, linkedInboxAccountId: true },
    });
    for (const stamp of matchProviderReplies(sends, mails)) {
      await stampProviderEngagement(userId, "REPLIED", [stamp.emailId], stamp.at);
    }
  } catch (err) {
    // Name and code only: a Prisma message can quote the query's values.
    reportSentError("provider-replies.lookup", err, userId);
  }
}
