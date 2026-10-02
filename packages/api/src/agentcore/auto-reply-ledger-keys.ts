/**
 * The at-most-once claim for an unattended reply.
 *
 * One Notification row per mail, unique on (userId, dedupeKey), is written
 * BEFORE a send and kept — as a failure record if the send did not go through —
 * afterwards. The AUTO_REPLY rule sweep and the auto-mode sweep claim the SAME
 * key, so whichever path claims first wins atomically (the other gets P2002
 * and never sends), even when two cycles overlap.
 *
 * Rows written by older versions under the `auto-mode-reply:` key still read
 * as claims.
 */

const CLAIM_PREFIX = "auto-reply:";
const LEGACY_AUTO_MODE_PREFIX = "auto-mode-reply:";

/** The key new claims are written under (both paths). */
export function replyLedgerKey(gmailId: string): string {
  return `${CLAIM_PREFIX}${gmailId}`;
}

/** Every key that reads as "an unattended reply already claimed this mail". */
export function replyLedgerKeys(gmailId: string): string[] {
  return [replyLedgerKey(gmailId), `${LEGACY_AUTO_MODE_PREFIX}${gmailId}`];
}

/**
 * Notification.type of a claim the bell must not list: one still in flight
 * (nothing is settled yet) or one whose bell entry the user cleared. The row
 * is kept either way — deleting it would release the lock.
 */
export const HIDDEN_CLAIM_TYPE = "claim";

/** Prisma filter matching claim rows in any state (sent, failed, hidden). */
export const REPLY_CLAIM_ROWS = {
  OR: [
    { dedupeKey: { startsWith: CLAIM_PREFIX } },
    { dedupeKey: { startsWith: LEGACY_AUTO_MODE_PREFIX } },
  ],
};
