/**
 * Upstream verification for a BYOK key at SAVE time. Root cause of the
 * 2026-07-16 all-day judge outage: a dead provider key sat silently in the
 * user's BYOK slot and poisoned every chain walk. A key must prove it works
 * before we store it — and a definitively-rejected key must never be stored
 * at all.
 *
 * Fail-open on provider noise: a 5xx/timeout from the provider must not block
 * the user's save (the chain handles transient provider failures at call
 * time); only a definitive 401/403 rejects.
 *
 * The key travels only in the request header and is never logged.
 */

export type KeyVerification = "valid" | "invalid" | "unreachable";

const VERIFY_TIMEOUT_MS = 4_000;
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Verify an Anthropic key with `GET /v1/models`: authenticated, but it runs no
 * model, so a save spends no tokens on the user's account.
 */
export async function verifyAnthropicKey(key: string): Promise<KeyVerification> {
  try {
    const res = await fetch(ANTHROPIC_MODELS_URL, {
      headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (res.ok) return "valid";
    if (res.status === 401 || res.status === 403) return "invalid";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}
