import { API_BASE, getStoredAuthToken } from "./api";

/**
 * localStorage keys that hold SECRETS (beyond the session token, which
 * clearStoredAuthToken owns). Must match the playground's keyStorageFor()
 * scheme in app/playground/page.tsx — the visitor's own LLM provider keys
 * live only in this browser, so logout on a shared machine must wipe them.
 * (CASA 6.6.1: browser storage securely cleared during logout, 2026-08-13.)
 */
const SENSITIVE_STORAGE_KEYS = [
  "klorn-playground-key",
  "klorn-playground-key-openrouter",
  "klorn-playground-key-gemini",
  "klorn-playground-key-openai",
] as const;

/**
 * sessionStorage keys under this prefix hold Mail v2 view state: the lane,
 * account, filter and search the list was on, and the mail last read. Not
 * secrets, but they describe the previous user's mail, so logout drops them.
 */
const MAIL_VIEW_STATE_PREFIX = "klorn.mailV2.";

/** The keys under `prefix`, collected first so removing them cannot skip one. */
export function keysWithPrefix(storage: Pick<Storage, "length" | "key">, prefix: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

export function clearSensitiveStorage(): void {
  if (typeof window === "undefined") return;
  for (const key of SENSITIVE_STORAGE_KEYS) {
    localStorage.removeItem(key);
  }
  try {
    for (const key of keysWithPrefix(sessionStorage, MAIL_VIEW_STATE_PREFIX)) {
      sessionStorage.removeItem(key);
    }
  } catch {
    // sessionStorage unavailable (private mode): there is nothing to clear.
  }
}

/**
 * Tell the API to drop this token's device session so the JWT is rejected
 * server-side from now on — clearing localStorage alone leaves the token
 * valid until natural expiry (CASA 2.2.1). Fire-and-forget by design:
 * logout must complete instantly even when the API is unreachable, and the
 * 7-day TTL plus the device-session check bound the damage of a lost call.
 */
export function revokeServerSession(): void {
  const token = getStoredAuthToken();
  if (!token) return;
  void fetch(`${API_BASE}/api/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    keepalive: true,
  }).catch(() => {
    // Best effort — see above.
  });
}
