-- NT0 notification redesign: the meeting notification shows how many people
-- an invite lists ("10분 후 · Google Meet · 3명"). Expand-only: one nullable
-- column, no default, no backfill (the next calendar sync fills it). A count
-- only; attendee identities are never stored.
ALTER TABLE "CalendarEvent" ADD COLUMN "attendeeCount" INTEGER;
