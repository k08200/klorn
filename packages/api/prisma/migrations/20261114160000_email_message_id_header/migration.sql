-- IMAP attachment download beyond INBOX (src/mail/attachment-bytes.ts).
--
-- EmailMessage.messageIdHeader is the RFC 5322 Message-ID the IMAP poll reads
-- from the envelope. An IMAP row's gmailId names an INBOX UID; once the user
-- moves the message in another client that UID no longer serves its
-- attachments, and the download looks the message up by this value in the
-- account's role folders instead.
--
-- EXPAND ONLY. A nullable column with no default adds without a table rewrite.
-- No backfill: the poll fills rows it re-touches, and every other row (Gmail,
-- Outlook, Klorn, older IMAP mail) stays NULL, which only means the INBOX-only
-- behaviour it had before. The previous instance keeps writing rows without it
-- during the swap. No index: the value is read from a row already found by id,
-- never searched on.
--
-- No new table, so no new RLS policy: the table already has RLS enabled.
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261114160000_email_message_id_header`
-- and redeploy.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "EmailMessage" ADD COLUMN "messageIdHeader" TEXT;
