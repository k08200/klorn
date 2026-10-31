/**
 * One redactor for provider credentials, shared by every text surface.
 *
 * BYOK is a locked product decision: the key a user or a playground visitor
 * supplies is theirs, and the product's promise is that it is used and
 * forgotten. That promise is only as good as the weakest place a key can be
 * echoed — so an operator log line, a visitor-facing playground error and a
 * Sentry breadcrumb all have to apply the SAME patterns. Three near-copies is
 * how a shape gets covered in one place and missed in two:
 *
 *   - `llm/model-fallback.ts` knew `sk-…` and `bearer …` but no Google shape,
 *     and its [A-Za-z0-9_-] class could not match OpenAI's masked echo form
 *     ("sk-proj-****…abcd") because `*` ends the class four characters in.
 *   - `routes/playground.ts` knew `AIza…` but only inside that one route.
 *   - nothing covered a key riding in a URL query parameter, which is exactly
 *     how the Gemini native API used to be called.
 *
 * Pure module — no I/O, no imports. Every pattern is a single character class
 * behind a literal anchor, so matching stays linear in the input length; the
 * untrusted-text paths in this codebase have been DoS'd by a regex before
 * (#1466), and this one runs on every breadcrumb.
 */

/**
 * Credential-shaped substrings.
 *
 * These carry NO left anchor on purpose. An earlier version anchored each
 * prefix on `\b`, which looks right and is wrong: a word boundary needs a
 * non-word character to the left, and the character actually preceding a key in
 * the wild is often a word character — the `D` of `%3D`, the `0` of `%20`, the
 * `n` of an escaped `\n` inside a JSON string. Probing real-shaped keys found
 * ten such bypasses, all of them nested or encoded URLs of the kind a Referer
 * header or a redirect parameter carries. The prefixes below are distinctive
 * enough to stand on their own.
 *
 * The replacement keeps the prefix so an operator can still tell WHICH
 * provider rejected the call.
 *
 * Deliberately NOT case-insensitive. Every shape here is case-exact as issued
 * (`sk-`, `AIza`, `AQ.`), and an /i flag would start redacting ordinary prose —
 * any "SK-" ticket prefix, any word ending in "...sk-". An uppercased key is
 * not a form these providers hand out, so the trade is not worth making.
 */
const CREDENTIAL_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // OpenAI and OpenRouter, by their distinctive sub-prefixes. `*` and `.` are
  // in the tail class so the masked forms providers echo back
  // ("sk-proj-****abcd", "sk-...A1b2") match too. Four characters minimum, so
  // "sk-***" is not re-matched and the redactor stays idempotent.
  // Anthropic's `sk-ant-api03-…` / `sk-ant-admin01-…` (playground BYOK) ride
  // here too: the bare-`sk-` rule below refuses a letter to the left, so
  // without the explicit prefix "key%3Dsk-ant-…" would leak through.
  [/sk-(?:proj|or-v1|svcacct|admin|ant)-[A-Za-z0-9_*.-]{4,}/g, "sk-***"],
  // Bare `sk-` is the one shape that needs a guard: without it
  // "risk-assessment" contains "sk-assessment" and gets mangled into "ri" +
  // the marker. A letter to the left is the only thing excluded, so `_sk-…`,
  // `%20sk-…` and `1sk-…` still match.
  [/(?<![A-Za-z])sk-[A-Za-z0-9_*.-]{4,}/g, "sk-***"],
  // Google AI Studio: the classic AIza… form, and the newer AQ.… form that
  // providers/gemini-native.ts exists to support. The AQ tail allows `.`
  // because a dot mid-key otherwise ends the match and leaks the rest.
  [/AIza[A-Za-z0-9_-]{10,}/g, "AIza***"],
  [/AQ\.[A-Za-z0-9_.-]{10,}/g, "AQ.***"],
  // Keep the scheme readable; drop the token. `%20` because an encoded URL is
  // exactly where this shows up.
  [/(bearer)(?:\s|%20)+[A-Za-z0-9._*-]{8,}/gi, "$1 ***"],
];

/**
 * Parameter and header names whose VALUE is a credential.
 *
 * Substring matching, like Sentry's own denylist: the exact-equality version
 * this replaced let `gemini_api_key`, `x-api-key`, `auth_token` and
 * `X-Amz-Signature` through — and the first of those is one of this API's own
 * request-body field names. Over-redaction costs only readability.
 */
const CREDENTIAL_NAME_SUBSTRINGS = [
  "key",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "signature",
  "authorization",
  "verifier",
  "cookie",
] as const;

/**
 * Names that are credentials only as the WHOLE name.
 *
 * `code` and `state` are the OAuth callback's authorization code and signed
 * state JWT, but `country_code` and `statement` are not secrets — matching
 * these by substring would redact ordinary context for nothing.
 */
const CREDENTIAL_NAME_EXACT = ["auth", "sig", "code", "state", "session"] as const;

/**
 * `name=value` pairs in a URL, a bare query string, or an encoded one.
 *
 * The value is a TEMPERED class, not a plain one: `=` has to stay legal in a
 * value (base64 padding), so a plain class let a harmless pair swallow the
 * credential pair behind an encoded separator — `?alt=sse%26key=SECRET` parsed
 * as `alt` = `sse%26key=SECRET` and redacted nothing. Each step still consumes
 * exactly one character, so matching stays linear.
 */
const QUERY_PAIR = /(^|[?&#;]|%26|%3[BF])([\w.[\]-]{1,64})=((?:(?!%26|%3[BF])[^&#;\s"'<>])*)/gi;

/** Whether a parameter or header name carries a credential as its value. */
export function isCredentialName(name: string): boolean {
  const normalized = name.toLowerCase();
  if (CREDENTIAL_NAME_SUBSTRINGS.some((needle) => normalized.includes(needle))) return true;
  const bare = normalized.replace(/[^a-z]/g, "");
  return CREDENTIAL_NAME_EXACT.some((exact) => bare === exact);
}

/** Redact anything shaped like a provider credential, wherever it sits. */
export function redactCredentialShapes(text: string): string {
  let out = text;
  for (const [pattern, replacement] of CREDENTIAL_SHAPES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Redact the values of credential-bearing query parameters.
 *
 * Per-parameter rather than dropping the query string whole: `?alt=sse` and
 * `?model=…` are the context that makes a failed request readable, and an
 * unreadable breadcrumb is a breadcrumb nobody keeps.
 */
export function redactCredentialQueryParams(text: string): string {
  return text.replace(QUERY_PAIR, (match, separator, name, value) =>
    value && isCredentialName(name) ? `${separator}${name}=[REDACTED]` : match,
  );
}

/** Both passes — the one to reach for unless you know you want just one. */
export function redactCredentials(text: string): string {
  return redactCredentialShapes(redactCredentialQueryParams(text));
}
