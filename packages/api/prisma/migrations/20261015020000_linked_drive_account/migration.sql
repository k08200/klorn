-- Linked drive accounts (2026-10-15): step D5a of
-- docs/providers/unified-platform-plan.md, the schema slice of the Google Drive
-- connector (D5). GOOGLE_DRIVE_ENABLED does not exist yet; nothing reads or
-- writes the new table or column except the user purge and the key-rotation
-- sweep.
--
-- LinkedDriveAccount. A Google Drive (D5) or OneDrive (D6) account linked for
-- its files. Its own table, not LinkedCalendarAccount and not UserToken, so
-- unlinking a drive unlinks nothing else. provider is a DriveProvider with no
-- DEFAULT (the table is new, so no previous release writes it and every writer
-- states it) and a CHECK that it is never KLORN: the Klorn drive has no account.
-- accessToken and refreshToken hold encryptToken ciphers under the
-- TOKEN_ENCRYPTION_KEYS ring, never plain text, and are NOT NULL: the link flow
-- refuses a grant without a refresh token. grantedScopes is the token response's
-- space-delimited scope. email is stored normalised: a CHECK that it equals
-- lower(btrim("email")), so a padded or upper-case address fails loud (23514)
-- instead of making a second row for the same account; the link flow (D5b)
-- trims and lower-cases it first. Unique (userId, provider, email): one row per
-- account. A second unique, (id, userId, provider), is the target of DriveFile's
-- composite foreign key below; redundant as a key, since id is unique. The row
-- goes with its user (the foreign key cascades).
--
-- DriveFile.sourceAccountId. A nullable column with a COMPOSITE foreign key:
-- ("sourceAccountId", "userId", "provider") references LinkedDriveAccount
-- ("id", "userId", "provider"), ON DELETE CASCADE. So the database itself
-- refuses a row that names another user's account, or an account of another
-- provider; the connector also loads the account by (id, userId, provider)
-- before it writes (D5b). MATCH SIMPLE (the default): a row whose
-- sourceAccountId is NULL, every KLORN row, is not checked. Unlinking an
-- account deletes its rows in the database itself, and a write still in flight
-- fails the foreign key instead of leaving an orphan. The cascade reaches
-- DriveFileSummary through its own cascading foreign key
-- (20261014020000_drive_file_summary). Indexed on sourceAccountId alone: the
-- cascade and the unlink look one account's rows up by it, with no userId to
-- lead with (C2's reason, 20261002010000_calendar_linked_source_key), and the
-- account id is a UUID, so the leading column serves the composite lookup too.
--
-- Two CHECKs on DriveFile that Prisma cannot declare (the CI drift check does not
-- see them; linked-drive-account-migration.test.ts pins them):
--   * ("provider" = 'KLORN') = ("sourceAccountId" IS NULL): a KLORN row has no
--     account, and every GOOGLE or ONEDRIVE row names the one it came from.
--   * "sourceAccountId" IS NULL OR "sourceAccountId" = "sourceKey": the account
--     is the source. drive/drive-rows.ts is the only place that derives it, on
--     create only, so the two columns cannot drift.
-- Because the cascade can only reach rows with a sourceAccountId, it never
-- deletes a KLORN row, whose object must be deleted before its row (D3).
--
-- Why the CHECKs hold on existing rows. The first CHECK fails on any non-KLORN
-- DriveFile row, because the new column is NULL on every existing row. None can
-- exist: drive/drive-rows.ts is the only DriveFile writer (drive-file-guard.test.ts,
-- which also proves no raw SQL touches the table), and its only callers
-- (drive/klorn-upload.ts, drive/klorn-tree.ts) pass klornDriveSource, never
-- connectedDriveSource. So every existing row is KLORN, with a NULL
-- sourceAccountId, and both CHECKs hold. The previous release, during the deploy
-- overlap and after a rollback of the code, writes only KLORN rows and omits the
-- column (NULL), so the CHECKs hold for every row it writes too.
--
-- Row-level security on the new table, in the form every per-user table has
-- (20260806033517_add_user_identity): ENABLE, not FORCE, a tenant policy on
-- app.current_user_id and a system policy on app.bypass_rls. Inert while the app
-- connects as a role with BYPASSRLS; the D5d refresh job reads every user's
-- accounts, so when that role drops BYPASSRLS it moves to withSystem
-- (db-tenant.ts). The default-privilege revoke of
-- 20261010020000_revoke_data_api_table_grants (#1381) covers the new table: the
-- Data API roles get no grant on it.
--
-- Locks and cost. Every LinkedDriveAccount statement runs first, every
-- DriveFile statement last, so the locks are taken in one order: the "User"
-- foreign key takes SHARE ROW EXCLUSIVE on "User" before anything touches
-- "DriveFile", and ACCESS EXCLUSIVE on "DriveFile" is never held while waiting
-- for "User". ADD COLUMN (nullable, no default) is metadata-only but takes
-- ACCESS EXCLUSIVE on "DriveFile", and Prisma runs the whole migration in one
-- transaction, so reads of "DriveFile" are blocked until commit. The index
-- build, the foreign-key validation and the two CHECK validations scan
-- "DriveFile" under that lock; the composite foreign key's SHARE ROW EXCLUSIVE
-- on "LinkedDriveAccount" is on a table this transaction created and already
-- holds. CONCURRENTLY is illegal inside a transaction. Production's DriveFile size was
-- not measured for this text (no production access from the authoring session);
-- the preflight below measures it. lock_timeout makes a deploy blocked by a long
-- transaction fail fast instead of queueing behind it.
--
-- Runbook.
--   * Preflight: SELECT count(*) FROM "DriveFile" WHERE "provider" <> 'KLORN'
--     must be 0 (see above). Above 0, the first CHECK fails this migration: stop
--     and find the writer before deploying anything.
--     SELECT count(*) FROM "DriveFile" gives the size the locks scan.
--   * If this migration fails (lock_timeout, or a CHECK), Prisma records it as
--     failed and refuses every later deploy with P3009. The transaction rolled
--     back, so recover with:
--     prisma migrate resolve --rolled-back 20261015020000_linked_drive_account
--     and redeploy.
--   * Rollback: revert the code; the schema can stay (an empty table and a NULL
--     column the previous release never names). If GOOGLE_DRIVE_ENABLED was ever
--     on: turn it off, DELETE FROM "LinkedDriveAccount" (the cascade takes the
--     files and their summaries), then revert.
--
-- Additive only: one table, one nullable column, three indexes, two foreign
-- keys, four CHECKs. After 20261015010000_auto_unsubscribe_caps (the latest on main
-- when this was written), with a timestamp of its own.
SET LOCAL lock_timeout = '5s';

-- LinkedDriveAccount: everything on the new table first (see "Locks and cost").

-- CreateTable
CREATE TABLE "LinkedDriveAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "DriveProvider" NOT NULL,
    "email" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "grantedScopes" TEXT NOT NULL,
    "needsReconnect" BOOLEAN NOT NULL DEFAULT false,
    "lastRefreshedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedDriveAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LinkedDriveAccount_provider_not_klorn_check" CHECK ("provider" <> 'KLORN'),
    CONSTRAINT "LinkedDriveAccount_email_normalized_check" CHECK ("email" = lower(btrim("email")))
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkedDriveAccount_userId_provider_email_key" ON "LinkedDriveAccount"("userId", "provider", "email");

-- CreateIndex (the composite foreign key's target)
CREATE UNIQUE INDEX "LinkedDriveAccount_id_userId_provider_key" ON "LinkedDriveAccount"("id", "userId", "provider");

-- AddForeignKey
ALTER TABLE "LinkedDriveAccount" ADD CONSTRAINT "LinkedDriveAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security
ALTER TABLE "LinkedDriveAccount" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "LinkedDriveAccount_tenant_isolation" ON "LinkedDriveAccount" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "LinkedDriveAccount_system_bypass" ON "LinkedDriveAccount" USING (current_setting('app.bypass_rls', true) = 'on');

-- DriveFile: last.

-- AlterTable
ALTER TABLE "DriveFile" ADD COLUMN "sourceAccountId" TEXT;

-- CreateIndex
CREATE INDEX "DriveFile_sourceAccountId_idx" ON "DriveFile"("sourceAccountId");

-- AddForeignKey (composite, MATCH SIMPLE)
ALTER TABLE "DriveFile" ADD CONSTRAINT "DriveFile_sourceAccountId_userId_provider_fkey" FOREIGN KEY ("sourceAccountId", "userId", "provider") REFERENCES "LinkedDriveAccount"("id", "userId", "provider") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECKs (see above)
ALTER TABLE "DriveFile" ADD CONSTRAINT "DriveFile_sourceAccountId_klorn_check" CHECK (("provider" = 'KLORN') = ("sourceAccountId" IS NULL));
ALTER TABLE "DriveFile" ADD CONSTRAINT "DriveFile_sourceAccountId_sourceKey_check" CHECK ("sourceAccountId" IS NULL OR "sourceAccountId" = "sourceKey");
