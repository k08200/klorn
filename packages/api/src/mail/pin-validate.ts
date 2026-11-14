/**
 * Tier pin validation — pure (no db), so the Rules DSL compiler and every pin
 * writer share one definition of a valid pin. Live lanes only (AUTO and CALL
 * are retired vocabulary), exactly two levels — exact address or exact
 * non-public domain — always lowercased. Re-exported by pin-rules.ts.
 */

import type { TierPinInput } from "@klorn/contract";
import { isTier } from "../judge/tiers.js";
import { isPublicMailboxDomain } from "./public-mailbox-domains.js";

const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[^\s@]+\.[^\s@]+$/;

/**
 * RFC 5321's forward-path limit. Checked before the patterns run, on the raw
 * and on the lowercased value: ADDRESS_RE/DOMAIN_RE backtrack quadratically on
 * a crafted failing input, so an uncapped value posted to /rules/pins could
 * hold the event loop for minutes.
 */
export const PIN_VALUE_MAX_CHARS = 254;

/** Why a pin was refused, for callers that report it in their own words. */
export type PinErrorCode = "scope" | "tier" | "address" | "domain" | "public-domain" | "too-long";

const TOO_LONG = {
  error: `at most ${PIN_VALUE_MAX_CHARS} characters.`,
  code: "too-long",
} as const;

export type PinValidation = { ok: TierPinInput } | { error: string; code: PinErrorCode };

/** Normalize + validate one pin. Returns the canonical lowercased pin. */
export function validateTierPin(pin: {
  scope: string;
  value: string;
  tier: string;
}): PinValidation {
  if (pin.scope !== "sender" && pin.scope !== "domain") {
    return { error: 'scope must be "sender" or "domain".', code: "scope" };
  }
  if (!isTier(pin.tier) || pin.tier === "AUTO") {
    return { error: "tier must be one of the five live lanes.", code: "tier" };
  }
  const raw = String(pin.value ?? "");
  if (raw.length > PIN_VALUE_MAX_CHARS * 2) return TOO_LONG;
  const value = raw.trim().toLowerCase();
  if (value.length > PIN_VALUE_MAX_CHARS) return TOO_LONG;
  if (pin.scope === "sender") {
    if (!ADDRESS_RE.test(value)) return { error: "not a valid email address.", code: "address" };
    return { ok: { scope: "sender", value, tier: pin.tier } };
  }
  const domain = value.replace(/^@/, "");
  if (!DOMAIN_RE.test(domain)) return { error: "not a valid domain.", code: "domain" };
  if (isPublicMailboxDomain(domain)) {
    return { error: "public mailbox domain — pin the sender instead.", code: "public-domain" };
  }
  return { ok: { scope: "domain", value: domain, tier: pin.tier } };
}
