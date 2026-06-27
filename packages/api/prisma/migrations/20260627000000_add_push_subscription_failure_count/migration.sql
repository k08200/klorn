-- AlterTable: budgeted-retry eviction counters for web-push subscriptions.
ALTER TABLE "PushSubscription" ADD COLUMN     "failureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastFailedAt" TIMESTAMP(3);
