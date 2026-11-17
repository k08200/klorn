-- Slack residuals (docs/providers/slack.md §8-§9):
--   SlackEpisode.verdictSource  where the stored verdict came from ("llm" or
--                               "keyword-fallback"), so the fallback
--                               re-judge pass (slack/rejudge.ts) can find
--                               the verdicts no model made
--   SlackEpisode.rejudgedAt     the one re-judge of such a verdict was claimed
--   SlackEpisode.answeredAt     the user replied after the episode's last
--                               message: it never rings from then on
--
-- EXPAND ONLY. Three nullable columns (a catalog update, no table rewrite, no
-- backfill) and one index on a table written only while SLACK_ENABLED is on
-- (off in production, so the table is empty or tiny). The previous instance
-- keeps writing rows without them during the swap; null (unknown source, no
-- re-judge, no reply on record) is correct for those rows, which the re-judge
-- pass therefore never picks.
--
-- No new table, so no new RLS policy: SlackEpisode already has RLS enabled.
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261117100000_slack_rejudge_answered`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "SlackEpisode" ADD COLUMN "verdictSource" TEXT,
ADD COLUMN "rejudgedAt" TIMESTAMP(3),
ADD COLUMN "answeredAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "SlackEpisode_verdictSource_rejudgedAt_lastMessageAt_idx" ON "SlackEpisode"("verdictSource", "rejudgedAt", "lastMessageAt");
