-- Per-feature LLM cost attribution: which module made each call, what it
-- actually cost, and whether the user's own key paid. Expand-only: new
-- nullable/defaulted columns, safe while the previous release still runs.
-- Constant defaults are metadata-only on Postgres 11+ (no table rewrite).
-- Write-hot table: give up rather than queue the fire-and-forget inserts
-- behind a long reader while waiting for the brief ACCESS EXCLUSIVE lock.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "LlmUsageLog"
  ADD COLUMN "costMicroCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "feature" TEXT,
  ADD COLUMN "ownedByUser" BOOLEAN NOT NULL DEFAULT false;
