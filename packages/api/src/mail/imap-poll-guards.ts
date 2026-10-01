/**
 * What the IMAP poller does about UIDVALIDITY and about moves Klorn made itself
 * (steps B2 and B2b of docs/providers/unified-platform-plan.md). Kept out of
 * imap-sync.ts, which owns the IMAP conversation; this owns the database
 * consequences.
 *
 * UIDVALIDITY. A row's id is `<idPrefix>:<email>:<uid>`, and a UID names a message
 * only under the mailbox's UIDVALIDITY. The poller stores the INBOX value per linked
 * account, and on each cycle compares it with the server's (imap-uidvalidity-reset.ts
 * decides the step):
 *   - none stored yet: record it (the baseline every action compares against);
 *   - unchanged: nothing (a pending reset is forgotten: the server flapped back);
 *   - the server reported no usable value: nothing. Actions refuse such a mailbox,
 *     because they cannot vouch for a UID;
 *   - a different value, a RESET: the server renumbered the mailbox, so the UIDs in
 *     this mailbox's rows are stale. The mailbox is HELD: the poll persists NOTHING
 *     for it and skips the moved-row cleanup, and every action refuses it (stored
 *     differs from live). Persisting would dedupe a new message that reuses an old UID
 *     into the stale row (B2 did: lost mail, wrong triage). A held poll does not
 *     count as a sync (imap-accounts.ts leaves lastSyncedAt alone), logs at most
 *     every 15 minutes and alerts Sentry at most once a day per account
 *     (imap-hold-state.ts). The first poll that sees the value remembers it; a later
 *     poll that sees the same value at least a minute later repairs, at most once per
 *     account per 24 h: one transaction moves the account to the new value (dated
 *     from the first sighting), resolves the mailbox's OPEN and SNOOZED attention
 *     items and re-keys its rows (`#uv<old>.<repair ms>`, imap-tombstone.ts). Nothing
 *     is deleted. A failed or timed-out repair rolls back, the mailbox stays held and
 *     the next attempt waits an exponential backoff. The next poll ingests the window
 *     under the new numbering; those rows are history (imap-history.ts: judged, but
 *     no push, no urgent alert, no unattended reply). Re-keyed rows stay visible, so
 *     a recent message can show twice (accepted, see the plan's B2b entry).
 *   - a pending reset with no usable live value: still held, pending kept as it is.
 *
 * Racing moves. A poll reads its window, then persists each message. A message
 * Klorn moved out of INBOX in between is written back as a fresh row for a message
 * that is no longer there. After the window is persisted, rows for INBOX ids Klorn
 * moved out within the last few minutes are removed again, so the race heals
 * within the same cycle (and, if the move lands even later, in the next one). While
 * the mailbox is held that cleanup does not run, and after a repair a move recorded
 * before it is ignored: its id is an old number that a new message may now carry.
 */

import type { Prisma } from "@prisma/client";
import { imapMoveActionsEnabled } from "../config.js";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";
import {
  clearRepairBackoff,
  heldAlertDue,
  heldWarnDue,
  noteRepairFailure,
  repairRetryAt,
  resetHoldState,
} from "./imap-hold-state.js";
import type { ImapProviderConfig } from "./imap-providers.js";
import {
  applyUidValidityRepair,
  holdsMailbox,
  nextResetStep,
  type ValidityState,
} from "./imap-uidvalidity-reset.js";
import { describeFailure, sanitizedError } from "./providers/action-failure.js";
import { recentlyMovedSourceIds } from "./providers/imap-moved.js";

export interface ReconcileArgs extends ValidityState {
  provider: ImapProviderConfig;
  userId: string;
  email: string;
  linkedInboxAccountId: string;
  /** The value the server reported for INBOX, canonical, or null when unusable. */
  live: string | null;
}

/** Whether the poll may persist this mailbox's window. */
export type PollGate = "ingest" | "hold";

/** Test hook: forget what this process remembers about held mailboxes. */
export function resetPollGuardState(): void {
  resetHoldState();
}

/** Report through Sentry; a reporting failure is logged, never thrown. */
function capture(args: ReconcileArgs, err: unknown, scope: string): void {
  const { provider, userId, linkedInboxAccountId, stored, live } = args;
  try {
    captureError(err, {
      tags: { scope: `${provider.logScope}.${scope}` },
      extra: { userId, linkedInboxAccountId, stored, live },
    });
  } catch (reportErr) {
    console.warn(`[${provider.logScope}] could not report ${scope}: ${describeFailure(reportErr)}`);
  }
}

/**
 * A poll that holds the mailbox: a log line at most every HELD_WARN_INTERVAL_MS and a
 * Sentry event at most every HELD_ALERT_INTERVAL_MS, per account, whatever the value,
 * so a hold that lasts days keeps being seen. Only the row id and the numbers are
 * written, never a message id or an address.
 */
