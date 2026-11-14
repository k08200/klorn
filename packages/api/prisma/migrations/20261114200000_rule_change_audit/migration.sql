-- Rules DSL apply audit (2026-11-14). See src/mail/rules-dsl-store.ts.
--
-- One row per Rules DSL apply: counts of lane pins added, changed and removed,
-- and a SHA-256 of the applied text. Never the rules themselves (no names,
-- senders or lanes).
--
-- EXPAND ONLY: one new table, written only while RULES_DSL_ENABLED is on.
-- Safe to apply ahead of the code that writes it.
--
-- RLS as every user-scoped table (docs/rls-rollout.md). Not fenced by the
-- data-wipe trigger: an account action's own audit row, with no mail data
-- (privacy/data-wipe-fence.ts UNFENCED_MODELS).
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261114200000_rule_change_audit`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "RuleChangeAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ruleCount" INTEGER NOT NULL,
    "addedCount" INTEGER NOT NULL,
    "changedCount" INTEGER NOT NULL,
    "removedCount" INTEGER NOT NULL,
    "textHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleChangeAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RuleChangeAudit_userId_createdAt_idx" ON "RuleChangeAudit"("userId", "createdAt");

CREATE INDEX "RuleChangeAudit_createdAt_idx" ON "RuleChangeAudit"("createdAt");

ALTER TABLE "RuleChangeAudit" ADD CONSTRAINT "RuleChangeAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RuleChangeAudit" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "RuleChangeAudit_tenant_isolation" ON "RuleChangeAudit" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "RuleChangeAudit_system_bypass" ON "RuleChangeAudit" USING (current_setting('app.bypass_rls', true) = 'on');
