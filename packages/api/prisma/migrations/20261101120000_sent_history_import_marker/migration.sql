-- Additive, nullable: when the one-time Sent-history import
-- (mail/sent-history-import.ts, SENT_HISTORY_BACKFILL_ENABLED) finished for the
-- inbox this grant row owns. Null = not finished (or never started). It lives on
-- the grant row, so a reconnected or re-linked account is imported again.
-- No backfill, no lock beyond a catalog update.
ALTER TABLE "UserToken" ADD COLUMN "sentHistoryImportedAt" TIMESTAMP(3);
ALTER TABLE "LinkedInboxAccount" ADD COLUMN "sentHistoryImportedAt" TIMESTAMP(3);
