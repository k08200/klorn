/**
 * Pure helper for deciding whether the autonomous agent should run for a
 * user this tick. Kept separate from `autonomous-agent.ts` so the policy can
 * be unit-tested without booting the scheduler.
 *
 * Why this exists: an early dogfood account list of 24 PRO users was burning
 * the shared OpenRouter free-tier daily cap inside minutes — most users had
 * never opened the app, but the scheduler still fired their background LLM
 * loops every minute. Skipping idle users cuts that fan-out by an order of
 * magnitude with no impact on people actively using Klorn.
 */
import { AGENT_IDLE_THRESHOLD_MS } from "./config.js";

/**
 * Returns true when the agent should skip this user's cycle because they
 * haven't touched the app within the idle threshold.
 *
 * - If we have no lastActiveAt for the user, treat them as idle (no devices
 *   ever registered → almost certainly an abandoned signup).
 * - If their lastActiveAt is older than `thresholdMs`, skip.
 * - Otherwise allow the cycle.
 *
 * `now` and `thresholdMs` are parameters (not module reads) so tests can pin
 * the values without mocking config.
 */
export function isUserIdleForAgent(
  lastActiveAt: Date | null | undefined,
  options: { now?: number; thresholdMs?: number } = {},
): boolean {
  const now = options.now ?? Date.now();
  const thresholdMs = options.thresholdMs ?? AGENT_IDLE_THRESHOLD_MS;
  if (!lastActiveAt) return true;
  return now - lastActiveAt.getTime() > thresholdMs;
}
