-- Rollout instrumentation for CONTACT_ENGAGEMENT_IN_JUDGE: record which learned-
-- engagement grounding (if any) fed each decision. Nullable, no backfill — old
-- rows stay null ("no grounding recorded"), matching pre-feature reality.
ALTER TABLE "DecisionLabel" ADD COLUMN "engagementKind" TEXT;
