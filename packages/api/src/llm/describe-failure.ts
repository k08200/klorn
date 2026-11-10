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

  // A self-assigned name (AllProvidersExhaustedError, GeminiHttp404Error) is
  // already precise; only fall back to the constructor when `name` is the
  // inherited default that tells us nothing.
  const label = err.name && err.name !== "Error" ? err.name : err.constructor?.name || "Error";

  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? `${label} ${status}` : label;
}
