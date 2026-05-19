-- Convert PendingAction.toolArgs from TEXT (JSON-as-String) to JSONB.
-- Audited 2026-05-19: every writer (autonomous-agent.ts, skill-recorder.ts,
-- routes/chat.ts createPendingActionFromProposal) used JSON.stringify of
-- a plain object. The cast is safe per row.
--
-- We intentionally leave `result` as TEXT — different tools return
-- different shapes (sometimes already a JSON string, sometimes a plain
-- text status message). Keeping it loose avoids breaking the heterogeneous
-- return values from tool-executor.ts.

ALTER TABLE "PendingAction"
  ALTER COLUMN "toolArgs" TYPE JSONB
  USING ("toolArgs"::jsonb);
