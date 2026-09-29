-- Proactive reply drafts (2026-09-28): a draft written ahead of time for
-- PUSH mail that needs a reply, and the stamp of the attempt (daily cap +
-- retry guard). Behind PROACTIVE_DRAFT_ENABLED (default off).
-- Additive only: two nullable columns, no backfill.

ALTER TABLE "EmailMessage" ADD COLUMN "proactiveDraft" TEXT;
ALTER TABLE "EmailMessage" ADD COLUMN "proactiveDraftAt" TIMESTAMP(3);
