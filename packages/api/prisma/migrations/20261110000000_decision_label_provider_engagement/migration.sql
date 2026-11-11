-- Provider-side engagement on the decision ledger: when the user first replied
-- to, or archived, a judged mail in the mail provider itself (Gmail), as seen
-- by sync — the Sent-folder scan and the INBOX reconcile — rather than by a
-- Klorn route. Own columns so Klorn and provider engagement stay separable and
-- neither overwrites the other. Additive and nullable: no backfill, no table
-- rewrite (a catalog update per column).
ALTER TABLE "DecisionLabel" ADD COLUMN "providerRepliedAt" TIMESTAMP(3);
ALTER TABLE "DecisionLabel" ADD COLUMN "providerArchivedAt" TIMESTAMP(3);
