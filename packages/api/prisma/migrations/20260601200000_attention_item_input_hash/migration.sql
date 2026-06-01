-- Content-addressed classification — attaches a sha256 hash of the decision-
-- relevant input bytes to every AttentionItem at classify time. Read paths
-- can re-hash the current input and detect post-decision mutation. Additive
-- columns only; existing rows stay non-hashed (legacy) and read paths treat
-- a null hash as "skip the integrity check, this row predates the doctrine."

ALTER TABLE "AttentionItem"
  ADD COLUMN IF NOT EXISTS "inputHash" TEXT,
  ADD COLUMN IF NOT EXISTS "inputHashAt" TIMESTAMP(3);
