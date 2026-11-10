-- API keys (2026-08-27): machine credentials for the MCP endpoint, and only
-- it — the session-auth surface (requireAuth) never accepts one, so a leaked
-- key's blast radius is the MCP toolset, not the account. Only the SHA-256
-- hash of the key is stored (the Device.tokenHash standard); the raw key is
-- shown once at creation. Revocation is a timestamp, not a delete, so the
-- settings list can show what existed and when it was last used.
--
-- Additive only: one new table. Safe to apply ahead of the code that writes
-- it.

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
