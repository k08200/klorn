/**
 * Report an LLM failure to the console and Sentry without its words.
 *
 * A provider error can quote the request, and on a production call the request
 * is someone's mail or chat: Gemini puts the raw response body in the message,
 * an exhausted chain carries the provider error as `cause` (Sentry and Node's
 * console both print it), and JSON.parse's SyntaxError quotes the start of the
 * model's reply. So a catch on an LLM path reports through here: a fixed
 * label, the failure's facts (llmFailureFacts: class, status, provider
 * type/code, message length) and the caller's operational context. Never the
 * error object itself.
 *
 * The label is operator text written in code. Never interpolate content into
 * it; put ids and names in `extra` (llm-failure-redaction-guard.test.ts holds
 * every call to a string literal).
 */
import type { ProviderCredentials } from "../providers/index.js";
import {
  captureFailureFacts,
  type FailureLogOptions,
  type FailureSentryContext,
  logFailureFacts,
} from "../report-failure.js";
import { formatLlmFailureFacts, llmFailureFacts } from "./describe-failure.js";

export type LlmFailureSentryContext = FailureSentryContext;
export type LlmFailureLogOptions = FailureLogOptions;

/**
 * One console line:
 * `<label> (userId=u1): RateLimitError 429, type=rate_limit_error, message 87 chars`.
 */
export function logLlmFailure(
  label: string,
  err: unknown,
  options: LlmFailureLogOptions = {},
): void {
  logFailureFacts(label, formatLlmFailureFacts(llmFailureFacts(err)), options);
}

/**
 * Send Sentry a fresh Error (label plus class name, no cause) carrying the
 * original's stack frames, with the facts in `extra` (report-failure.ts).
 * Every failure that reaches a catch on an LLM path is reported this way,
 * LLM-shaped or not: a database or send error raised over model-written
 * arguments can quote them too. A data-wipe fence rejection is skipped, as
 * captureError skips it for the raw error.
 */
export function captureLlmFailure(
  label: string,
  err: unknown,
  context: LlmFailureSentryContext,
): void {
  captureFailureFacts(label, err, llmFailureFacts(err), context);
}

/**
 * Whether the call offered the user's own key ("byok") or ran on Klorn's
 * ("platform"). A BYOK failure is the user's key or quota; a platform one is ours.
 */
export function offeredKeyKind(credentials?: ProviderCredentials | null): "byok" | "platform" {
  return credentials?.anthropicApiKey || credentials?.geminiApiKey || credentials?.openAiApiKey
    ? "byok"
    : "platform";
}
