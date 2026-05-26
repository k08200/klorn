-- Remove POC-out models: Workspace, WorkspaceMember, Agent, TestRun, Evaluation
-- and their enums (WorkspaceRole, TestStatus, Verdict).
--
-- These shipped with the original AI-coding-agents evaluation product (pre-pivot)
-- plus the team-workspace scaffolding from the v1 multi-tenant phase. POC scope
-- has no team surface and no agent evaluation harness, so the rows are dead.
--
-- Order: drop dependent tables first (Evaluation → TestRun → Agent;
-- WorkspaceMember → Workspace), then enums.

DROP TABLE IF EXISTS "Evaluation" CASCADE;
DROP TABLE IF EXISTS "TestRun" CASCADE;
DROP TABLE IF EXISTS "Agent" CASCADE;
DROP TABLE IF EXISTS "WorkspaceMember" CASCADE;
DROP TABLE IF EXISTS "Workspace" CASCADE;

DROP TYPE IF EXISTS "WorkspaceRole";
DROP TYPE IF EXISTS "TestStatus";
DROP TYPE IF EXISTS "Verdict";
