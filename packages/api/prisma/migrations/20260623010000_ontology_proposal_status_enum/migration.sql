-- OntologyProposal.status: raw String -> ProposalStatus enum. status is
-- load-bearing now (APPLIED drives the live classifier via ontology-overrides),
-- so a typo must fail at compile time and a bad value must fail at the DB.
-- Existing rows hold OPEN/APPLIED/DISMISSED, so the USING cast is total.

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('OPEN', 'APPLIED', 'DISMISSED');

-- AlterTable
ALTER TABLE "OntologyProposal"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "ProposalStatus" USING ("status"::"ProposalStatus"),
  ALTER COLUMN "status" SET DEFAULT 'OPEN';
