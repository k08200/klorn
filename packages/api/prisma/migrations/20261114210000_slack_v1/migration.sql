-- Slack integration v1 (2026-11-14). See docs/providers/slack.md.
--
-- SlackConnection: one internal Slack app per user — the hookId that routes
-- its Events API requests, the team / Slack user it belongs to, and the
-- signing secret encrypted with crypto-tokens.ts (never plaintext; the
-- user token is checked with auth.test on connect and never stored).
-- SlackEpisode: one burst of conversation and the lane it was judged into
-- (verdict and short reason kept 90 days). SlackMessage: a kept
-- message's text, purged 7 days after receipt; the unique
-- (connectionId, eventId) turns a Slack retry or replay into a no-op.
--
-- EXPAND ONLY: three new tables, written only while SLACK_ENABLED is on.
-- Safe to apply ahead of the code that writes them.
--
-- RLS as every user-scoped table (docs/rls-rollout.md). All three are fenced
-- by the data-wipe trigger (privacy/data-wipe-fence.ts FENCED_MODELS): a
-- Slack event landing during an account wipe must not re-create user data.
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261114210000_slack_v1` and redeploy.
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "SlackConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hookId" TEXT NOT NULL,
    "teamId" TEXT,
    "slackUserId" TEXT,
    "workspaceUrl" TEXT,
    "signingSecretCipher" TEXT,
    "optInChannelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "credentialsSetAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlackConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlackEpisode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "channelType" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "mentionsUser" BOOLEAN NOT NULL DEFAULT false,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "firstTs" TEXT NOT NULL,
    "lastTs" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "tier" TEXT,
    "reason" TEXT,
    "judgedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackEpisode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlackMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "ts" TEXT NOT NULL,
    "threadTs" TEXT,
    "senderId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlackMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SlackConnection_userId_key" ON "SlackConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SlackConnection_hookId_key" ON "SlackConnection"("hookId");

-- CreateIndex
CREATE INDEX "SlackEpisode_connectionId_channelId_threadKey_status_idx" ON "SlackEpisode"("connectionId", "channelId", "threadKey", "status");

-- CreateIndex
CREATE INDEX "SlackEpisode_connectionId_status_idx" ON "SlackEpisode"("connectionId", "status");

-- CreateIndex
CREATE INDEX "SlackEpisode_status_lastMessageAt_idx" ON "SlackEpisode"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "SlackEpisode_userId_createdAt_idx" ON "SlackEpisode"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SlackEpisode_createdAt_idx" ON "SlackEpisode"("createdAt");

-- CreateIndex
CREATE INDEX "SlackMessage_connectionId_channelId_ts_idx" ON "SlackMessage"("connectionId", "channelId", "ts");

-- CreateIndex
CREATE INDEX "SlackMessage_connectionId_createdAt_idx" ON "SlackMessage"("connectionId", "createdAt");

-- CreateIndex
CREATE INDEX "SlackMessage_episodeId_idx" ON "SlackMessage"("episodeId");

-- CreateIndex
CREATE INDEX "SlackMessage_createdAt_idx" ON "SlackMessage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SlackMessage_connectionId_eventId_key" ON "SlackMessage"("connectionId", "eventId");

-- AddForeignKey
ALTER TABLE "SlackConnection" ADD CONSTRAINT "SlackConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackEpisode" ADD CONSTRAINT "SlackEpisode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackEpisode" ADD CONSTRAINT "SlackEpisode_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SlackConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackMessage" ADD CONSTRAINT "SlackMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackMessage" ADD CONSTRAINT "SlackMessage_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SlackConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackMessage" ADD CONSTRAINT "SlackMessage_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "SlackEpisode"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "SlackConnection" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SlackConnection_tenant_isolation" ON "SlackConnection" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "SlackConnection_system_bypass" ON "SlackConnection" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "SlackEpisode" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SlackEpisode_tenant_isolation" ON "SlackEpisode" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "SlackEpisode_system_bypass" ON "SlackEpisode" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "SlackMessage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SlackMessage_tenant_isolation" ON "SlackMessage" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "SlackMessage_system_bypass" ON "SlackMessage" USING (current_setting('app.bypass_rls', true) = 'on');

CREATE TRIGGER "SlackConnection_data_wipe_fence" BEFORE INSERT ON "SlackConnection" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "SlackEpisode_data_wipe_fence" BEFORE INSERT ON "SlackEpisode" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "SlackMessage_data_wipe_fence" BEFORE INSERT ON "SlackMessage" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
