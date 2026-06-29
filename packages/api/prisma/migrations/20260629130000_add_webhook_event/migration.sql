-- Persistent Stripe webhook idempotency (replaces the in-memory dedup map):
-- survives dyno restarts and is shared across dynos.
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);
