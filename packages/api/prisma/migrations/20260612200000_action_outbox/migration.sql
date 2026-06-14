-- Transactional outbox for action execution (T6). Execution intent is written
-- here in the same transaction as the PendingAction status claim, so the
-- approval and "this must run" commit atomically. A deterministic worker
-- drains QUEUED rows (status, nextAttemptAt) and replays the stored
-- toolArgs + receipt — the LLM is never in the retry loop. The UNIQUE index
-- on "pendingActionId" makes enqueue idempotent (double-approve collapses to
-- one row); the UNIQUE "idempotencyKey" is the per-action audit anchor.

CREATE TABLE IF NOT EXISTS "ActionOutbox" (
    "id" TEXT NOT NULL,
    "pendingActionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "toolName" TEXT NOT NULL,
    "toolArgs" JSONB NOT NULL,
    "actionReceipt" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ActionOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ActionOutbox_pendingActionId_key" ON "ActionOutbox"("pendingActionId");
CREATE UNIQUE INDEX IF NOT EXISTS "ActionOutbox_idempotencyKey_key" ON "ActionOutbox"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "ActionOutbox_status_nextAttemptAt_idx" ON "ActionOutbox"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "ActionOutbox_userId_idx" ON "ActionOutbox"("userId");

ALTER TABLE "ActionOutbox" ADD CONSTRAINT "ActionOutbox_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
