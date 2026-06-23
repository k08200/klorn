-- ActionOutbox.status was declared as the OutboxStatus enum in schema.prisma,
-- but the 20260612200000_action_outbox migration created the column as TEXT and
-- no migration ever created the enum type. The generated Prisma client emits
-- status casts to "OutboxStatus", so every ActionOutbox query (the outbox
-- drain) fails with `type "public.OutboxStatus" does not exist` — queued actions
-- never drain. `prisma migrate status` reports "up to date" because it only
-- diffs the _prisma_migrations log, not schema-vs-DB drift.
--
-- Create the enum and convert the column in place. The only values ever written
-- are QUEUED/IN_PROGRESS/COMPLETED/DEAD, so the USING cast is total.

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('QUEUED', 'IN_PROGRESS', 'COMPLETED', 'DEAD');

-- AlterTable
ALTER TABLE "ActionOutbox"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "OutboxStatus" USING ("status"::"OutboxStatus"),
  ALTER COLUMN "status" SET DEFAULT 'QUEUED';
