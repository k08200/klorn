-- Reject-with-feedback (HITL gap A, 2026-06-11 engine audit).
-- Stores the user's stated "why" at reject time so the learning signal is
-- no longer thrown away. Nullable on purpose: rejecting without a reason
-- stays valid (back-compat) and legacy rows have no reason. Length is
-- enforced at the route boundary (trim, max 500 chars), not in the DB.

ALTER TABLE "PendingAction"
  ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;
