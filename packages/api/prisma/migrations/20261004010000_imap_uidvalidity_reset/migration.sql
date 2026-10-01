-- IMAP UIDVALIDITY reset state (2026-09-30): step B2b of
-- docs/providers/unified-platform-plan.md. Additive only: three nullable columns on
-- "LinkedInboxAccount". Nothing is dropped, rewritten or backfilled.
--
-- Step B2 stored the INBOX UIDVALIDITY ("inboxUidValidity") and, when the server
-- reported a different value, only held: it changed nothing and every action refused
-- the mailbox. B2b repairs a reset without deleting anything, and to do that safely
-- it needs to remember what the poller has seen:
--   "inboxUidValidityPending"   a live value that differs from the stored one and has
--                               been seen on ONE poll so far. A reset is acted on only
--                               when the same new value is seen on a second, later poll.
--   "inboxUidValidityPendingAt" when that first sighting happened (two polls of the
--                               same instant, e.g. overlapping ticks, are not two).
--   "inboxUidValidityResetAt"   when the last reset was applied; at most one per
--                               account per 24 h.
-- TEXT for the value, for the reason "inboxUidValidity" is TEXT (an unsigned 32-bit
-- integer, compared only for equality). NULL for every existing row: no reset pending,
-- none ever applied.
--
-- Deploy overlap and rollback: migrations run at container start while the previous
-- release is still serving. That release never names these columns, so it is
-- unaffected, and the code can be rolled back with no schema step. Rolling back leaves
-- a pending value in place, which the old code ignores (it only holds on a reset).
--
-- Cost. ADD COLUMN with no default is metadata-only; nothing is rewritten.
-- Migrations run in a transaction, so no CONCURRENTLY; there is no index to build.

-- Fail fast instead of queueing behind a long transaction: a waiting ALTER on
-- "LinkedInboxAccount" would block every reader behind it. SET LOCAL lasts only for
-- this migration's transaction.
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "LinkedInboxAccount"
  ADD COLUMN "inboxUidValidityPending" TEXT,
  ADD COLUMN "inboxUidValidityPendingAt" TIMESTAMP(3),
  ADD COLUMN "inboxUidValidityResetAt" TIMESTAMP(3);
