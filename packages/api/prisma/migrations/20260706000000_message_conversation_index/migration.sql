-- CreateIndex: every conversation load runs Prisma's child query
-- (WHERE "conversationId" = ? ORDER BY "createdAt" ASC). Postgres does not
-- auto-index FK columns and Message only had the content trigram GIN index,
-- so the busiest child table was seq-scanned per load. The composite serves
-- the filter and returns rows already ordered, and also turns
-- Conversation-cascade deletes into an index scan. IF NOT EXISTS allows an
-- out-of-band CONCURRENTLY pre-build before a large-table deploy (Prisma
-- precludes CONCURRENTLY inside its migration transaction).
CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
