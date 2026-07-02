-- CreateIndex
-- Serves getDecisionMetrics' admin/scheduler-wide query (no userId), which
-- filters DecisionLabel on source + judgedAt only. The userId-leading index
-- cannot serve it, so without this the daily calibration job sequentially
-- scans the entire append-only ledger. Mirrors the LlmUsageLog fix (#578).
CREATE INDEX "DecisionLabel_source_judgedAt_idx" ON "DecisionLabel"("source", "judgedAt");
