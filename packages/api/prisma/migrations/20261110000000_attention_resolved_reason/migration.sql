-- AttentionItem.resolvedReason: which system rule resolved the row. The
-- attention aging sweep (ATTENTION_AGING_ENABLED) stamps 'aging:acted',
-- 'aging:silent' or 'aging:queue', so every resolution it makes can be found
-- and undone. NULL = resolved by any other path, or not resolved.
--
-- EXPAND ONLY, metadata-only: a nullable column with no default adds without a
-- table rewrite. The previous instance keeps resolving rows without it during
-- the swap; the sweep is OFF by default, so no aging resolution is unstamped.
SET LOCAL lock_timeout = '5s';
ALTER TABLE "AttentionItem" ADD COLUMN "resolvedReason" TEXT;
