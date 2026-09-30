-- Triage priorities (2026-09-11): the user's own words about what matters
-- ("investor mail is always urgent"). Reaches the lane judge and the
-- summarize preamble; capped at 500 chars (triage-priorities.ts). Null until
-- the user says.
--
-- Additive only: one nullable column, no backfill.

ALTER TABLE "User" ADD COLUMN "triagePriorities" TEXT;
