-- AddColumn: durable "needs reconnect" flag for a linked secondary inbox. Set
-- when its token is found revoked/undecryptable; cleared on a successful refresh
-- or re-link. NOT NULL DEFAULT false — safe on a populated table (Postgres 11+
-- stores a constant default in the catalog, no table rewrite).
ALTER TABLE "LinkedInboxAccount" ADD COLUMN "needsReconnect" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex: the multi-inbox sync/reconcile queries filter EmailMessage by
-- (userId, linkedInboxAccountId) and sort the bounded read-status refresh by
-- receivedAt. Without this the linked scope is a residual filter over all of a
-- user's rows, degrading as a heavy user's mailbox grows across accounts.
--
-- Locking note (mirrors 20260625000000): Prisma runs each migration in a
-- transaction, which precludes CREATE INDEX CONCURRENTLY. The build takes a
-- SHARE lock on EmailMessage for its duration. This is cheap today —
-- MULTI_INBOX_SYNC_ENABLED is OFF, so linkedInboxAccountId is uniformly NULL and
-- the table is modest — and the migration runs once at deploy on the CURRENT
-- size. If EmailMessage is ever large at deploy time, pre-build the index
-- out-of-band first:  CREATE INDEX CONCURRENTLY "EmailMessage_userId_linkedInboxAccountId_receivedAt_idx"
-- ON "EmailMessage"("userId","linkedInboxAccountId","receivedAt");  — the
-- IF NOT EXISTS below then makes this migration a no-op instead of a write-lock.
CREATE INDEX IF NOT EXISTS "EmailMessage_userId_linkedInboxAccountId_receivedAt_idx" ON "EmailMessage"("userId", "linkedInboxAccountId", "receivedAt");
