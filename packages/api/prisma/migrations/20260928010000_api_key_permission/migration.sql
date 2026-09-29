-- API key permission (2026-09-28): what a machine credential may do over MCP.
-- Two levels — read and read_write — so a later step can let an agent act on
-- mail (mark read, set lane) without widening any key that already exists.
--
-- Every existing key gets the DEFAULT 'read', so it stays read-only. The
-- MCP_WRITE_TOOLS_ENABLED flag (off by default) gates both minting a read_write
-- key and using one: while it is off, a read_write key acts as read. No write
-- tool exists yet.
--
-- Additive only: one new enum type and one new NOT NULL column with a default.
-- No existing column is altered and no row is rewritten by application code,
-- so this is safe to apply ahead of the code that reads or writes it.

-- CreateEnum
CREATE TYPE "ApiKeyPermission" AS ENUM ('read', 'read_write');

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "permission" "ApiKeyPermission" NOT NULL DEFAULT 'read';
