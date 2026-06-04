-- Deterministic floor enforcement (PR #481 follow-up to #480 doctrine).
-- Stores the signed ActionReceipt minted at /approve time for floor actions.
-- Nullable on purpose: legacy rows pre-this-PR have no receipt, and non-floor
-- toolNames don't need one. Verification happens in tool-executor.ts on the
-- floor-action subset only.

ALTER TABLE "PendingAction"
  ADD COLUMN IF NOT EXISTS "actionReceipt" JSONB;
