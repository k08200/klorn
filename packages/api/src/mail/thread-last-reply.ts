/**
 * When the user last answered each thread: a reply through Klorn
 * (EmailMessage.repliedAt), a provider reply stamp or a Klorn reply on the
 * decision ledger, or a Sent-folder row in the thread since `since`. Shared by
 * the evening review and meeting prep, which both ask "is this mail still
 * waiting on the user?".
 */

import { prisma } from "../db.js";

/** The fields of a mail the answer needs. */
export interface ThreadMail {
  readonly id: string;
  readonly threadId: string | null;
}

/** Latest time the user answered each thread: Klorn, provider and Sent-folder records. */
export async function lastReplyByThread(
  userId: string,
  mails: readonly ThreadMail[],
  ledger: ReadonlyMap<string, { repliedAt: Date | null; providerRepliedAt: Date | null }>,
  repliedAt: ReadonlyMap<string, Date | null>,
  since: Date,
): Promise<Map<string, number>> {
  const latest = new Map<string, number>();
  const note = (thread: string, at: Date | null | undefined) => {
    if (at && at.getTime() > (latest.get(thread) ?? 0)) latest.set(thread, at.getTime());
  };
  for (const mail of mails) {
    const thread = mail.threadId ?? mail.id;
    note(thread, repliedAt.get(mail.id));
    note(thread, ledger.get(mail.id)?.repliedAt);
    note(thread, ledger.get(mail.id)?.providerRepliedAt);
  }
  const threadIds = [...new Set(mails.flatMap((m) => (m.threadId ? [m.threadId] : [])))];
  if (threadIds.length > 0) {
    const sent = await prisma.sentMessage.findMany({
      where: { userId, threadId: { in: threadIds }, sentAt: { gte: since } },
      select: { threadId: true, sentAt: true },
    });
    for (const row of sent) if (row.threadId) note(row.threadId, row.sentAt);
  }
  return latest;
}
