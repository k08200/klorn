-- Contract step of the OpenRouter removal (#1611). The expand step
-- (20261104000000_byok_anthropic_key) made "openRouterApiKey" an @ignore'd
-- column, so the client deployed since 2026-11-04 (bcbf7fdc) never selects it;
-- dropping it now cannot break a still-serving instance's User reads.
-- Prod held 0 non-null rows (verified 2026-11-04 before this migration).
ALTER TABLE "User" DROP COLUMN IF EXISTS "openRouterApiKey";
