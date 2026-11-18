-- Retired notification languages (founder decision 2026-11-17): Klorn ships
-- English, Korean and Simplified Chinese only. Settings (GET/PATCH
-- /api/automations, shipped-languages.ts) already reads and writes a stored
-- ja/es/fr/de as English; this folds the stored value too, so every reader of
-- AutomationConfig.notificationLanguage (pushes, briefings, digests) agrees
-- with what Settings shows, instead of a picker reading "English" over
-- notifications still arriving in the retired language.
--
-- DATA ONLY, one statement, no schema change. Exactly the four retired codes
-- are touched; any other value is left for the readers' own fallback.
-- One-way: the retired value is not kept (the language no longer ships).
SET LOCAL lock_timeout = '5s';

UPDATE "AutomationConfig"
SET "notificationLanguage" = 'en'
WHERE "notificationLanguage" IN ('ja', 'es', 'fr', 'de');
