-- Engagement signals on the decision ledger: when the user first opened,
-- replied to, archived, dismissed, snoozed, starred or unsubscribed from each
-- judged item. Additive and nullable: existing rows read as "no signal yet",
-- no backfill, no table rewrite (a catalog update per column).
--
-- Kept apart from "outcome" on purpose: fallback-rejudge selects outcome IS
-- NULL rows and the override/confirm stamps only write while outcome IS NULL,
-- so an open recorded there would stop re-judging and block a later lane move.
ALTER TABLE "DecisionLabel" ADD COLUMN "openedAt" TIMESTAMP(3);
ALTER TABLE "DecisionLabel" ADD COLUMN "repliedAt" TIMESTAMP(3);
ALTER TABLE "DecisionLabel" ADD COLUMN "archivedAt" TIMESTAMP(3);
ALTER TABLE "DecisionLabel" ADD COLUMN "dismissedAt" TIMESTAMP(3);
ALTER TABLE "DecisionLabel" ADD COLUMN "snoozedAt" TIMESTAMP(3);
ALTER TABLE "DecisionLabel" ADD COLUMN "starredAt" TIMESTAMP(3);
ALTER TABLE "DecisionLabel" ADD COLUMN "unsubscribedAt" TIMESTAMP(3);
