-- Per-thread reasoning cache ("why did this person write, now?").
CREATE TABLE IF NOT EXISTS "ThreadBrief" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" VARCHAR(120) NOT NULL,
    "whyNow" VARCHAR(400) NOT NULL,
    "asks" JSONB,
    "weOwe" VARCHAR(300),
    "theyOwe" VARCHAR(300),
    "stance" VARCHAR(300),
    "analyzedMessageCount" INTEGER NOT NULL,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ThreadBrief_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ThreadBrief_userId_threadId_key" ON "ThreadBrief"("userId", "threadId");

ALTER TABLE "ThreadBrief" ADD CONSTRAINT "ThreadBrief_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
