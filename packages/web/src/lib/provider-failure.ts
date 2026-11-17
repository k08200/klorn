/**
 * A failed call to a connected service, in the user's language. The API
 * answers `{ error, code }`: `error` is a fixed English sentence and `code`
 * a ProviderFailureCode (api: public-failure.ts). Clients put the code into
 * words; the sentence is only the fallback for a code this build predates.
 */
import type { ProviderFailureCode } from "@klorn/contract";

const KEYS: Readonly<Record<ProviderFailureCode, string>> = {
  PROVIDER_AUTH_FAILED: "providerFailure.reconnect",
  PROVIDER_SCOPE_MISSING: "providerFailure.scope",
  PROVIDER_NOT_FOUND: "providerFailure.notFound",
  PROVIDER_RATE_LIMITED: "providerFailure.rateLimited",
  PROVIDER_UNAVAILABLE: "providerFailure.unavailable",
  RATE_LIMITED: "providerFailure.tooManyRequests",
  DAILY_COST_CAP: "providerFailure.dailyCap",
  DAILY_COST_CAP_FREE: "providerFailure.dailyCap",
  INTERNAL_ERROR: "providerFailure.internal",
};

export function isProviderFailureCode(value: unknown): value is ProviderFailureCode {
  return typeof value === "string" && Object.hasOwn(KEYS, value);
}

type Translate = (key: string, vars?: Record<string, string>) => string;

/**
 * The localized sentence for a failure body, or null when it carries no
 * known code (an older server, or a failure this helper does not cover).
 * `service` is a product name ("Gmail", "Google Calendar"), not translated.
 */
export function providerFailureText(
  t: Translate,
  body: { code?: unknown } | null | undefined,
  service: string,
): string | null {
  const code = body?.code;
  return isProviderFailureCode(code) ? t(KEYS[code], { service }) : null;
}
