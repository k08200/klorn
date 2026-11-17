/**
 * What a client response, a tool result handed to the model, or a stored
 * column may say about a failure: a stable code, a fixed sentence chosen by
 * that code, and class/status facts. Never the error's own text.
 *
 * report-failure.ts made the log and Sentry facts-only; this is the same rule
 * for the values a catch returns. A PrismaClientValidationError renders the
 * rejected call's arguments (someone's mail, an event title) into its message;
 * a JSON.parse SyntaxError quotes the model's answer; a provider's error can
 * quote the request it was sent. Text that goes into a column outlives the
 * request and shows up in UIs and exports, and text fed back to the model is
 * a prompt-injection and leak channel. So a failure is classified here, from
 * its HTTP status, its class and the provider's machine-readable reason
 * tokens, and only the classification travels.
 */
import type { ProviderFailureCode } from "@klorn/contract";
import { costCapRefusal } from "./llm/cost-cap-refusal.js";
import { dbFailureFacts } from "./report-db-failure.js";

export type { ProviderFailureCode };

/** Every code once; the Record makes the compiler reject a code missing from this list. */
const CODE_PRESENCE = {
  PROVIDER_AUTH_FAILED: true,
  PROVIDER_SCOPE_MISSING: true,
  PROVIDER_NOT_FOUND: true,
  PROVIDER_RATE_LIMITED: true,
  PROVIDER_UNAVAILABLE: true,
  RATE_LIMITED: true,
  DAILY_COST_CAP: true,
  DAILY_COST_CAP_FREE: true,
  SERVICE_UNAVAILABLE: true,
  INTERNAL_ERROR: true,
} as const satisfies Record<ProviderFailureCode, true>;

export const PROVIDER_FAILURE_CODES = Object.keys(CODE_PRESENCE) as readonly ProviderFailureCode[];

const CODE_SET: ReadonlySet<string> = new Set(PROVIDER_FAILURE_CODES);

export function isProviderFailureCode(value: unknown): value is ProviderFailureCode {
  return typeof value === "string" && CODE_SET.has(value);
}

/** Which service a sentence names. */
export type FailureService = "gmail" | "googleCalendar" | "mail" | "ai";

const SERVICE_LABEL: Readonly<Record<FailureService, string>> = {
  gmail: "Gmail",
  googleCalendar: "Google Calendar",
  mail: "Your mail provider",
  ai: "The AI provider",
};

/** The account a reconnect sentence names ("not connected" is what web clients match). */
const ACCOUNT_LABEL: Readonly<Record<FailureService, string>> = {
  gmail: "Gmail",
  googleCalendar: "Google Calendar",
  mail: "Your mail account",
  // Unused: aiFailureMessage answers every auth failure for the AI provider.
  ai: "The AI provider",
};

/**
 * Klorn's own "not connected" throws (mail/email-sync.ts and friends): a
 * missing or rejected grant, raised before any provider call. Matched exactly,
 * as automation-scheduler.ts already does.
 */
const NOT_CONNECTED_MESSAGES: ReadonlySet<string> = new Set([
  "Gmail not connected",
  "Gmail not connected.",
]);

/** OAuth token-endpoint errors (`response.data.error`) that mean the grant is gone. */
const DEAD_GRANT_ERRORS: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_token",
  "unauthorized_client",
  "UNAUTHENTICATED",
]);

/** Google's reasons and statuses for a quota refusal, which Gmail answers with 403. */
const QUOTA_REASONS: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "dailyLimitExceeded",
  "quotaExceeded",
  "RATE_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
]);

/** Socket and DNS failures (Node, undici): the service could not be reached. */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  // imapflow's connection codes (mail/imap-verify-failure.ts names the same set).
  "ETIMEOUT",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "NoConnection",
  "EConnectionClosed",
]);

/** Error classes that mean "no answer came back", whatever the status. */
const UNAVAILABLE_NAMES: ReadonlySet<string> = new Set([
  "AbortError",
  "TimeoutError",
  "AllProvidersExhaustedError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
]);

