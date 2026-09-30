-- Agent lane provenance (2026-09-30): which AttentionItem tiers an MCP agent set
-- through set_tier, and with which API key (step A2b of
-- docs/providers/unified-platform-plan.md).
--
-- A non-NULL "agentTierSetAt" means the item's CURRENT tier was set by an agent.
-- It is deliberately separate from "isManualOverride", the human ground-truth
-- flag that only a person's action may set: every reader that turns lane changes
-- into learning (sender priors, tier history, correction examples, calibration)
-- skips rows carrying this stamp, and any write that replaces the tier with a
-- judge or human decision clears it. "agentTierKeyId" is the ApiKey id and is
-- deliberately not a foreign key, so the history outlives the key (same as
-- "McpWriteAudit"."apiKeyId").
--
-- Nothing writes either column while MCP_WRITE_TOOLS_ENABLED is off. Existing
-- rows keep NULL in both, which reads "not set by an agent".
--
-- Additive only: two nullable columns, no default, no index, no rewrite of
-- existing rows. Safe to apply ahead of the code that reads or writes them.

-- AlterTable
ALTER TABLE "AttentionItem" ADD COLUMN "agentTierSetAt" TIMESTAMP(3),
ADD COLUMN "agentTierKeyId" TEXT;
