-- MCP write audit: the identity of a create_draft call (step A4 of
-- docs/providers/unified-platform-plan.md).
--
-- "argsHash" only marks an argument object over 4 KB as oversize, so two different
-- long drafts to the same email left identical rows. These columns identify a
-- draft without storing any of it:
--   "bodyHash"      SHA-256 hex of the body text, written with the `attempted` row.
--   "recipientHash" SHA-256 hex of the lowercased recipient address.
--   "draftId"       the provider's draft id (id-shaped values only).
-- The last two are written when the draft is created. No body, address or
-- subject is stored. They are NULL for every other tool, for refused calls and
-- for a draft that was not created.
--
-- Additive only: three nullable columns, no default, no index, no rewrite of
-- existing rows. The earlier McpWriteAudit migrations are untouched. Safe to
-- apply ahead of the code that writes them.

-- AlterTable
ALTER TABLE "McpWriteAudit" ADD COLUMN     "bodyHash" TEXT,
ADD COLUMN     "draftId" TEXT,
ADD COLUMN     "recipientHash" TEXT;
