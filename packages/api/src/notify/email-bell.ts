/**
 * Settling the bell rows about one mail once the user opened it.
 *
 * Opening a mail from a device push, Today or the mail list never touched the
 * bell, so its urgent-mail row stayed unread until the user clicked that row or
 * hit "mark all read". The reader routes (GET /api/email/:id as an open,
 * PATCH /api/email/:id/read) now mark the rows that name the mail read. The
 * mail's own read state is untouched by an open: that one stays explicit.
 * Bulk mark-read from the mail list (routes/email-bulk.ts) is not an open and
 * leaves the bell alone.
 */

import { HIDDEN_CLAIM_TYPE } from "../agentcore/auto-reply-ledger-keys.js";
import { prisma } from "../db.js";
import { escapeLikePattern } from "../db-like.js";
import { captureError } from "../sentry.js";
import { URGENT_EMAIL_TITLES } from "./notification-strings.js";

export interface OpenedEmail {
  /** EmailMessage.id */
  id: string;
  /** The provider id the urgent-mail dedupe marker carries (Gmail id or IMAP key). */
  gmailId: string;
  createdAt: Date;
}

/**
 * Mark the user's unread bell rows about this mail read; returns how many.
 *
 * A row names the mail by sourceEmailId (every urgent-mail, candidate and
 * mail-reminder row written today). An urgent-mail row written before that
 * column names it only by its one-mail `[gmailId]` dedupe marker, counted from
 * the mail row's creation on, the floor the push dedupe uses for IMAP ids a
 * UIDVALIDITY repair can hand to a new message (firewall-push.ts). An
 * urgent-sweep batch row (`[a,b]`) names several mails: opening one of them is
 * not having seen the others, so it stays unread. Hidden claim rows are not
 * bell entries and are never touched.
 */
export async function markEmailBellRowsRead(userId: string, email: OpenedEmail): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: {
      userId,
      isRead: false,
      type: { not: HIDDEN_CLAIM_TYPE },
      OR: [
        { sourceEmailId: email.id },
        {
          type: "email",
          title: { in: [...URGENT_EMAIL_TITLES] },
          message: { endsWith: escapeLikePattern(`[${email.gmailId}]`) },
          createdAt: { gte: email.createdAt },
        },
      ],
    },
    data: { isRead: true },
  });
  return result.count;
}

/**
 * Fire-and-forget form for the reader routes: the response never waits on it
 * and never fails because of it, but a failed write is reported, not hidden.
 */
export function noteEmailBellRowsRead(userId: string, email: OpenedEmail): void {
  void markEmailBellRowsRead(userId, email).catch((err) => {
    console.warn(
      `[NOTIFY] could not mark bell rows read for email ${email.id}:`,
      err instanceof Error ? err.message : String(err),
    );
    captureError(err, {
      tags: { scope: "notifications.email-open-read" },
      extra: { userId, emailId: email.id },
    });
  });
}
