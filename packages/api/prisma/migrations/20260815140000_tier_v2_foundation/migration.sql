-- Ontology v2 foundation (docs/design/tier-ontology-v2.md). Additive only;
-- classification behavior is unchanged until TIER_V2_ENABLED flips.
ALTER TABLE "AttentionItem" ADD COLUMN "autoEligible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutomationConfig" ADD COLUMN "attentionMode" TEXT NOT NULL DEFAULT 'BASIC';
ALTER TABLE "AutomationConfig" ADD COLUMN "autoReplyGuideline" TEXT;
