-- First-touch inflow attribution, captured on the login surface and carried
-- through the signup that follows. utm_* / referrer hostname / landing path
-- only — no PII. Nullable: accounts created before this, and anyone who
-- arrives with no params at all, simply have none.
ALTER TABLE "User" ADD COLUMN "attribution" TEXT;
