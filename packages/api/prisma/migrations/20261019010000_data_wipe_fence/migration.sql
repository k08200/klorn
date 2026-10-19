-- Data-wipe fence (2026-10-19). See src/privacy/data-wipe-fence.ts.
--
-- A data wipe (DELETE /api/user/me/data) raced everything already running for
-- the user. A sync holding the token in memory, a judge call waiting in the
-- background LLM queue, or a timer from the last sign-in could insert rows
-- after the purge's deletes, and those rows outlived the wipe.
--
-- "DataWipe" records the wipe. The trigger below rejects an insert into any of
-- the account's data tables while the wipe is pending ("purgedAt" null) or
-- until "fenceUntil". It takes FOR KEY SHARE on the account row first; the wipe
-- takes FOR UPDATE on that row before it writes "DataWipe". So an insert that
-- got there first commits before the wipe starts and is purged with the rest,
-- and one that comes later waits for the wipe and then sees its record. Each
-- statement in a plpgsql function takes a fresh snapshot under READ COMMITTED,
-- so the EXISTS after the lock sees the committed record.
--
-- Timestamps are compared in UTC whatever the session time zone: the columns
-- are timestamp without time zone, written in UTC (db-url.ts pins the session).
-- search_path is empty and every name is schema-qualified (Supabase's
-- function_search_path_mutable advisor). SECURITY DEFINER: the functions read
-- "User", "DataWipe" and the parent tables under the migration role, so the
-- fence keeps working if the app ever runs as a role that RLS restricts
-- (docs/rls-rollout.md); they read and raise, nothing else.
--
-- Message, ConversationSummary and CommitmentPath have no "userId": their
-- trigger finds the owner through the parent row named by its arguments.

-- Fail fast instead of queueing behind a long lock: each CREATE TRIGGER takes
-- SHARE ROW EXCLUSIVE on its table until the migration commits (same guard as
-- 20261009010000).
SET LOCAL lock_timeout = '5s';

