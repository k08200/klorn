-- AddColumn: durable "needs reconnect" flag for a linked secondary calendar,
-- mirroring LinkedInboxAccount.needsReconnect. Set when the token is found
-- revoked/undecryptable; cleared on a successful refresh or re-link. NOT NULL
-- DEFAULT false — safe on a populated table (Postgres 11+ constant default,
-- no rewrite).
ALTER TABLE "LinkedCalendarAccount" ADD COLUMN "needsReconnect" BOOLEAN NOT NULL DEFAULT false;
