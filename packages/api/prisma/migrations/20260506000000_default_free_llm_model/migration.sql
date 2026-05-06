-- Default EVE to a zero-cost OpenRouter model for beta.
ALTER TABLE "User"
  ALTER COLUMN "chatModel" SET DEFAULT 'google/gemma-4-31b-it:free';

-- Existing rows created with old paid defaults should move to the free default.
-- Preserve explicit premium selections except for known previous defaults.
UPDATE "User"
SET "chatModel" = 'google/gemma-4-31b-it:free'
WHERE "chatModel" IN (
  'openai/gpt-5.4-nano',
  'qwen/qwen3.5-flash-02-23'
);

UPDATE "User"
SET "agentModel" = 'google/gemma-4-31b-it:free'
WHERE "agentModel" IN (
  'openai/gpt-5.4-nano',
  'openai/gpt-5.4-mini',
  'qwen/qwen3.5-flash-02-23'
);
