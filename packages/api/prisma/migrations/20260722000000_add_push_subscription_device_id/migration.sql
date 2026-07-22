-- Fix duplicate web-push delivery (e.g. the "Daily Briefing" notification
-- arriving twice). A browser's push subscription can rotate (SW replacement,
-- permission re-grant, a second SW scope); when it re-registers via
-- /push/subscribe instead of /push/rotate, a NEW endpoint row is inserted and
-- the old one lingers as an orphan. Delivery fans out to every row, so one
-- notification is sent to both — a visible duplicate.
--
-- Add a stable per-browser identifier so /push/subscribe can prune this
-- browser's previous rows on re-register, mirroring DevicePushToken's
-- prune-on-register. Nullable: rows created before this column skip the prune
-- and are cleaned as legacy on the owning browser's next subscribe.
ALTER TABLE "PushSubscription" ADD COLUMN "deviceId" TEXT;
CREATE INDEX "PushSubscription_userId_deviceId_idx" ON "PushSubscription"("userId", "deviceId");
