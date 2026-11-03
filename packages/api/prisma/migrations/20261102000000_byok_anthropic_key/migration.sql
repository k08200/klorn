-- BYOK moves from an OpenRouter key to an Anthropic key: hosted Klorn runs on
-- the Claude API only (founder decision 2026-11-01) and the OpenRouter
-- provider is gone, so a stored OpenRouter key can no longer serve anything.
--
-- An OpenRouter key cannot be converted into an Anthropic one, so nothing is
-- copied across. Prod held 0 non-null "openRouterApiKey" rows when this
-- shipped (verified 2026-11-01); any key saved after that check is a dead
-- credential under the new code, and dropping it is the privacy-correct
-- outcome. ADD before DROP and IF [NOT] EXISTS so a re-run is a no-op; both
-- are catalog-only changes (nullable, no default, no table rewrite).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "anthropicApiKey" TEXT;
ALTER TABLE "User" DROP COLUMN IF EXISTS "openRouterApiKey";

-- chatModel: null now means "unset — the surface default applies". The old
-- default ('google/gemma-4-31b-it:free') was never a catalog id and already
-- read as unset; existing rows holding it become NULL. The chat catalog is
-- now Claude-only with native ids, so the two Claude picks carry over to
-- their native spelling; GPT/Gemini/Grok picks are left as stored and read
-- as unset (the chat surface falls back to CHAT_MODEL).
ALTER TABLE "User" ALTER COLUMN "chatModel" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "chatModel" DROP NOT NULL;
UPDATE "User" SET "chatModel" = NULL WHERE "chatModel" = 'google/gemma-4-31b-it:free';
UPDATE "User" SET "chatModel" = 'claude-sonnet-5' WHERE "chatModel" = 'anthropic/claude-sonnet-5';
UPDATE "User" SET "chatModel" = 'claude-opus-4-8' WHERE "chatModel" = 'anthropic/claude-opus-4.8';
