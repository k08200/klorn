-- Sender pin rules (user-enforced lane). Additive enum value.
ALTER TYPE "EmailRuleAction" ADD VALUE IF NOT EXISTS 'PIN_TIER';
