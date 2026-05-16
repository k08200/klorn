-- CommitmentPath: AI-generated fulfillment plan for a commitment
CREATE TABLE "CommitmentPath" (
  "id"           TEXT NOT NULL,
  "commitmentId" TEXT NOT NULL,
  "steps"        JSONB NOT NULL,
  "builtAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "model"        TEXT,
  CONSTRAINT "CommitmentPath_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CommitmentPath"
  ADD CONSTRAINT "CommitmentPath_commitmentId_fkey"
  FOREIGN KEY ("commitmentId") REFERENCES "Commitment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "CommitmentPath_commitmentId_key" ON "CommitmentPath"("commitmentId");
CREATE INDEX "CommitmentPath_commitmentId_idx" ON "CommitmentPath"("commitmentId");
