/**
 * Wire contract for `GET /api/providers/available` — which account types this
 * deployment can connect (productization plan P8, ONBOARDING_V2). The first
 * run draws one tile per entry and words its scope from these facts, so a
 * provider whose connector is off is never offered and nothing is claimed
 * that the server does not do.
 *
 * The route answers exactly like an unregistered route while the server's
 * ONBOARDING_V2 flag is off. Booleans only: no client id, host, secret or
 * flag name crosses the wire.
 */

/** Same values as `InboxProvider`; listed here so the order is part of the contract. */
export type ConnectableProvider = "GOOGLE" | "OUTLOOK" | "NAVER" | "ICLOUD" | "IMAP";

export interface ProviderAvailability {
  provider: ConnectableProvider;
  /** The server reads this provider's calendar (which may be its own connection). */
  calendar: boolean;
  /**
   * Klorn reads this provider's mail and no mail action (mark read, archive,
   * send) reaches the provider.
   */
  readOnly: boolean;
  /** A second account of this provider is synced, not only stored. */
  additionalAccounts: boolean;
}

export interface ProvidersAvailableResponse {
  /** Only providers whose mail can be connected now, in display order. */
  providers: ProviderAvailability[];
}
