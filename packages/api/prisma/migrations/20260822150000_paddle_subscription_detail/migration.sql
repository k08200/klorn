-- Paddle subscription detail: persist the subscription id, live status, and
-- period dates so /billing can render renewal/cancel state and the in-app
-- cancel route can call the Paddle API without a lookup.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "paddleSubscriptionId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "subscriptionStatus" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "subscriptionRenewsAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "subscriptionCancelAt" TIMESTAMP(3);
-- Ordering guard: occurred_at of the newest provider event already applied.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "subscriptionEventAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "User_paddleSubscriptionId_key" ON "User"("paddleSubscriptionId");
