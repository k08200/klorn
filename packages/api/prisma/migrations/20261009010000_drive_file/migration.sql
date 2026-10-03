-- Drive file index (2026-10-03): step D2 of
-- docs/providers/unified-platform-plan.md.
--
-- One row per file or folder of one source, as metadata only: what the drive
-- surfaces list and search. The bytes stay in the source (GOOGLE, ONEDRIVE) or in
-- object storage (KLORN, DEVICE; step D1). There is no content column.
--
-- Identity. (userId, provider, sourceKey, externalId): the same upstream id can
-- exist once per source. sourceKey is 'klorn' for the user's Klorn drive, the
-- connector's account id for GOOGLE and ONEDRIVE (D5, D6) and the device source
-- key for DEVICE (D7). provider and sourceKey have no DEFAULT: the table is new,
-- so no previous release writes it and every writer states both.
--
-- No account table and no foreign key from sourceKey. D2 has no connector, so a
-- credentials table would have no writer; D5 and D6 add theirs with their grant
-- flow, and the foreign key with it (as C2 did for CalendarEvent).
--
-- Two CHECKs Prisma cannot declare (the CI drift check does not see them; the
-- test drive-file-migration.test.ts pins them):
--   * webUrl is NULL or starts with 'https://'. An external file's link reaches
--     an <a href> and a native open; nothing but https is ever stored.
--   * storageKey is NULL unless the provider is one whose bytes Klorn holds
--     (KLORN, DEVICE). An external connector's row never points at an object.
--
-- Indexes. The unique above, and (userId, modifiedAt, id) for the list and the
-- name search: both read one user's rows newest first, keyset-paged on
-- (modifiedAt, id), scanned backward. The name search is ILIKE within that
-- user's rows; no pg_trgm extension is created.
--
-- No row-level-security policy: like every table created since 20260806033517,
-- it joins the backlog in docs/rls-rollout.md.
--
-- Additive only: one enum, one table. Nothing existing is altered, so the
-- previous release is unaffected and a rollback of the code needs no schema step.
-- Slotted after 20261007010000_linked_calendar_display_name (main), with a
-- timestamp of its own.
-- Fail fast instead of queueing behind a long lock (same guard as 20261007010000).
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "DriveProvider" AS ENUM ('KLORN', 'GOOGLE', 'ONEDRIVE', 'DEVICE');

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
    "readOnly" BOOLEAN NOT NULL DEFAULT true,
    "trashed" BOOLEAN NOT NULL DEFAULT false,
    "summaryStatus" TEXT NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveFile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DriveFile_webUrl_https_check" CHECK ("webUrl" IS NULL OR "webUrl" LIKE 'https://%'),
    CONSTRAINT "DriveFile_storageKey_klorn_held_check" CHECK ("storageKey" IS NULL OR "provider" IN ('KLORN', 'DEVICE'))
);

-- CreateIndex
CREATE INDEX "DriveFile_userId_modifiedAt_id_idx" ON "DriveFile"("userId", "modifiedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DriveFile_userId_provider_sourceKey_externalId_key" ON "DriveFile"("userId", "provider", "sourceKey", "externalId");

-- AddForeignKey
ALTER TABLE "DriveFile" ADD CONSTRAINT "DriveFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
