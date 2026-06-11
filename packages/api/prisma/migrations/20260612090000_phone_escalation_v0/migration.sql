-- Phone escalation v0: one plain TTS call when a PUSH-tier push goes
-- unacknowledged (delivery channel for PUSH, NOT a new tier — tiers.ts is
-- locked at SILENT/QUEUE/PUSH/AUTO). The UNIQUE index on "notificationId"
-- is the hard "max one call per notification, ever" rail: racing scheduler
-- ticks collapse into a single row instead of a double dial.

CREATE TABLE IF NOT EXISTS "PhoneEscalation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "gatherToken" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLACED',
    "twilioCallSid" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneEscalation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PhoneEscalation_notificationId_key" ON "PhoneEscalation"("notificationId");
CREATE UNIQUE INDEX IF NOT EXISTS "PhoneEscalation_gatherToken_key" ON "PhoneEscalation"("gatherToken");
CREATE INDEX IF NOT EXISTS "PhoneEscalation_userId_createdAt_idx" ON "PhoneEscalation"("userId", "createdAt");

ALTER TABLE "PhoneEscalation" ADD CONSTRAINT "PhoneEscalation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-user opt-in. Default false: a phone call is the most intrusive channel
-- Klorn has; nobody gets dialed without explicitly turning this on.
ALTER TABLE "AutomationConfig" ADD COLUMN IF NOT EXISTS "phoneEscalationEnabled" BOOLEAN NOT NULL DEFAULT false;
