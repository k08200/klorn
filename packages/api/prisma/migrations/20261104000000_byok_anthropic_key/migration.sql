-- BYOK moves from an OpenRouter key to an Anthropic key: hosted Klorn runs on
-- the Claude API only (founder decision 2026-11-01) and the OpenRouter
-- provider is gone, so a stored OpenRouter key can no longer serve anything.
-- An OpenRouter key cannot be converted into an Anthropic one, so nothing is
-- copied across. Prod held 0 non-null "openRouterApiKey" rows (verified
-- 2026-11-01).
--
-- EXPAND ONLY. start.sh migrates while the previous instance still serves, and
-- that instance reads full User rows (auth, sign-in, billing): dropping a
-- column or writing NULL into a column its client types as required would
-- fail those reads until the swap. So this migration only adds and rewrites
-- values. "openRouterApiKey" is @ignore'd in schema.prisma (no client selects
-- it after this release) and is dropped by a follow-up migration.
--
-- chatModel: "" means unset (the surface default applies). The old default
-- ('google/gemma-4-31b-it:free') was never a catalog id and already read as
-- unset, so those rows become "". The chat catalog is now Claude-only with
-- native ids, so the two Claude picks carry over to their native spelling;
-- GPT/Gemini/Grok picks stay as stored and read as unset (CHAT_MODEL applies).
-- The previous client reads every new value as a non-catalog string: unset.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "anthropicApiKey" TEXT;
ALTER TABLE "User" ALTER COLUMN "chatModel" SET DEFAULT '';
UPDATE "User" SET "chatModel" = '' WHERE "chatModel" = 'google/gemma-4-31b-it:free';
UPDATE "User" SET "chatModel" = 'claude-sonnet-5' WHERE "chatModel" = 'anthropic/claude-sonnet-5';
UPDATE "User" SET "chatModel" = 'claude-opus-4-8' WHERE "chatModel" = 'anthropic/claude-opus-4.8';
