-- List-Unsubscribe support (2026-08-27). The sync pipeline has parsed the
-- List-Unsubscribe header since the POC — but only into an in-memory boolean
-- that was discarded after the inline judge call. These columns persist what
-- the header actually said, so (a) the backfill/heal re-judge paths can
-- carry the bulk-mail signal they have silently lacked, and (b) the
-- unsubscribe endpoint can act on the mailto / https / RFC 8058 one-click
-- targets without re-fetching the message.
--
-- Additive only: three nullable/defaulted columns on "EmailMessage".
-- Safe to apply ahead of the code that writes them — NULL rows behave
-- exactly like today (no unsubscribe affordance, no judge signal), and the
-- update path backfills values on the next re-sync of each message.

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN "listUnsubscribeMailto" TEXT;
ALTER TABLE "EmailMessage" ADD COLUMN "listUnsubscribeUrl" TEXT;
ALTER TABLE "EmailMessage" ADD COLUMN "listUnsubscribeOneClick" BOOLEAN NOT NULL DEFAULT false;
