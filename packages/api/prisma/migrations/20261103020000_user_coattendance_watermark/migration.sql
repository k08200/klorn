-- The calendar co-attendance watermark (pim/coattendance/,
-- docs/design/attention-engine-v3.md §3(2)): "User"."coAttendanceCountedThrough",
-- the last UTC day through which every finished day has been evaluated for every
-- included Google calendar source of the user. A day at or before it is never
-- evaluated again; null until the first pass, and reset by a data wipe
-- (purge-user-data.ts) so a reconnect counts the whole window again.
--
-- In a migration of its own because "User" is read by every request: ADD COLUMN
-- takes ACCESS EXCLUSIVE on it. The column is nullable with no default, so the
-- change is metadata-only (no rewrite, no scan) and the lock is held for a
-- catalog update. lock_timeout is short (2 s) so a deploy that finds "User" busy
-- behind a long transaction fails fast and is retried, instead of queueing every
-- request behind it.
SET LOCAL lock_timeout = '2s';

ALTER TABLE "User" ADD COLUMN "coAttendanceCountedThrough" TIMESTAMP(3);
