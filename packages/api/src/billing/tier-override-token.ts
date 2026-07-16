/**
 * Tier-override capability token — lets a push notification carry one-tap
 * "Later" (→ QUEUE) / "Mute" (→ SILENT) buttons that retier a firewall item
 * from the service worker, where no session cookie is reliably available.
 *
 * Why a dedicated token instead of the session JWT (auth.ts):
 *  - It is signed with a secret DERIVED from JWT_SECRET (HMAC over a fixed
 *    purpose string), so it is cryptographically distinct from a session token:
 *    a leaked override token can never be replayed as a session credential, and
 *    a stolen session token can never be replayed against the override endpoint.
 *  - It is scoped to exactly one (userId, itemId) and carries a `kind`
 *    discriminator, so it can only ever retier the single item it was minted for.
 *
 * The token is a capability (mirrors the receiptUrl pattern): possession is the
 * authorization, so it is short-lived and the endpoint that consumes it only
 * permits the safe, reversible tiers (QUEUE / SILENT — never PUSH/AUTO).
 */

import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { resolveEffectiveJwtSecret } from "../auth.js";

// Go through the single gated resolver instead of re-reading process.env with
// an inline `|| "<public dev secret>"` fallback: that duplicated the exact
// fail-open the resolver exists to prevent (the repo-public secret would sign
// override tokens in any misconfigured non-dev/test env). resolveEffectiveJwtSecret
// throws outside development/test when JWT_SECRET is unset.
const BASE_SECRET = resolveEffectiveJwtSecret();

// Derived, purpose-bound secret. Versioned so the purpose string can be rotated
// (invalidating outstanding override tokens) without touching session tokens.
const OVERRIDE_SECRET = createHmac("sha256", BASE_SECRET).update("tier-override-v1").digest("hex");

// A notification button is actionable for a while after delivery (the user may
// not see the phone immediately), but not forever — cap the capability lifetime.
const TOKEN_TTL = "7d";

const TOKEN_KIND = "tier-override";

// The tiers a notification-action token may apply — both reversible. Baked into
// the token so the grant is self-describing: a future change to what a
// notification can do must widen THIS set (which re-scopes the token), not just
// an out-of-band route allowlist. A capability can never reach PUSH/AUTO.
export const NOTIFICATION_OVERRIDE_TIERS = ["QUEUE", "SILENT"] as const;

export interface TierOverrideGrant {
  userId: string;
  itemId: string;
  /** The tiers this token is permitted to apply (token-bound, not caller-supplied). */
  tiers: readonly string[];
}

/**
 * Mint a capability token authorizing a retier of exactly this item by this
 * user, to one of `tiers` (default: the reversible notification set). The
 * permitted tiers are embedded so the endpoint enforces them from the token,
 * not from an out-of-band allowlist.
 */
export function mintTierOverrideToken(
  userId: string,
  itemId: string,
  tiers: readonly string[] = NOTIFICATION_OVERRIDE_TIERS,
): string {
  return jwt.sign({ kind: TOKEN_KIND, userId, itemId, tiers }, OVERRIDE_SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

/**
 * Verify a capability token. Returns the grant, or null for any failure
 * (bad signature, wrong/expired token, wrong kind, missing claims). Never
 * throws — the caller treats null as 401.
 */
export function verifyTierOverrideToken(token: string): TierOverrideGrant | null {
  try {
    const decoded = jwt.verify(token, OVERRIDE_SECRET) as {
      kind?: string;
      userId?: string;
      itemId?: string;
      tiers?: unknown;
    };
    const tiers = Array.isArray(decoded.tiers)
      ? decoded.tiers.filter((t): t is string => typeof t === "string")
      : [];
    if (decoded.kind !== TOKEN_KIND || !decoded.userId || !decoded.itemId || tiers.length === 0) {
      return null;
    }
    return { userId: decoded.userId, itemId: decoded.itemId, tiers };
  } catch {
    return null;
  }
}
