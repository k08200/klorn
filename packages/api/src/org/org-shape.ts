/**
 * Input normalizers and wire shapes for the organization routes. Pure: no
 * database, so the rules are unit-testable and shared by every service file.
 */

import { randomBytes } from "node:crypto";
import { type TeamInterval, teamCheckoutIntervals } from "../billing/paddle-team.js";
import type { AgentModeCap } from "./ceilings.js";
import { seatsActive } from "./effective-tier.js";

/** Self-serve organizations hold at most 150 seats; larger ones go to Enterprise. */
export const MAX_SELF_SERVE_SEATS = 150;
/** The smallest team subscription. */
export const MIN_TEAM_SEATS = 2;
export const NAME_MAX = 80;
export const MAX_COMPANY_DOMAINS = 10;

// A plain address only: no display name, list separator, quote or bracket can
// reach the mail provider. Applied after lowercasing.
const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// Zero-width and bidirectional controls: they let a name read differently
// from what it is (a spoofed "Klorn Security" in an invite subject).
const INVISIBLE_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// An organization name is not a link: it is shown in invite mail.
const LINK_LIKE_RE = /:\/\/|\bwww\./i;
const SLUG_BASE_MAX = 40;

/** Text with its zero-width and bidirectional control characters removed. */
export function stripInvisibleText(value: string): string {
  return value.replace(INVISIBLE_RE, "");
}

export function normalizeOrgName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = stripInvisibleText(value).trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > NAME_MAX) return null;
  if (CONTROL_RE.test(name) || LINK_LIKE_RE.test(name)) return null;
  return name;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 320 && EMAIL_RE.test(email) ? email : null;
}

/** Lowercase, "@" stripped, deduplicated; null when any entry is not a domain. */
export function normalizeDomains(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_COMPANY_DOMAINS) return null;
  const domains: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    const domain = raw.trim().toLowerCase().replace(/^@/, "");
    if (!DOMAIN_RE.test(domain)) return null;
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

/** A readable, unique slug: the name's ASCII letters and digits plus a random suffix. */
export function slugFor(name: string): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_BASE_MAX)
      .replace(/-+$/, "") || "org";
  return `${base}-${randomBytes(3).toString("hex")}`;
}

export const ORG_SELECT = {
  id: true,
  name: true,
  slug: true,
  companyDomains: true,
  autoReplyDisabled: true,
  agentModeCap: true,
  seatsPurchased: true,
  billingInterval: true,
  subscriptionStatus: true,
  paddleSubscriptionId: true,
} as const;

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  companyDomains: string[];
  autoReplyDisabled: boolean;
  agentModeCap: string | null;
  seatsPurchased: number;
  billingInterval: string | null;
  subscriptionStatus: string | null;
  paddleSubscriptionId: string | null;
}

export interface OrgWire {
  id: string;
  name: string;
  slug: string;
  companyDomains: string[];
  autoReplyDisabled: boolean;
  agentModeCap: AgentModeCap | null;
  seats: {
    purchased: number;
    used: number;
    status: string | null;
    interval: string | null;
    active: boolean;
    /** Intervals a team checkout can be opened for now; empty while billing is off. */
    checkoutIntervals: TeamInterval[];
  };
}

export function orgWire(org: OrgRow, memberCount: number, cap: AgentModeCap | null): OrgWire {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    companyDomains: org.companyDomains,
    autoReplyDisabled: org.autoReplyDisabled,
    agentModeCap: cap,
    seats: {
      purchased: org.seatsPurchased,
      used: memberCount,
      status: org.subscriptionStatus,
      interval: org.billingInterval,
      active: seatsActive(org.subscriptionStatus),
      checkoutIntervals: teamCheckoutIntervals(),
    },
  };
}
