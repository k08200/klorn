-- Calendar provider-aware schema (2026-09-30): step C1 of
-- docs/providers/unified-platform-plan.md — the EXPAND phase. Calendars stop
-- being implicitly Google. Nothing reads the new columns yet; every existing
-- code path keeps reading by googleId.
--
-- New enum CalendarProvider. Only the sources the plan's C steps name:
--   GOOGLE   today's primary and linked Google calendars
--   OUTLOOK  C4, Microsoft Graph
--   ICLOUD   C3, CalDAV
--   NAVER    C3, CalDAV
--   DEVICE   C5/C6, on-device calendars uploaded behind per-source opt-in (P4)
--   LOCAL    events created in Klorn with no external calendar (sample/demo
--            rows, and manual events whose Google insert failed or was absent)
-- Adding a value later is a one-line ALTER TYPE; removing one is not, so the
-- list stays minimal. LOCAL only ever appears on CalendarEvent.
--
-- LinkedCalendarAccount (mirrors LinkedInboxAccount, migration
-- 20260805150000_linked_inbox_provider):
--   provider              every existing row is a Google OAuth link, so the
--                         DEFAULT backfills them all.
--   accessToken           now nullable — CalDAV rows never have one. Readers
--                         already guard `row.accessToken ?`.
--   caldavUrl /           non-OAuth credentials for C3: server URL + AES-256-GCM
--   caldavPasswordCipher  cipher of an app-specific password (the same
--                         crypto-tokens helper as the OAuth ciphers). Unused
--                         until C3; already in the key-rotation sweep.
--   unique key            (userId, email) becomes (userId, provider, email) so
--                         one address can exist on two services. No row is
--                         lost: every existing row is GOOGLE, so the new key
--                         holds exactly when the old one did.
--
-- CalendarEvent:
--   provider, externalId  the provider-aware identity. googleId and its
--                         (userId, googleId) unique are untouched and stay the
--                         key for every read until the contract phase.
--   sourceAccountId       which LinkedCalendarAccount a row was synced from.
--                         NULL = primary login calendar or LOCAL. Deliberately
--                         no foreign key: same shape as
--                         EmailMessage.linkedInboxAccountId, so unlinking an
--                         account never cascades into events.
--
-- Backfill (one UPDATE, a total function of googleId): a row WITH a googleId
-- becomes GOOGLE with externalId = googleId; a row WITHOUT one is a local or
-- sample event and becomes LOCAL with externalId NULL — never GOOGLE. The
-- statement is idempotent. The new unique index is created after it, so the
-- index validates the backfilled data; Postgres treats NULLs as distinct, so
-- LOCAL rows never collide.
--
-- provider keeps DEFAULT 'GOOGLE' on both tables on purpose: migrations run at
-- container start while the previous release is still serving, and its inserts
-- know nothing about provider. A row that release writes in that window is
-- GOOGLE (right for Google syncs, wrong for a local event) and may lack
-- externalId. The new code's sync upsert re-stamps provider/externalId on
-- update, and the contract-phase migration must re-run the UPDATE below before
-- it drops the defaults.
--
-- Deploy overlap and rollback, checked 2026-09-30 against a scratch Postgres 16
-- with the previous release's generated client: its Google sync upsert keeps
-- working (ON CONFLICT on the untouched (userId, googleId) key). Its
-- link-calendar upsert does NOT — it compiles to ON CONFLICT ("userId","email")
-- and fails with 42P10 once that index is dropped. So attaching a second
-- Google calendar errors until the new release is serving (a rare action; the
-- user retries) — the same trade Phase 0a made for LinkedInboxAccount. Rolling
-- the CODE back after this is applied has the same effect; restore the old key
-- first (valid while every row is GOOGLE, i.e. before C3 ships):
--   CREATE UNIQUE INDEX "LinkedCalendarAccount_userId_email_key"
--     ON "LinkedCalendarAccount"("userId", "email");
--
-- Cost. The column adds and the NOT NULL drop are metadata-only (constant
-- defaults, Postgres 11+). The UPDATE rewrites CalendarEvent rows once. The two
-- index builds take a brief write lock because Prisma migrations run in a
-- transaction, where CONCURRENTLY is illegal — acceptable on these small
-- tables (the same call Phase 0a made). Nothing is dropped except the one
-- superseded LinkedCalendarAccount index. Never applied anywhere before this
-- revision.

-- CreateEnum
CREATE TYPE "CalendarProvider" AS ENUM ('GOOGLE', 'OUTLOOK', 'ICLOUD', 'NAVER', 'DEVICE', 'LOCAL');

-- LinkedCalendarAccount: provider, non-OAuth credentials, nullable accessToken
ALTER TABLE "LinkedCalendarAccount"
  ADD COLUMN "provider" "CalendarProvider" NOT NULL DEFAULT 'GOOGLE',
  ADD COLUMN "caldavUrl" TEXT,
  ADD COLUMN "caldavPasswordCipher" TEXT,
  ALTER COLUMN "accessToken" DROP NOT NULL;

-- Unique key swap: (userId, email) -> (userId, provider, email)
DROP INDEX "LinkedCalendarAccount_userId_email_key";
CREATE UNIQUE INDEX "LinkedCalendarAccount_userId_provider_email_key" ON "LinkedCalendarAccount"("userId", "provider", "email");

-- CalendarEvent: provider-aware identity
ALTER TABLE "CalendarEvent"
  ADD COLUMN "provider" "CalendarProvider" NOT NULL DEFAULT 'GOOGLE',
  ADD COLUMN "externalId" TEXT,
  ADD COLUMN "sourceAccountId" TEXT;

-- Backfill: googleId -> GOOGLE + externalId; no googleId -> LOCAL (sample/demo
-- and Google-less manual events).
UPDATE "CalendarEvent"
SET "provider" = CASE WHEN "googleId" IS NULL THEN 'LOCAL'::"CalendarProvider" ELSE 'GOOGLE'::"CalendarProvider" END,
    "externalId" = "googleId";

CREATE UNIQUE INDEX "CalendarEvent_userId_provider_externalId_key" ON "CalendarEvent"("userId", "provider", "externalId");
