ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "openRouterApiKey" TEXT,
  ADD COLUMN IF NOT EXISTS "geminiApiKey" TEXT;

ALTER TABLE "AutomationConfig"
  ALTER COLUMN "briefingTime" SET DEFAULT '06:00';

UPDATE "AutomationConfig"
SET "briefingTime" = '06:00'
WHERE "briefingTime" = '07:30';
