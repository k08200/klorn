-- Drive file index (2026-10-03): step D2 of
-- docs/providers/unified-platform-plan.md.
--
-- One row per file or folder of one source, as metadata only: what the drive
-- surfaces list and search. The bytes stay in the source (GOOGLE, ONEDRIVE) or in
-- object storage (KLORN; step D1). There is no content column and no summary
-- state (D4 keeps that in a table of its own).
--
-- Providers. KLORN, GOOGLE, ONEDRIVE. There is no DEVICE value: a device import
-- (D7) lands in the Klorn drive, so its rows are KLORN, and Postgres cannot remove
-- an enum value once it exists.
--
-- Identity. (userId, provider, sourceKey, externalId): the same upstream id can
-- exist once per source. sourceKey is 'klorn' for the user's Klorn drive and the
-- connector's account id for GOOGLE and ONEDRIVE (D5, D6). provider and sourceKey
-- have no DEFAULT: the table is new, so no previous release writes it and every
-- writer states both.
--
-- parentExternalId NULL means "no known parent row": the source's root, OR a
-- parent that was never indexed (a file picked through the Google Picker under
-- drive.file reports a parent the user never picked). It is not "at the root".
--
-- No account table and no foreign key from sourceKey. D2 has no connector, so a
-- credentials table would have no writer; D5 and D6 add theirs with their grant
-- flow, and the foreign key with it (as C2 did for CalendarEvent).
--
-- Three CHECKs Prisma cannot declare (the CI drift check does not see them; the
-- test drive-file-migration.test.ts pins them):
--   * webUrl is NULL or starts with 'https://'. An external file's link reaches
--     an <a href> and a native open; nothing but https is ever stored.
--   * storageKey is NULL unless the provider is KLORN, the one provider whose
--     bytes Klorn holds. An external connector's row never points at an object.
--   * sizeBytes is NULL or not negative.
--
-- Indexes. The unique above; (userId, modifiedAt, id) for the list and the name
-- search, which read one user's rows newest first, keyset-paged on
-- (modifiedAt, id), scanned backward; and (userId, provider, modifiedAt, id) for
-- the same list narrowed to one provider. The name search is ILIKE within that
-- user's rows; no pg_trgm extension is created.
--
-- Row-level security, in the form every per-user table has
-- (20260806033517_add_user_identity): ENABLE, not FORCE, with a tenant policy on
-- app.current_user_id and a system policy on app.bypass_rls. Inert while the app
-- connects as a role with BYPASSRLS; it binds when the app role drops that
-- (docs/rls-rollout.md), at which point the drive reads move to withTenant.
--
-- Additive only: one enum, one table. Nothing existing is altered, so the
-- previous release is unaffected and a rollback of the code needs no schema step.
-- After 20261007010000_linked_calendar_display_name (main), with a timestamp of
-- its own.
-- Fail fast instead of queueing behind a long lock (same guard as 20261007010000).
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "DriveProvider" AS ENUM ('KLORN', 'GOOGLE', 'ONEDRIVE');

-- CreateTable
CREATE TABLE "DriveFile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "DriveProvider" NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT,
    "isFolder" BOOLEAN NOT NULL DEFAULT false,
    "sizeBytes" BIGINT,
    "parentExternalId" TEXT,
    "modifiedAt" TIMESTAMP(3) NOT NULL,
    "webUrl" TEXT,
    "storageKey" TEXT,
    "etag" TEXT,
    "trashed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveFile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DriveFile_webUrl_https_check" CHECK ("webUrl" IS NULL OR "webUrl" LIKE 'https://%'),
    CONSTRAINT "DriveFile_storageKey_klorn_check" CHECK ("storageKey" IS NULL OR "provider" = 'KLORN'),
    CONSTRAINT "DriveFile_sizeBytes_check" CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0)
);

-- CreateIndex
CREATE INDEX "DriveFile_userId_modifiedAt_id_idx" ON "DriveFile"("userId", "modifiedAt", "id");

-- CreateIndex
CREATE INDEX "DriveFile_userId_provider_modifiedAt_id_idx" ON "DriveFile"("userId", "provider", "modifiedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DriveFile_userId_provider_sourceKey_externalId_key" ON "DriveFile"("userId", "provider", "sourceKey", "externalId");

-- AddForeignKey
ALTER TABLE "DriveFile" ADD CONSTRAINT "DriveFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security
ALTER TABLE "DriveFile" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "DriveFile_tenant_isolation" ON "DriveFile" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "DriveFile_system_bypass" ON "DriveFile" USING (current_setting('app.bypass_rls', true) = 'on');
