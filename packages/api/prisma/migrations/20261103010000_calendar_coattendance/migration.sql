-- Calendar co-attendance (2026-11-01): the relationship signal "how often has the
-- user actually met this person" for attention engine v3
-- (docs/design/attention-engine-v3.md §3(2)). Founder decision 2026-11-01: store
-- per-contact co-attendance counts only, never an attendee list. Nothing writes
-- either table until CALENDAR_COATTENDANCE_ENABLED is on (pim/coattendance/).
--
-- ContactCoAttendance. One row per (userId, contactEmail): the number of ended
-- meetings the user took part in and that address was invited to without
-- declining, how many of them had at most five such people, and the UTC day (never
-- the instant) of the first and the last. contactEmail is stored
-- normalised: a CHECK that it equals lower(btrim("contactEmail")), so a padded or
-- upper-case address fails loud (23514) instead of making a second row for the
-- same person. A second CHECK keeps the small count within the total. No row
-- means never counted, which readers treat as unknown, never 0.
--
-- CoAttendanceMeeting. One row per meeting already counted, so a meeting the sync
-- lists again is never counted twice. eventKey is the SHA-256 (64 hex) of the
-- meeting's identity across calendars, never the identity itself; a CHECK keeps it
-- a hash. endedAt, the UTC day the meeting ended, prunes the row once the
-- meeting is older than the counting window.
--
-- Nothing finer than a day. Neither table has a column for a title, an attendee,
-- or a time: no createdAt, updatedAt or countedAt, and the three dates
-- (firstMetAt, lastMetAt, endedAt) are UTC midnights. Rows written in one
-- transaction would otherwise share a write time, and grouping by it recovers
-- who was in the meeting that ended at a given time (review of #1604).
--
-- UserToken and LinkedCalendarAccount gain two nullable columns for each Google
-- calendar source: coAttendanceObservedSince (the first full UTC day the source
-- was covered by an advance of the user's watermark) and coAttendanceLastPassAt
-- (the last pass in which the source's own listing succeeded in full). The
-- watermark itself, "User"."coAttendanceCountedThrough", has its own migration
-- (20261103020000_user_coattendance_watermark), so the statement that locks
-- "User" runs alone. Reconnecting or re-linking a grant clears both source
-- columns (routes/google-link-finish.ts). docs/design/attention-engine-v3.md
-- §3(2) is the reader's contract.
--
-- Row-level security on both, in the form every per-user table has: ENABLE, not
-- FORCE, a tenant policy on app.current_user_id and a system policy on
-- app.bypass_rls. The default-privilege revoke of
-- 20261010020000_revoke_data_api_table_grants covers new tables. Both are in the
-- data-wipe fence (privacy/data-wipe-fence.ts FENCED_MODELS): the BEFORE INSERT
-- trigger of 20261019010000_data_wipe_fence rejects an insert while the account's
-- wipe is pending. The rows go with their user (the foreign keys cascade) and with
-- a data wipe (purge-user-data.ts).
--
-- Locks and cost: two new, empty tables. The foreign keys take SHARE ROW EXCLUSIVE
-- on "User" for the length of the transaction. The two ADD COLUMN statements
-- (nullable, no default) are metadata-only but take ACCESS EXCLUSIVE on
-- "UserToken" and "LinkedCalendarAccount", which every sync reads; they run last
-- so those locks are held for the shortest time, and lock_timeout makes a deploy
-- blocked by a long transaction fail fast instead of queueing reads behind it.
-- Nothing scans an existing table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "ContactCoAttendance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "meetingCount" INTEGER NOT NULL DEFAULT 0,
    "smallMeetingCount" INTEGER NOT NULL DEFAULT 0,
    "firstMetAt" TIMESTAMP(3) NOT NULL,
    "lastMetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactCoAttendance_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ContactCoAttendance_contactEmail_normalized_check" CHECK ("contactEmail" = lower(btrim("contactEmail"))),
    CONSTRAINT "ContactCoAttendance_counts_check" CHECK ("smallMeetingCount" >= 0 AND "smallMeetingCount" <= "meetingCount")
);

CREATE TABLE "CoAttendanceMeeting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "CalendarProvider" NOT NULL,
    "eventKey" TEXT NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoAttendanceMeeting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CoAttendanceMeeting_eventKey_sha256_check" CHECK ("eventKey" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "ContactCoAttendance_userId_contactEmail_key" ON "ContactCoAttendance"("userId", "contactEmail");

CREATE INDEX "CoAttendanceMeeting_userId_endedAt_idx" ON "CoAttendanceMeeting"("userId", "endedAt");

CREATE UNIQUE INDEX "CoAttendanceMeeting_userId_provider_eventKey_key" ON "CoAttendanceMeeting"("userId", "provider", "eventKey");

ALTER TABLE "ContactCoAttendance" ADD CONSTRAINT "ContactCoAttendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CoAttendanceMeeting" ADD CONSTRAINT "CoAttendanceMeeting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactCoAttendance" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ContactCoAttendance_tenant_isolation" ON "ContactCoAttendance" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "ContactCoAttendance_system_bypass" ON "ContactCoAttendance" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "CoAttendanceMeeting" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CoAttendanceMeeting_tenant_isolation" ON "CoAttendanceMeeting" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "CoAttendanceMeeting_system_bypass" ON "CoAttendanceMeeting" USING (current_setting('app.bypass_rls', true) = 'on');

CREATE TRIGGER "ContactCoAttendance_data_wipe_fence" BEFORE INSERT ON "ContactCoAttendance" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "CoAttendanceMeeting_data_wipe_fence" BEFORE INSERT ON "CoAttendanceMeeting" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();

ALTER TABLE "UserToken" ADD COLUMN "coAttendanceObservedSince" TIMESTAMP(3), ADD COLUMN "coAttendanceLastPassAt" TIMESTAMP(3);
ALTER TABLE "LinkedCalendarAccount" ADD COLUMN "coAttendanceObservedSince" TIMESTAMP(3), ADD COLUMN "coAttendanceLastPassAt" TIMESTAMP(3);
