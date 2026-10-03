-- Proactive reply drafts (2026-09-28): a draft written ahead of time for
-- PUSH mail that needs a reply, and the stamp of the attempt (retry guard).
-- The user row carries the per-UTC-day slot counter that makes
-- PROACTIVE_DRAFT_DAILY_CAP a hard bound. Behind PROACTIVE_DRAFT_ENABLED
-- (default off).
-- Additive only: nullable columns and one defaulted counter, no backfill.

ALTER TABLE "EmailMessage" ADD COLUMN "proactiveDraft" TEXT;
ALTER TABLE "EmailMessage" ADD COLUMN "proactiveDraftAt" TIMESTAMP(3);

ALTER TABLE "User" ADD COLUMN "proactiveDraftDay" TEXT;
ALTER TABLE "User" ADD COLUMN "proactiveDraftCount" INTEGER NOT NULL DEFAULT 0;
