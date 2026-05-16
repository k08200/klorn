-- Migration: 5-tier attention escalation + contact trust score
--
-- 1. AttentionItem gains `tier` and `tierReason` for the 5-tier escalation model
--    (SILENT | QUEUE | PUSH | AUTO). The index speeds up the receipt query which
--    filters by (userId, tier, surfacedAt).
--
-- 2. ContactTrustScore tracks how reliably counterparties fulfil commitments.
--    Called from trust-score.ts whenever a COUNTERPARTY commitment → DONE.

-- ── Commitment: counterpartyEmail ───────────────────────────────────────────
-- Needed so trust-score.ts can update reliability when a COUNTERPARTY commitment
-- transitions to DONE. The email ingestion pipeline sets this from the sender
-- address of the source email.

ALTER TABLE "Commitment" ADD COLUMN "counterpartyEmail" TEXT;

CREATE INDEX "Commitment_counterpartyEmail_idx"
  ON "Commitment"("counterpartyEmail")
  WHERE "counterpartyEmail" IS NOT NULL;

-- ── AttentionItem additions ──────────────────────────────────────────────────

ALTER TABLE "AttentionItem" ADD COLUMN "tier"       TEXT;
ALTER TABLE "AttentionItem" ADD COLUMN "tierReason" TEXT;

CREATE INDEX "AttentionItem_userId_tier_surfacedAt_idx"
  ON "AttentionItem"("userId", "tier", "surfacedAt");

-- ── ContactTrustScore ────────────────────────────────────────────────────────

CREATE TABLE "ContactTrustScore" (
  "id"            TEXT         NOT NULL,
  "userId"        TEXT         NOT NULL,
  "contactEmail"  TEXT         NOT NULL,
  "displayName"   TEXT,
  "totalCount"    INTEGER      NOT NULL DEFAULT 0,
  "onTimeCount"   INTEGER      NOT NULL DEFAULT 0,
  "lateCount"     INTEGER      NOT NULL DEFAULT 0,
  "totalDelayDays" INTEGER     NOT NULL DEFAULT 0,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContactTrustScore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContactTrustScore_userId_contactEmail_key"
  ON "ContactTrustScore"("userId", "contactEmail");

CREATE INDEX "ContactTrustScore_userId_idx"
  ON "ContactTrustScore"("userId");

ALTER TABLE "ContactTrustScore"
  ADD CONSTRAINT "ContactTrustScore_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
