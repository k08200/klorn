/**
 * MCP write budget — a sliding window per USER, never per key: a user may hold
 * several keys, and five keys must not multiply the number of mailbox changes an
 * agent can make. Read tools are not counted; the route's per-key request limit
 * still bounds them.
 *
 * In-process, so the cap is PER INSTANCE: with N instances behind the load
 * balancer the effective ceiling is up to N x the constant. Same trade-off as
 * the team_availability budget in agentcore/tool-executor.ts, which this
 * follows; a shared store is worth adding only if the fleet ever grows past one.
 */

/** Allowed write calls per user per window. Proposed value, no measurement behind it. */
export const MCP_WRITE_CAP_PER_WINDOW = 30;
export const MCP_WRITE_WINDOW_MS = 60_000;

/** Timestamps (ms) of each user's counted writes inside the window. Replaced, never mutated. */
const writesByUser = new Map<string, readonly number[]>();

/**
 * Spend one write from `userId`'s budget. Returns false, and records nothing,
 * when the window already holds the cap — a refused call must not extend the
 * lockout.
 */
export function consumeMcpWriteBudget(userId: string, now: number = Date.now()): boolean {
  const recent = (writesByUser.get(userId) ?? []).filter((t) => now - t < MCP_WRITE_WINDOW_MS);
  if (recent.length >= MCP_WRITE_CAP_PER_WINDOW) {
    writesByUser.set(userId, recent);
    return false;
  }
  writesByUser.set(userId, [...recent, now]);
  return true;
}
