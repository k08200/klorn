/**
 * What the IMAP poller does about UIDVALIDITY and about moves Klorn made itself
 * (step B2 of docs/providers/unified-platform-plan.md). Kept out of imap-sync.ts,
 * which owns the IMAP conversation; this owns the database consequences.
 *
 * UIDVALIDITY. A row's id is `<idPrefix>:<email>:<uid>`, and a UID names a message
 * only under the mailbox's UIDVALIDITY. The poller stores the INBOX value per
 * linked account, and on each cycle compares it with the server's:
 *   - none stored yet: record it (the baseline every action compares against);
 *   - unchanged: nothing;
 *   - changed: the server renumbered the mailbox, so every UID in this mailbox's
 *     rows is meaningless, and worse, dedup by key would skip a NEW message that
 *     reuses an old message's UID. The mailbox's local rows are a mirror of the
 *     server, so they are retired (deleted) and the window is ingested again under
 *     its new numbers; then the new value is stored. The deletion comes FIRST and
 *     a failure aborts the poll before the value is stored, so the next cycle sees
 *     the same change and retries. Move records made in the last few minutes are
 *     dropped too: their INBOX ids are old numbers, and the race cleanup below would
 *     delete a new message that reuses one. Only rows whose id carries this
 *     mailbox's prefix and address are retired; another account, another provider
 *     and Gmail rows are never touched.
 *   - the server reported no usable value: do nothing. Actions refuse such a
 *     mailbox, because they cannot vouch for a UID.
 *
 * Racing moves. A poll reads its window, then persists each message. A message
 * Klorn moved out of INBOX in between is written back as a fresh row for a message
 * that is no longer there. After the window is persisted, rows for INBOX ids Klorn
 * moved out within the last few minutes are removed again, so the race heals
 * within the same cycle (and, if the move lands even later, in the next one).
 */

import { imapMoveActionsEnabled } from "../config.js";
import { prisma } from "../db.js";
import { resolveAttentionForDeletedEmails } from "./attention-cleanup.js";
import type { ImapProviderConfig } from "./imap-providers.js";
import { classifyPollValidity, type PollValidity } from "./imap-uidvalidity.js";
import { describeFailure } from "./providers/action-failure.js";
import { forgetRecentMoves, recentlyMovedSourceIds } from "./providers/imap-moved.js";

export interface ReconcileArgs {
  provider: ImapProviderConfig;
  userId: string;
  email: string;
  linkedInboxAccountId: string;
  /** The value stored on the account row, or null/undefined when none is. */
  stored: string | null | undefined;
  /** The value the server reported for INBOX, canonical, or null when unusable. */
  live: string | null;
}

async function storeValidity(args: ReconcileArgs): Promise<void> {
  await prisma.linkedInboxAccount.updateMany({
    where: { id: args.linkedInboxAccountId, userId: args.userId },
    data: { inboxUidValidity: args.live },
  });
}

/** Retire this mailbox's local rows, then store the new value. Throws on any failure. */
async function retireAndRebaseline(args: ReconcileArgs): Promise<void> {
  const { provider, userId, email, linkedInboxAccountId } = args;
  const where = { userId, gmailId: { startsWith: `${provider.idPrefix}:${email}:` } };
  // Resolve the attention items of the rows about to go, as the Gmail reconcile
  // does, so no OPEN item is orphaned next to the fresh one the re-ingest creates.
  const stale = await prisma.emailMessage.findMany({ where, select: { id: true } });
  await resolveAttentionForDeletedEmails(
    userId,
    stale.map((row) => row.id),
  );
  const retired = await prisma.emailMessage.deleteMany({ where });
  // Records of moves made moments ago name INBOX ids under the OLD numbering; left in
  // place, the race cleanup would delete a new message that reuses one of them.
  await forgetRecentMoves({ userId, linkedInboxAccountId });
  await storeValidity(args);
  console.warn(
    `[${provider.logScope}] UIDVALIDITY changed for row ${linkedInboxAccountId} (stored ${args.stored}, live ${args.live}): retired ${retired.count} local rows; the window is ingested again`,
  );
}

/** Record or reconcile the INBOX UIDVALIDITY for one poll cycle. Throws only when a reset could not be applied. */
export async function reconcileInboxValidity(args: ReconcileArgs): Promise<PollValidity> {
  const verdict = classifyPollValidity(args.stored, args.live);
  if (verdict === "baseline") {
    try {
      await storeValidity(args);
    } catch (err) {
      // Not fatal: actions refuse this mailbox until a later poll stores it.
      console.warn(
        `[${args.provider.logScope}] could not store UIDVALIDITY for row ${args.linkedInboxAccountId}: ${describeFailure(err)}`,
      );
    }
  } else if (verdict === "reset") {
    await retireAndRebaseline(args);
  }
  return verdict;
}

/**
 * Remove rows the poll wrote back for messages Klorn moved out of INBOX a moment
 * ago. Does nothing while IMAP_MOVE_ACTIONS_ENABLED is off. Never throws: the next
 * cycle repeats it.
 */
export async function removeRecentlyMovedRows(scope: {
  userId: string;
  linkedInboxAccountId: string;
  provider: ImapProviderConfig;
}): Promise<number> {
  if (!imapMoveActionsEnabled()) return 0;
  try {
    const ids = await recentlyMovedSourceIds(scope);
    if (ids.length === 0) return 0;
    const { count } = await prisma.emailMessage.deleteMany({
      where: { userId: scope.userId, gmailId: { in: ids } },
    });
    return count;
  } catch (err) {
    console.warn(
      `[${scope.provider.logScope}] could not remove rows for recently moved messages (row ${scope.linkedInboxAccountId}): ${describeFailure(err)}`,
    );
    return 0;
  }
}
