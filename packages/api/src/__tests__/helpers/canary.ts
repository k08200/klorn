/**
 * Canary checks for the LLM failure redaction tests.
 *
 * A provider error can quote the request (someone's mail or chat), and a
 * JSON.parse SyntaxError quotes the start of the model's reply. The tests put
 * a canary in those places and assert it never reaches a Sentry or console
 * mock. Checking `JSON.stringify` of the mock calls is not enough: an Error
 * serializes to `{}`, yet Sentry sends its message and follows its `cause`, and
 * Node's console prints both. So walk everything a sink could print.
 */

/**
 * Ten characters: V8's JSON.parse SyntaxError quotes exactly the first ten
 * characters of its input, so a model reply that starts with this canary puts
 * all of it in the error message.
 */
export const LLM_CANARY = "CNRY-7f3a9";

/** Every string reachable from `value`: Error message, stack and cause, own properties, arrays. */
export function reachableText(value: unknown, seen: Set<unknown> = new Set()): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object" && typeof value !== "function") return String(value);
  if (seen.has(value)) return "";
  seen.add(value);
  const parts: string[] = [];
  if (value instanceof Error) {
    parts.push(value.name, value.message, value.stack ?? "");
    parts.push(reachableText((value as { cause?: unknown }).cause, seen));
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "stack" || key === "message") continue;
    let child: unknown;
    try {
      child = (value as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (typeof child === "function") continue;
    parts.push(key, reachableText(child, seen));
  }
  return parts.join("\n");
}

/** The text every call of a vi.fn() mock carried, arguments walked as above. */
export function callText(mock: { mock: { calls: unknown[][] } }): string {
  return mock.mock.calls.map((args) => reachableText(args)).join("\n");
}

/** A provider error as an SDK raises it, quoting the request (the mail) in its message. */
export function providerErrorQuotingMail(): Error {
  return Object.assign(new Error(`429 quota exceeded while reading: ${LLM_CANARY}`), {
    status: 429,
    type: "rate_limit_error",
  });
}

/** An exhausted chain over that error: a safe message, the quoting error as `cause`. */
export function exhaustedOverQuotingError(): Error {
  return Object.assign(
    new Error("All AI providers are unavailable", { cause: providerErrorQuotingMail() }),
    { name: "AllProvidersExhaustedError" },
  );
}

/** A model reply that is not JSON and starts with the canary (JSON.parse quotes it). */
export const NON_JSON_REPLY = `${LLM_CANARY} — sure, here is what I found`;