CREATE TABLE "DataWipe" (
    "userId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "purgedAt" TIMESTAMP(3),
    "fenceUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataWipe_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "DataWipe_purgedAt_idx" ON "DataWipe"("purgedAt");

ALTER TABLE "DataWipe" ADD CONSTRAINT "DataWipe_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, as for every table (docs/rls-rollout.md).
ALTER TABLE "DataWipe" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "DataWipe_tenant_isolation" ON "DataWipe" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "DataWipe_system_bypass" ON "DataWipe" USING (current_setting('app.bypass_rls', true) = 'on');

CREATE FUNCTION public.klorn_data_wipe_check(owner text, target text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $check$
BEGIN
  IF owner IS NULL THEN
    RETURN;
  END IF;
  PERFORM 1 FROM public."User" WHERE "id" = owner FOR KEY SHARE;
  IF EXISTS (
    SELECT 1 FROM public."DataWipe" w
    WHERE w."userId" = owner
      AND (w."purgedAt" IS NULL OR w."fenceUntil" > (now() AT TIME ZONE 'UTC'))
  ) THEN
    RAISE EXCEPTION 'klorn_data_wipe_fence: insert into % rejected, the account''s data wipe has not finished', target
      USING ERRCODE = 'KW001';
  END IF;
END;
$check$;

CREATE FUNCTION public.klorn_data_wipe_fence() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fence$
BEGIN
  PERFORM public.klorn_data_wipe_check(NEW."userId", TG_TABLE_NAME);
  RETURN NEW;
END;
$fence$;

-- TG_ARGV[0]: the parent table; TG_ARGV[1]: this table's column naming it.
CREATE FUNCTION public.klorn_data_wipe_fence_via_parent() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fence$
DECLARE
  owner text;
BEGIN
  EXECUTE format('SELECT "userId" FROM public.%I WHERE "id" = $1', TG_ARGV[0])
    INTO owner
    USING to_jsonb(NEW) ->> TG_ARGV[1];
  PERFORM public.klorn_data_wipe_check(owner, TG_TABLE_NAME);
  RETURN NEW;
END;
$fence$;

-- The functions run only as triggers. SECURITY DEFINER makes them callable by
-- anyone with EXECUTE, and PUBLIC holds EXECUTE by default; on Supabase that
-- would publish klorn_data_wipe_check as an anon RPC (a wipe-state oracle that
-- takes locks). Firing a trigger checks no EXECUTE privilege, and the
-- functions call the check as its owner, so revoking breaks nothing
-- (20261010020000 left pg_trgm's as the only callable functions in public).
REVOKE EXECUTE ON FUNCTION public.klorn_data_wipe_check(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.klorn_data_wipe_fence() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.klorn_data_wipe_fence_via_parent() FROM PUBLIC;
DO $revoke$
DECLARE
  data_api_role text;
BEGIN
  FOREACH data_api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = data_api_role) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.klorn_data_wipe_check(text, text) FROM %I', data_api_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.klorn_data_wipe_fence() FROM %I', data_api_role);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION public.klorn_data_wipe_fence_via_parent() FROM %I', data_api_role);
    END IF;
  END LOOP;
END;
$revoke$;

-- One per table in FENCED_MODELS (a guard test keeps the two lists equal).
CREATE TRIGGER "UserToken_data_wipe_fence" BEFORE INSERT ON "UserToken" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "LinkedInboxAccount_data_wipe_fence" BEFORE INSERT ON "LinkedInboxAccount" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "LinkedCalendarAccount_data_wipe_fence" BEFORE INSERT ON "LinkedCalendarAccount" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "LinkedDriveAccount_data_wipe_fence" BEFORE INSERT ON "LinkedDriveAccount" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "EmailMessage_data_wipe_fence" BEFORE INSERT ON "EmailMessage" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "EmailAttachment_data_wipe_fence" BEFORE INSERT ON "EmailAttachment" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "EmailProcessingLog_data_wipe_fence" BEFORE INSERT ON "EmailProcessingLog" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "EmailLabelFeedback_data_wipe_fence" BEFORE INSERT ON "EmailLabelFeedback" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "CandidateIntake_data_wipe_fence" BEFORE INSERT ON "CandidateIntake" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "ImapMovedMessage_data_wipe_fence" BEFORE INSERT ON "ImapMovedMessage" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "SentMessage_data_wipe_fence" BEFORE INSERT ON "SentMessage" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "SendReceipt_data_wipe_fence" BEFORE INSERT ON "SendReceipt" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "AttentionItem_data_wipe_fence" BEFORE INSERT ON "AttentionItem" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "DecisionLabel_data_wipe_fence" BEFORE INSERT ON "DecisionLabel" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "LearnedRule_data_wipe_fence" BEFORE INSERT ON "LearnedRule" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "SenderTrait_data_wipe_fence" BEFORE INSERT ON "SenderTrait" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "SenderLabel_data_wipe_fence" BEFORE INSERT ON "SenderLabel" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "ScreenerDecision_data_wipe_fence" BEFORE INSERT ON "ScreenerDecision" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "ContactDossier_data_wipe_fence" BEFORE INSERT ON "ContactDossier" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "ThreadBrief_data_wipe_fence" BEFORE INSERT ON "ThreadBrief" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "Commitment_data_wipe_fence" BEFORE INSERT ON "Commitment" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "FeedbackEvent_data_wipe_fence" BEFORE INSERT ON "FeedbackEvent" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "FeedbackPolicyPreference_data_wipe_fence" BEFORE INSERT ON "FeedbackPolicyPreference" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "CalibrationSnapshot_data_wipe_fence" BEFORE INSERT ON "CalibrationSnapshot" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "WorkContextSnapshot_data_wipe_fence" BEFORE INSERT ON "WorkContextSnapshot" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "CalendarEvent_data_wipe_fence" BEFORE INSERT ON "CalendarEvent" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "DriveFile_data_wipe_fence" BEFORE INSERT ON "DriveFile" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "DriveFileSummary_data_wipe_fence" BEFORE INSERT ON "DriveFileSummary" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "DriveSummaryUsage_data_wipe_fence" BEFORE INSERT ON "DriveSummaryUsage" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "Conversation_data_wipe_fence" BEFORE INSERT ON "Conversation" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "Task_data_wipe_fence" BEFORE INSERT ON "Task" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "Note_data_wipe_fence" BEFORE INSERT ON "Note" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "Reminder_data_wipe_fence" BEFORE INSERT ON "Reminder" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "Contact_data_wipe_fence" BEFORE INSERT ON "Contact" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "ContactTrustScore_data_wipe_fence" BEFORE INSERT ON "ContactTrustScore" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "ContactEngagementScore_data_wipe_fence" BEFORE INSERT ON "ContactEngagementScore" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "Team_data_wipe_fence" BEFORE INSERT ON "Team" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "Memory_data_wipe_fence" BEFORE INSERT ON "Memory" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "Skill_data_wipe_fence" BEFORE INSERT ON "Skill" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "ActivatedPlaybook_data_wipe_fence" BEFORE INSERT ON "ActivatedPlaybook" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "EmailRule_data_wipe_fence" BEFORE INSERT ON "EmailRule" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "PendingAction_data_wipe_fence" BEFORE INSERT ON "PendingAction" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "ActionOutbox_data_wipe_fence" BEFORE INSERT ON "ActionOutbox" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "AgentLog_data_wipe_fence" BEFORE INSERT ON "AgentLog" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "McpWriteAudit_data_wipe_fence" BEFORE INSERT ON "McpWriteAudit" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "Notification_data_wipe_fence" BEFORE INSERT ON "Notification" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "PushDeliveryLog_data_wipe_fence" BEFORE INSERT ON "PushDeliveryLog" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "PushRingEvent_data_wipe_fence" BEFORE INSERT ON "PushRingEvent" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();
CREATE TRIGGER "PhoneEscalation_data_wipe_fence" BEFORE INSERT ON "PhoneEscalation" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence();

-- One per table in PARENT_SCOPED_MODELS.
CREATE TRIGGER "Message_data_wipe_fence" BEFORE INSERT ON "Message" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence_via_parent('Conversation', 'conversationId');
CREATE TRIGGER "ConversationSummary_data_wipe_fence" BEFORE INSERT ON "ConversationSummary" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence_via_parent('Conversation', 'conversationId');
CREATE TRIGGER "CommitmentPath_data_wipe_fence" BEFORE INSERT ON "CommitmentPath" FOR EACH ROW EXECUTE FUNCTION public.klorn_data_wipe_fence_via_parent('Commitment', 'commitmentId');
