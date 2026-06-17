-- Flip the AutomationConfig.autonomousAgent default to OFF.
--
-- A fresh install is a pure 4-tier firewall (classify-only) — the README
-- doctrine is "an attention firewall, not a suggestion engine". The proactive
-- agent loop is opt-in, so newly-created configs must default to disabled.
--
-- This only changes the default for FUTURE inserts. Existing rows keep their
-- current value (so anyone already running the agent loop is unaffected).
ALTER TABLE "AutomationConfig" ALTER COLUMN "autonomousAgent" SET DEFAULT false;
