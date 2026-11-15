-- KakaoTalk chat-export import v1 (2026-11-15). See docs/providers/kakaotalk-import.md.
--
-- KakaoImport: one uploaded chat export — its parser format, counts, the
-- processed time window and the outcome. No file name, chat title or speaker
-- name. KakaoImportMessage: one in-window message awaiting processing (the
-- speaker's display name and the text, capped); deleted when its import is
-- processed and in any case 7 days after upload (kakao-import/purge.ts).
--
-- EXPAND ONLY: two new tables, written only while KAKAO_IMPORT_ENABLED is on.
-- Safe to apply ahead of the code that writes them.
--
-- RLS as every user-scoped table (docs/rls-rollout.md). Both are fenced by the
-- data-wipe trigger (privacy/data-wipe-fence.ts FENCED_MODELS): a processing
-- pass running during an account wipe must not re-create user data.
--
-- If it fails on lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261115100100_kakao_import_v1` and redeploy.
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "KakaoImport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "format" TEXT NOT NULL,
    "totalMessages" INTEGER NOT NULL,
    "windowMessages" INTEGER NOT NULL,
    "speakerCount" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "candidatesFound" INTEGER NOT NULL DEFAULT 0,
    "commitmentsCreated" INTEGER NOT NULL DEFAULT 0,
    "duplicatesSkipped" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "claimedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KakaoImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KakaoImportMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "speaker" TEXT NOT NULL,
    "fromMe" BOOLEAN NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KakaoImportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KakaoImport_userId_createdAt_idx" ON "KakaoImport"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "KakaoImport_status_createdAt_idx" ON "KakaoImport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "KakaoImportMessage_userId_idx" ON "KakaoImportMessage"("userId");

-- CreateIndex
CREATE INDEX "KakaoImportMessage_createdAt_idx" ON "KakaoImportMessage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "KakaoImportMessage_importId_seq_key" ON "KakaoImportMessage"("importId", "seq");

-- AddForeignKey
ALTER TABLE "KakaoImport" ADD CONSTRAINT "KakaoImport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KakaoImportMessage" ADD CONSTRAINT "KakaoImportMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KakaoImportMessage" ADD CONSTRAINT "KakaoImportMessage_importId_fkey" FOREIGN KEY ("importId") REFERENCES "KakaoImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "KakaoImport" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "KakaoImport_tenant_isolation" ON "KakaoImport" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "KakaoImport_system_bypass" ON "KakaoImport" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "KakaoImportMessage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "KakaoImportMessage_tenant_isolation" ON "KakaoImportMessage" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "KakaoImportMessage_system_bypass" ON "KakaoImportMessage" USING (current_setting('app.bypass_rls', true) = 'on');

CREATE TRIGGER "KakaoImport_data_wipe_fence" BEFORE INSERT ON "KakaoImport" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "KakaoImportMessage_data_wipe_fence" BEFORE INSERT ON "KakaoImportMessage" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
