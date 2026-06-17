-- Decision ledger: the tier the firewall SHOWED the user for each classified
-- item, plus the user's eventual outcome. AttentionItem.tier is overwritten in
-- place on a manual override, so the original shown tier (and the features that
-- produced it) can't be reconstructed after the fact. This table records the
-- decision immutably so per-user PUSH recall and over-suppression can be
-- measured from real traffic later.

-- CreateTable
CREATE TABLE "DecisionLabel" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "AttentionSource" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "shownTier" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "sender" TEXT,
    "decidedBy" TEXT,
    "outcome" TEXT,
    "outcomeAt" TIMESTAMP(3),
    "judgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DecisionLabel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: one ledger row per (source, sourceId) — refreshed while open,
-- frozen once the outcome is stamped.
CREATE UNIQUE INDEX "DecisionLabel_source_sourceId_key" ON "DecisionLabel"("source", "sourceId");

-- CreateIndex: per-user recall/over-suppression slices by shown tier over time.
CREATE INDEX "DecisionLabel_userId_shownTier_judgedAt_idx" ON "DecisionLabel"("userId", "shownTier", "judgedAt");

-- AddForeignKey
ALTER TABLE "DecisionLabel" ADD CONSTRAINT "DecisionLabel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
