-- Notification center delivery view (2026-11-14). See src/notify/notification-center.ts.
--
-- PushDeliveryLog.bellNotificationId names the bell row (Notification id) a
-- push rang for, on the web / FCM / APNs / Telegram rows alike, so
-- GET /api/notifications/:id/delivery can find where a mail alert landed.
-- notificationId cannot carry it: it is NULL by design for firewall pushes
-- because phone escalation keys on it.
--
-- EXPAND ONLY. A nullable column adds without a table rewrite. The previous
-- instance keeps writing rows without it during the swap; those rows simply
-- do not show in the delivery view. No index: the read is bounded by
-- (userId, createdAt), which PushDeliveryLog_userId_createdAt_idx serves.
--
-- No new table, so no new RLS policy: the table already has RLS enabled.
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261114000000_push_delivery_bell_row`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "PushDeliveryLog" ADD COLUMN "bellNotificationId" TEXT;
