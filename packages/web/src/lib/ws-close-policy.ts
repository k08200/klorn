/**
 * What the realtime socket does after the API closes it.
 *
 * The API's handshake session check (packages/api/src/websocket.ts) closes
 * with one of two codes of its own:
 *   - 1013 "Try Again Later": the database could not decide the session (the
 *     socket form of the HTTP 503 SESSION_CHECK_UNAVAILABLE) — retry;
 *   - 4001: the session is definitively over (forged/expired token, kicked
 *     device, password reset).
 *
 * The socket never signs anyone out. The session authority is the HTTP layer:
 * a 401 on any API call signs out (lib/api.ts apiFetch), a 503 never does. So
 * after a 4001 the socket only waits the capped delay — retrying sooner with
 * the same dead token earns another 4001 — and the next HTTP call's 401 ends
 * the session. Every other close (network drop, server restart, 1013) uses the
 * normal exponential backoff.
 */

export const WS_CLOSE_SESSION_ENDED = 4001;
export const WS_CLOSE_TRY_AGAIN_LATER = 1013;

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const JITTER_MS = 1_000;

/**
 * Delay before reconnect attempt number `attempt` (0-based) after a close with
 * `closeCode`: 1s, 2s, 4s … capped at 30s, plus up to 1s of jitter so many
 * clients don't reconnect in lockstep after a server blip.
 */
export function wsReconnectDelayMs(
  closeCode: number,
  attempt: number,
  random: () => number = Math.random,
): number {
  const base =
    closeCode === WS_CLOSE_SESSION_ENDED
      ? MAX_DELAY_MS
      : Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return base + random() * JITTER_MS;
}
