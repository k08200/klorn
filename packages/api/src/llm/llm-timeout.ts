/**
 * Request timeouts for every OpenAI-SDK client (providers, embeddings).
 *
 * The SDK's default is 10 minutes per request (x its 2 retries): a hung
 * provider held a judge call, a summary or a chat turn for up to half an hour.
 * No call streams through the SDK, so the timeout bounds the whole response.
 * A self-hosted model on CPU is slower than a cloud API; LLM_REQUEST_TIMEOUT_MS
 * (a positive integer, milliseconds) overrides both.
 */

export const CLOUD_LLM_TIMEOUT_MS = 60_000;
export const LOCAL_LLM_TIMEOUT_MS = 300_000;

export function llmRequestTimeoutMs(fallback: number): number {
  const configured = Number(process.env.LLM_REQUEST_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : fallback;
}
