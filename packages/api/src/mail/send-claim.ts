/**
 * The claim that makes the smart action's repeat check atomic (#1734 follow-up).
 *
 * The Send refuses "the same bytes to the same mail moments ago" as a repeat
 * (mail/reply-send.ts). That check reads SendReceipt; the request's own receipt
 * was written a provider round trip later. On its own the pair is
 * check-then-insert: two Sends fired together both read "nothing yet" and both
 * sent. So, with the provider calls already done, a request claims
 * (userId, emailId, payloadHash) here, runs the check and writes its receipt
 * while holding the claim, then releases it. A second request for the same
 * bytes meanwhile finds the claim held and is a repeat; one arriving after the
 * release finds the receipt.
 *
 * One atomic statement takes the claim, as for the scheduler lease
 * (scheduler-lease-store.ts): no session lock, so it does not matter which
 * pooled backend runs the claim or the release. The claim spans two database
 * statements and no provider call, so a claim older than SEND_CLAIM_STALE_MS
 * was left by a request that died before releasing, and is taken over.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { captureError } from "../sentry.js";

/**
 * A claim this old belongs to a request that died. It spans the repeat check
 * and the receipt insert only, each a single statement that queues ~10 s at
 * most for a pooled connection (db.ts), so two minutes is far past any live
 * holder, as for the scheduler lease's TTL; a crash blocks a retry no longer.
 */
export const SEND_CLAIM_STALE_MS = 2 * 60_000;

export interface SendClaimKey {
  userId: string;
  emailId: string;
  payloadHash: string;
}

export interface SendClaim extends SendClaimKey {
  token: string;
}

/**
 * Take the claim, or null when another request holds a live one. Takes over a
 * claim older than SEND_CLAIM_STALE_MS. Throws when the database does.
 */
export async function claimSend(key: SendClaimKey): Promise<SendClaim | null> {
  const token = randomUUID();
  const staleSeconds = SEND_CLAIM_STALE_MS / 1000;
  // clock_timestamp(), not now(): the time of this statement even inside a transaction.
  const rows = await prisma.$queryRaw<{ token: string }[]>`
    INSERT INTO "SendClaim" ("userId", "emailId", "payloadHash", "token", "claimedAt")
    VALUES (${key.userId}, ${key.emailId}, ${key.payloadHash}, ${token}, (clock_timestamp() AT TIME ZONE 'UTC'))
    ON CONFLICT ("userId", "emailId", "payloadHash") DO UPDATE
      SET "token" = EXCLUDED."token", "claimedAt" = EXCLUDED."claimedAt"
      WHERE "SendClaim"."claimedAt" < EXCLUDED."claimedAt" - make_interval(secs => ${staleSeconds}::double precision)
    RETURNING "token"`;
  return rows[0]?.token === token ? { ...key, token } : null;
}

/**
 * Release the claim. Only the holder's own row is deleted, so a late release
 * never frees a claim another request took over. Fail-soft: a miss leaves the
 * row to go stale (SEND_CLAIM_STALE_MS), and is reported.
 */
export async function releaseSend(claim: SendClaim): Promise<void> {
  try {
    await prisma.sendClaim.deleteMany({
      where: {
        userId: claim.userId,
        emailId: claim.emailId,
        payloadHash: claim.payloadHash,
        token: claim.token,
      },
    });
  } catch (err) {
    captureError(err, {
      tags: { scope: "send-claim.release" },
      extra: { userId: claim.userId, emailId: claim.emailId },
    });
  }
}
