-- Company domains (2026-09-10): the email domains the user declares as
-- THEIR company. A sender on one is 회사 (internal) as a recorded fact —
-- feeds the row chip and the analysis preamble. Validated hostnames only,
-- at most 10 (company-domains.ts).
--
-- Additive only: one array column with an empty default, no backfill. Safe
-- to apply ahead of the code that writes it.

ALTER TABLE "User" ADD COLUMN "companyDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
