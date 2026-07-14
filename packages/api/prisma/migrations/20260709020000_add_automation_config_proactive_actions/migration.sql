-- Per-user opt-in toggle for rule-based proactive actions (reminders/
-- notifications only — no floor actions, no LLM cost). Backs the settings UI
-- toggle and the scheduler's per-user check, both of which referenced this
-- field before the column existed (a PATCH /api/automations carrying
-- proactiveActions previously threw a Prisma "unknown column" error → 500).
-- NOT NULL DEFAULT false so existing rows keep their classify-only behaviour.
ALTER TABLE "AutomationConfig" ADD COLUMN "proactiveActions" BOOLEAN NOT NULL DEFAULT false;
