-- Klorn Vault export audit (2026-11-14). See src/vault/vault-audit.ts.
--
-- One row per data export a user starts: format, whether mail text was asked
-- for, the outcome and counts. Never the export's content: the archive is
-- streamed to the user and stored nowhere. The per-user cooldown reads the
-- latest row, so it holds across restarts.
--
-- EXPAND ONLY: one new table, written only while VAULT_EXPORT_ENABLED is on.
-- Safe to apply ahead of the code that writes it.
--
-- RLS as every user-scoped table (docs/rls-rollout.md). Not fenced by the
-- data-wipe trigger: an account action's own audit row, with no mail data
-- (privacy/data-wipe-fence.ts UNFENCED_MODELS).
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261114120000_data_export_audit`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "DataExportAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "includeBodies" BOOLEAN NOT NULL,
    "outcome" TEXT NOT NULL,
    "noteCount" INTEGER,
    "byteCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "DataExportAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DataExportAudit_userId_createdAt_idx" ON "DataExportAudit"("userId", "createdAt");

CREATE INDEX "DataExportAudit_createdAt_idx" ON "DataExportAudit"("createdAt");

ALTER TABLE "DataExportAudit" ADD CONSTRAINT "DataExportAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DataExportAudit" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "DataExportAudit_tenant_isolation" ON "DataExportAudit" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "DataExportAudit_system_bypass" ON "DataExportAudit" USING (current_setting('app.bypass_rls', true) = 'on');
