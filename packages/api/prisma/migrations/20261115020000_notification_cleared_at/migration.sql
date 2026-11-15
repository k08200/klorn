-- "Clear all" in the bell hides a notification instead of deleting it:
--   clearedAt  when the user cleared the row from the bell (null = shown)
-- The "already notified?" reads that look back over bell rows (urgent mail,
-- the day's briefing, proactive nudges) keep seeing a cleared row, so clearing
-- never makes Klorn ring the same thing again (background.ts clearNotifications).
-- Cleared rows go at the next clear once past 7 days, and in the log-retention
-- sweep after 30 days (log-retention.ts CLEARED_NOTIFICATION_RETENTION_DAYS).
--
-- EXPAND ONLY. One nullable column, no default: a catalog update, no table
-- rewrite, no backfill. The previous instance keeps deleting on clear during
-- the swap, which is the old behavior; null is correct for every existing row.
--
-- No new table, so no new RLS policy: Notification already has RLS enabled.
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261115020000_notification_cleared_at`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Notification" ADD COLUMN "clearedAt" TIMESTAMP(3);
