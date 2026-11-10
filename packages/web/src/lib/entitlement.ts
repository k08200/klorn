/**
 * Recognising the API's "this is a Pro feature" refusal.
 *
 * With the paywall on, a paid route answers a non-entitled (FREE) user with
 *
 *   403 {"error": "...", "code": "ENTITLEMENT_REQUIRED"}
 *
 * (api billing/entitlement-guard.ts, billing/mail-account-entitlement.ts). It
 * is an expected answer, not a fault: the screen shows the upgrade notice
 * (components/pro-feature-notice.tsx) and does not report it to Sentry.
 * While the paywall is off the API never sends it, so nothing here fires.
 */

const ENTITLEMENT_REQUIRED = "ENTITLEMENT_REQUIRED";

/** What an older API sends for a BYOK save, before the refusal carried a code. */
const LEGACY_BYOK_REFUSAL = "BYOK requires an active subscription";

const API_ERROR_RE = /^API (\d{3}): /;

/** Status and JSON body of the Error apiFetch throws (`API <status>: <body>`). */
function parseApiError(err: unknown): { status: number; body: unknown } | null {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : null;
  if (message === null) return null;
  const match = API_ERROR_RE.exec(message);
  if (!match) return null;
  try {
    return { status: Number(match[1]), body: JSON.parse(message.slice(match[0].length)) };
  } catch {
    return { status: Number(match[1]), body: null };
  }
}

function bodyField(body: unknown, field: "code" | "error"): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  return (body as Record<string, unknown>)[field];
}

/** For callers that read the response themselves (raw fetch). */
export function isEntitlementResponse(status: number, body: unknown): boolean {
  return status === 403 && bodyField(body, "code") === ENTITLEMENT_REQUIRED;
}

/** The apiFetch Error, or its message, for a 403 ENTITLEMENT_REQUIRED. */
export function isEntitlementRefusal(err: unknown): boolean {
  const parsed = parseApiError(err);
  return parsed !== null && isEntitlementResponse(parsed.status, parsed.body);
}

/** BYOK save refusal: the coded one, or the uncoded one an older API sends. */
export function isByokEntitlementRefusal(err: unknown): boolean {
  if (isEntitlementRefusal(err)) return true;
  const parsed = parseApiError(err);
  return parsed?.status === 403 && bodyField(parsed.body, "error") === LEGACY_BYOK_REFUSAL;
}

/**
 * Whether to keep a FREE user from typing a BYOK key the server will refuse to
 * store. Only an explicit `entitled: false` locks it: the field is true while
 * the paywall is off and absent on an older API, and both keep today's form.
 */
export function byokLocked(user: { entitled?: boolean } | null | undefined): boolean {
  return user?.entitled === false;
}
