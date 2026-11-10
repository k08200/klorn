-- Send receipts (2026-10-16): the deterministic floor for USER-INITIATED sends,
-- POST /api/email/send and POST /api/email/:id/reply. CLAUDE.md: send / delete /
-- forward always produce an ActionReceipt with a payload hash. The agent path
-- stores its receipt on PendingAction / ActionOutbox; the two manual routes
-- stored none. MANUAL_SEND_RECEIPTS_ENABLED (OFF by default) is the only writer:
-- while it is off nothing reads or writes this table except the user purge.
--
-- One row per manual send attempt, written BEFORE the provider is called (a
-- failed write refuses the send) and settled after: status PENDING | SENT |
-- REFUSED | UNKNOWN, providerMessageId, completedAt. receipt is the full
-- ActionReceipt JSON (judge/attention-floor.ts, schema "v1"); payloadHash
-- duplicates receipt.payloadHash for lookup. emailId (reply only) has no foreign
-- key on purpose: the audit row outlives the mail row. The row goes with its
-- user (the foreign key cascades) and purge-user-data.ts deletes it.
--
-- Row-level security in the form every per-user table has
-- (20261015020000_linked_drive_account): ENABLE, a tenant policy on
-- app.current_user_id and a system policy on app.bypass_rls. The default-
-- privilege revoke of 20261010020000_revoke_data_api_table_grants covers the new
-- table: the Data API roles get no grant on it.
--
-- Additive only: one new table, one index, one foreign key. No existing table is
-- altered, so no lock is taken on a live table beyond the SHARE ROW EXCLUSIVE the
-- foreign key takes on "User" (brief: the new table is empty).
-- Rollback: revert the code; the empty table can stay.
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "SendReceipt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "receipt" JSONB NOT NULL,
    "inbox" TEXT NOT NULL,
    "emailId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "providerMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SendReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SendReceipt_userId_createdAt_idx" ON "SendReceipt"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "SendReceipt" ADD CONSTRAINT "SendReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security
ALTER TABLE "SendReceipt" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SendReceipt_tenant_isolation" ON "SendReceipt" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "SendReceipt_system_bypass" ON "SendReceipt" USING (current_setting('app.bypass_rls', true) = 'on');