/** Exhausted chain → 402 wrapper → SDK error, plus room for a caller's wrapper. */
const CAUSE_DEPTH = 4;
/** A reason token is a bounded identifier, never a phrase. */
const REASON_TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const STATUS_UNAUTHORIZED = 401;
const STATUS_PAYMENT_REQUIRED = 402;
const STATUS_FORBIDDEN = 403;
const STATUS_NOT_FOUND = 404;
const STATUS_GONE = 410;
const STATUS_TOO_MANY = 429;
const STATUS_SERVER_ERROR = 500;

function causeChain(err: unknown): unknown[] {
  const chain = [err];
  for (let depth = 0; depth < CAUSE_DEPTH; depth++) {
    const cause = (chain[chain.length - 1] as { cause?: unknown } | null | undefined)?.cause;
    if (cause === undefined || cause === null) break;
    chain.push(cause);
  }
  return chain;
}

/** The first HTTP status on the error or down its cause chain. */
function failureStatus(err: unknown): number | null {
  for (const candidate of causeChain(err)) {
    const status = dbFailureFacts(candidate).status;
    if (status !== null) return status;
  }
  return null;
}

function token(value: unknown): string | null {
  return typeof value === "string" && REASON_TOKEN.test(value) ? value : null;
}

/**
 * Google's machine-readable reason tokens: `data.error` as a string (the token
 * endpoint's "invalid_grant"), `data.error.status` and `data.error.errors[].reason`
 * (the REST APIs). Free-text fields beside them are never read.
 */
function googleReasons(err: unknown): string[] {
  const data = (err as { response?: { data?: unknown } } | null | undefined)?.response?.data;
  const body = (data as { error?: unknown } | null | undefined)?.error;
  if (typeof body === "string") return [token(body)].filter((t): t is string => t !== null);
  const fields = body as { status?: unknown; errors?: unknown } | null | undefined;
  const reasons = Array.isArray(fields?.errors)
    ? fields.errors.map((entry) => token((entry as { reason?: unknown } | null)?.reason))
    : [];
  return [token(fields?.status), ...reasons].filter((t): t is string => t !== null);
}

function systemCode(err: unknown): string | null {
  return token((err as { code?: unknown } | null | undefined)?.code);
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "";
}

function isNotConnected(err: unknown): boolean {
  return err instanceof Error && NOT_CONNECTED_MESSAGES.has(err.message);
}

function klornLimit(err: unknown): ProviderFailureCode | null {
  const capped = costCapRefusal(err);
  if (capped) return capped.code;
  return errorName(err) === "UserRateLimitedError" ? "RATE_LIMITED" : null;
}

function fromStatus(status: number | null, reasons: readonly string[]): ProviderFailureCode | null {
  if (status === null) return null;
  // 402: an AI provider refusing a key with no credit left; the account owner must act.
  if (status === STATUS_UNAUTHORIZED || status === STATUS_PAYMENT_REQUIRED) {
    return "PROVIDER_AUTH_FAILED";
  }
  if (status === STATUS_FORBIDDEN) {
    return reasons.some((r) => QUOTA_REASONS.has(r))
      ? "PROVIDER_RATE_LIMITED"
      : "PROVIDER_SCOPE_MISSING";
  }
  if (status === STATUS_NOT_FOUND || status === STATUS_GONE) return "PROVIDER_NOT_FOUND";
  if (status === STATUS_TOO_MANY) return "PROVIDER_RATE_LIMITED";
  if (status >= STATUS_SERVER_ERROR) return "PROVIDER_UNAVAILABLE";
  return null;
}

/** Every undici transport failure (UND_ERR_BODY_TIMEOUT, UND_ERR_CLOSED, …). */
const UNDICI_CODE = /^UND_ERR_/;

function isUnreachable(err: unknown): boolean {
  return causeChain(err).some((candidate) => {
    const code = systemCode(candidate);
    return (
      (code !== null && (UNREACHABLE_CODES.has(code) || UNDICI_CODE.test(code))) ||
      UNAVAILABLE_NAMES.has(errorName(candidate))
    );
  });
}

/**
 * Prisma codes for a database that could not be reached or answered in time:
 * P1001 unreachable, P1002 timed out, P1008 operation timeout, P1017 server
 * closed the connection, P2024 connection-pool timeout. Transient, and not
 * the user's provider: SERVICE_UNAVAILABLE.
 */
const DB_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
]);

function isDatabaseUnavailable(err: unknown): boolean {
  return causeChain(err).some((candidate) => {
    const code = dbFailureFacts(candidate).code;
    return code !== null && DB_UNAVAILABLE_CODES.has(code);
  });
}

