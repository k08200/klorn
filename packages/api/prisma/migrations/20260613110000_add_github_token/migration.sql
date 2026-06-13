-- GitHub as a second attention source: store the user's encrypted personal
-- access token (BYO, like the Naver app-password) + a poll cursor. Nullable
-- and additive — no behavior change until a user connects a token.

ALTER TABLE "User" ADD COLUMN "githubTokenCipher" TEXT;
ALTER TABLE "User" ADD COLUMN "githubConnectedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "githubLastPolledAt" TIMESTAMP(3);
