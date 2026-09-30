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
 *   - the server reported no usable value: nothing. Actions refuse such a mailbox,
 *     because they cannot vouch for a UID;
 *   - a different value, a RESET: the server renumbered the mailbox, so the UIDs in
 *     this mailbox's rows are stale. The poller HOLDS. It deletes nothing, resolves
 *     nothing, stores nothing and does not stop: it logs, reports ONE Sentry event
 *     per account and value, and ingests exactly as it did before B2. Because the
 *     stored value stays the old one, every action keeps refusing the mailbox
 *     (stored differs from live), so no stale UID is acted on.
 *
 * Why hold and not repair. Repairing means changing rows on a single observation of
 * one value, from a poller that may overlap itself and against a server that could
 * be flapping; deleting them would also take a user's review work (attachments,
 * candidate intakes, summaries, stars, replied state) with it. The repair that does
 * not destroy anything is step B2b of the plan (a guarded tombstone re-key). Until
 * it lands, a reset leaves the mailbox refusing actions and an operator decides.
 * The collision it would fix (a NEW message that reuses an old UID is deduped
 * against the stale row) exists on main and is unchanged.
 *
 * Racing moves. A poll reads its window, then persists each message. A message
 * Klorn moved out of INBOX in between is written back as a fresh row for a message
 * that is no longer there. After the window is persisted, rows for INBOX ids Klorn
 * moved out within the last few minutes are removed again, so the race heals
 * within the same cycle (and, if the move lands even later, in the next one). While
 * the mailbox is held that cleanup is skipped: its ids are old numbers, and it would
 * delete a new message that reuses one.
 */

import { imapMoveActionsEnabled } from "../config.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import type { ImapProviderConfig } from "./imap-providers.js";
import { classifyPollValidity, type PollValidity } from "./imap-uidvalidity.js";
import { describeFailure } from "./providers/action-failure.js";
import { recentlyMovedSourceIds } from "./providers/imap-moved.js";

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

/** `${rowId}:${live value}` of the resets already reported by this process. */
const reportedResets = new Set<string>();
/** Bound on the set above; past it the set is cleared and a reset may be reported again. */
const MAX_REPORTED_RESETS = 1000;

/** Test hook: forget which resets were reported. */
export function resetPollGuardState(): void {
  reportedResets.clear();
}

/**
 * A reset was observed: say so once per account and value, and change nothing. The
 * event carries the row id and the two numbers, never a message id or an address.
 */
function holdOnReset(args: ReconcileArgs): void {
  const { provider, userId, linkedInboxAccountId } = args;
  const key = `${linkedInboxAccountId}:${args.live}`;
  if (reportedResets.has(key)) return;
  if (reportedResets.size >= MAX_REPORTED_RESETS) reportedResets.clear();
  reportedResets.add(key);
  console.warn(
    `[${provider.logScope}] UIDVALIDITY changed for row ${linkedInboxAccountId} (stored ${args.stored}, live ${args.live}): holding — rows are left as they are and actions for this mailbox refuse until it is repaired`,
  );
  try {
    captureError(new Error(`${provider.logScope} UIDVALIDITY changed`), {
      tags: { scope: `${provider.logScope}.uidvalidity-reset` },
      extra: { userId, linkedInboxAccountId, stored: args.stored, live: args.live },
    });
  } catch (err) {
    console.warn(
      `[${provider.logScope}] could not report the UIDVALIDITY change: ${describeFailure(err)}`,
    );
  }
}

/** Record or check the INBOX UIDVALIDITY for one poll cycle. Never throws, never changes rows on a reset. */
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
    holdOnReset(args);
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
