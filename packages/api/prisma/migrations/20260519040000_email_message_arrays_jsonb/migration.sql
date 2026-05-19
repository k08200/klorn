-- Convert EmailMessage.keyPoints + actionItems from TEXT (JSON-as-String)
-- to JSONB. Audited 2026-05-19: both columns are exclusively written by
-- email-sync.ts via JSON.stringify(string[]) from the email-summarizer
-- output, so every existing row is either NULL or a JSON array literal.
--
-- The cast is safe per row. NULLs stay NULL — JSONB still accepts NULL
-- because the columns remain optional.

ALTER TABLE "EmailMessage"
  ALTER COLUMN "keyPoints" TYPE JSONB
  USING (CASE WHEN "keyPoints" IS NULL THEN NULL ELSE "keyPoints"::jsonb END);

ALTER TABLE "EmailMessage"
  ALTER COLUMN "actionItems" TYPE JSONB
  USING (CASE WHEN "actionItems" IS NULL THEN NULL ELSE "actionItems"::jsonb END);
