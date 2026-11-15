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
import { isDataWipeFenceError } from "../privacy/data-wipe-fence.js";
import type { ProviderCredentials } from "../providers/index.js";
import { captureError } from "../sentry.js";
import { formatLlmFailureFacts, llmFailureFacts } from "./describe-failure.js";

export interface LlmFailureSentryContext {
  /** Sentry tags, e.g. the existing `scope`. Keep a site's scope unchanged so its alerts keep matching. */
  readonly tags: Readonly<Record<string, string>>;
  /** Ids and operational context (provider, key kind, model, route). Never content. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface LlmFailureLogOptions {
  readonly level?: "warn" | "error";
  /** Ids and counters for the line, e.g. { userId, emailId }. Never content. */
  readonly ids?: Readonly<Record<string, string | number | null | undefined>>;
}

/**
 * One console line:
 * `<label> (userId=u1): RateLimitError 429, type=rate_limit_error, message 87 chars`.
 */
export function logLlmFailure(
  label: string,
  err: unknown,
  options: LlmFailureLogOptions = {},
): void {
  const ids = Object.entries(options.ids ?? {})
    .map(([key, value]) => `${key}=${value ?? "-"}`)
    .join(", ");
  const head = ids === "" ? label : `${label} (${ids})`;
  const line = `${head}: ${formatLlmFailureFacts(llmFailureFacts(err))}`;
  if (options.level === "error") console.error(line);
  else console.warn(line);
}

/** A stack line that names a frame (function and file position), never message text. */
const STACK_FRAME = /^\s+at /;

/**
 * The original's stack frames without its `Name: message` header, so Sentry
 * still shows where the failure was thrown. V8 writes that header from the
 * error's name and message when the stack is first read; when it cannot be
 * matched exactly (the message changed after the stack was read), or anything
 * after it is not a frame line, no frames are kept rather than risk message
 * text, which can span lines.
 */
function originalFrames(err: unknown): string | null {
  if (!(err instanceof Error) || typeof err.stack !== "string") return null;
  const header = err.message ? `${err.name}: ${err.message}` : err.name;
  if (!err.stack.startsWith(`${header}\n`)) return null;
  const frames = err.stack.slice(header.length + 1).split("\n");
  return frames.every((line) => STACK_FRAME.test(line)) ? frames.join("\n") : null;
}

/**
 * Send Sentry a fresh Error (label plus class name, no cause) carrying the
 * original's stack frames, with the facts in `extra`. Every failure that
 * reaches a catch on an LLM path is reported this way, LLM-shaped or not: a
 * database or send error raised over model-written arguments can quote them
 * too. A data-wipe fence rejection is skipped, as captureError skips it for
 * the raw error.
 */
export function captureLlmFailure(
  label: string,
  err: unknown,
  context: LlmFailureSentryContext,
): void {
  if (isDataWipeFenceError(err)) return;
  const facts = llmFailureFacts(err);
  const reported = new Error(`${label} (${facts.errorName})`);
  const frames = originalFrames(err);
  if (frames !== null) reported.stack = `Error: ${reported.message}\n${frames}`;
  captureError(reported, {
    tags: { ...context.tags },
    extra: { ...context.extra, ...facts },
  });
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
