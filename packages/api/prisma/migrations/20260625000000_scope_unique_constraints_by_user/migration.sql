-- Multi-tenant correctness: scope the (source, sourceId) / googleId unique
-- constraints by userId so a shared or colliding sourceId can never force two
-- users' rows to collide (cross-user upsert clobber / outcome stamp).
--
-- Why this is safe on a populated table:
--   The OLD key is a strict subset of the NEW key (we only PREPEND userId), so
--   any data that satisfied UNIQUE(source, sourceId) also satisfies
--   UNIQUE(userId, source, sourceId). The CREATE UNIQUE INDEX below therefore
--   cannot find a duplicate and cannot fail on existing rows.
--   sourceId is a per-row uuid for every source today (EMAIL=EmailMessage.id,
--   etc.), so even cross-user there are no collisions on the current single-user
--   DB. The change matters for shared-id sources (GITHUB thread id, Google
--   Calendar googleId shared between attendees) and for future N>1 tenancy.
--
-- Locking note: these are small per-user tables today, so the brief lock from a
-- non-CONCURRENT index build is negligible. (Prisma runs migrations in a
-- transaction, which precludes CREATE INDEX CONCURRENTLY.)

-- DROP INDEX IF EXISTS so a manual re-run during recovery is idempotent
-- (matches the convention in 20260616210000_drop_redundant_indexes).

-- DecisionLabel: (source, sourceId) -> (userId, source, sourceId)
DROP INDEX IF EXISTS "DecisionLabel_source_sourceId_key";
CREATE UNIQUE INDEX "DecisionLabel_userId_source_sourceId_key"
  ON "DecisionLabel"("userId", "source", "sourceId");

-- AttentionItem: (source, sourceId) -> (userId, source, sourceId)
DROP INDEX IF EXISTS "AttentionItem_source_sourceId_key";
CREATE UNIQUE INDEX "AttentionItem_userId_source_sourceId_key"
  ON "AttentionItem"("userId", "source", "sourceId");

-- CalendarEvent: (googleId) -> (userId, googleId)
DROP INDEX IF EXISTS "CalendarEvent_googleId_key";
CREATE UNIQUE INDEX "CalendarEvent_userId_googleId_key"
  ON "CalendarEvent"("userId", "googleId");
