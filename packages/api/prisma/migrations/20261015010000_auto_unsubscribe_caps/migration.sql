-- Auto-unsubscribe caps (security review 2026-08-27): a per-user daily
-- counter on "User" and fleet-wide counters (per target domain, global) in a
-- new system-only table. AUTO_UNSUBSCRIBE_ENABLED stays off; this only makes
-- flipping it safe. Additive: two columns with defaults, one new table.

ALTER TABLE "User" ADD COLUMN "autoUnsubscribeDay" TEXT;
ALTER TABLE "User" ADD COLUMN "autoUnsubscribeCount" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "UnsubscribeQuota" (
    "key" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnsubscribeQuota_pkey" PRIMARY KEY ("key")
);

-- No "userId": system-only, so the bypass policy and no tenant line
-- (docs/rls-rollout.md). The default-privilege revoke already keeps the
-- Data API roles off it.
ALTER TABLE "UnsubscribeQuota" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "UnsubscribeQuota_system_bypass" ON "UnsubscribeQuota" USING (current_setting('app.bypass_rls', true) = 'on');
