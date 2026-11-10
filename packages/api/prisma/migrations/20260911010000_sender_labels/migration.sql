-- Sender labels (2026-09-11): the user's correction of who a sender is —
-- one row per (user, scope, value), scope "sender" (address) or "domain".
-- The strongest row-chip evidence and one line in the analysis prompt.
--
-- Additive only: a new table, no backfill. Safe to apply ahead of the code.

CREATE TABLE "SenderLabel" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SenderLabel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SenderLabel_userId_scope_value_key" ON "SenderLabel"("userId", "scope", "value");
CREATE INDEX "SenderLabel_userId_idx" ON "SenderLabel"("userId");

ALTER TABLE "SenderLabel" ADD CONSTRAINT "SenderLabel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
