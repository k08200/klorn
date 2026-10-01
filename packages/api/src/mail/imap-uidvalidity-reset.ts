/**
 * Repairing an IMAP UIDVALIDITY reset (step B2b of
 * docs/providers/unified-platform-plan.md). Step B2 only held: it stored nothing and
 * every action refused the mailbox. This decides when a reset is real and repairs it
 * without deleting anything. The poller's side (what a poll does with each step) is
 * imap-poll-guards.ts.
 *
 * When. One observation of one value could be a glitch, a flapping server or a
 * half-restored mailbox, and a repair re-keys rows and resolves attention items, so:
 *   1. the first poll that sees a usable value other than the stored one REMEMBERS it
 *      (`inboxUidValidityPending`, `inboxUidValidityPendingAt`) and changes no row;
 *   2. a later poll that sees the SAME value, at least MIN_SIGHTING_GAP_MS after the
 *      first sighting, repairs. Overlapping polls of one tick are not two sightings;
 *   3. seeing the stored value again discards the pending value; a third value
 *      replaces it (and restarts the clock); a poll with no usable value leaves it;
 *   4. at most one repair per account per RESET_LIMIT_WINDOW_MS
 *      (`inboxUidValidityResetAt`); inside that window the mailbox stays held.
 * While a reset is pending, limited or being repaired, the poll persists nothing for
 * the mailbox, so every row with its id prefix is a row of the old numbering.
 *
 * How. ONE transaction, with an explicit timeout:
 *   a. claim: a conditional updateMany that only matches the account in exactly the
 *      state this poll decided on (stored value, pending value, pending time, no repair
 *      inside the window) and moves it to the new value. A count other than 1 means
 *      another poll won or the state moved: nothing else runs;
 *   b. resolve the OPEN and SNOOZED attention items of the mailbox's rows;
 *   c. re-key those rows with one raw UPDATE (imap-tombstone.ts): `#uv<old>` is
 *      appended to `gmailId`, the row id stays.
 * Any failure, a unique collision included, rolls all three back and the mailbox
 * stays held (the caller reports it once). The next ordinary poll then ingests the
 * window under the new numbering.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { imapMessageIdHead } from "./imap-message-id.js";
import type { ImapProviderConfig } from "./imap-providers.js";
import {
  isTombstonedId,
  TOMBSTONE_MARKER,
  tombstoneRekeyStatement,
  tombstoneSuffix,
} from "./imap-tombstone.js";
import { classifyPollValidity } from "./imap-uidvalidity.js";

/** The second sighting must come at least this long after the first. */
export const MIN_SIGHTING_GAP_MS = 60_000;
/** At most one repair per account within this window. */
export const RESET_LIMIT_WINDOW_MS = 24 * 60 * 60_000;
/** The repair transaction's own limit (Prisma's default is 5 s). */
export const REPAIR_TX_TIMEOUT_MS = 30_000;
/** How long the repair may wait for a connection to start its transaction. */
const REPAIR_TX_MAX_WAIT_MS = 10_000;
/** Attention items resolved per statement (the bind-parameter cap). */
const ATTENTION_CHUNK = 1_000;

/** What the account row says, as this poll read it. */
export interface ValidityState {
  stored: string | null | undefined;
  pending: string | null | undefined;
  pendingAt: Date | null | undefined;
  resetAt: Date | null | undefined;
}

/**
 * What one poll does with the value the server just reported:
 *   none           nothing to record; ingest
 *   baseline       record the first value; ingest
 *   clear-pending  the stored value is back: forget the pending one; ingest
 *   note-pending   a first sighting (or a third value): remember it; hold
 *   wait           a reset is pending but not confirmed yet; hold
 *   limited        confirmed, but a repair ran inside the window; hold
 *   repair         confirmed: run the repair transaction; hold
 */
export type ResetStep =
  | "none"
  | "baseline"
  | "clear-pending"
  | "note-pending"
  | "wait"
  | "limited"
  | "repair";

