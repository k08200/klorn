-- AlterTable: structural authorship flag for AttentionItem, so judge/LLM-authored
-- tierReason text can never be mistaken for a genuine human override
-- (GHSA-cxc5-fmqv-pxv6). Only overrideAttentionTier() (attention-override.ts)
-- ever sets this true going forward; every judge write (attention-mirror.ts)
-- resets it false.
ALTER TABLE "AttentionItem" ADD COLUMN "isManualOverride" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: trusting the tierReason prefix alone would just re-run the exact
-- heuristic this migration exists to retire — a historical prompt-injected row
-- would pass it too. Cross-check against DecisionLabel.outcome, which
-- overrideAttentionTier() stamps as 'OVERRIDE:<tier>' in the SAME transaction
-- as the tierReason write (attention-override.ts) but which the judge's LLM
-- output can never reach. Only rows with both signals are backfilled true.
--
-- Locking note: runs inside Prisma's migration transaction, taking row locks
-- only on matched AttentionItem rows (indexed EXISTS lookup against
-- DecisionLabel's (userId, source, sourceId) unique index, not a full scan).
-- One-time backfill on the CURRENT table size at deploy — cheap today; the
-- matched set is bounded by historical manual overrides, not table size.
UPDATE "AttentionItem" a
SET "isManualOverride" = true
WHERE a."tierReason" LIKE 'Manual override%'
  AND EXISTS (
    SELECT 1 FROM "DecisionLabel" d
    WHERE d."userId" = a."userId"
      AND d."source" = a."source"
      AND d."sourceId" = a."sourceId"
      AND d."outcome" LIKE 'OVERRIDE:%'
  );
