/**
 * Upstream verification for a BYOK key at SAVE time. Root cause of the
 * 2026-07-16 all-day judge outage: a dead/free provider key sat silently in
 * the user's BYOK slot and poisoned every chain walk. A key must prove it
 * works before we store it — and a definitively-rejected key must never be
 * stored at all.
 *
 * Fail-open on provider noise: a 5xx/timeout from the provider must not block
 * the user's save (the chain handles transient provider failures at call
 * time); only a definitive 401/403 rejects.
 */

export type KeyVerification = "valid" | "invalid" | "unreachable";

const VERIFY_TIMEOUT_MS = 4_000;

export async function verifyOpenRouterKey(key: string): Promise<KeyVerification> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (res.ok) return "valid";
    if (res.status === 401 || res.status === 403) return "invalid";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}
