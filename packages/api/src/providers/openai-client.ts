/**
 * The one place an OpenAI SDK client is built: OpenAI itself (playground
 * BYOK), a self-host OpenAI-compatible endpoint, and the embeddings endpoint.
 *
 * The log level is pinned rather than left to the SDK's env pickup: given no
 * `logLevel`, the SDK reads OPENAI_LOG, and at "debug" it logs every request's
 * options through console, body included — the mail and chat text Klorn
 * sends. Same rule as createAnthropicClient. openai-client-log-level.test.ts
 * holds every construction to this file.
 */
import OpenAI from "openai";

export interface OpenAIClientOptions {
  readonly apiKey: string;
  /** Always explicit: unset, the SDK would read OPENAI_BASE_URL. */
  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries?: number;
}

export function createOpenAIClient(options: OpenAIClientOptions): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    timeout: options.timeout,
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    logLevel: "warn",
  });
}
