-- Reversible manual lane override (productization plan P4, 2026-10-03): the
-- undo handle and the snapshot of what the override replaced. Written only
-- while KEYBOARD_TRIAGE is on (default off).
-- Additive only: two nullable columns, no default, no backfill, no index (the
-- row is always reached by primary key). Rollback: the previous release
-- ignores the columns; drop them only after.
-- Fail fast instead of queueing behind a long lock (same guard as
-- 20261007010000_linked_calendar_display_name).
SET LOCAL lock_timeout = '5s';
ALTER TABLE "AttentionItem" ADD COLUMN "overrideUndoToken" TEXT,
ADD COLUMN "overrideUndo" JSONB;
