-- Enable Row-Level Security on every per-user table, PERMISSIVE (NOT FORCED).
--
-- Safety: the app connects as the table owner, and an owner bypasses RLS
-- unless FORCE ROW LEVEL SECURITY is set. This migration never FORCEs, so it
-- is INERT for the running app — zero functional change, cannot deny-all.
-- It only installs the policies so a later, per-table `FORCE` (done after a
-- backup/restore rehearsal, once query sites are routed through db-tenant.ts's
-- withTenant/withSystem) activates isolation with no further code change.
--
-- Two permissive policies OR together per table:
--   *_tenant_isolation : "userId" = current_setting('app.current_user_id', true)
--   *_system_bypass    : current_setting('app.bypass_rls', true) = 'on'
-- current_setting(..., true) returns NULL (missing_ok) when the GUC is unset,
-- so with neither set and FORCE on, the table fails closed (no rows) — the
-- intended default. WITH CHECK defaults to USING, so writes are tenant-scoped
-- too once forced.
--
-- Not covered here (need bespoke policies, follow-up slices): Message
-- (scoped via conversationId, no direct userId), LlmUsageLog (nullable userId
-- for system calls), WebhookEvent (global idempotency ledger).

ALTER TABLE "Device" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Device_tenant_isolation" ON "Device" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "Device_system_bypass" ON "Device" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Conversation_tenant_isolation" ON "Conversation" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "Conversation_system_bypass" ON "Conversation" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "UserToken" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "UserToken_tenant_isolation" ON "UserToken" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "UserToken_system_bypass" ON "UserToken" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "LinkedCalendarAccount" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "LinkedCalendarAccount_tenant_isolation" ON "LinkedCalendarAccount" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "LinkedCalendarAccount_system_bypass" ON "LinkedCalendarAccount" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "LinkedInboxAccount" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "LinkedInboxAccount_tenant_isolation" ON "LinkedInboxAccount" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "LinkedInboxAccount_system_bypass" ON "LinkedInboxAccount" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Task_tenant_isolation" ON "Task" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "Task_system_bypass" ON "Task" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "Note" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Note_tenant_isolation" ON "Note" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "Note_system_bypass" ON "Note" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "Reminder" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Reminder_tenant_isolation" ON "Reminder" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "Reminder_system_bypass" ON "Reminder" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Contact_tenant_isolation" ON "Contact" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "Contact_system_bypass" ON "Contact" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "CalendarEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CalendarEvent_tenant_isolation" ON "CalendarEvent" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "CalendarEvent_system_bypass" ON "CalendarEvent" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "AutomationConfig" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "AutomationConfig_tenant_isolation" ON "AutomationConfig" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "AutomationConfig_system_bypass" ON "AutomationConfig" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "AgentLog" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "AgentLog_tenant_isolation" ON "AgentLog" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "AgentLog_system_bypass" ON "AgentLog" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "EmailProcessingLog" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "EmailProcessingLog_tenant_isolation" ON "EmailProcessingLog" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "EmailProcessingLog_system_bypass" ON "EmailProcessingLog" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Notification_tenant_isolation" ON "Notification" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "Notification_system_bypass" ON "Notification" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "PushSubscription" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "PushSubscription_tenant_isolation" ON "PushSubscription" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "PushSubscription_system_bypass" ON "PushSubscription" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "DevicePushToken" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "DevicePushToken_tenant_isolation" ON "DevicePushToken" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "DevicePushToken_system_bypass" ON "DevicePushToken" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "PushDeliveryLog" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "PushDeliveryLog_tenant_isolation" ON "PushDeliveryLog" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "PushDeliveryLog_system_bypass" ON "PushDeliveryLog" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "PushRingEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "PushRingEvent_tenant_isolation" ON "PushRingEvent" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "PushRingEvent_system_bypass" ON "PushRingEvent" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "CalibrationSnapshot" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CalibrationSnapshot_tenant_isolation" ON "CalibrationSnapshot" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "CalibrationSnapshot_system_bypass" ON "CalibrationSnapshot" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "PhoneEscalation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "PhoneEscalation_tenant_isolation" ON "PhoneEscalation" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "PhoneEscalation_system_bypass" ON "PhoneEscalation" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "Memory" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Memory_tenant_isolation" ON "Memory" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "Memory_system_bypass" ON "Memory" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "Skill" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Skill_tenant_isolation" ON "Skill" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "Skill_system_bypass" ON "Skill" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "TokenUsage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "TokenUsage_tenant_isolation" ON "TokenUsage" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "TokenUsage_system_bypass" ON "TokenUsage" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "PendingAction" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "PendingAction_tenant_isolation" ON "PendingAction" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "PendingAction_system_bypass" ON "PendingAction" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "ActionOutbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ActionOutbox_tenant_isolation" ON "ActionOutbox" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "ActionOutbox_system_bypass" ON "ActionOutbox" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "EmailMessage" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "EmailMessage_tenant_isolation" ON "EmailMessage" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "EmailMessage_system_bypass" ON "EmailMessage" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "EmailAttachment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "EmailAttachment_tenant_isolation" ON "EmailAttachment" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "EmailAttachment_system_bypass" ON "EmailAttachment" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "CandidateIntake" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "CandidateIntake_tenant_isolation" ON "CandidateIntake" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "CandidateIntake_system_bypass" ON "CandidateIntake" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "EmailLabelFeedback" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "EmailLabelFeedback_tenant_isolation" ON "EmailLabelFeedback" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "EmailLabelFeedback_system_bypass" ON "EmailLabelFeedback" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "EmailRule" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "EmailRule_tenant_isolation" ON "EmailRule" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "EmailRule_system_bypass" ON "EmailRule" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "AttentionItem" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "AttentionItem_tenant_isolation" ON "AttentionItem" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "AttentionItem_system_bypass" ON "AttentionItem" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "DecisionLabel" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "DecisionLabel_tenant_isolation" ON "DecisionLabel" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "DecisionLabel_system_bypass" ON "DecisionLabel" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "LearnedRule" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "LearnedRule_tenant_isolation" ON "LearnedRule" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "LearnedRule_system_bypass" ON "LearnedRule" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "SenderTrait" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "SenderTrait_tenant_isolation" ON "SenderTrait" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "SenderTrait_system_bypass" ON "SenderTrait" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "Commitment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Commitment_tenant_isolation" ON "Commitment" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "Commitment_system_bypass" ON "Commitment" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "FeedbackEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "FeedbackEvent_tenant_isolation" ON "FeedbackEvent" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "FeedbackEvent_system_bypass" ON "FeedbackEvent" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "WorkContextSnapshot" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "WorkContextSnapshot_tenant_isolation" ON "WorkContextSnapshot" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "WorkContextSnapshot_system_bypass" ON "WorkContextSnapshot" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "ActivatedPlaybook" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ActivatedPlaybook_tenant_isolation" ON "ActivatedPlaybook" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "ActivatedPlaybook_system_bypass" ON "ActivatedPlaybook" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "FeedbackPolicyPreference" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "FeedbackPolicyPreference_tenant_isolation" ON "FeedbackPolicyPreference" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "FeedbackPolicyPreference_system_bypass" ON "FeedbackPolicyPreference" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "ContactTrustScore" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ContactTrustScore_tenant_isolation" ON "ContactTrustScore" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "ContactTrustScore_system_bypass" ON "ContactTrustScore" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "ContactEngagementScore" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ContactEngagementScore_tenant_isolation" ON "ContactEngagementScore" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "ContactEngagementScore_system_bypass" ON "ContactEngagementScore" USING (current_setting('app.bypass_rls', true) = 'on');

ALTER TABLE "LlmCostLedger" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "LlmCostLedger_tenant_isolation" ON "LlmCostLedger" USING ("userId" = current_setting('app.current_user_id', true));
CREATE POLICY "LlmCostLedger_system_bypass" ON "LlmCostLedger" USING (current_setting('app.bypass_rls', true) = 'on');

