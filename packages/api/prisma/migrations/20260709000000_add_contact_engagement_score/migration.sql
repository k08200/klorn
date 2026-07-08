-- Migration: ContactEngagementScore — learned per-contact engagement edges for
-- the importance graph. Written by user actions (outbound email/reply = engaged;
-- dismiss = negative). Raw counters, read O(1) at judge time (same pattern as
-- ContactTrustScore). Consumed later, flag-gated, as a soft grounding signal for
-- the LLM's senderTrust score — never a hard override ("measure, not inject").

CREATE TABLE "ContactEngagementScore" (
  "id"            TEXT         NOT NULL,
  "userId"        TEXT         NOT NULL,
  "contactEmail"  TEXT         NOT NULL,
  "outboundCount" INTEGER      NOT NULL DEFAULT 0,
  "dismissCount"  INTEGER      NOT NULL DEFAULT 0,
  "lastEngagedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContactEngagementScore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContactEngagementScore_userId_contactEmail_key"
  ON "ContactEngagementScore"("userId", "contactEmail");

CREATE INDEX "ContactEngagementScore_userId_idx"
  ON "ContactEngagementScore"("userId");

ALTER TABLE "ContactEngagementScore"
  ADD CONSTRAINT "ContactEngagementScore_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
