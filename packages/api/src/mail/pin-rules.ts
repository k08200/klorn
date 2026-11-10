/**
 * Tier pins — the ONE implementation of validation, listing, and replace
 * semantics for user-authored PIN_TIER rules, shared by the /:id/pin-tier
 * routes, the NL rule compiler, and the settings Rules UI. Write-side twin
 * of fetchPinnedTier's read-side rules: live lanes only (AUTO and CALL are
 * retired vocabulary), exactly two levels — exact address or exact
 * non-public domain — always lowercased, matched by equality, never
 * substring.
 */

import type { TierPinInput, TierPinWire } from "@klorn/contract";
import { prisma } from "../db.js";
import { isTier } from "../judge/tiers.js";
import { isPublicMailboxDomain } from "./public-mailbox-domains.js";

const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[^\s@]+\.[^\s@]+$/;

export type PinValidation = { ok: TierPinInput } | { error: string };

/** Normalize + validate one pin. Returns the canonical lowercased pin. */
export function validateTierPin(pin: {
  scope: string;
  value: string;
  tier: string;
}): PinValidation {
  if (pin.scope !== "sender" && pin.scope !== "domain") {
    return { error: 'scope must be "sender" or "domain".' };
  }
  if (!isTier(pin.tier) || pin.tier === "AUTO") {
    return { error: "tier must be one of the five live lanes." };
  }
  const value = String(pin.value ?? "")
    .trim()
    .toLowerCase();
  if (pin.scope === "sender") {
    if (!ADDRESS_RE.test(value)) return { error: "not a valid email address." };
    return { ok: { scope: "sender", value, tier: pin.tier } };
  }
  const domain = value.replace(/^@/, "");
  if (!DOMAIN_RE.test(domain)) return { error: "not a valid domain." };
  if (isPublicMailboxDomain(domain)) {
    return { error: "public mailbox domain — pin the sender instead." };
  }
  return { ok: { scope: "domain", value: domain, tier: pin.tier } };
}

type StoredPinRule = {
  id: string;
  conditions: unknown;
  actionValue?: string;
};

function pinShapeOf(rule: StoredPinRule): { scope: "sender" | "domain"; value: string } | null {
  const conditions = (rule.conditions ?? {}) as { from?: unknown; fromDomain?: unknown };
  const from = conditions.from;
  if (Array.isArray(from) && from.length === 1 && typeof from[0] === "string") {
    return { scope: "sender", value: from[0].toLowerCase() };
  }
  const fromDomain = conditions.fromDomain;
  if (Array.isArray(fromDomain) && fromDomain.length === 1 && typeof fromDomain[0] === "string") {
    return { scope: "domain", value: fromDomain[0].toLowerCase() };
  }
  return null;
}

/**
 * Replace-apply pins: for each pin, every existing single-entity rule for
 * the same address/domain is deleted and one fresh rule created — one
 * findMany, one transaction, exactly the /:id/pin-tier semantics. Callers
 * pass ALREADY-VALIDATED pins (validateTierPin).
 */
export async function replaceTierPins(
  userId: string,
  pins: TierPinInput[],
): Promise<TierPinWire[]> {
  if (pins.length === 0) return [];
  // Dedupe the same entity within one request, last wins — two rows for one
  // entity would break the one-row-per-entity invariant every reader
  // (pinShapeOf, fetchPinnedTier, the settings list) assumes.
  const byEntity = new Map<string, TierPinInput>();
  for (const pin of pins) byEntity.set(`${pin.scope}:${pin.value}`, pin);
  const deduped = [...byEntity.values()];

  const existing = (await prisma.emailRule.findMany({
    where: { userId, actionType: "PIN_TIER" },
    select: { id: true, conditions: true },
  })) as StoredPinRule[];

  const staleIds = new Set<string>();
  for (const pin of deduped) {
    for (const rule of existing) {
      const shape = pinShapeOf(rule);
      if (shape && shape.scope === pin.scope && shape.value === pin.value) {
        staleIds.add(rule.id);
      }
    }
  }

  const creates = deduped.map((pin) =>
    prisma.emailRule.create({
      data: {
        userId,
        name: pin.scope === "domain" ? `Pin: @${pin.value}` : `Pin: ${pin.value}`,
        conditions: pin.scope === "domain" ? { fromDomain: [pin.value] } : { from: [pin.value] },
        actionType: "PIN_TIER",
        actionValue: pin.tier,
      },
    }),
  );
  const results = await prisma.$transaction([
    ...(staleIds.size
      ? [prisma.emailRule.deleteMany({ where: { id: { in: [...staleIds] }, userId } })]
      : []),
    ...creates,
  ]);
  const created = results.slice(staleIds.size ? 1 : 0) as Array<{ id: string }>;
  return deduped.map((pin, i) => ({ ...pin, id: created[i]?.id ?? "" }));
}

/** All of the user's pins in wire shape, newest first; generic rules and
 * retired-vocabulary rows never surface. */
export async function listTierPins(userId: string): Promise<TierPinWire[]> {
  const rules = (await prisma.emailRule.findMany({
    where: { userId, actionType: "PIN_TIER", isActive: true },
    select: { id: true, conditions: true, actionValue: true },
    orderBy: { updatedAt: "desc" },
  })) as StoredPinRule[];
  const pins: TierPinWire[] = [];
  for (const rule of rules) {
    const shape = pinShapeOf(rule);
    const tier = rule.actionValue;
    if (!shape || !tier || !isTier(tier) || tier === "AUTO") continue;
    pins.push({ id: rule.id, scope: shape.scope, value: shape.value, tier });
  }
  return pins;
}
