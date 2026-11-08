-- PushRingEvent.bucket: the per-user push rate limit counts an "interrupt"
-- bucket (urgent mail, meeting alerts) and an "ambient" bucket (everything
-- else) apart, each against its own caps, so briefings and proposals can no
-- longer use up the room an urgent mail needs (notify/push-bucket.ts).
--
-- EXPAND ONLY, metadata-only: a constant default adds the column without a
-- table rewrite. Every push writes this table and start.sh migrates while the
-- previous instance still serves; its rows take the default, so for the
-- minutes of the swap its urgent pushes count as ambient. No index:
-- each user's rows are pruned to the 60-minute window, so the existing
-- (userId, createdAt) index already narrows a count to a few dozen rows.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "PushRingEvent" ADD COLUMN "bucket" TEXT NOT NULL DEFAULT 'ambient';
