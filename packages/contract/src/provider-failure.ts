/**
 * Why a call to a connected service (Gmail, Google Calendar, Outlook, an AI
 * provider) failed, as one stable machine code. A failure response carries
 * this code next to a fixed English `error` sentence; a client puts the code
 * into words in the user's language and never needs to read the sentence.
 *
 * The provider's own error text never reaches a client: it can quote the
 * request (someone's mail, an event title, a prompt), so the server reduces
 * every failure to one of these codes (api: public-failure.ts).
 */
export type ProviderFailureCode =
  /** The account's grant is gone (401, revoked or expired token): reconnect it. */
  | "PROVIDER_AUTH_FAILED"
  /** The grant lacks a permission this call needs (403): reconnect and allow it. */
  | "PROVIDER_SCOPE_MISSING"
  /** The item is gone on the provider's side (404, 410). */
  | "PROVIDER_NOT_FOUND"
  /** The provider is throttling (429, or Google's 403 quota reasons). */
  | "PROVIDER_RATE_LIMITED"
  /** The provider is down or unreachable (5xx, timeout, network). */
  | "PROVIDER_UNAVAILABLE"
  /** Klorn's own per-user request throttle. */
  | "RATE_LIMITED"
  /** Klorn's daily AI budget for the user's plan is spent. */
  | "DAILY_COST_CAP"
  | "DAILY_COST_CAP_FREE"
  /** Klorn's own database could not be reached or answered in time: transient. */
  | "SERVICE_UNAVAILABLE"
  /** Anything else: a database fault, a code fault, an unreadable model answer. */
  | "INTERNAL_ERROR";

/** The body of a failure classified by ProviderFailureCode. */
export interface ProviderFailureResponse {
  /** A fixed English sentence chosen by `code`; never the provider's text. */
  error: string;
  code: ProviderFailureCode;
}
