-- MCP write audit (2026-09-29): one row per MCP write-tool call, refused calls
-- included — the record of what an agent tried to change, through which key,
-- and how it ended (step A2a of docs/providers/unified-platform-plan.md).
--
-- An allowed call is inserted before the tool runs; a refused call is inserted
-- best-effort. No mail content is stored: targetId is an opaque message id and
-- argsHash is a SHA-256 of the canonical JSON of the arguments. apiKeyId is
-- deliberately not a foreign key, so the history outlives the key. Rows are
-- removed with the user (ON DELETE CASCADE) and by purgeUserData.
--
-- Additive only: one new enum type, one new table, two indexes and one foreign
-- key. No existing table or column is touched, so this is safe to apply ahead
-- of the code that writes it; nothing writes to it while MCP_WRITE_TOOLS_ENABLED
-- is off.

-- CreateEnum
CREATE TYPE "McpAuditOutcome" AS ENUM ('ok', 'refused', 'error');

-- CreateTable
CREATE TABLE "McpWriteAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "targetId" TEXT,
    "argsHash" TEXT NOT NULL,
    "outcome" "McpAuditOutcome" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpWriteAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "McpWriteAudit_userId_createdAt_idx" ON "McpWriteAudit"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "McpWriteAudit_apiKeyId_createdAt_idx" ON "McpWriteAudit"("apiKeyId", "createdAt");

-- AddForeignKey
ALTER TABLE "McpWriteAudit" ADD CONSTRAINT "McpWriteAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

