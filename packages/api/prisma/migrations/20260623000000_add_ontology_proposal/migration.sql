-- Ontology write-side v0: advisory threshold-change proposals derived from the
-- override ledger (decision-metrics). The classifier never reads this table; it
-- keeps running the git `const`s. A human applies an approved proposal via a
-- code PR (git = audit trail + revert). Global today (no userId) because the
-- policy is global. Dedup ("one OPEN per knob") is enforced in the writer, not a
-- DB constraint, so repeated terminal rows don't collide.

-- CreateTable
CREATE TABLE "OntologyProposal" (
    "id" TEXT NOT NULL,
    "knob" TEXT NOT NULL,
    "currentValue" DOUBLE PRECISION NOT NULL,
    "proposedValue" DOUBLE PRECISION NOT NULL,
    "direction" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OntologyProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OntologyProposal_knob_status_idx" ON "OntologyProposal"("knob", "status");

-- CreateIndex
CREATE INDEX "OntologyProposal_status_idx" ON "OntologyProposal"("status");
