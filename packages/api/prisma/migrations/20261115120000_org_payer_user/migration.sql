-- Klorn Teams payer identity (src/org/seat-billing.ts, src/org/seat-management.ts):
--   Organization.payerUserId  the Klorn user who bought the team subscription
--                             (checkout custom_data.payerUserId), stored only
--                             when an owner of the organization; or null
--
-- EXPAND ONLY, metadata-only: a nullable column with no default adds without a
-- table rewrite, and the previous instance never reads it. Nothing reads it
-- while TEAMS_ENABLED is off. No new table, so no new RLS policy:
-- "Organization" already has RLS enabled (20261114130000_teams_v1_foundation).
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261115120000_org_payer_user`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Organization" ADD COLUMN "payerUserId" TEXT;
