-- Klorn Teams v1.1 seat management (src/org/seat-management.ts):
--   Organization.subscriptionCancelAt  when a period-end cancel takes effect
--                                      (Paddle scheduled_change), or null
--   Organization.billingUserId         the account that opened the team
--                                      checkout; the only one the Paddle
--                                      customer portal opens for
--
-- EXPAND ONLY, metadata-only: nullable columns with no default add without a
-- table rewrite, and the previous instance never reads them. Nothing reads
-- them while TEAMS_ENABLED is off. No new table, so no new RLS policy:
-- "Organization" already has RLS enabled (20261114130000_teams_v1_foundation).
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261114220000_org_subscription_cancel`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Organization" ADD COLUMN "subscriptionCancelAt" TIMESTAMP(3),
ADD COLUMN "billingUserId" TEXT;
