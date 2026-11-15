/**
 * Name an LLM failure in a way an operator can act on.
 *
 * `err.name` is not enough on its own. The OpenAI SDK's error classes extend
 * Error without ever assigning `name`, so a 401 dead key, a 400 malformed
 * request and a 503 upstream outage all arrive carrying the inherited string
 * "Error" (verified against openai@6.29.0). The reply-draft route surfaced that
 * word verbatim, which is how "Reply drafting is temporarily unavailable
 * (Error)" survived a full day of retries with no way to tell a dead key from a
 * code fault (2026-08-10).
 *
 * The constructor name plus the HTTP status is the smallest thing that is both
 * actionable and safe to echo to a client: no request bodies, no prompts, and
 * no key material — provider messages are deliberately dropped because they can
 * quote the credential that was rejected.
 */
export function describeLlmFailure(err: unknown): string {
  if (!(err instanceof Error)) return "UnknownError";
  const label = llmFailureName(err);
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? `${label} ${status}` : label;
}

/** The failure's class name, never its message (see describeLlmFailure). */
export function llmFailureName(err: unknown): string {
  if (!(err instanceof Error)) return "UnknownError";
  // A self-assigned name (AllProvidersExhaustedError, GeminiHttp404Error) is
  // already precise; only fall back to the constructor when `name` is the
  // inherited default that tells us nothing.
  return err.name && err.name !== "Error" ? err.name : err.constructor?.name || "Error";
}

/** The provider's HTTP status, on the error or, for an exhausted chain, its cause. */
export function llmFailureStatus(err: unknown): number | null {
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    const status = (candidate as { status?: unknown } | null)?.status;
    if (typeof status === "number") return status;
  }
  return null;
}

/**
 * A provider's machine-readable type or code: one bounded token, never a phrase.
 * Anything with whitespace or past 64 characters is treated as free text and
 * dropped, so a provider that put a sentence in `code` cannot carry it out.
 */
const PROVIDER_CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function enumLike(value: unknown): string | null {
  return typeof value === "string" && PROVIDER_CODE_SHAPE.test(value) ? value : null;
}

interface ProviderErrorFields {
  readonly type?: unknown;
  readonly code?: unknown;
  readonly errorCode?: unknown;
}

/**
 * The provider's error type and code, read from the SDK fields that hold them
 * (Anthropic: `type`, `errorCode`; OpenAI: `type`, `code`) on the error or,
 * for a wrapper such as the Anthropic credit-limit 402, on its cause.
 */
function providerErrorCodes(err: unknown): { type: string | null; code: string | null } {
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    const fields = candidate as ProviderErrorFields | null | undefined;
    const type = enumLike(fields?.type);
    const code = enumLike(fields?.errorCode) ?? enumLike(fields?.code);
    if (type !== null || code !== null) return { type, code };
  }
  return { type: null, code: null };
}

/** What a failure report may say about an LLM error. */
export interface LlmFailureFacts {
  readonly errorName: string;
  readonly status: number | null;
  readonly providerErrorType: string | null;
  readonly providerErrorCode: string | null;
  readonly messageLength: number;
}

/**
 * The facts of an LLM failure that are safe for Sentry and the log: class
 * name, HTTP status, the provider's type and code, and the message's length.
 * Never the message: a provider error can quote the request, and on a BYOK
 * call from the mail judge, Slack or the KakaoTalk import that request is
 * someone else's mail or chat text.
 */
export function llmFailureFacts(err: unknown): LlmFailureFacts {
  const { type, code } = providerErrorCodes(err);
  return {
    errorName: llmFailureName(err),
    status: llmFailureStatus(err),
    providerErrorType: type,
    providerErrorCode: code,
    messageLength: err instanceof Error ? err.message.length : 0,
  };
}

/** One log fragment, e.g. "RateLimitError 429, type=rate_limit_error, message 87 chars". */
export function formatLlmFailureFacts(facts: LlmFailureFacts): string {
  const head = facts.status === null ? facts.errorName : `${facts.errorName} ${facts.status}`;
  return [
    head,
    facts.providerErrorType === null ? null : `type=${facts.providerErrorType}`,
    facts.providerErrorCode === null ? null : `code=${facts.providerErrorCode}`,
    `message ${facts.messageLength} chars`,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}
