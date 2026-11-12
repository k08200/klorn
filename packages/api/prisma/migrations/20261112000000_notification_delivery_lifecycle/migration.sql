-- Notification delivery lifecycle (2026-11-12). See src/notify/delivery-lifecycle.ts.
--
-- PushDeliveryLog becomes one row per notification per channel:
--   channel     web | fcm | apns | telegram | desktop_mac | desktop_windows.
--               Every existing row is web push (no other channel wrote rows),
--               which is what the default says.
--   queuedAt    the attempt was handed to its transport
--   actionedAt  an action button (Reply / Later) was used; action names it
--   dedupeKey   idempotency for rows a client reports (desktop receipts)
-- PushSubscription.needsResubscribeAt flags a zombie web-push subscription
-- (src/notify/push-zombie.ts); endpointSince restarts its run when the
-- endpoint changes.
--
-- EXPAND ONLY. Nullable columns add without a table rewrite, and so does
-- "channel": a constant default is metadata-only since Postgres 11. The
-- previous instance keeps writing web rows without the new columns during the
-- swap, and "web" is correct for them. The unique index is built on a column
-- that is NULL in every row.
--
-- No new table, so no new RLS policy: both tables already have RLS enabled.
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261112000000_notification_delivery_lifecycle`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "PushDeliveryLog" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'web',
ADD COLUMN "queuedAt" TIMESTAMP(3),
ADD COLUMN "actionedAt" TIMESTAMP(3),
ADD COLUMN "action" TEXT,
ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "PushDeliveryLog_dedupeKey_key" ON "PushDeliveryLog"("dedupeKey");

ALTER TABLE "PushSubscription" ADD COLUMN "needsResubscribeAt" TIMESTAMP(3),
ADD COLUMN "endpointSince" TIMESTAMP(3);
