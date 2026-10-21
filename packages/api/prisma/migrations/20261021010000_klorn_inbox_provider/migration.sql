-- Klorn mailbox, step E1a of docs/providers/unified-platform-plan.md.
--
-- KLORN: the Klorn address as an inbox provider. A LinkedInboxAccount row with
-- this provider holds no credentials; mail reaches it through the inbound
-- webhook (E1b). Its own migration: Postgres cannot use an enum value in the
-- transaction that added it, and the next migration's partial index does.
-- Postgres cannot drop an enum value either, so a rollback leaves it unused.

-- Fail fast instead of queueing behind a long lock (same guard as 20261009010000).
SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "InboxProvider" ADD VALUE IF NOT EXISTS 'KLORN';
