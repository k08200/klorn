-- Attention Engine v3 facts (2026-10-31, docs/design/attention-engine-v3.md §3,
-- phase P2). One row per judged item: the facts v1 the extractor produced (or,
-- with no usable model answer, factsSource "none" and only the certain
-- pre-facts), the header signals, the relationship snapshot it saw, the evidence-check result, the model/provider
-- that served, and the v2 lane shown at the time (frozen here because
-- DecisionLabel.shownTier is rewritten on re-judge). JUDGE_V3_SHADOW (OFF by
-- default) is the only writer, and nothing on the lane path reads it: users see
-- v2 exactly. Policy replay (P3) joins on (userId, source, sourceId), the
-- natural key AttentionItem and DecisionLabel already use.
--
-- The row goes with its user (the foreign key cascades) and purge-user-data.ts
-- deletes it. It is in FENCED_MODELS, so the data-wipe fence trigger rejects a
-- shadow write that lands during a wipe, like every other mail-derived table
-- (20261019010000_data_wipe_fence).
--
-- Row-level security in the form every per-user table has
-- (20261016010000_send_receipt): ENABLE, a tenant policy on
-- app.current_user_id and a system policy on app.bypass_rls. The default-
-- privilege revoke of 20261010020000_revoke_data_api_table_grants covers the new
-- table: the Data API roles get no grant on it.
--
-- Additive only: one new table, three indexes, one foreign key, one trigger. No
-- existing table is altered; the foreign key takes a brief SHARE ROW EXCLUSIVE on
-- "User" while the new table is empty.
-- Rollback: revert the code; the empty table can stay.
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "AttentionFacts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "AttentionSource" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "factsVersion" INTEGER NOT NULL,
    "factsSource" TEXT NOT NULL,
    "model" TEXT,
    "provider" TEXT,
    "extractedAt" TIMESTAMP(3) NOT NULL,
    "facts" JSONB NOT NULL,
    "certainFields" TEXT[],
    "signals" JSONB,
    "relationship" JSONB,
    "evidenceCheck" JSONB NOT NULL,
    "issues" TEXT[],
    "escalate" BOOLEAN NOT NULL DEFAULT false,
    "escalateReasons" TEXT[],
    "v2Tier" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttentionFacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttentionFacts_userId_extractedAt_idx" ON "AttentionFacts"("userId", "extractedAt");

-- CreateIndex
CREATE INDEX "AttentionFacts_extractedAt_idx" ON "AttentionFacts"("extractedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttentionFacts_userId_source_sourceId_key" ON "AttentionFacts"("userId", "source", "sourceId");

-- AddForeignKey
ALTER TABLE "AttentionFacts" ADD CONSTRAINT "AttentionFacts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security
ALTER TABLE "AttentionFacts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "AttentionFacts_tenant_isolation" ON "AttentionFacts" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "AttentionFacts_system_bypass" ON "AttentionFacts" USING (current_setting('app.bypass_rls', true) = 'on');

-- Data-wipe fence (FENCED_MODELS in src/privacy/data-wipe-fence.ts)
CREATE TRIGGER "AttentionFacts_data_wipe_fence" BEFORE INSERT ON "AttentionFacts" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
