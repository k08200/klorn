-- Serve the userId-less global decay scan (amplifyStaleAttentionItems):
-- filters status + surfacedAt with no userId, so the userId-leading indexes
-- cannot be used and it would seq-scan the whole table as rows accumulate.
CREATE INDEX "AttentionItem_status_surfacedAt_idx" ON "AttentionItem"("status", "surfacedAt");

-- Serve the admin-wide / ontology-calibration aggregation (getDecisionMetrics
-- with no userId): filters source + judgedAt only. Mirrors the standalone
-- LlmUsageLog_createdAt_idx added for the same userId-less aggregation pattern.
CREATE INDEX "DecisionLabel_source_judgedAt_idx" ON "DecisionLabel"("source", "judgedAt");
