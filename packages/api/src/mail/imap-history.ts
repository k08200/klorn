/**
 * Re-ingested history after an IMAP UIDVALIDITY repair (step B2b of
 * docs/providers/unified-platform-plan.md).
 *
 * A repair re-keys the mailbox's rows (imap-tombstone.ts) and the next poll ingests the
 * INBOX window again, as NEW rows. That mail is not new to the user: it was notified,
 * maybe answered, under the old rows. So those rows are stored and judged like any
 * other, but they get no PUSH, no urgent-sweep notification and no unattended reply.
 * A row is history when
 *   - its id ends in a tombstone suffix (the re-keyed old row itself), or
 *   - it is an IMAP row whose linked account has `inboxUidValidityResetAt` set (the
 *     first sighting of the reset) and it was received before that instant. Mail
 *     received during the hold keeps its side effects.
 * `receivedAt` comes from the message's Date header, which the sender controls, so a
 * mis-dated message can land on the wrong side of the cutoff. Accepted.
 *
 * Gmail and Outlook ids are never history and cost no query: callers can run every
 * row through here and the Gmail path reads exactly what it read before.
 */

import { prisma } from "../db.js";
import { isImapMessageId } from "./imap-message-id.js";
import { isTombstonedId } from "./imap-tombstone.js";

export interface HistoryCandidate {
  id: string;
  gmailId: string;
  receivedAt: Date;
  linkedInboxAccountId?: string | null;
}

/** Whether a row is history, given its linked account's reset time (null = never reset). */
export function isReingestedHistory(
  row: Pick<HistoryCandidate, "gmailId" | "receivedAt">,
  resetAt: Date | null | undefined,
): boolean {
  if (isTombstonedId(row.gmailId)) return true;
  if (!isImapMessageId(row.gmailId) || !resetAt) return false;
  return row.receivedAt.getTime() < resetAt.getTime();
}

/**
 * The ids of the rows that are history. One query for the reset times of every
 * linked account among the IMAP rows, none when there is no IMAP row.
 */
export async function findReingestedHistory(
  userId: string,
  rows: readonly HistoryCandidate[],
): Promise<Set<string>> {
  const accountIds = [
    ...new Set(
      rows
        .filter((row) => isImapMessageId(row.gmailId) && !isTombstonedId(row.gmailId))
        .map((row) => row.linkedInboxAccountId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const resetAt = new Map<string, Date>();
  if (accountIds.length > 0) {
    const accounts = await prisma.linkedInboxAccount.findMany({
      where: { userId, id: { in: accountIds }, inboxUidValidityResetAt: { not: null } },
      select: { id: true, inboxUidValidityResetAt: true },
    });
    for (const account of accounts) {
      if (account.inboxUidValidityResetAt) resetAt.set(account.id, account.inboxUidValidityResetAt);
    }
  }
  return new Set(
    rows
      .filter((row) =>
        isReingestedHistory(
          row,
          row.linkedInboxAccountId ? resetAt.get(row.linkedInboxAccountId) : null,
        ),
      )
      .map((row) => row.id),
  );
}
