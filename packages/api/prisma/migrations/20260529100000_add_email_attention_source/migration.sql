-- POC firewall: surface each judged EmailMessage as an AttentionItem
-- with source = EMAIL, sourceId = EmailMessage.id. Lets the existing
-- /api/inbox/firewall route render emails alongside PendingActions in
-- the same tier-grouped queue.

ALTER TYPE "AttentionSource" ADD VALUE IF NOT EXISTS 'EMAIL';
