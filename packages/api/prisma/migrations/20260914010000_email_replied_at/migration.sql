-- Reply state (2026-09-14): when the user answered a mail through Klorn.
-- The row chip shows "replied" (a recorded fact) over the judged needsReply.
-- Additive only: one nullable column, no backfill.

ALTER TABLE "EmailMessage" ADD COLUMN "repliedAt" TIMESTAMP(3);
