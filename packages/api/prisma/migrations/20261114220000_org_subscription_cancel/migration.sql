-- Klorn Teams v1.1 seat management (src/org/seat-management.ts):
--   Organization.subscriptionCancelAt  when a period-end cancel takes effect
--                                      (Paddle scheduled_change), or null
--
-- EXPAND ONLY, metadata-only: a nullable column with no default adds without a
-- table rewrite, and the previous instance never reads it. Nothing reads it
-- while TEAMS_ENABLED is off. No new table, so no new RLS policy:
-- "Organization" already has RLS enabled (20261114130000_teams_v1_foundation).
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261114220000_org_subscription_cancel`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Organization" ADD COLUMN "subscriptionCancelAt" TIMESTAMP(3);