/** One code for any failure: read from its status, class and reason tokens, never its text. */
export function classifyFailure(err: unknown): ProviderFailureCode {
  const limit = klornLimit(err);
  if (limit !== null) return limit;
  if (isNotConnected(err)) return "PROVIDER_AUTH_FAILED";
  const reasons = causeChain(err).flatMap(googleReasons);
  if (reasons.some((r) => DEAD_GRANT_ERRORS.has(r))) return "PROVIDER_AUTH_FAILED";
  if (reasons.some((r) => QUOTA_REASONS.has(r))) return "PROVIDER_RATE_LIMITED";
  if (isDatabaseUnavailable(err)) return "SERVICE_UNAVAILABLE";
  const byStatus = fromStatus(failureStatus(err), reasons);
  if (byStatus !== null) return byStatus;
  return isUnreachable(err) ? "PROVIDER_UNAVAILABLE" : "INTERNAL_ERROR";
}

/**
 * The AI provider's sentences. A refused key may be Klorn's own (no setting
 * for the user to fix), so the refusal names the user's own key only as a
 * condition; a 404 is a retired model, not a missing item.
 */
function aiFailureMessage(code: ProviderFailureCode): string | null {
  switch (code) {
    case "PROVIDER_AUTH_FAILED":
    case "PROVIDER_SCOPE_MISSING":
      return "The AI provider refused the request. If you use your own API key, check its key and credit in Settings.";
    case "PROVIDER_NOT_FOUND":
      return "The AI model is unavailable right now. Try again shortly.";
    default:
      return null;
  }
}

/** The fixed English sentence for a code. Clients localize by the code instead. */
export function providerFailureMessage(code: ProviderFailureCode, service: FailureService): string {
  const ai = service === "ai" ? aiFailureMessage(code) : null;
  if (ai !== null) return ai;
  const label = SERVICE_LABEL[service];
  switch (code) {
    case "PROVIDER_AUTH_FAILED":
      return `${ACCOUNT_LABEL[service]} is not connected. Reconnect it in Settings.`;
    case "PROVIDER_SCOPE_MISSING":
      return `${label} did not grant a permission Klorn needs. Reconnect it in Settings and allow every requested permission.`;
    case "PROVIDER_NOT_FOUND":
      return `${label} could not find that item. It may have been moved or deleted.`;
    case "PROVIDER_RATE_LIMITED":
      return `${label} is limiting requests right now. Try again in a minute.`;
    case "PROVIDER_UNAVAILABLE":
      return `${label} is unavailable right now. Try again shortly.`;
    case "RATE_LIMITED":
      return "Too many requests right now. Try again in a minute.";
    case "DAILY_COST_CAP":
    case "DAILY_COST_CAP_FREE":
      return "Today's AI limit is used up. It resets tomorrow.";
    case "SERVICE_UNAVAILABLE":
      return "Klorn is briefly unavailable. Try again shortly.";
    case "INTERNAL_ERROR":
      return "Something went wrong on our side. Try again shortly.";
  }
}

/** A failure as a response body: `{ error, code }`. */
export interface PublicFailure {
  readonly error: string;
  readonly code: ProviderFailureCode;
}

/**
 * The body a route answers for a failure. The cost cap keeps its own
 * Klorn-written sentence (it names the reset time); every other code gets
 * its fixed sentence.
 */
export function publicFailure(err: unknown, service: FailureService): PublicFailure {
  const capped = costCapRefusal(err);
  if (capped) return { error: capped.error, code: capped.code };
  const code = classifyFailure(err);
  return { error: providerFailureMessage(code, service), code };
}

/** Class plus status or code, e.g. "GaxiosError 503", "PrismaClientKnownRequestError P2002". */
export function failureFacts(err: unknown): string {
  const facts = dbFailureFacts(err);
  const status = facts.status ?? failureStatus(err);
  return [facts.errorName, facts.code, status].filter((part) => part !== null).join(" ");
}

/** A stored failure: `<label> (<CODE>; <facts>)`. Readable in a UI, greppable, text-free. */
export function storedFailure(label: string, err: unknown): string {
  return `${label} (${classifyFailure(err)}; ${failureFacts(err)})`;
}
