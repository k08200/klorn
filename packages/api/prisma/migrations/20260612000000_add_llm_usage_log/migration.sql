-- LlmUsageLog: ground-truth token accounting — one row per successful LLM
-- call, written at the createCompletion/createVisionCompletion chokepoints.
-- The cost gates pre-bill ESTIMATES (LlmCostLedger); this table records the
-- ACTUAL usage providers returned, plus the provider+model that actually
-- served the request after failover, so estimate-vs-reality drift is
-- measurable. userId is nullable so system-initiated calls are captured;
-- SET NULL on user deletion keeps cost history (token counts only, no
-- content).
CREATE TABLE IF NOT EXISTS "LlmUsageLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "usageMissing" BOOLEAN NOT NULL DEFAULT false,
    "estimatedCostCents" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'foreground',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmUsageLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LlmUsageLog_userId_createdAt_idx" ON "LlmUsageLog"("userId", "createdAt");

ALTER TABLE "LlmUsageLog" ADD CONSTRAINT "LlmUsageLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
