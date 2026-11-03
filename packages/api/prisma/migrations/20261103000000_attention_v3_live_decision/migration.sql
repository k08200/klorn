-- Attention engine v3 live decision (P3 PR2,
-- docs/design/attention-engine-v3.md §3(5) "Live decision"). Additive and
-- nullable: nothing is backfilled, and every column stays null for users the
-- JUDGE_V3_POLICY flag does not cover.

ALTER TABLE "AttentionItem"
  ADD COLUMN "v3PolicyVersion" TEXT,
  ADD COLUMN "v3Decision" JSONB,
  ADD COLUMN "v3Due" TIMESTAMP(3),
  ADD COLUMN "v3Importance" DOUBLE PRECISION,
  ADD COLUMN "heldAt" TIMESTAMP(3);

ALTER TABLE "AutomationConfig" ADD COLUMN "interruptBudget" INTEGER;
