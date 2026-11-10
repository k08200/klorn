-- Inbox purpose (2026-08-31): what each mailbox is FOR — 'work' |
-- 'personal' | 'mixed', null until the user says. Feeds the analysis
-- prompts: a personal inbox must not be scored as a work inbox. Declared by
-- the user, never inferred.
--
-- Additive only: two nullable columns, no backfill. Safe to apply ahead of
-- the code that writes them.

ALTER TABLE "User" ADD COLUMN "primaryInboxPurpose" TEXT;
ALTER TABLE "LinkedInboxAccount" ADD COLUMN "purpose" TEXT;
