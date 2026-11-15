-- Klorn Teams payer edges (src/org/seat-billing.ts, src/org/seat-management.ts):
--   Organization.seatsAtAttach            the seat quantity the subscription
--                                         reported when it attached (checkout
--                                         count); bounds increases by a
--                                         recorded payer whose email Paddle
--                                         does not bill
--   Organization.cancelRequestedByUserId  the owner who scheduled the pending
--   Organization.cancelRequestedAt        period-end cancel through Klorn, and
--                                         when; null for a portal cancel
--
-- EXPAND ONLY, metadata-only: nullable columns with no default add without a
-- table rewrite, and the previous instance never reads them. Nothing reads
-- them while TEAMS_ENABLED is off. No backfill: a subscription attached before
-- this has no attach count, and a recorded payer whose email Paddle does not
-- bill then adds no seats (the paying email still can). No new table, so no
-- new RLS policy: "Organization" already has RLS enabled
-- (20261114130000_teams_v1_foundation).
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261115130000_org_payer_edges`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "Organization"
  ADD COLUMN "seatsAtAttach" INTEGER,
  ADD COLUMN "cancelRequestedByUserId" TEXT,
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);
