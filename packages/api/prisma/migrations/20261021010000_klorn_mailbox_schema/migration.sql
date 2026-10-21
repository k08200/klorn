-- Klorn mailbox, step E1a of docs/providers/unified-platform-plan.md.
--
-- KLORN: the Klorn address as an inbox provider. A LinkedInboxAccount row with
-- this provider holds no credentials; mail reaches it through the inbound
-- webhook (E1b). Postgres cannot drop an enum value, so a rollback leaves it
-- unused.
--
-- KlornAddress: the handle of each Klorn address. A row whose userId is null is
-- a tombstone: the account was deleted, the foreign key nulled the owner (SET
-- NULL, never CASCADE), and the handle is never issued again (L5). Lowercase
-- only. One address per account (unique userId), one account per address (the
-- primary key).
--
-- EmailMessage.authentication: the receiving server's SPF, DKIM and DMARC
-- verdicts for mail Klorn receives itself; null for every other provider.

-- AlterEnum
ALTER TYPE "InboxProvider" ADD VALUE IF NOT EXISTS 'KLORN';

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN "authentication" JSONB;

-- CreateTable
CREATE TABLE "KlornAddress" (
    "handle" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KlornAddress_pkey" PRIMARY KEY ("handle"),
    CONSTRAINT "KlornAddress_handle_lowercase" CHECK ("handle" = lower("handle"))
);

-- CreateIndex
CREATE UNIQUE INDEX "KlornAddress_userId_key" ON "KlornAddress"("userId");

-- AddForeignKey
ALTER TABLE "KlornAddress" ADD CONSTRAINT "KlornAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS, as for every table (docs/rls-rollout.md).
ALTER TABLE "KlornAddress" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "KlornAddress_tenant_isolation" ON "KlornAddress" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "KlornAddress_system_bypass" ON "KlornAddress" USING (current_setting('app.bypass_rls', true) = 'on');
