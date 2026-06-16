-- Drop three indexes fully covered by an existing composite UNIQUE on the same
-- leftmost columns. The unique's b-tree already serves every equality and
-- userId-prefix scan, so these plain indexes only added write amplification +
-- storage. (Sub-project F cleanup; no query plan loses an access path.)
--   Skill_userId_idx            ⊂ Skill_userId_key            (userId, key)
--   ContactTrustScore_userId_idx ⊂ ContactTrustScore_userId_contactEmail_key
--   LlmCostLedger_userId_dayKey_idx = LlmCostLedger_userId_dayKey_key (exact dup)
DROP INDEX IF EXISTS "Skill_userId_idx";
DROP INDEX IF EXISTS "ContactTrustScore_userId_idx";
DROP INDEX IF EXISTS "LlmCostLedger_userId_dayKey_idx";
