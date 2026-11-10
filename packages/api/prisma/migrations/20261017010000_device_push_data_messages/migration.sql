-- DevicePushToken.dataMessages (2026-10-17): an Android build that posts Klorn's
-- data-only FCM messages itself, with action buttons, says so when it registers
-- its token (apps/mobile push/KlornMessagingService.java). The sender
-- (notify/push-device.ts) sends a MAIL push data-only only to such a device and
-- only while ANDROID_DATA_PUSH_ENABLED is on (OFF by default); every other row
-- keeps notification messages, which is what false means.
--
-- Additive only. ADD COLUMN with a constant default is catalog-only on Postgres
-- 11+ (no table rewrite, no backfill); the ACCESS EXCLUSIVE lock it takes on
-- "DevicePushToken" (a small table) is held only until this commits.
-- lock_timeout makes a deploy blocked by a long transaction fail fast.
-- Rollback: revert the code; the column can stay (nothing else reads it).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "DevicePushToken" ADD COLUMN "dataMessages" BOOLEAN NOT NULL DEFAULT false;
