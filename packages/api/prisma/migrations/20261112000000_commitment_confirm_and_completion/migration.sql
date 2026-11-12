-- Commitment.confirmedAt: the user confirmed a suggested (rule-mined,
-- low-confidence) commitment from the web ledger. Confirmed rows may reach the
-- PUSH lane; suggestions never do.
-- Commitment.completionSuggestedAt: a later reply in the promise's thread
-- suggested it was kept ("likely done" / "likely delivered"). The user still
-- confirms DONE; nothing sets it from this stamp.
--
-- EXPAND ONLY, metadata-only: nullable columns with no default add without a
-- table rewrite, and the previous instance never reads them. Row-level
-- security is per table, so the existing Commitment policies cover both
-- columns unchanged.
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261112000000_commitment_confirm_and_completion`
-- and redeploy.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Commitment" ADD COLUMN "confirmedAt" TIMESTAMP(3),
  ADD COLUMN "completionSuggestedAt" TIMESTAMP(3);
