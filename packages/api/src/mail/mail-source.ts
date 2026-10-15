/**
 * The one rule for "does this user have real mail?" — the gate between the
 * real (DB-backed) mail path and the no-connection answer.
 *
 * A source is ANY connected mailbox: the primary Google token, or any
 * LinkedInboxAccount row (a second Google account, Outlook, or an IMAP inbox —
 * iCloud, Naver, generic IMAP). The list, thread, stats and lane-count routes
 * all read EmailMessage rows by userId, so none of them needs Gmail itself.
 *
 * A linked row with needsReconnect: true still counts: its already-synced mail
 * is real and the user should see it (or an honest empty inbox), never someone
 * else's imaginary inbox. Empty and honest beats populated and false.
 *
 * Both lookups are scoped by userId — the only ownership boundary here. A DB
 * failure propagates (the route answers 500) rather than silently degrading
 * to the no-connection answer.
 */

import { prisma } from "../db.js";

export async function hasAnyMailSource(userId: string): Promise<boolean> {
  const [googleToken, linkedInbox] = await Promise.all([
    prisma.userToken.findFirst({
      where: { userId, provider: "google" },
      select: { id: true },
    }),
    prisma.linkedInboxAccount.findFirst({
      where: { userId },
      select: { id: true },
    }),
  ]);
  return googleToken !== null || linkedInbox !== null;
}
