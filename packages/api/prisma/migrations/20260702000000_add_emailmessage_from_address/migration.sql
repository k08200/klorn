-- AddColumn: normalized sender address (extractEmailAddress(from), lowercased,
-- display name stripped). Nullable so existing rows stay valid until backfilled
-- (`pnpm backfill:from-address`). Only read under SENDER_ADDRESS_INDEX_ENABLED.
ALTER TABLE "EmailMessage" ADD COLUMN "fromAddress" TEXT;

-- Serve the flag-gated fetchSenderItems lookup: equality on (userId, fromAddress)
-- with receivedAt-desc ordering, replacing the unindexable `from` ILIKE scan.
--
-- SCALE/OPS NOTE: this is a plain (transaction-wrapped) CREATE INDEX, which takes
-- an ACCESS EXCLUSIVE lock that blocks writes to EmailMessage for the build.
-- Cheap now — the column is 100% NULL until `backfill:from-address` runs, so the
-- build is near-instant. If EmailMessage is already large in production when this
-- deploys, build the index out-of-band instead to avoid a write-blocking window:
--   1) mark this migration applied without running it (prisma migrate resolve
--      --applied 20260702000000_add_emailmessage_from_address), then
--   2) run CREATE INDEX CONCURRENTLY manually (it cannot run inside Prisma's
--      migration transaction):
--      CREATE INDEX CONCURRENTLY "EmailMessage_userId_fromAddress_receivedAt_idx"
--        ON "EmailMessage"("userId", "fromAddress", "receivedAt");
CREATE INDEX "EmailMessage_userId_fromAddress_receivedAt_idx" ON "EmailMessage"("userId", "fromAddress", "receivedAt");
