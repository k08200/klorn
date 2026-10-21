-- Klorn mailbox, step E1a of docs/providers/unified-platform-plan.md.
--
-- The KLORN enum value is the previous migration: Postgres cannot use an enum
-- value in the transaction that added it, and the partial index below uses it.
--
-- KlornAddress: the handle of each Klorn address. A row whose userId is null is
-- a tombstone: the account was deleted, the foreign key nulled the owner (SET
-- NULL, never CASCADE), and the handle is never issued again (L5). One address
-- per account (unique userId), one account per address (the primary key). The
-- database holds the rules no writer may skip, since a handle cannot be fixed
-- once issued:
--   - the shape (lowercase ASCII letters and digits, single separators) and
--     lowercase only;
--   - no two handles that differ only in separators (jane.doe and janedoe), a
--     retired one included;
--   - no rename, no delete, no reassignment: the one change allowed is the
--     foreign key's own SET NULL when the account is deleted.
-- The product rules (length, the reserved list) are mail/klorn-handle.ts.
--
-- LinkedInboxAccount: one KLORN mailbox row per account.
--
-- EmailMessage.authentication: the receiving server's SPF, DKIM and DMARC
-- verdicts for mail Klorn receives itself; null for every other provider.

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN "authentication" JSONB;

-- CreateTable
CREATE TABLE "KlornAddress" (
    "handle" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KlornAddress_pkey" PRIMARY KEY ("handle"),
    CONSTRAINT "KlornAddress_handle_lowercase" CHECK ("handle" = lower("handle")),
    CONSTRAINT "KlornAddress_handle_shape" CHECK (
        length("handle") BETWEEN 1 AND 64
        AND "handle" ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "KlornAddress_userId_key" ON "KlornAddress"("userId");

-- Separator-insensitive: an expression index, which Prisma neither models nor
-- reports as drift.
CREATE UNIQUE INDEX "KlornAddress_handle_skeleton_key" ON "KlornAddress" ((translate("handle", '._-', '')));

-- One KLORN mailbox row per account: a partial index, which Prisma neither
-- models nor reports as drift.
CREATE UNIQUE INDEX "LinkedInboxAccount_one_klorn_per_user" ON "LinkedInboxAccount" ("userId") WHERE "provider" = 'KLORN';

-- AddForeignKey
ALTER TABLE "KlornAddress" ADD CONSTRAINT "KlornAddress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS, as for every table (docs/rls-rollout.md).
ALTER TABLE "KlornAddress" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "KlornAddress_tenant_isolation" ON "KlornAddress" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "KlornAddress_system_bypass" ON "KlornAddress" USING (current_setting('app.bypass_rls', true) = 'on');

-- A handle is permanent (L5). The only change allowed is the foreign key's SET
-- NULL when the account is deleted, which leaves the tombstone.
CREATE FUNCTION public.klorn_address_permanent() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a Klorn address is never deleted (L5)' USING ERRCODE = 'KA001';
  END IF;
  IF NEW."handle" IS DISTINCT FROM OLD."handle"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR OLD."userId" IS NULL
     OR NEW."userId" IS NOT NULL THEN
    RAISE EXCEPTION 'a Klorn address never changes, except to be retired with its account (L5)'
      USING ERRCODE = 'KA001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "KlornAddress_permanent"
  BEFORE UPDATE OR DELETE ON "KlornAddress"
  FOR EACH ROW EXECUTE FUNCTION public.klorn_address_permanent();
