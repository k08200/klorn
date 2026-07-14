-- Single-column timestamp indexes so the retention sweep's
-- `WHERE <ts> < cutoff` batch lookup is an index range scan, not a seq scan.
-- The existing composite indexes are all [userId, ...]-leading and can't serve
-- a userId-less range. LlmUsageLog already has @@index([createdAt]).
-- Plain CREATE INDEX (Prisma runs each migration in a transaction, so
-- CONCURRENTLY is unavailable here); at true table scale, build these
-- concurrently out-of-band before enabling the flag.
CREATE INDEX IF NOT EXISTS "AgentLog_createdAt_idx" ON "AgentLog" ("createdAt");
CREATE INDEX IF NOT EXISTS "EmailProcessingLog_processedAt_idx" ON "EmailProcessingLog" ("processedAt");
CREATE INDEX IF NOT EXISTS "PushDeliveryLog_createdAt_idx" ON "PushDeliveryLog" ("createdAt");
CREATE INDEX IF NOT EXISTS "PushRingEvent_createdAt_idx" ON "PushRingEvent" ("createdAt");
CREATE INDEX IF NOT EXISTS "WebhookEvent_processedAt_idx" ON "WebhookEvent" ("processedAt");
