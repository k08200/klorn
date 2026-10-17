/**
 * Request timeouts for every LLM HTTP client (OpenAI-SDK providers, Gemini
 * native, embeddings).
 *
 * The OpenAI SDK's default is 10 minutes per request: a hung provider held a
 * judge call, a summary or a chat turn for up to half an hour with its 2
 * retries. The timeout covers the time until the response starts (the SDK
 * clears its timer when fetch resolves). No SDK call streams, so a completion
 * arrives whole and this bounds it in practice; the SDK still retries a timeout
 * (timeout × 3 per provider, plus backoff), and a timeout counts as a connection
 * error, so the chain fails over (llm/model-fallback.ts isConnectionError).
 *
 * LLM_REQUEST_TIMEOUT_MS (milliseconds) overrides the defaults; it is clamped to
 * [1 s, the largest setTimeout delay], and an unusable value is reported once.
 */

export const CLOUD_LLM_TIMEOUT_MS = 60_000;
export const LOCAL_LLM_TIMEOUT_MS = 300_000;
// Embeddings sit on the judge's hot path and fall back to lexical ranking.
export const EMBEDDING_TIMEOUT_MS = 30_000;

const MIN_TIMEOUT_MS = 1_000;
// Node clamps a larger setTimeout delay to 1 ms, which would abort every request.
const MAX_TIMEOUT_MS = 2_147_483_647;

let warnedUnusable = false;

export function llmRequestTimeoutMs(fallback: number): number {
  const raw = process.env.LLM_REQUEST_TIMEOUT_MS?.trim() ?? "";
  if (raw === "") return fallback;
  const configured = Number(raw);
  if (!Number.isFinite(configured) || configured <= 0) {
    if (!warnedUnusable) {
      warnedUnusable = true;
      console.warn(
        `[LLM] LLM_REQUEST_TIMEOUT_MS=${JSON.stringify(raw)} is not a positive number of milliseconds; using the defaults.`,
      );
    }
    return fallback;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(configured)));
}
