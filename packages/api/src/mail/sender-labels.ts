/**
 * Sender labels (2026-09-11): the user's correction of who a sender IS —
 * "this address is a customer", "everyone at acme.io is an investor". The
 * strongest evidence a row chip can have (the user said so), above the
 * declared company domain and far above the judge's guess; and the one way
 * 고객 / 투자자 chips can appear at all, since the summarize vocabulary never
 * stores those words.
 *
 * Two scopes: a sender address, or a whole domain. The address wins when
 * both match. Domain labels never accept a public mail provider — "everyone
 * at gmail.com is a customer" is not a correction, it is a flood.
 *
 * The label also reaches the analysis prompt as one line, so the LLM's
 * category and priority follow the correction instead of fighting it.
 */

import { prisma } from "../db.js";
import { senderEmail } from "../notify/notification-format.js";
import { normalizeDomain, PUBLIC_MAIL_DOMAINS } from "./company-domains.js";

export const USER_LABEL_CATEGORIES = [
  "internal",
  "customer",
  "investor",
  "system",
  "billing",
  "promotions",
] as const;
export type UserLabelCategory = (typeof USER_LABEL_CATEGORIES)[number];

export const SENDER_LABEL_SCOPES = ["sender", "domain"] as const;
export type SenderLabelScope = (typeof SENDER_LABEL_SCOPES)[number];

export interface SenderLabelKey {
  scope: SenderLabelScope;
  /** Lowercase address (scope sender) or hostname (scope domain). */
  value: string;
}

export interface SenderLabel extends SenderLabelKey {
  category: UserLabelCategory;
}

export function isUserLabelCategory(value: unknown): value is UserLabelCategory {
  return typeof value === "string" && (USER_LABEL_CATEGORIES as readonly string[]).includes(value);
}

const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The domain part of a lowercase address, or null. */
function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1) || null : null;
}

/**
 * Scope + value → the canonical key, or an error naming what was wrong. A
 * sender value may be a full From header ("Name <a@b.com>"); a domain value
 * takes what people paste (see normalizeDomain).
 */
export function normalizeSenderLabelKey(input: {
  scope?: unknown;
  value?: unknown;
}): { ok: SenderLabelKey } | { error: string } {
  const { scope, value } = input;
  if (scope !== "sender" && scope !== "domain") {
    return { error: "scope must be sender or domain" };
  }
  if (typeof value !== "string" || !value.trim()) return { error: "value is required" };
  if (scope === "sender") {
    const address = senderEmail(value).toLowerCase();
    if (!ADDRESS_RE.test(address)) return { error: `Not an email address: ${value.trim()}` };
    return { ok: { scope, value: address } };
  }
  const domain = normalizeDomain(value);
  if (!domain) return { error: `Not a domain: ${value.trim()}` };
  if (PUBLIC_MAIL_DOMAINS.has(domain)) {
    return { error: `${domain} is a public mail provider — label the address instead` };
  }
  return { ok: { scope, value: domain } };
}

export function validateSenderLabel(input: {
  scope?: unknown;
  value?: unknown;
  category?: unknown;
}): { ok: SenderLabel } | { error: string } {
  const key = normalizeSenderLabelKey(input);
  if ("error" in key) return key;
  if (!isUserLabelCategory(input.category)) {
    return { error: `category must be one of ${USER_LABEL_CATEGORIES.join(", ")}` };
  }
  return { ok: { ...key.ok, category: input.category } };
}

export async function listSenderLabels(userId: string): Promise<SenderLabel[]> {
  const rows = await prisma.senderLabel.findMany({
    where: { userId },
    orderBy: [{ scope: "asc" }, { value: "asc" }],
    select: { scope: true, value: true, category: true },
  });
  return rows.flatMap((row) =>
    isUserLabelCategory(row.category) && (row.scope === "sender" || row.scope === "domain")
      ? [{ scope: row.scope, value: row.value, category: row.category }]
      : [],
  );
}

export async function upsertSenderLabel(userId: string, label: SenderLabel): Promise<void> {
  await prisma.senderLabel.upsert({
    where: { userId_scope_value: { userId, scope: label.scope, value: label.value } },
    create: { userId, ...label },
    update: { category: label.category },
  });
}

/** True when a row was removed; false = nothing to remove (a 404 for the route). */
export async function deleteSenderLabel(userId: string, key: SenderLabelKey): Promise<boolean> {
  const { count } = await prisma.senderLabel.deleteMany({
    where: { userId, scope: key.scope, value: key.value },
  });
  return count > 0;
}

/**
 * The user's label for each of these sender addresses, one query: address
 * labels first, then the address's domain label. Addresses without a label
 * are absent from the map. Pure lookup — callers decide fail-open.
 */
export async function senderLabelsFor(
  userId: string,
  addresses: readonly string[],
): Promise<Map<string, UserLabelCategory>> {
  const senders = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (!senders.length) return new Map();
  const domains = [...new Set(senders.map(domainOf).filter((d): d is string => d !== null))];
  const rows = await prisma.senderLabel.findMany({
    where: {
      userId,
      OR: [
        { scope: "sender", value: { in: senders } },
        { scope: "domain", value: { in: domains } },
      ],
    },
    select: { scope: true, value: true, category: true },
  });
  const bySender = new Map(
    rows.filter((r) => r.scope === "sender").map((r) => [r.value, r.category]),
  );
  const byDomain = new Map(
    rows.filter((r) => r.scope === "domain").map((r) => [r.value, r.category]),
  );
  const out = new Map<string, UserLabelCategory>();
  for (const sender of senders) {
    const domain = domainOf(sender);
    const label = bySender.get(sender) ?? (domain ? byDomain.get(domain) : undefined);
    if (isUserLabelCategory(label)) out.set(sender, label);
  }
  return out;
}

/**
 * The prompt line for a labeled sender — the analysis must follow the
 * user's correction, not argue with it. Empty when there is no label so the
 * prompt stays byte-identical for everyone else.
 */
export function userLabelLine(category: string | null | undefined): string {
  if (!isUserLabelCategory(category)) return "";
  return `Sender relationship (declared by the user, authoritative): ${category}\n`;
}
