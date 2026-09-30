-- IMAP move tracking (2026-09-30): step B2 of
-- docs/providers/unified-platform-plan.md — the schema behind archive and trash
-- for Naver and iCloud. Additive only: one nullable column, one enum, one table.
-- Nothing reads or writes any of it until IMAP_MOVE_ACTIONS_ENABLED is on, except
-- the IMAP poller, which records the INBOX UIDVALIDITY and acts on a change in it
-- (below).
--
-- LinkedInboxAccount."inboxUidValidity":
--   A UID in EmailMessage."gmailId" (`naver-imap:<email>:<uid>`) names a message
--   only under the mailbox's UIDVALIDITY (RFC 3501 §2.3.1.1); when the server
--   changes it, every stored UID points at a different message or none. The
--   poller records the INBOX value here, every IMAP action compares the live value
--   with it before touching a UID, and a poll that sees a different one
--   re-baselines. TEXT, not INTEGER or BIGINT: the value is an unsigned 32-bit
--   integer (over a signed INTEGER), is only compared for equality, and a BigInt
--   column would make any code path that serializes a whole LinkedInboxAccount row
--   throw. NULL for every existing row; the first poll after deploy fills it, and
--   an action on a row whose value is still NULL is refused, never guessed.
--
-- ImapMoveRole / "ImapMovedMessage":
--   An IMAP MOVE gives the message a NEW UID in the destination folder, and trash
--   and archive delete the local "EmailMessage" row (as the Gmail path does), so
--   where the message went cannot live on that row. One row per message parked by
--   a move, keyed by the INBOX id it had ("sourceId"): the destination folder, its
--   UID and that folder's own UIDVALIDITY, and what the message looked like
--   (Message-ID, subject, date) so undo can refuse if the UID now names something
--   else. Undo consumes the row; rows older than 30 days are swept by the next
--   move for the same account.
--   "folderUid" is BIGINT for the same reason as above (UIDs reach 4294967295).
--   Both foreign keys cascade: unlinking a mailbox or deleting a user removes the
--   tracking rows (and purgeUserData deletes them explicitly). Unlike
--   EmailMessage."linkedInboxAccountId", which is a plain tag so that unlinking
--   keeps classified mail, there is nothing to keep here: without the account's
--   credentials a parked message cannot be restored.
--
-- Deploy overlap and rollback: migrations run at container start while the
-- previous release is still serving. That release never names the new column or
-- table, so it is unaffected, and the code can be rolled back with no schema step
-- (the column and table are simply unused). The poller's UIDVALIDITY write is
-- harmless to a rollback: the old code ignores the column.
--
-- Cost. ADD COLUMN with no default is metadata-only. The foreign keys take a brief
-- SHARE ROW EXCLUSIVE lock on "User" and "LinkedInboxAccount" while they validate
-- against an empty table. Migrations run in a transaction, so no CONCURRENTLY;
-- the new table is empty, so the index builds are instant. Nothing is dropped and
-- nothing is backfilled. Replayed on a scratch Postgres against every earlier
-- migration, then compared with schema.prisma: the migration diff is empty.

-- Fail fast instead of queueing behind a long transaction: a waiting lock request
-- on "User" would block every reader behind it. SET LOCAL lasts only for this
-- migration's transaction.
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ImapMoveRole" AS ENUM ('TRASH', 'ARCHIVE');

-- AlterTable
ALTER TABLE "LinkedInboxAccount" ADD COLUMN "inboxUidValidity" TEXT;

-- CreateTable
CREATE TABLE "ImapMovedMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "linkedInboxAccountId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "role" "ImapMoveRole" NOT NULL,
    "folderPath" TEXT NOT NULL,
    "folderUid" BIGINT NOT NULL,
    "folderUidValidity" TEXT NOT NULL,
    "messageIdHeader" TEXT,
    "subject" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImapMovedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImapMovedMessage_linkedInboxAccountId_sourceId_key" ON "ImapMovedMessage"("linkedInboxAccountId", "sourceId");

-- CreateIndex
CREATE INDEX "ImapMovedMessage_linkedInboxAccountId_createdAt_idx" ON "ImapMovedMessage"("linkedInboxAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "ImapMovedMessage_userId_idx" ON "ImapMovedMessage"("userId");

-- AddForeignKey
ALTER TABLE "ImapMovedMessage" ADD CONSTRAINT "ImapMovedMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImapMovedMessage" ADD CONSTRAINT "ImapMovedMessage_linkedInboxAccountId_fkey" FOREIGN KEY ("linkedInboxAccountId") REFERENCES "LinkedInboxAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
