-- Enable Row-Level Security on the 19 public tables that still lacked it
-- (2026-10-03). Second of two migrations: 20261010020000_revoke_data_api_table_grants
-- runs first and takes the Data API roles' table privileges away.
--
-- Found on production (Supabase), read-only, 2026-10-03: the security advisor
-- reported ERROR `rls_disabled_in_public` for these 19 tables. Supabase serves
-- the `public` schema over its REST API as the roles `anon` and
-- `authenticated`, and both held SELECT, INSERT and DELETE on them. So anyone
-- holding the project's anon key could read or change them. The app never uses
-- that API: it connects with Prisma as `postgres`.
--
-- Safety, the same as 20260714140000 and 20260805120000: ENABLE only, never
-- FORCE, and the app's role both owns these tables and has BYPASSRLS. So this
-- changes nothing for the running app. Every other role now reaches a row only
-- through the policies below. See docs/rls-rollout.md.
--
-- This migration can fail where the first cannot. ENABLE ROW LEVEL SECURITY
-- needs an ACCESS EXCLUSIVE lock on each of the 19 tables, and one transaction
-- that holds any lock on one of them for more than 5 seconds makes the whole
-- file time out and roll back. scripts/start.sh then records it as applied
-- without running it (docs/rls-rollout.md, "Check the database after the
-- deploy"). That is why the revoke is a migration of its own: it is already
-- committed by then.
--
-- Every statement can run twice. A policy is dropped before it is created, so
-- applying this by hand first and deploying it afterwards does not fail.
-- Slotted after 20261010010000_attention_override_undo (main) and the revoke.
-- Fail fast instead of queueing behind a long lock (same guard as 20261007010000).
SET LOCAL lock_timeout = '5s';

-- 1. Tables with a "userId" column: the two policies every other tenant table has.

ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ApiKey_tenant_isolation" ON "ApiKey";
CREATE POLICY "ApiKey_tenant_isolation" ON "ApiKey" USING ("userId" = current_setting('app.current_user_id', true));
DROP POLICY IF EXISTS "ApiKey_system_bypass" ON "ApiKey";
CREATE POLICY "ApiKey_system_bypass" ON "ApiKey" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "ContactDossier" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ContactDossier_tenant_isolation" ON "ContactDossier";
CREATE POLICY "ContactDossier_tenant_isolation" ON "ContactDossier" USING ("userId" = current_setting('app.current_user_id', true));
DROP POLICY IF EXISTS "ContactDossier_system_bypass" ON "ContactDossier";
CREATE POLICY "ContactDossier_system_bypass" ON "ContactDossier" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "ImapMovedMessage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ImapMovedMessage_tenant_isolation" ON "ImapMovedMessage";
CREATE POLICY "ImapMovedMessage_tenant_isolation" ON "ImapMovedMessage" USING ("userId" = current_setting('app.current_user_id', true));
DROP POLICY IF EXISTS "ImapMovedMessage_system_bypass" ON "ImapMovedMessage";
CREATE POLICY "ImapMovedMessage_system_bypass" ON "ImapMovedMessage" USING (current_setting('app.bypass_rls', true) = 'on');

-- "userId" is nullable here: NULL marks a system call. NULL never equals the
-- tenant id, so those rows are reachable through the system bypass only, as on
-- "AnalyticsEvent".
ALTER TABLE "LlmUsageLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "LlmUsageLog_tenant_isolation" ON "LlmUsageLog";
CREATE POLICY "LlmUsageLog_tenant_isolation" ON "LlmUsageLog" USING ("userId" = current_setting('app.current_user_id', true));
DROP POLICY IF EXISTS "LlmUsageLog_system_bypass" ON "LlmUsageLog";
CREATE POLICY "LlmUsageLog_system_bypass" ON "LlmUsageLog" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "McpWriteAudit" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "McpWriteAudit_tenant_isolation" ON "McpWriteAudit";
CREATE POLICY "McpWriteAudit_tenant_isolation" ON "McpWriteAudit" USING ("userId" = current_setting('app.current_user_id', true));
DROP POLICY IF EXISTS "McpWriteAudit_system_bypass" ON "McpWriteAudit";
CREATE POLICY "McpWriteAudit_system_bypass" ON "McpWriteAudit" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "PmfResponse" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PmfResponse_tenant_isolation" ON "PmfResponse";
CREATE POLICY "PmfResponse_tenant_isolation" ON "PmfResponse" USING ("userId" = current_setting('app.current_user_id', true));
DROP POLICY IF EXISTS "PmfResponse_system_bypass" ON "PmfResponse";
CREATE POLICY "PmfResponse_system_bypass" ON "PmfResponse" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "ScreenerDecision" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ScreenerDecision_tenant_isolation" ON "ScreenerDecision";
CREATE POLICY "ScreenerDecision_tenant_isolation" ON "ScreenerDecision" USING ("userId" = current_setting('app.current_user_id', true));
DROP POLICY IF EXISTS "ScreenerDecision_system_bypass" ON "ScreenerDecision";
CREATE POLICY "ScreenerDecision_system_bypass" ON "ScreenerDecision" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "SenderLabel" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SenderLabel_tenant_isolation" ON "SenderLabel";
CREATE POLICY "SenderLabel_tenant_isolation" ON "SenderLabel" USING ("userId" = current_setting('app.current_user_id', true));
DROP POLICY IF EXISTS "SenderLabel_system_bypass" ON "SenderLabel";
CREATE POLICY "SenderLabel_system_bypass" ON "SenderLabel" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "SentMessage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SentMessage_tenant_isolation" ON "SentMessage";
CREATE POLICY "SentMessage_tenant_isolation" ON "SentMessage" USING ("userId" = current_setting('app.current_user_id', true));
DROP POLICY IF EXISTS "SentMessage_system_bypass" ON "SentMessage";
CREATE POLICY "SentMessage_system_bypass" ON "SentMessage" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "Team" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Team_tenant_isolation" ON "Team";
CREATE POLICY "Team_tenant_isolation" ON "Team" USING ("userId" = current_setting('app.current_user_id', true));
DROP POLICY IF EXISTS "Team_system_bypass" ON "Team";
CREATE POLICY "Team_system_bypass" ON "Team" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "ThreadBrief" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ThreadBrief_tenant_isolation" ON "ThreadBrief";
CREATE POLICY "ThreadBrief_tenant_isolation" ON "ThreadBrief" USING ("userId" = current_setting('app.current_user_id', true));
DROP POLICY IF EXISTS "ThreadBrief_system_bypass" ON "ThreadBrief";
CREATE POLICY "ThreadBrief_system_bypass" ON "ThreadBrief" USING (current_setting('app.bypass_rls', true) = 'on');

-- 2. Tables with no "userId" whose parent has one: the tenant is the parent's.
--
-- These hold a user's chat messages, their summaries and a commitment's steps,
-- and tenant-scoped handlers read them together with the parent. A bypass-only
-- policy would return zero rows to those handlers once RLS binds, or push them
-- to withSystem, which drops the backstop on the most sensitive of these
-- tables. The subquery reads the parent under the parent's own policies, so a
-- child row is never visible when its parent is not. The lookup is by the
-- parent's primary key.

ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Message_tenant_isolation" ON "Message";
CREATE POLICY "Message_tenant_isolation" ON "Message" USING (EXISTS (SELECT 1 FROM "Conversation" parent WHERE parent."id" = "Message"."conversationId" AND parent."userId" = current_setting('app.current_user_id', true)));
DROP POLICY IF EXISTS "Message_system_bypass" ON "Message";
CREATE POLICY "Message_system_bypass" ON "Message" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "ConversationSummary" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ConversationSummary_tenant_isolation" ON "ConversationSummary";
CREATE POLICY "ConversationSummary_tenant_isolation" ON "ConversationSummary" USING (EXISTS (SELECT 1 FROM "Conversation" parent WHERE parent."id" = "ConversationSummary"."conversationId" AND parent."userId" = current_setting('app.current_user_id', true)));
DROP POLICY IF EXISTS "ConversationSummary_system_bypass" ON "ConversationSummary";
CREATE POLICY "ConversationSummary_system_bypass" ON "ConversationSummary" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "CommitmentPath" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CommitmentPath_tenant_isolation" ON "CommitmentPath";
CREATE POLICY "CommitmentPath_tenant_isolation" ON "CommitmentPath" USING (EXISTS (SELECT 1 FROM "Commitment" parent WHERE parent."id" = "CommitmentPath"."commitmentId" AND parent."userId" = current_setting('app.current_user_id', true)));
DROP POLICY IF EXISTS "CommitmentPath_system_bypass" ON "CommitmentPath";
CREATE POLICY "CommitmentPath_system_bypass" ON "CommitmentPath" USING (current_setting('app.bypass_rls', true) = 'on');

-- 3. System tables with no owning user: the bypass policy only.
--
-- "GlobalCostLedger" is one fleet-wide row per day, "WebhookEvent" a global
-- idempotency ledger, "Waitlist" holds people who have no account yet, and
-- "OntologyProposal" tunes the classifier for everyone. No tenant can own a row.

ALTER TABLE "GlobalCostLedger" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "GlobalCostLedger_system_bypass" ON "GlobalCostLedger";
CREATE POLICY "GlobalCostLedger_system_bypass" ON "GlobalCostLedger" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "OntologyProposal" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "OntologyProposal_system_bypass" ON "OntologyProposal";
CREATE POLICY "OntologyProposal_system_bypass" ON "OntologyProposal" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "Waitlist" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Waitlist_system_bypass" ON "Waitlist";
CREATE POLICY "Waitlist_system_bypass" ON "Waitlist" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "WebhookEvent_system_bypass" ON "WebhookEvent";
CREATE POLICY "WebhookEvent_system_bypass" ON "WebhookEvent" USING (current_setting('app.bypass_rls', true) = 'on');

-- 4. Prisma's own bookkeeping table: RLS on, no policy.
--
-- With no policy, RLS denies every row to every role that neither owns the
-- table nor bypasses RLS. `prisma migrate deploy` runs as the owner, so it is
-- unaffected. IF EXISTS because a shadow database (`prisma migrate diff`, the
-- CI Migrations job) replays this file with no such table.
ALTER TABLE IF EXISTS "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
