-- Reversible manual lane override (productization plan P4, 2026-10-03): the
-- undo handle and the snapshot of what the override replaced. Written only
-- while KEYBOARD_TRIAGE is on (default off).
-- Additive only: two nullable columns, no backfill, no index (the row is
-- always reached by primary key).

ALTER TABLE "AttentionItem" ADD COLUMN "overrideUndoToken" TEXT;
ALTER TABLE "AttentionItem" ADD COLUMN "overrideUndo" JSONB;
