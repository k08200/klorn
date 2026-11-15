-- Klorn Teams v1 foundation (2026-11-14). See src/org/ and
-- docs/design/pricing-tiers.md "Team (company) plan".
--
-- Organization, OrgMembership, OrgInvite, AvailabilityGrant and OrgAuditEvent.
-- An organization is a scheduling and billing object: it holds no mail, and no
-- organization role reads a member's mail (the privacy invariants of
-- docs/design/team-mode-v3.md). Seat entitlement is derived from OrgMembership
-- at read time and never written to "User"."plan".
--
-- EXPAND ONLY: five new, empty tables and two enum types that nothing reads
-- while TEAMS_ENABLED is off. The previous instance keeps running without them
-- during the swap. The foreign keys take SHARE ROW EXCLUSIVE on "User" for the
-- length of the transaction; lock_timeout makes a deploy blocked by a long
-- transaction fail fast instead of queueing writes behind it. If it fails on
-- lock_timeout, Prisma records the migration as failed: run
-- `prisma migrate resolve --rolled-back 20261114130000_teams_v1_foundation`
-- and redeploy.
--
-- Row-level security in the forms of docs/rls-rollout.md: OrgMembership and
-- AvailabilityGrant carry "userId" and get the standard pair; Organization,
-- OrgInvite and OrgAuditEvent have no owning user and get the bypass policy
-- only. Reads that span members (the roster, a co-member's free/busy) go
-- through the system scope once RLS binds.
--
-- Not in the data-wipe fence (privacy/data-wipe-fence.ts UNFENCED_MODELS):
-- membership and the free/busy consent are account settings with no mail data.
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'MEMBER');

-- CreateEnum
CREATE TYPE "AvailabilityScope" AS ENUM ('NONE', 'FREEBUSY');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(48) NOT NULL,
    "companyDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoReplyDisabled" BOOLEAN NOT NULL DEFAULT false,
    "agentModeCap" VARCHAR(16),
    "seatsPurchased" INTEGER NOT NULL DEFAULT 0,
    "billingInterval" VARCHAR(8),
    "subscriptionStatus" VARCHAR(16),
    "paddleCustomerId" TEXT,
    "paddleSubscriptionId" TEXT,
    "subscriptionEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgMembership" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgInvite" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "invitedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityGrant" (
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scope" "AvailabilityScope" NOT NULL DEFAULT 'NONE',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AvailabilityGrant_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "OrgAuditEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" VARCHAR(48) NOT NULL,
    "targetUserId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_paddleSubscriptionId_key" ON "Organization"("paddleSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgMembership_userId_key" ON "OrgMembership"("userId");

-- CreateIndex
CREATE INDEX "OrgMembership_orgId_joinedAt_idx" ON "OrgMembership"("orgId", "joinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrgInvite_tokenHash_key" ON "OrgInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "OrgInvite_orgId_createdAt_idx" ON "OrgInvite"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "AvailabilityGrant_orgId_idx" ON "AvailabilityGrant"("orgId");

-- CreateIndex
CREATE INDEX "OrgAuditEvent_orgId_createdAt_idx" ON "OrgAuditEvent"("orgId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrgMembership" ADD CONSTRAINT "OrgMembership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgMembership" ADD CONSTRAINT "OrgMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgInvite" ADD CONSTRAINT "OrgInvite_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityGrant" ADD CONSTRAINT "AvailabilityGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilityGrant" ADD CONSTRAINT "AvailabilityGrant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgAuditEvent" ADD CONSTRAINT "OrgAuditEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Exactly one OWNER per organization, in the database itself (src/org/
-- org-lock.ts serializes the changes; this backs it). A partial index, which
-- Prisma neither models nor reports as drift.
CREATE UNIQUE INDEX "OrgMembership_one_owner_per_org" ON "OrgMembership" ("orgId") WHERE "role" = 'OWNER';

-- Row-level security
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Organization_system_bypass" ON "Organization" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "OrgMembership" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "OrgMembership_tenant_isolation" ON "OrgMembership" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "OrgMembership_system_bypass" ON "OrgMembership" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "OrgInvite" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "OrgInvite_system_bypass" ON "OrgInvite" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "AvailabilityGrant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "AvailabilityGrant_tenant_isolation" ON "AvailabilityGrant" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "AvailabilityGrant_system_bypass" ON "AvailabilityGrant" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "OrgAuditEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "OrgAuditEvent_system_bypass" ON "OrgAuditEvent" USING (current_setting('app.bypass_rls', true) = 'on');