export function nextResetStep(state: ValidityState, live: string | null, now: Date): ResetStep {
  const verdict = classifyPollValidity(state.stored, live);
  if (verdict === "unknown") return state.pending ? "wait" : "none";
  if (verdict === "baseline") return "baseline";
  if (verdict === "same") return state.pending ? "clear-pending" : "none";
  if (live !== state.pending || !state.pendingAt) return "note-pending";
  if (now.getTime() - state.pendingAt.getTime() < MIN_SIGHTING_GAP_MS) return "wait";
  if (state.resetAt && now.getTime() - state.resetAt.getTime() <= RESET_LIMIT_WINDOW_MS) {
    return "limited";
  }
  return "repair";
}

/** Whether a poll that took this step must persist nothing for the mailbox. */
export function holdsMailbox(step: ResetStep): boolean {
  return step === "note-pending" || step === "wait" || step === "limited" || step === "repair";
}

export interface RepairArgs {
  provider: ImapProviderConfig;
  userId: string;
  /** The mailbox address the row ids were minted with (the account row's). */
  email: string;
  linkedInboxAccountId: string;
  stored: string;
  live: string;
  /** The pending sighting time this poll read; the claim requires it unchanged. */
  pendingAt: Date;
  now: Date;
}

/** a. Move the account to the new value, only from the state this poll decided on. */
async function claimRepair(tx: Prisma.TransactionClient, args: RepairArgs): Promise<boolean> {
  const limitStart = new Date(args.now.getTime() - RESET_LIMIT_WINDOW_MS);
  const { count } = await tx.linkedInboxAccount.updateMany({
    where: {
      id: args.linkedInboxAccountId,
      userId: args.userId,
      inboxUidValidity: args.stored,
      inboxUidValidityPending: args.live,
      inboxUidValidityPendingAt: args.pendingAt,
      OR: [{ inboxUidValidityResetAt: null }, { inboxUidValidityResetAt: { lt: limitStart } }],
    },
    data: {
      inboxUidValidity: args.live,
      inboxUidValidityPending: null,
      inboxUidValidityPendingAt: null,
      inboxUidValidityResetAt: args.now,
    },
  });
  return count === 1;
}

/** b. Resolve the OPEN and SNOOZED attention items of the rows about to be re-keyed. */
async function resolveMailboxAttention(
  tx: Prisma.TransactionClient,
  args: RepairArgs,
): Promise<void> {
  const head = imapMessageIdHead(args.provider.idPrefix, args.email);
  const rows = await tx.emailMessage.findMany({
    where: {
      userId: args.userId,
      gmailId: { startsWith: head },
      NOT: { gmailId: { contains: TOMBSTONE_MARKER } },
    },
    select: { id: true, gmailId: true },
  });
  // The exact prefix test again in code: the same set the re-key's starts_with
  // matches, whatever LIKE would make of a `_` in the address.
  const ids = rows
    .filter((row) => row.gmailId.startsWith(head) && !isTombstonedId(row.gmailId))
    .map((row) => row.id);
  for (let i = 0; i < ids.length; i += ATTENTION_CHUNK) {
    await tx.attentionItem.updateMany({
      where: {
        userId: args.userId,
        source: "EMAIL",
        sourceId: { in: ids.slice(i, i + ATTENTION_CHUNK) },
        status: { in: ["OPEN", "SNOOZED"] },
      },
      data: { status: "RESOLVED", resolvedAt: args.now },
    });
  }
}

/**
 * Run the repair transaction. Resolves true when this poll applied it, false when the
 * claim matched nothing (another poll won, or the state moved since it was read).
 * Rejects when the transaction failed; everything is rolled back then.
 */
export async function applyUidValidityRepair(args: RepairArgs): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      if (!(await claimRepair(tx, args))) return false;
      await resolveMailboxAttention(tx, args);
      await tx.$executeRaw(
        tombstoneRekeyStatement({
          userId: args.userId,
          prefix: imapMessageIdHead(args.provider.idPrefix, args.email),
          suffix: tombstoneSuffix(args.stored),
          now: args.now,
        }),
      );
      return true;
    },
    { timeout: REPAIR_TX_TIMEOUT_MS, maxWait: REPAIR_TX_MAX_WAIT_MS },
  );
}
