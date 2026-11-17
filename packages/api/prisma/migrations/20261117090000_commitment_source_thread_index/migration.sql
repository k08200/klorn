-- The KakaoTalk orphan sweep (kakao-import/commitments.ts) runs every 10
-- minutes whatever KAKAO_IMPORT_ENABLED says, and groups the Kakao commitments
-- of every user by thread: WHERE "sourceType" = 'KAKAO' AND "threadId" LIKE
-- 'kakao-import:%'. Every other Commitment index leads with userId, so that
-- query was a sequential scan of the whole table, every user's mail
-- commitments included. This index answers it with an index condition on
-- sourceType (kakao-orphan-sweep-plan-pg.test.ts).
--
-- EXPAND ONLY. One new index, no column or data change; the previous instance
-- runs unchanged during the swap.
--
-- Not CONCURRENTLY: Prisma runs each migration in a transaction, where CREATE
-- INDEX CONCURRENTLY is refused. A plain CREATE INDEX holds a SHARE lock on
-- Commitment (reads go on, writes wait) for as long as the build takes. If it
-- fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261117090000_commitment_source_thread_index`
-- and redeploy.
--
-- No new table, so no new RLS policy: Commitment already has RLS enabled.
SET LOCAL lock_timeout = '5s';

-- CreateIndex
CREATE INDEX "Commitment_sourceType_threadId_idx" ON "Commitment"("sourceType", "threadId");
