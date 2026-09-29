-- Sent messages (2026-09-18): headers of mail the user sent, recorded at
-- send time through Klorn and by a throttled Sent-folder scan, so "waiting
-- on" can list what nobody answered. Additive only: a new table.

CREATE TABLE "SentMessage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gmailId" TEXT NOT NULL,
    "threadId" TEXT,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "inbox" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SentMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SentMessage_userId_gmailId_key" ON "SentMessage"("userId", "gmailId");
CREATE INDEX "SentMessage_userId_sentAt_idx" ON "SentMessage"("userId", "sentAt");

ALTER TABLE "SentMessage" ADD CONSTRAINT "SentMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
