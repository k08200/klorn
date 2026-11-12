-- IP24 instrumentation on the decision ledger (src/judge/ip24.ts):
--   rangAt          when Klorn's interrupt for the mail got past every hold
--                   gate and went to the user's channels (null = never rang)
--   gmailImportant  Gmail's IMPORTANT marker on the inbox mail when it was
--                   first judged (null = not Gmail mail, or judged before this)
--
-- EXPAND ONLY. Nullable columns, no default: a catalog update, no table
-- rewrite, no backfill. The previous instance keeps writing rows without them
-- during the swap, and null is correct for those rows.
--
-- No new table, so no new RLS policy: DecisionLabel already has RLS enabled.
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261112020000_decision_label_ring_snapshot`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "DecisionLabel" ADD COLUMN "rangAt" TIMESTAMP(3),
ADD COLUMN "gmailImportant" BOOLEAN;