function noteHeld(args: ReconcileArgs, now: Date, reason: string): void {
  const { provider, linkedInboxAccountId: rowId } = args;
  if (heldWarnDue(rowId, now)) {
    console.warn(
      `[${provider.logScope}] UIDVALIDITY changed for row ${rowId} (stored ${args.stored}, live ${args.live}, pending ${args.pending ?? "none"}): holding — nothing is stored for this mailbox and its actions refuse; ${reason}`,
    );
  }
  if (heldAlertDue("held", rowId, now)) {
    capture(args, new Error(`${provider.logScope} UIDVALIDITY changed`), "uidvalidity-reset");
  }
}

/** A database write of this cycle; a failure is logged and the next poll repeats it. */
async function write(
  args: ReconcileArgs,
  what: string,
  data: Prisma.LinkedInboxAccountUpdateManyMutationInput,
  where: Prisma.LinkedInboxAccountWhereInput = {},
): Promise<void> {
  try {
    await prisma.linkedInboxAccount.updateMany({
      where: { id: args.linkedInboxAccountId, userId: args.userId, ...where },
      data,
    });
  } catch (err) {
    console.warn(
      `[${args.provider.logScope}] could not ${what} for row ${args.linkedInboxAccountId}: ${describeFailure(err)}`,
    );
  }
}

/**
 * Run the repair, unless an earlier attempt failed and its backoff has not run out: a
 * repair that keeps failing or timing out must not take a pooled connection every poll.
 */
async function repair(args: ReconcileArgs, now: Date): Promise<void> {
  const { stored, live, pendingAt, linkedInboxAccountId: rowId, provider } = args;
  if (!stored || !live || !pendingAt) return; // nextResetStep never asks for this
  const retryAt = repairRetryAt(rowId);
  if (retryAt !== null && now.getTime() < retryAt) {
    noteHeld(
      args,
      now,
      `the last repair attempt did not complete; the next one runs after ${new Date(retryAt).toISOString()}`,
    );
    return;
  }
  try {
    const applied = await applyUidValidityRepair({ ...args, stored, live, pendingAt, now });
    clearRepairBackoff(rowId);
    if (applied) {
      console.warn(
        `[${provider.logScope}] UIDVALIDITY reset repaired for row ${rowId} (${stored} -> ${live}): old rows re-keyed, their open attention items resolved; the next poll ingests the new numbering`,
      );
    }
  } catch (err) {
    const next = new Date(noteRepairFailure(rowId, now)).toISOString();
    console.warn(
      `[${provider.logScope}] UIDVALIDITY repair failed for row ${rowId} (stored ${stored}, live ${live}), rolled back; holding, next attempt after ${next}: ${describeFailure(err)}`,
    );
    if (heldAlertDue("repair-failed", rowId, now)) {
      // Sanitized: a Prisma error can quote the colliding gmailId (an address).
      capture(args, sanitizedError(err), "uidvalidity-repair");
    }
  }
}

/**
 * Record or check the INBOX UIDVALIDITY for one poll cycle, and repair a confirmed
 * reset. Answers whether the poll may persist the window. Never throws.
 */
export async function reconcileInboxValidity(args: ReconcileArgs): Promise<PollGate> {
  const now = new Date();
  const step = nextResetStep(args, args.live, now);
  if (step === "baseline") {
    // Not fatal if it fails: actions refuse this mailbox until a later poll stores it.
    await write(args, "store UIDVALIDITY", { inboxUidValidity: args.live });
  } else if (step === "clear-pending") {
    clearRepairBackoff(args.linkedInboxAccountId);
    await write(args, "clear the pending UIDVALIDITY", {
      inboxUidValidityPending: null,
      inboxUidValidityPendingAt: null,
    });
  } else if (step === "note-pending") {
    noteHeld(
      args,
      now,
      "first sighting of this value; it is repaired once a later poll confirms it",
    );
    await write(
      args,
      "record the pending UIDVALIDITY",
      { inboxUidValidityPending: args.live, inboxUidValidityPendingAt: now },
      { inboxUidValidity: args.stored },
    );
  } else if (step === "wait") {
    noteHeld(
      args,
      now,
      args.live ? "waiting for a later sighting" : "the server reported no usable value",
    );
  } else if (step === "limited") {
    noteHeld(args, now, "confirmed, but at most one repair runs per account per 24 h");
  } else if (step === "repair") {
    await repair(args, now);
  }
  return holdsMailbox(step) ? "hold" : "ingest";
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
  /** The account's last UIDVALIDITY repair: moves recorded before it are ignored. */
  notBefore?: Date | null;
}): Promise<number> {
  if (!imapMoveActionsEnabled()) return 0;
  try {
    const ids = await recentlyMovedSourceIds(scope, scope.notBefore ?? null);
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
