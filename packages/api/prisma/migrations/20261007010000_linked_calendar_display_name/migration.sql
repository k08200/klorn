-- Device calendar sources (2026-10-02): step C6 of
-- docs/providers/unified-platform-plan.md.
--
-- A desktop app uploads the device calendars the user opted into (decision P4),
-- one LinkedCalendarAccount per calendar with provider DEVICE (the enum value came
-- with C1). Its `email` holds `device:<key>`, the device's hash of the calendar
-- identifier plus the device id, so the existing (userId, provider, email) unique
-- is the source's upsert key. This column holds the calendar's title on the
-- device, which readers show as the row's source label instead of that key.
--
-- "deviceSnapshotAt" is the device's time of the last snapshot applied to a
-- source, so an older snapshot that arrives later is ignored.
--
-- Additive and nullable: no default, no backfill, no index. NULL for every row of
-- every other provider, whose label stays `email`. Rollback: the previous release
-- ignores the column; drop it only after.
-- Slotted after 20261006010000_proactive_draft (main), with a timestamp of its own.
-- Fail fast instead of queueing behind a long lock (same guard as 20261005010000).
SET LOCAL lock_timeout = '5s';
ALTER TABLE "LinkedCalendarAccount" ADD COLUMN "displayName" TEXT,
ADD COLUMN "deviceSnapshotAt" TIMESTAMP(3);
