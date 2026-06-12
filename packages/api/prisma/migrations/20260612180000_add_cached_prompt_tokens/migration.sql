-- Cache-hit visibility for the LLM usage ledger. Prompt tokens served from
-- the provider's prompt cache (OpenAI prompt_tokens_details.cached_tokens,
-- Gemini usageMetadata.cachedContentTokenCount). 0 when the serving
-- provider doesn't cache or doesn't report it — honest zeros, not guesses.

ALTER TABLE "LlmUsageLog" ADD COLUMN "cachedPromptTokens" INTEGER NOT NULL DEFAULT 0;
