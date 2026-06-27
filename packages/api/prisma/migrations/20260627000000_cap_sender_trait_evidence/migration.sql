-- Cap SenderTrait evidence columns at VARCHAR(300). The extractor truncates
-- verbatim quotes to 200 chars; the column bound is the DB-level safety net
-- against an unbounded model quote overflowing the row.
ALTER TABLE "SenderTrait" ALTER COLUMN "evidenceText" SET DATA TYPE VARCHAR(300),
                          ALTER COLUMN "conflictEvidence" SET DATA TYPE VARCHAR(300);
