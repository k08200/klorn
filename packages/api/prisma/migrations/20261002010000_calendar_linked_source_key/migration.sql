-- Linked-calendar event identity (2026-09-30): step C2 of
-- docs/providers/unified-platform-plan.md. C2 syncs each linked GOOGLE calendar
-- into CalendarEvent rows, and the same Google event id can live in the primary
-- calendar AND in a linked one (an invite to both addresses). C1's unique
-- (userId, provider, externalId) cannot hold both rows, so this migration
-- replaces it. Gate (a) of the C1 database review: decided here, before any
-- linked row is written.
--
-- Decision. CalendarEvent gets `sourceKey TEXT NOT NULL DEFAULT 'primary'`: the
-- primary calendar and LOCAL rows are 'primary', a linked row is its
-- LinkedCalendarAccount id. The identity of a synced event becomes
-- (userId, provider, sourceKey, externalId): one row per event PER SOURCE
-- CALENDAR. Both copies of an invite exist; readers dedupe by externalId at
-- read time (pim/calendar-dedupe.ts) and prefer the primary copy. Linked rows
-- keep googleId NULL, so they can never collide with the legacy
-- (userId, googleId) unique and no googleId lookup ever lands on one.
--
-- sourceKey duplicates COALESCE(sourceAccountId, 'primary'). A CHECK enforces
-- that, and pim/calendar-rows.ts is the only place that derives it, so the two
-- columns cannot drift.
--
-- Unlinking (gate b). sourceAccountId becomes a foreign key to
-- LinkedCalendarAccount with ON DELETE CASCADE, so deleting an account deletes
-- its events in the database itself. The unlink route also deletes them
-- explicitly in its own transaction (it needs their ids to clear the matching
-- AttentionItems); the cascade is the backstop for what no route can see: a
-- sync that is mid-flight when the account is unlinked (its insert then fails
-- the foreign key instead of leaving an orphan that keeps showing), and the
-- previous release's unlink route after a rollback. C1 left this open on
-- purpose ("a foreign key with ON DELETE CASCADE, or delete in the same
-- transaction"); both are used. The previous release only ever writes NULL here.
--
-- Why not the alternatives:
--   * Keep C1's unique and make linked rows collide. A linked row for event X
--     would block the PREVIOUS release's insert of primary event X with a unique
--     violation on an index that is not its ON CONFLICT target, so its whole
--     sync throws. C1's index must go; nothing the previous release writes
--     names it.
--   * A COALESCE("sourceAccountId", ...) expression unique index. Prisma cannot
--     declare it (the CI drift check would flag it, or raw SQL would be needed
--     for every change) and Prisma's upsert cannot target it.
--   * UNIQUE NULLS NOT DISTINCT on (userId, provider, sourceAccountId,
--     externalId). Postgres 15+ only, and Prisma cannot declare it either.
--   * A sentinel value in sourceAccountId itself. C1 shipped that field
--     nullable on the wire (NULL = primary), and the previous release writes
--     NULL, so a non-null sentinel would change the wire and break overlap.
--
-- Deploy overlap and rollback, checked against a scratch Postgres 16 with the
-- previous release's generated client (see the plan's C2 block). Its writers'
-- conflict targets all survive this migration:
--   * CalendarEvent Google sync upsert: ON CONFLICT ("userId", "googleId"), the
--     untouched legacy unique.
--   * LinkedCalendarAccount link upsert: ON CONFLICT ("userId", "provider",
--     "email"), untouched here.
--   * Its inserts omit sourceKey, which takes DEFAULT 'primary', and it writes
--     sourceAccountId NULL, so the CHECK holds for every row it writes.
-- The code can be rolled back with no schema step.
--
-- Backfill. Every existing row is a primary or LOCAL row, because no writer has
-- set sourceAccountId before C2, so the DEFAULT fills sourceKey correctly. The
-- UPDATE below is the total function of sourceAccountId anyway and touches no
-- row today; it keeps the CHECK from failing this migration if one exists.
--
-- Contract phase (a later migration, not this one). With C1's list
-- (LinkedCalendarAccount_userId_email_key, the provider default, the
-- CalendarEvent googleId scoped repairs and its CHECK), it also drops:
--   * the "sourceKey" DEFAULT 'primary', once the previous release is gone and
--     every writer states it (they all do, through pim/calendar-rows.ts);
--   * the "googleId" column and "CalendarEvent_userId_googleId_key", after reads
--     move to (provider, externalId). The unique created below is the key that
--     replaces it.
-- It keeps the new unique, the CHECK and the index. C7 also decides whether to
-- match events across calendars by iCalUID instead of the event id (an invite
-- to two Google accounts of one person does not always share an id).
--
-- Cost. The column add is metadata-only (constant default, Postgres 11+). The
-- two index builds, the foreign key and the CHECK validation take a brief write
-- lock because
-- Prisma migrations run in a transaction, where CONCURRENTLY is illegal;
-- acceptable on this small table (the call C1 made). lock_timeout below makes a
-- deploy blocked by a long transaction fail fast instead of queueing behind it.

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN "sourceKey" TEXT NOT NULL DEFAULT 'primary';

UPDATE "CalendarEvent" SET "sourceKey" = "sourceAccountId" WHERE "sourceAccountId" IS NOT NULL;

-- Build the replacement unique first, then drop C1's: uniqueness is never
-- unenforced. While every row is 'primary' the two keys hold on the same data.
CREATE UNIQUE INDEX "CalendarEvent_userId_provider_sourceKey_externalId_key" ON "CalendarEvent"("userId", "provider", "sourceKey", "externalId");

DROP INDEX "CalendarEvent_userId_provider_externalId_key";

-- Serves the foreign key's cascade and the unlink delete, both of which look up
-- one account's rows by sourceAccountId (a UUID, so already selective). The
-- C1 review suggested (userId, sourceAccountId); the cascade has no userId to
-- lead with, so the single column is the one that serves both.
CREATE INDEX "CalendarEvent_sourceAccountId_idx" ON "CalendarEvent"("sourceAccountId");

-- Every existing sourceAccountId is NULL, so validating the constraint is a scan.
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "LinkedCalendarAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_sourceKey_matches_sourceAccountId" CHECK ("sourceKey" = COALESCE("sourceAccountId", 'primary'));
