CREATE TYPE "SenderTraitKind" AS ENUM ('relationship', 'recurring_intent');
CREATE TYPE "SenderTraitStatus" AS ENUM ('active', 'superseded', 'conflicted');

CREATE TABLE "SenderTrait" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "factKind" "SenderTraitKind" NOT NULL,
    "factValue" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceText" TEXT NOT NULL,
    "sourceSig" TEXT NOT NULL,
    "observedCount" INTEGER NOT NULL DEFAULT 1,
    "conflictValue" TEXT,
    "conflictEvidence" TEXT,
    "conflictedAt" TIMESTAMP(3),
    "status" "SenderTraitStatus" NOT NULL DEFAULT 'active',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SenderTrait_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SenderTrait_userId_sender_factKind_key" ON "SenderTrait"("userId", "sender", "factKind");
CREATE INDEX "SenderTrait_userId_sender_idx" ON "SenderTrait"("userId", "sender");
CREATE INDEX "SenderTrait_userId_factKind_status_idx" ON "SenderTrait"("userId", "factKind", "status");

ALTER TABLE "SenderTrait" ADD CONSTRAINT "SenderTrait_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
