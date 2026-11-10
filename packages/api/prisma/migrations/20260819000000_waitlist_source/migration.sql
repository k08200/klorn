-- Self-reported acquisition channel on the waitlist ("how did you hear about
-- us"). Additive and nullable: every existing row stays valid and the form
-- field is optional, so no signup can fail because of it.
--
-- Why this column exists at all: GitHub restricted the stargazers API on
-- 2026-06-30 (admin-only), so referral reconstruction from outside the repo is
-- no longer possible, and self-hosted installs never phone home by design.
-- This is the only channel attribution the product can still collect.
ALTER TABLE "Waitlist" ADD COLUMN "source" VARCHAR(80);
