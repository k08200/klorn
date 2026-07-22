-- Phase 1 retention instrumentation: first-party product-analytics events.
-- Own-Postgres, not a third-party tracker (keeps the Privacy Manifest / Limited
-- Use posture intact). onDelete CASCADE wipes a user's events on account delete.
CREATE TABLE "AnalyticsEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "event" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnalyticsEvent_event_createdAt_idx" ON "AnalyticsEvent"("event", "createdAt");
CREATE INDEX "AnalyticsEvent_userId_event_createdAt_idx" ON "AnalyticsEvent"("userId", "event", "createdAt");
CREATE INDEX "AnalyticsEvent_createdAt_idx" ON "AnalyticsEvent"("createdAt");

ALTER TABLE "AnalyticsEvent" ADD CONSTRAINT "AnalyticsEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-Level Security: permissive + inert (owner bypasses without FORCE), matching
-- 20260714140000_enable_rls_permissive. Installs policies for a future FORCE.
ALTER TABLE "AnalyticsEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "AnalyticsEvent_tenant_isolation" ON "AnalyticsEvent" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "AnalyticsEvent_system_bypass" ON "AnalyticsEvent" USING (current_setting('app.bypass_rls', true) = 'on');
