-- Second attention source: GitHub notification threads (PR/issue/CI/mention)
-- surface as AttentionItems with source = GITHUB, sourceId = thread id, so
-- the generic firewall queue tiers them alongside email. Mirrors the EMAIL
-- enum-add (20260529100000); the BYO-token poller lands in a follow-up.

ALTER TYPE "AttentionSource" ADD VALUE IF NOT EXISTS 'GITHUB';
