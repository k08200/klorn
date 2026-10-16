-- EmailAttachment identity: the MIME partId instead of Gmail's attachmentId.
--
-- Why. Gmail mints a fresh attachmentId on every users.messages.get, so the old
-- ON CONFLICT ("emailId", "gmailAttachmentId") never matched a re-fetch and each
-- re-sync of a message inserted another copy of every attachment. Production on
-- 2026-10-16: 123,997 rows for 296 distinct files, 293 MB of a 446 MB database
-- on a 500 MB plan, still growing (682 rows for 172 files since 2026-08-01).
-- Gmail documents partId as "the immutable ID of the message part".
--
-- Expand only. The old unique stays: code from before this change upserts with
-- ON CONFLICT ("emailId", "gmailAttachmentId") and needs that arbiter, so a
-- rollback keeps syncing. Drop it in a later migration, after the legacy copies
-- are deleted. NULL partKey rows (everything synced before this) never collide
-- in a unique index, so the build needs no backfill.
--
-- Locks and cost. ADD COLUMN without a default is catalog-only. The index build
-- holds a SHARE lock on "EmailAttachment" (writes wait, reads continue) while it
-- scans the table: about 124k rows in production on 2026-10-16, seconds.
-- lock_timeout makes a deploy blocked by a long transaction fail fast instead of
-- queueing every attachment write behind it.
--
-- Runbook. If this fails (lock_timeout), Prisma records it as failed and refuses
-- later deploys with P3009. The transaction rolled back, so recover with
--   prisma migrate resolve --rolled-back 20261016010000_email_attachment_part_key
-- and redeploy. migrate diff sees both the column and the index, so start.sh's
-- resolve-all fallback cannot mark this applied while it is missing.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "EmailAttachment" ADD COLUMN "partKey" TEXT;

CREATE UNIQUE INDEX "EmailAttachment_emailId_partKey_key" ON "EmailAttachment"("emailId", "partKey");
