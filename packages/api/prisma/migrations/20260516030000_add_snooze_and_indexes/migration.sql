-- Snooze + decay fields for AttentionItem queue
ALTER TABLE "AttentionItem" ADD COLUMN IF NOT EXISTS "snoozedUntil" TIMESTAMP(3);
ALTER TABLE "AttentionItem" ADD COLUMN IF NOT EXISTS "lastAmplifiedAt" TIMESTAMP(3);

-- Missing performance indexes identified through query analysis

-- Tasks: users filter by status + due date constantly (overdue queries)
CREATE INDEX IF NOT EXISTS "Task_userId_status_dueDate_idx"
  ON "Task"("userId", "status", "dueDate" ASC NULLS LAST);

-- Reminders: due-soon queries filter by status + remindAt
CREATE INDEX IF NOT EXISTS "Reminder_userId_status_remindAt_idx"
  ON "Reminder"("userId", "status", "remindAt" ASC NULLS LAST);

-- Messages: chat history loads by conversation + role, ordered by time
CREATE INDEX IF NOT EXISTS "Message_conversationId_role_createdAt_idx"
  ON "Message"("conversationId", "role", "createdAt" DESC);

-- Memory: agent context loads highest-confidence memories first
CREATE INDEX IF NOT EXISTS "Memory_userId_type_confidence_idx"
  ON "Memory"("userId", "type", "confidence" DESC);

-- AgentLog: agent activity page groups by action + time
CREATE INDEX IF NOT EXISTS "AgentLog_userId_action_createdAt_idx"
  ON "AgentLog"("userId", "action", "createdAt" DESC);

-- Notifications: dashboard loads unread by type
CREATE INDEX IF NOT EXISTS "Notification_userId_type_isRead_createdAt_idx"
  ON "Notification"("userId", "type", "isRead", "createdAt" DESC);

-- EmailProcessingLog: receipt page filters by mode + processedAt
CREATE INDEX IF NOT EXISTS "EmailProcessingLog_userId_mode_processedAt_idx"
  ON "EmailProcessingLog"("userId", "mode", "processedAt" DESC);

-- AttentionItem: snooze resurrection query (find items to wake up)
CREATE INDEX IF NOT EXISTS "AttentionItem_userId_status_snoozedUntil_idx"
  ON "AttentionItem"("userId", "status", "snoozedUntil" ASC NULLS LAST)
  WHERE "snoozedUntil" IS NOT NULL;
