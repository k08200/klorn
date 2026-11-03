-- Additive, nullable: when the one-time Sent-history import
-- (mail/sent-history-import.ts, SENT_HISTORY_BACKFILL_ENABLED) finished for the
-- inbox this grant row owns. Null = not finished (or never started). A
-- reconnect or re-link resets it (routes/google-link-finish.ts), since it may
-- be another Google account. No backfill. UserToken is read on most requests,
-- so the catalog update waits at most 5 s for its lock rather than queueing
-- every reader behind it.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "UserToken" ADD COLUMN "sentHistoryImportedAt" TIMESTAMP(3);
ALTER TABLE "LinkedInboxAccount" ADD COLUMN "sentHistoryImportedAt" TIMESTAMP(3);
