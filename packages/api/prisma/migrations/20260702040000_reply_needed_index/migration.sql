-- CreateIndex: GET /inbox/reply-needed filters (userId, needsReply=true) and
-- sorts by needsReplyConfidence DESC, receivedAt DESC. The existing
-- (userId, needsReply) index covers only the filter, so Postgres does an
-- in-memory sort of the matching rows. This composite lets it return rows
-- already ordered (a backward index scan satisfies the DESC/DESC ORDER BY).
-- IF NOT EXISTS allows an out-of-band CONCURRENTLY pre-build before a large-table
-- deploy (Prisma precludes CONCURRENTLY inside its migration transaction).
CREATE INDEX IF NOT EXISTS "EmailMessage_reply_needed_idx" ON "EmailMessage"("userId", "needsReply", "needsReplyConfidence", "receivedAt");
