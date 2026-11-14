-- Provider phase 2: fixed-host app-password IMAP presets
-- (packages/api/src/mail/imap-preset-providers.ts). Expand-only: seven new
-- InboxProvider values and nothing else. No row uses them until
-- IMAP_PRESETS_ENABLED lets a user connect one, so no statement here touches
-- data. Postgres cannot use a new enum value in the transaction that added it
-- (nothing below does) and cannot drop one, so a rollback leaves them unused.

-- Fail fast instead of queueing behind a long lock (same guard as 20261021010000).
SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "InboxProvider" ADD VALUE IF NOT EXISTS 'DAUM';
ALTER TYPE "InboxProvider" ADD VALUE IF NOT EXISTS 'KAKAO';
ALTER TYPE "InboxProvider" ADD VALUE IF NOT EXISTS 'YAHOO';
ALTER TYPE "InboxProvider" ADD VALUE IF NOT EXISTS 'AOL';
ALTER TYPE "InboxProvider" ADD VALUE IF NOT EXISTS 'FASTMAIL';
ALTER TYPE "InboxProvider" ADD VALUE IF NOT EXISTS 'ZOHO';
ALTER TYPE "InboxProvider" ADD VALUE IF NOT EXISTS 'ZOHOPRO';
