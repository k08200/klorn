-- Learned-rule layer (write side). Per-user generalising rules mined from a
-- user's repeated manual overrides (learned-rule-mining.ts) — e.g. "anything
-- from this domain → SILENT". Advisory until APPLIED: the classifier acts only
-- on APPLIED rules (status reuses the ProposalStatus enum), so every learned
-- decision stays reviewable and reversible (deterministic-floor doctrine).

-- CreateTable
CREATE TABLE "LearnedRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "evidenceCount" INTEGER NOT NULL,
    "distinctSenders" INTEGER NOT NULL,
    "sourceIds" TEXT[],
    "status" "ProposalStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnedRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LearnedRule_userId_status_idx" ON "LearnedRule"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LearnedRule_userId_pattern_value_key" ON "LearnedRule"("userId", "pattern", "value");

-- AddForeignKey
ALTER TABLE "LearnedRule" ADD CONSTRAINT "LearnedRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
