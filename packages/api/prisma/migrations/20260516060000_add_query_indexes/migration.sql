-- Add indexes for common query patterns
-- These cover the hot read paths: listing tasks by status/due, reminders by status/time,
-- calendar events by time window, and notification unread counts.

CREATE INDEX "Task_userId_status_dueDate_idx" ON "Task"("userId", "status", "dueDate");
CREATE INDEX "Reminder_userId_status_remindAt_idx" ON "Reminder"("userId", "status", "remindAt");
CREATE INDEX "CalendarEvent_userId_startTime_idx" ON "CalendarEvent"("userId", "startTime");
CREATE INDEX "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");
