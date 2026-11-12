-- Note.picks: the daily briefing's picks — up to three mails, each with the
-- quote verified to be in it, and when the user first opened the mail from
-- the pick (pim/briefing-picks.ts). NULL for every other note.
--
-- EXPAND ONLY, metadata-only: a nullable column with no default adds without a
-- table rewrite. The previous instance keeps writing notes without it during
-- the swap.
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261112000000_note_briefing_picks`
-- and redeploy.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "Note" ADD COLUMN "picks" JSONB;
