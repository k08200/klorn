-- Convert EmailAttachment.keyPoints + extractedFields from TEXT
-- (JSON-as-String) to JSONB. Audited 2026-05-19: writers are the
-- attachment-analysis pipeline (email-attachments.ts) and the
-- correction endpoint (routes/email.ts), both of which serialize via
-- JSON.stringify of a string[] / flat object. NULLs stay NULL.

ALTER TABLE "EmailAttachment"
  ALTER COLUMN "keyPoints" TYPE JSONB
  USING (CASE WHEN "keyPoints" IS NULL THEN NULL ELSE "keyPoints"::jsonb END);

ALTER TABLE "EmailAttachment"
  ALTER COLUMN "extractedFields" TYPE JSONB
  USING (CASE WHEN "extractedFields" IS NULL THEN NULL ELSE "extractedFields"::jsonb END);
