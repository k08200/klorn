/**
 * The judge's PIN_TIER matcher, pure (no db): which lane the user's pins
 * force for one sender. judge-context.ts `lookupPinnedTier` runs it over the
 * user's active pins, and the Rules DSL dry-run runs the same function, so a
 * preview cannot drift from what the judge will do.
 *
 * Two levels and no more — exact address (`conditions.from`) beats exact
 * domain (`conditions.fromDomain`) — and both match by equality, never
 * substring: this runs at cascade rank 0, above the LLM, so a rule that could
 * fuzzy-match would override the judge on mail it was never authored for
 * (subdomains do not inherit a parent-domain pin for the same reason).
 */

import { isTier, type Tier } from "../judge/tiers.js";
import { isPublicMailboxDomain } from "./public-mailbox-domains.js";

export interface PinRuleLike {
  conditions: unknown;
  actionValue: string;
}

/**
 * `rules` must be the ACTIVE PIN_TIER rules, newest first: on a duplicate the
 * first match wins, as the judge's `updatedAt desc` read order makes it.
 */
export function pinnedTierFromRules(
  rules: readonly PinRuleLike[],
  senderAddress: string,
): Tier | null {
  if (!senderAddress) return null;
  const sender = senderAddress.toLowerCase();
  const at = sender.lastIndexOf("@");
  const senderDomain = at > 0 ? sender.slice(at + 1) : "";
  let domainPin: Tier | null = null;
  for (const rule of rules) {
    const conditions = rule.conditions as { from?: unknown; fromDomain?: unknown } | null;
    const from = conditions?.from;
    if (
      Array.isArray(from) &&
      from.some((f) => typeof f === "string" && f.toLowerCase() === sender)
    ) {
      // Junk actionValue must NOT pin to the normalizeTier fallback (QUEUE).
      return isTier(rule.actionValue) ? rule.actionValue : null;
    }
    const fromDomain = conditions?.fromDomain;
    if (
      domainPin === null &&
      senderDomain &&
      // Enforced at READ time, not only at the /pin-tier write guard: the
      // generic /api/email/rules endpoint can author arbitrary PIN_TIER
      // rows, and a public-mailbox domain pin would rank-0 every stranger
      // mailing from that provider.
      !isPublicMailboxDomain(senderDomain) &&
      Array.isArray(fromDomain) &&
      fromDomain.some(
        (d) => typeof d === "string" && d.toLowerCase().replace(/^@/, "") === senderDomain,
      ) &&
      isTier(rule.actionValue)
    ) {
      // Remember but keep scanning: a later rule may hold the exact-address
      // pin that outranks this one.
      domainPin = rule.actionValue;
    }
  }
  return domainPin;
}
