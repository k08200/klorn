-- Telegram delivery fields on User (BYO BotFather bot for self-hosters).
--
-- telegramChatId is the chat bound to this account for outbound PUSH-tier
-- interrupts; unique so one chat can never receive two users' mail signal.
-- telegramLinkCode is the one-time code minted by POST /api/telegram/link
-- and consumed by the bot webhook's `/start <code>` handler; unique so the
-- webhook lookup is exact, expiry enforced in code (10 minutes).

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "telegramChatId" TEXT,
  ADD COLUMN IF NOT EXISTS "telegramLinkCode" TEXT,
  ADD COLUMN IF NOT EXISTS "telegramLinkCodeExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "User_telegramChatId_key"
  ON "User"("telegramChatId");

CREATE UNIQUE INDEX IF NOT EXISTS "User_telegramLinkCode_key"
  ON "User"("telegramLinkCode");
