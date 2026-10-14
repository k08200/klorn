/**
 * Coming back to the first run after an OAuth connect (productization plan
 * P8, ONBOARDING_V2).
 *
 * The provider callbacks always land on `/settings?google=…|inbox=…`; the
 * server is not told where the connect was started and its redirect targets
 * are unchanged. Instead the first run leaves a marker in sessionStorage
 * before it sends the browser to the provider. When the callback lands on
 * Settings in the same tab, the marker turns the callback's fixed status into
 * a fixed result and the visitor is sent to `/onboarding` — a constant route,
 * never a value read from the URL.
 *
 * Only fixed values are ever written or accepted: a provider from
 * `OAUTH_PROVIDERS` and an outcome from `CONNECT_OUTCOMES`. Anything else in
 * storage or in the query string is ignored (unknown callback statuses read
 * as "failed"). sessionStorage, so a marker never outlives its tab, and the
 * pending marker carries the time it was written so an abandoned connect
 * stops counting after `PENDING_TTL_MS` and cannot claim a later, unrelated
 * connect made from Settings.
 */

export const ONBOARDING_ROUTE = "/onboarding";

const PENDING_KEY = "klorn.onboardingV2.connect";
const RESULT_KEY = "klorn.onboardingV2.result";

/** A little longer than the server's 10-minute signed OAuth state. */
export const PENDING_TTL_MS = 15 * 60 * 1000;

export const OAUTH_PROVIDERS = ["GOOGLE", "OUTLOOK"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export const CONNECT_OUTCOMES = [
  "connected",
  "denied",
  "offline",
  "unverified",
  "self",
  "limit",
  "failed",
] as const;
export type ConnectOutcome = (typeof CONNECT_OUTCOMES)[number];

export interface ConnectResult {
  provider: OAuthProvider;
  outcome: ConnectOutcome;
}

/** `?google=` statuses the primary Google callback sends. */
const GOOGLE_STATUS: ReadonlyMap<string, ConnectOutcome> = new Map([
  ["connected", "connected"],
  ["offline_access_denied", "offline"],
]);

/** `?inbox=` statuses the linked-inbox callbacks (Google and Outlook) send. */
const INBOX_STATUS: ReadonlyMap<string, ConnectOutcome> = new Map([
  ["success", "connected"],
  ["outlook_denied", "denied"],
  ["unverified", "unverified"],
  ["self", "self"],
  ["limit", "limit"],
  ["failed", "failed"],
]);

/**
 * What the callback's query string says happened; null when it carries
 * neither status (an ordinary visit to Settings). A status that is present
 * but not one this client knows is a failure, never a success.
 */
export function outcomeFromCallback(
  google: string | null,
  inbox: string | null,
): ConnectOutcome | null {
  if (google !== null) return GOOGLE_STATUS.get(google) ?? "failed";
  if (inbox !== null) return INBOX_STATUS.get(inbox) ?? "failed";
  return null;
}

function asProvider(value: string | null | undefined): OAuthProvider | null {
  return OAUTH_PROVIDERS.find((provider) => provider === value) ?? null;
}

function asOutcome(value: string | null | undefined): ConnectOutcome | null {
  return CONNECT_OUTCOMES.find((outcome) => outcome === value) ?? null;
}

/** `GOOGLE:connected` → its two fixed parts; null for anything else. */
export function parseConnectResult(raw: string | null): ConnectResult | null {
  if (!raw) return null;
  const [providerPart, outcomePart, ...rest] = raw.split(":");
  const provider = asProvider(providerPart);
  const outcome = asOutcome(outcomePart);
  return provider && outcome && rest.length === 0 ? { provider, outcome } : null;
}

/**
 * `GOOGLE|1760000000000` → the provider, while the marker is fresh. Anything
 * else (another shape, a time in the future, an old marker) is no marker.
 */
export function parsePending(raw: string | null, now: number): OAuthProvider | null {
  if (!raw) return null;
  const [providerPart, stampPart, ...rest] = raw.split("|");
  const provider = asProvider(providerPart);
  if (!provider || rest.length > 0 || !/^\d{1,15}$/.test(stampPart ?? "")) return null;
  const age = now - Number(stampPart);
  return age >= 0 && age <= PENDING_TTL_MS ? provider : null;
}

function session(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Storage blocked (private mode, embedded view): no marker, so the
    // callback stays on Settings exactly as it does without the first run.
    return null;
  }
}

/** The first run is about to send this tab to `provider`'s consent screen. */
export function markConnectStarted(provider: OAuthProvider): void {
  try {
    const store = session();
    store?.removeItem(RESULT_KEY);
    store?.setItem(PENDING_KEY, `${provider}|${Date.now()}`);
  } catch {
    // Quota or blocked storage: the connect still works, it returns to Settings.
  }
}

/** The provider whose connect the first run started in this tab, if any. */
export function pendingConnect(): OAuthProvider | null {
  try {
    return parsePending(session()?.getItem(PENDING_KEY) ?? null, Date.now());
  } catch {
    return null;
  }
}

/** Keep the callback's outcome for the first run to read. The pending marker stays until then. */
export function storeConnectResult(provider: OAuthProvider, outcome: ConnectOutcome): void {
  try {
    session()?.setItem(RESULT_KEY, `${provider}:${outcome}`);
  } catch {
    // Nothing stored: the first run opens without a notice.
  }
}

/**
 * Read the outcome once and clear both markers. Called when the first run
 * mounts, so a connect that was abandoned (back button, closed consent
 * screen) leaves nothing behind either.
 */
export function takeConnectResult(): ConnectResult | null {
  try {
    const store = session();
    const result = parseConnectResult(store?.getItem(RESULT_KEY) ?? null);
    store?.removeItem(RESULT_KEY);
    store?.removeItem(PENDING_KEY);
    return result;
  } catch {
    return null;
  }
}

/** The connect never left this tab (the start request failed): drop its marker. */
export function forgetConnect(): void {
  try {
    const store = session();
    store?.removeItem(PENDING_KEY);
    store?.removeItem(RESULT_KEY);
  } catch {
    // Nothing to forget.
  }
}
