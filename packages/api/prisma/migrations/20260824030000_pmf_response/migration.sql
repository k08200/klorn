-- Product/market-fit probe. One answer per user to the Sean Ellis question
-- ("how would you feel if you could no longer use Klorn?").
--
-- userId is UNIQUE rather than indexed: the model is one standing answer per
-- user, upserted when they reconsider, not an append-only log. Nobody would act
-- on the history, and keeping it invites reading a trend into three data points.
--
-- The index on answer exists for the summary, which groups by it on every read
-- of the admin cohort screen.
--
-- Additive only: new type, new table. Safe to apply ahead of the code that
-- writes it (PMF_PROBE_ENABLED is off).

-- CreateEnum
CREATE TYPE "PmfAnswer" AS ENUM ('VERY', 'SOMEWHAT', 'NOT');

-- CreateTable
CREATE TABLE "PmfResponse" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "answer" "PmfAnswer" NOT NULL,
    "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmfResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PmfResponse_userId_key" ON "PmfResponse"("userId");

-- CreateIndex
CREATE INDEX "PmfResponse_answer_idx" ON "PmfResponse"("answer");

-- AddForeignKey
ALTER TABLE "PmfResponse" ADD CONSTRAINT "PmfResponse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
