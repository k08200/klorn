-- Convert EmailRule.conditions from TEXT (JSON-as-String) to JSONB.
-- Audited 2026-05-19: every existing row was written by routes/email-rules.ts
-- via JSON.stringify({ from?, subjectContains?, category? }), so the cast
-- below should succeed for every row. If a row turns out to be malformed
-- (very unlikely — there is no other writer), deploy fails fast and a
-- one-off SQL fix is preferable to silent data loss.

ALTER TABLE "EmailRule"
  ALTER COLUMN "conditions" TYPE JSONB
  USING "conditions"::jsonb;
