-- Add lastAmplifiedAt to AttentionItem for priority-decay tracking
ALTER TABLE "AttentionItem" ADD COLUMN IF NOT EXISTS "lastAmplifiedAt" TIMESTAMP(3);
