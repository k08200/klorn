-- verifyToken / resetToken now store the SHA-256 hash of the emailed token
-- (same standard as Device.tokenHash), so outstanding plaintext tokens can no
-- longer be redeemed. Null them out: affected users simply re-request. Max
-- inconvenience window: verify links were 24h-lived, reset links 1h-lived.
UPDATE "User" SET "verifyToken" = NULL, "verifyTokenExp" = NULL WHERE "verifyToken" IS NOT NULL;
UPDATE "User" SET "resetToken" = NULL, "resetTokenExp" = NULL WHERE "resetToken" IS NOT NULL;
