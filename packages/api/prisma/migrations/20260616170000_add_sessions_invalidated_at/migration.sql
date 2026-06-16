-- Global session-revocation epoch for the User. Stamped on password reset so
-- every JWT issued before that instant (compared against the token's `iat`
-- claim at the auth gate) is rejected, independently of the Device table.
--
-- Fixes the reset-password bypass: reset wiped all Device rows, which dropped
-- the user to zero devices and tripped the "no devices = legacy session, allow
-- through" branch in isDeviceSessionValid, silently re-accepting every
-- still-unexpired stolen token the reset was meant to kill.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionsInvalidatedAt" TIMESTAMP(3);
