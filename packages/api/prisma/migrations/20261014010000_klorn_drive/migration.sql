-- Klorn drive (2026-10-14): step D3 of docs/providers/unified-platform-plan.md.
--
-- StoragePurge. The objects of an account that are still to be deleted from
-- object storage. A deletion writes this row (OBJECT_STORAGE_ENABLED on) before
-- it tries the bucket, so the account's rows can go even while the bucket is
-- down: this row keeps the user id, the one handle on the objects (`u/<userId>/`).
-- An hourly sweep retries with backoff until a pass that started after the
-- late-upload grace finds the prefix empty, then deletes the row. While it
-- exists, the drive refuses uploads for that user. No foreign key to "User" on
-- purpose: the row must outlive the account. `attempts` is never negative.
--
-- The DriveFile index serves the Klorn drive's folder listing (one folder's
-- children newest first) and its folder walks (cycle check, recursive delete).
-- For KLORN rows a NULL parent is the root: D3 only writes a parent that exists.
--
-- Row-level security on the new table, in the form every per-user table has
-- (20260806033517_add_user_identity): ENABLE, not FORCE, a tenant policy on
-- app.current_user_id and a system policy on app.bypass_rls. Inert while the app
-- connects as a role with BYPASSRLS; the sweep reads every row, so when that role
-- drops BYPASSRLS it moves to withSystem (db-tenant.ts).
--
-- Additive only: one table and two indexes. After
-- 20261010030000_enable_rls_remaining_tables (#1381, the latest on main), whose
-- default-privilege revoke also covers this table: the Data API roles get no
-- grant on it.
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "StoragePurge" (
    "userId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoragePurge_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "StoragePurge_attempts_check" CHECK ("attempts" >= 0)
);

-- CreateIndex
CREATE INDEX "StoragePurge_nextAttemptAt_idx" ON "StoragePurge"("nextAttemptAt");

-- CreateIndex
CREATE INDEX "DriveFile_userId_provider_parentExternalId_modifiedAt_id_idx" ON "DriveFile"("userId", "provider", "parentExternalId", "modifiedAt", "id");

-- Row-level security
ALTER TABLE "StoragePurge" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "StoragePurge_tenant_isolation" ON "StoragePurge" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "StoragePurge_system_bypass" ON "StoragePurge" USING (current_setting('app.bypass_rls', true) = 'on');
