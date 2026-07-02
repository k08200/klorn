-- CreateIndex: renewExpiringGmailWatches runs periodically and scans BOTH tables
-- by watch-expiry with NO userId filter (it is a system-wide renewal job):
--   UserToken:          WHERE gmailWatchExpiresAt IS NOT NULL AND <= cutoff
--   LinkedInboxAccount: WHERE gmailWatchExpiresAt IS NULL OR <= cutoff
-- Neither had an index on gmailWatchExpiresAt, so each tick seq-scanned the whole
-- table — cost grows linearly with the user base / linked-inbox count. A btree on
-- the expiry column serves both the range (<= cutoff) and the NULL first-register
-- lookup. Cheap build today (small tables); IF NOT EXISTS allows an out-of-band
-- CONCURRENTLY pre-build before a large-table deploy (Prisma precludes
-- CONCURRENTLY inside its migration transaction — see 20260702000000).
CREATE INDEX IF NOT EXISTS "UserToken_gmailWatchExpiresAt_idx" ON "UserToken"("gmailWatchExpiresAt");
CREATE INDEX IF NOT EXISTS "LinkedInboxAccount_gmailWatchExpiresAt_idx" ON "LinkedInboxAccount"("gmailWatchExpiresAt");
