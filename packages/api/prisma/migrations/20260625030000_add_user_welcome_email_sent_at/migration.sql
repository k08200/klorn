-- Founder welcome email: deliver it exactly once per user across the
-- email-verify and Google sign-in paths. Null = not sent yet; the atomic
-- claim in welcome-email.ts flips null -> now() so concurrent first sign-ins
-- cannot double-send.
--
-- Safe on a populated table: a nullable column with no default backfills as
-- NULL on every existing row.
ALTER TABLE "User" ADD COLUMN "welcomeEmailSentAt" TIMESTAMP(3);

-- Rollout decision: suppress the welcome for every pre-existing user. The email
-- reads "you just got set up", which would be jarring for accounts that have
-- used Klorn for days or weeks. Stamping them as already-welcomed means only
-- accounts created AFTER this migration receive it. New rows default to NULL,
-- so they remain eligible.
UPDATE "User" SET "welcomeEmailSentAt" = now() WHERE "welcomeEmailSentAt" IS NULL;
