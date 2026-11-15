-- IMAP login backoff (mail/imap-auth-backoff.ts): a mailbox whose stored app
-- password the provider refuses is no longer polled every five minutes for
-- good.
--   LinkedInboxAccount.imapAuthFailures  consecutive refused logins (0 = none)
--   LinkedInboxAccount.imapAuthRetryAt   when the poll may log in again; null
--                                        with a count of 4 = stopped until a
--                                        reconnect
--
-- EXPAND ONLY. A constant default and a nullable column: a catalog update, no
-- table rewrite, no backfill. The previous instance keeps writing rows without
-- them during the swap, and 0 / null (no refusal on record) is correct for
-- those rows.
--
-- No new table, so no new RLS policy: LinkedInboxAccount already has RLS enabled.
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261115213000_imap_auth_backoff`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "LinkedInboxAccount" ADD COLUMN "imapAuthFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "imapAuthRetryAt" TIMESTAMP(3);
