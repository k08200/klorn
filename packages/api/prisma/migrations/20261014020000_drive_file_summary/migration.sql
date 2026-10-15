-- Drive file summaries (2026-10-14): step D4 of docs/providers/unified-platform-plan.md.
--
-- DriveFileSummary. One row per drive file: the summary's state and text, kept
-- apart from DriveFile so the metadata index stays metadata only (D2). Written by
-- drive/summary-store.ts only. The extracted file text is never stored; the
-- summary is model output, capped by the CHECK below. `error` holds a code, never
-- a provider message (the CHECK keeps it to lower-case words and hyphens). The
-- row goes with its file and with its user (both foreign keys cascade).
--
-- DriveSummaryUsage. Summary calls per user per UTC day: the per-user daily
-- count cap. Its own ledger, so deleting a file does not give its count back.
--
-- Row-level security on both tables, in the form every per-user table has
-- (20260806033517_add_user_identity): ENABLE, not FORCE, a tenant policy on
-- app.current_user_id and a system policy on app.bypass_rls. Inert while the app
-- connects as a role with BYPASSRLS; the summary job reads every user's due rows,
-- so when that role drops BYPASSRLS it moves to withSystem (db-tenant.ts).
--
-- Additive only: one enum, two tables, four indexes, three foreign keys. After
-- 20261014010000_klorn_drive (D3), whose DriveFile rows it summarises. The
-- default-privilege revoke of 20261010020000_revoke_data_api_table_grants (#1381)
-- covers both tables: the Data API roles get no grant on them.
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "DriveSummaryStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "DriveFileSummary" (
    "id" TEXT NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "DriveSummaryStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT,
    "sourceEtag" TEXT,
    "model" TEXT,
    "costMicroCents" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "outageStreak" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runsDayKey" TEXT,
    "runsToday" INTEGER NOT NULL DEFAULT 0,
    "summarizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveFileSummary_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DriveFileSummary_summary_check" CHECK ("summary" IS NULL OR char_length("summary") <= 1000),
    CONSTRAINT "DriveFileSummary_error_check" CHECK ("error" IS NULL OR "error" ~ '^[a-z][a-z-]{0,63}$'),
    CONSTRAINT "DriveFileSummary_counts_check" CHECK ("costMicroCents" >= 0 AND "attempts" >= 0 AND "outageStreak" >= 0 AND "runsToday" >= 0)
);

-- CreateTable
CREATE TABLE "DriveSummaryUsage" (
    "userId" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveSummaryUsage_pkey" PRIMARY KEY ("userId","dayKey"),
    CONSTRAINT "DriveSummaryUsage_count_check" CHECK ("count" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "DriveFileSummary_driveFileId_key" ON "DriveFileSummary"("driveFileId");

-- CreateIndex
CREATE INDEX "DriveFileSummary_status_nextAttemptAt_idx" ON "DriveFileSummary"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "DriveFileSummary_userId_status_summarizedAt_idx" ON "DriveFileSummary"("userId", "status", "summarizedAt");

-- CreateIndex
CREATE INDEX "DriveSummaryUsage_dayKey_idx" ON "DriveSummaryUsage"("dayKey");

-- AddForeignKey
ALTER TABLE "DriveFileSummary" ADD CONSTRAINT "DriveFileSummary_driveFileId_fkey" FOREIGN KEY ("driveFileId") REFERENCES "DriveFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriveFileSummary" ADD CONSTRAINT "DriveFileSummary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriveSummaryUsage" ADD CONSTRAINT "DriveSummaryUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security
ALTER TABLE "DriveFileSummary" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "DriveFileSummary_tenant_isolation" ON "DriveFileSummary" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "DriveFileSummary_system_bypass" ON "DriveFileSummary" USING (current_setting('app.bypass_rls', true) = 'on');
ALTER TABLE "DriveSummaryUsage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "DriveSummaryUsage_tenant_isolation" ON "DriveSummaryUsage" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "DriveSummaryUsage_system_bypass" ON "DriveSummaryUsage" USING (current_setting('app.bypass_rls', true) = 'on');
