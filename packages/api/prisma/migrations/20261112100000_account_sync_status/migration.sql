-- Account Health (Settings -> Accounts): per-mailbox sync status.
--   LinkedInboxAccount.syncErrorCode  why the last poll failed, as a short code
--                                     ("auth" | "unreachable" | "throttled" | "error"),
--                                     null once a poll succeeds
--   LinkedInboxAccount.syncErrorAt    when that failure was recorded
--   UserToken.lastSyncedAt            the primary inbox's last successful sync
--
-- EXPAND ONLY. Nullable columns, no default: a catalog update, no table
-- rewrite, no backfill. The previous instance keeps writing rows without them
-- during the swap, and null is correct for those rows.
--
-- No new table, so no new RLS policy: both tables already have RLS enabled.
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261112100000_account_sync_status`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "LinkedInboxAccount" ADD COLUMN "syncErrorCode" TEXT,
ADD COLUMN "syncErrorAt" TIMESTAMP(3);

ALTER TABLE "UserToken" ADD COLUMN "lastSyncedAt" TIMESTAMP(3);
