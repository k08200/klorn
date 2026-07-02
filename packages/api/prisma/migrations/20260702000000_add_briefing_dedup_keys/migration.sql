-- Atomic dedup for the daily briefing. The old flow was check-then-create
-- (TOCTOU): the scheduler, the agent tool-executor, cron, and post-login auth
-- can all call createDailyBriefingDelivery concurrently, all pass the findFirst
-- check, and all create + push — sending the user DUPLICATE briefing web-push.
--
-- These nullable columns + unique indexes make the dedup atomic (create-catch
-- P2002, the idiom already used for WebhookEvent). Postgres treats NULLs as
-- DISTINCT in a unique index, so existing/other Notes & Notifications (dayKey /
-- dedupeKey = NULL) never collide — only briefing rows, which set the key, are
-- deduped. No backfill: a nullable column with no default is NULL on every
-- existing row, and we only prevent FUTURE duplicates.

-- Note.dayKey: the user's LOCAL calendar day (YYYY-MM-DD) the briefing note
-- dedupes on. One briefing note per (userId, dayKey).
ALTER TABLE "Note" ADD COLUMN "dayKey" TEXT;
CREATE UNIQUE INDEX "Note_userId_dayKey_key" ON "Note"("userId", "dayKey");

-- Notification.dedupeKey: idempotency key (e.g. "briefing:2026-07-01"). The
-- winner of the create is the only caller that sends the push.
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");
