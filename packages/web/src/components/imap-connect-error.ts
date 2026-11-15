/**
 * Connect failures the server answers with a stable code and a static English
 * sentence (api: mail/imap-verify-failure.ts). The web shows its own localized
 * generic sentence for these instead of the thrown "API 400: {json}" text.
 */
const GENERIC_VERIFY_CODES = ["IMAP_VERIFY_FAILED", "IMAP_UNREACHABLE"] as const;

export function isGenericImapVerifyFailure(message: string): boolean {
  if (!message.startsWith("API 400")) return false;
  return GENERIC_VERIFY_CODES.some((code) => message.includes(`"code":"${code}"`));
}

/**
 * What a failed app-password connect tells the user (the preset cards). The Pro
 * gate is recognised before this (isEntitlementRefusal).
 *   auth            — the provider refused the login: the card's hint says why
 *   verify          — unreachable or unverifiable: the generic sentence
 *   tooManyAttempts — the connect rate limit
 *   server          — a refusal the server explains in its own sentence
 *   unexpected      — anything else: the generic sentence, never raw response text
 */
export type ImapConnectFailure =
  | { kind: "auth" }
  | { kind: "verify" }
  | { kind: "tooManyAttempts" }
  | { kind: "server"; message: string }
  | { kind: "unexpected" };

const API_ERROR_RE = /^API (\d{3}): /;
const HTTP_TOO_MANY_REQUESTS = 429;
/** The statuses whose body is the connect route's own `{ ok: false, message }`. */
const EXPLAINED_STATUSES: ReadonlySet<number> = new Set([400, 409]);

function parseBody(text: string): Record<string, unknown> | null {
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function classifyImapConnectFailure(message: string): ImapConnectFailure {
  const match = API_ERROR_RE.exec(message);
  if (!match) return { kind: "unexpected" };
  const status = Number(match[1]);
  if (status === HTTP_TOO_MANY_REQUESTS) return { kind: "tooManyAttempts" };
  if (!EXPLAINED_STATUSES.has(status)) return { kind: "unexpected" };
  const body = parseBody(message.slice(match[0].length));
  if (body?.code === "IMAP_AUTH_FAILED") return { kind: "auth" };
  if (isGenericImapVerifyFailure(message)) return { kind: "verify" };
  const text = body?.message;
  return typeof text === "string" && text.trim()
    ? { kind: "server", message: text }
    : { kind: "unexpected" };
}
