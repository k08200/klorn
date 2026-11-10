/**
 * Verifying CalDAV credentials before they are stored (step C3): discovery steps 1
 * and 2 (the principal and its calendar home), through the same host guard, DNS
 * check and bounds as the sync, under a shorter deadline.
 *
 * The answer is only yes or no. What went wrong is logged as a constant class
 * (`http:401`, `guard:host`, `limit:timeout`...), never with server text, an
 * address, the username or the password, and the caller turns every "no" into one
 * generic message, so the link step tells a caller nothing it could use to probe a
 * server or an account.
 */

import { resolveHostAddresses } from "../../mail/host-resolver.js";
import type { HostResolver } from "../../mail/pinned-address.js";
import { findCalendarHome } from "./caldav-client.js";
import { caldavErrorClass } from "./caldav-errors.js";
import { CALDAV_REQUEST_TIMEOUT_MS, type CaldavTransport } from "./caldav-http.js";
import type { CaldavAccountIdentity, CaldavProviderConfig } from "./caldav-providers.js";
import { httpsPinnedTransport } from "./caldav-transport.js";

/** The whole time budget of one link verification. */
export const CALDAV_LINK_DEADLINE_MS = 20_000;

export interface CaldavLinkDeps {
  readonly transport: CaldavTransport;
  readonly resolve: HostResolver;
  readonly now: () => number;
}

const DEFAULT_DEPS: CaldavLinkDeps = {
  transport: httpsPinnedTransport,
  resolve: resolveHostAddresses,
  now: () => Date.now(),
};

/** True when the server accepts the credentials and names a calendar home. */
export async function verifyCaldavLogin(
  config: CaldavProviderConfig,
  identity: CaldavAccountIdentity,
  password: string,
  deps: Partial<CaldavLinkDeps> = {},
): Promise<boolean> {
  const resolved: CaldavLinkDeps = { ...DEFAULT_DEPS, ...deps };
  try {
    await findCalendarHome({
      provider: config,
      username: identity.username,
      password,
      deadline: resolved.now() + CALDAV_LINK_DEADLINE_MS,
      requestTimeoutMs: CALDAV_REQUEST_TIMEOUT_MS,
      transport: resolved.transport,
      resolve: resolved.resolve,
      now: resolved.now,
    });
    return true;
  } catch (err) {
    console.warn(`[CALDAV] ${config.provider} link verification failed (${caldavErrorClass(err)})`);
    return false;
  }
}
