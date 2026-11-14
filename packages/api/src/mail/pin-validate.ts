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

/** Why a pin was refused, for callers that report it in their own words. */
export type PinErrorCode = "scope" | "tier" | "address" | "domain" | "public-domain";

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
  const value = String(pin.value ?? "")
    .trim()
    .toLowerCase();
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
