-- Send claim (2026-11-13). See src/mail/send-claim.ts.
--
-- The smart action's Send refuses "the same bytes to the same mail moments
-- ago" as a repeat. That check read SendReceipt and, a provider round trip
-- later, wrote the request's own receipt, so two Sends fired together both read
-- "nothing yet" and both sent. A request now holds a row here, keyed by
-- (userId, emailId, payloadHash), while it checks and writes its receipt. One
-- atomic INSERT ... ON CONFLICT decides who holds it, whichever pooled backend
-- runs it; the holder deletes it (by token) once the receipt is written or
-- refused, and a row older than the repeat window is a dead holder's and is
-- taken over. No content: the mail id and the payload hash only.
--
-- EXPAND ONLY: a new, empty table nothing reads yet. The previous instance
-- keeps sending without it during the swap. The foreign key takes SHARE ROW
-- EXCLUSIVE on "User" for the length of the transaction; lock_timeout makes a
-- deploy blocked by a long transaction fail fast instead of queueing writes
-- behind it. If it fails on lock_timeout, Prisma records the migration as
-- failed: run `prisma migrate resolve --rolled-back 20261113000000_send_claim`
-- and redeploy.
--
-- Row-level security in the form every per-user table has (docs/rls-rollout.md).
-- Not in the data-wipe fence (privacy/data-wipe-fence.ts UNFENCED_MODELS): the
-- row lives only until its receipt is written, and that receipt insert is
-- fenced. The rows go with their user (the foreign key cascades) and with a
-- data wipe (purge-user-data.ts).
SET LOCAL lock_timeout = '5s';

CREATE TABLE "SendClaim" (
    "userId" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SendClaim_pkey" PRIMARY KEY ("userId","emailId","payloadHash")
);

ALTER TABLE "SendClaim" ADD CONSTRAINT "SendClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SendClaim" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SendClaim_tenant_isolation" ON "SendClaim" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "SendClaim_system_bypass" ON "SendClaim" USING (current_setting('app.bypass_rls', true) = 'on');
