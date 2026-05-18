-- Missing per-user indexes (audited 2026-05-19) so listing queries and
-- cascade deletes stop falling back to sequential scans.
CREATE INDEX IF NOT EXISTS "Agent_userId_idx" ON "Agent"("userId");
CREATE INDEX IF NOT EXISTS "TestRun_userId_createdAt_idx" ON "TestRun"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "TestRun_agentId_createdAt_idx" ON "TestRun"("agentId", "createdAt");
CREATE INDEX IF NOT EXISTS "Evaluation_testRunId_idx" ON "Evaluation"("testRunId");
CREATE INDEX IF NOT EXISTS "Conversation_userId_updatedAt_idx" ON "Conversation"("userId", "updatedAt");
CREATE INDEX IF NOT EXISTS "Note_userId_updatedAt_idx" ON "Note"("userId", "updatedAt");
CREATE INDEX IF NOT EXISTS "Note_userId_category_idx" ON "Note"("userId", "category");
CREATE INDEX IF NOT EXISTS "Contact_userId_name_idx" ON "Contact"("userId", "name");
CREATE INDEX IF NOT EXISTS "Contact_userId_email_idx" ON "Contact"("userId", "email");
CREATE INDEX IF NOT EXISTS "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- LlmCostLedger: per-user, per-UTC-day spend ledger used by the daily cap.
CREATE TABLE IF NOT EXISTS "LlmCostLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "cents" INTEGER NOT NULL DEFAULT 0,
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "lastModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmCostLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LlmCostLedger_userId_dayKey_key" ON "LlmCostLedger"("userId", "dayKey");
CREATE INDEX IF NOT EXISTS "LlmCostLedger_userId_dayKey_idx" ON "LlmCostLedger"("userId", "dayKey");

ALTER TABLE "LlmCostLedger" ADD CONSTRAINT "LlmCostLedger_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
