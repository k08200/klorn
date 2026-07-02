-- AddColumn: last-synced Gmail historyId watermark for incremental (History API) sync.
-- Nullable so existing tokens stay valid; the next sync snapshots then baselines it.
ALTER TABLE "UserToken" ADD COLUMN "historyId" TEXT;
