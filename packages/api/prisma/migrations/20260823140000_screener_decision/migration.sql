-- Screener (first-contact gate). Records the user's standing decision about a
-- sender they had never heard from before.
--
-- A BLOCK also writes a PIN_TIER -> SILENT row into "EmailRule"; that rule is
-- what the judge actually enforces at rank 0. This table exists so the screener
-- knows to stop asking, and so ALLOW is distinguishable from "never seen" —
-- without it, allowing a sender would be indistinguishable from ignoring them
-- and they would be presented again forever.
--
-- Additive only: new type, new table. Nothing existing is altered, so this is
-- safe to apply ahead of the code that reads it (SCREENER_ENABLED is off).

-- CreateEnum
CREATE TYPE "ScreenerVerdict" AS ENUM ('ALLOW', 'BLOCK');

-- CreateTable
CREATE TABLE "ScreenerDecision" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "verdict" "ScreenerVerdict" NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScreenerDecision_pkey" PRIMARY KEY ("id")
);

-- One standing decision per sender; re-deciding updates it in place.
-- CreateIndex
CREATE UNIQUE INDEX "ScreenerDecision_userId_sender_key" ON "ScreenerDecision"("userId", "sender");

-- CreateIndex
CREATE INDEX "ScreenerDecision_userId_decidedAt_idx" ON "ScreenerDecision"("userId", "decidedAt");

-- AddForeignKey
ALTER TABLE "ScreenerDecision" ADD CONSTRAINT "ScreenerDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
