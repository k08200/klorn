-- Persistent push rate-limit window (notification dispatcher).
-- One row per allowed "ring" — a logical notification dispatch that passed
-- every gate. The limiter counts rows in the 10/60-minute windows, so the
-- per-user caps survive process restarts and horizontal scaling. Rows older
-- than the widest window are pruned opportunistically on allowed attempts.

CREATE TABLE "PushRingEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushRingEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PushRingEvent_userId_createdAt_idx" ON "PushRingEvent"("userId", "createdAt");

ALTER TABLE "PushRingEvent" ADD CONSTRAINT "PushRingEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
