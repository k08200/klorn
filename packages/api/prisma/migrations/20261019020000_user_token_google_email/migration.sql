-- UserToken.googleEmail (2026-10-19). See auth/google-grant-revoke.ts.
--
-- Klorn never revoked a Google grant: wiping data, deleting the account or
-- disconnecting Gmail deleted only Klorn's copy of the tokens, so the grant
-- stayed on the user's Google account and the encrypted refresh token stayed
-- valid in backups. Google revokes a grant for the whole Google account, and
-- two Klorn accounts can hold grants for the same one (a shared mailbox
-- linked by two users), so a revoke must know the account's address first.
-- Linked accounts already store it; the primary grant did not.
--
-- Nullable, no default, no backfill here: the address is read from Gmail at
-- connect, or the first time a revoke needs it. Adding a nullable column is a
-- catalog-only change.
-- Fail fast instead of queueing behind a long lock (same guard as 20261009010000).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "UserToken" ADD COLUMN "googleEmail" TEXT;

CREATE INDEX "UserToken_googleEmail_idx" ON "UserToken"("googleEmail");
