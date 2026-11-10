-- MCP write audit: the lane a set_tier call changed from and to (2026-09-30, step
-- A2b of docs/providers/unified-platform-plan.md).
--
-- "tierFrom" and "tierTo" are filled only when a set_tier call actually changed
-- an item's lane, so the activity log (A3) can show what an agent did and a later
-- step can revert it. They are NULL for every other tool, for refused calls and
-- for a call that asked for the lane the item already had. Each holds one of the
-- five lane names (or a retired legacy value as stored); no mail content is
-- stored.
--
-- Additive only: two nullable columns, no default, no index, no rewrite of
-- existing rows. The 20260929010000_mcp_write_audit migration is untouched. Safe
-- to apply ahead of the code that writes them.

-- AlterTable
ALTER TABLE "McpWriteAudit" ADD COLUMN "tierFrom" TEXT,
ADD COLUMN "tierTo" TEXT;
