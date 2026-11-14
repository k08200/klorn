/**
 * Pure rules for the Settings → Team organization pages (Klorn Teams v1) and
 * the invite accept page. No React, no fetch: tested from packages/api
 * (web-files-orgs.test.ts) like the other web models.
 */

import type { AgentModeCapWire, OrgMeWire, OrgRoleWire } from "@klorn/contract";

/** Where the accept page keeps the invite token across the sign-in redirect. */
export const INVITE_TOKEN_STORAGE_KEY = "klorn.teamInviteToken";

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** The token in an invite link's fragment (`#token=…`), or null. */
export function inviteTokenFromHash(hash: string): string | null {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const token = new URLSearchParams(fragment).get("token");
  return token && TOKEN_RE.test(token) ? token : null;
}

export function isInviteToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

/** The settings nav offers Team for saved teams (team mode) or an organization (Klorn Teams). */
export function showTeamSection(
  teamModeProbe: boolean | null,
  teams: boolean | undefined,
): boolean {
  return teamModeProbe === true || teams === true;
}

export function isOwner(me: Pick<OrgMeWire, "role"> | null | undefined): boolean {
  return me?.role === "OWNER";
}

export const ROLE_KEYS: Record<OrgRoleWire, string> = {
  OWNER: "settings.org.role.owner",
  MEMBER: "settings.org.role.member",
};

/** The agent mode cap choices, most permissive first; "" is no cap. */
export const CAP_OPTIONS: ReadonlyArray<{ value: AgentModeCapWire | ""; key: string }> = [
  { value: "", key: "settings.org.cap.none" },
  { value: "SUGGEST", key: "settings.org.cap.suggest" },
  { value: "SHADOW", key: "settings.org.cap.shadow" },
  { value: "OFF", key: "settings.org.cap.off" },
];

const CAP_CEILING_KEYS: Record<AgentModeCapWire, string> = {
  OFF: "settings.org.transparency.ceiling.cap.off",
  SHADOW: "settings.org.transparency.ceiling.cap.shadow",
  SUGGEST: "settings.org.transparency.ceiling.cap.suggest",
};

/** The limits the organization sets for this member, as message keys (none = empty). */
export function ceilingKeys(ceilings: {
  autoReplyDisabled: boolean;
  agentModeCap: AgentModeCapWire | null;
}): string[] {
  return [
    ...(ceilings.autoReplyDisabled ? ["settings.org.transparency.ceiling.autoReplyOff"] : []),
    ...(ceilings.agentModeCap ? [CAP_CEILING_KEYS[ceilings.agentModeCap]] : []),
  ];
}

export function capFromOption(value: string): AgentModeCapWire | null {
  return value === "SUGGEST" || value === "SHADOW" || value === "OFF" ? value : null;
}

const STATUS_KEYS: Record<string, string> = {
  active: "settings.org.seats.status.active",
  trialing: "settings.org.seats.status.trialing",
  past_due: "settings.org.seats.status.pastDue",
  paused: "settings.org.seats.status.paused",
  canceled: "settings.org.seats.status.canceled",
};

export function seatStatusKey(status: string | null): string {
  return (status && STATUS_KEYS[status]) || "settings.org.seats.status.none";
}

export const MIN_SEATS = 2;
export const MAX_SEATS = 150;

/** The seat count a checkout starts from: everyone in the org, at least the minimum. */
export function defaultSeats(memberCount: number): number {
  return Math.min(MAX_SEATS, Math.max(MIN_SEATS, Math.floor(memberCount)));
}

export function clampSeats(value: number): number {
  if (!Number.isFinite(value)) return MIN_SEATS;
  return Math.min(MAX_SEATS, Math.max(MIN_SEATS, Math.round(value)));
}

/** USD cents as a short price ("$30", "$26.50") in the reader's locale. */
export function formatUsd(cents: number, locale: string): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

const KNOWN_CODES = new Set([
  "EMAIL_NOT_VERIFIED",
  "ALREADY_IN_ORG",
  "ALREADY_MEMBER",
  "INVALID_EMAIL",
  "INVALID_NAME",
  "INVALID_DOMAINS",
  "INVITE_LIMIT",
  "MEMBER_LIMIT",
  "OWNER_MUST_TRANSFER",
  "SUBSCRIPTION_ACTIVE",
  "INVITE_EMAIL_FAILED",
  "INVITE_EXPIRED",
  "INVITE_USED",
  "INVITE_INVALID",
  "INVITE_EMAIL_MISMATCH",
  "TEAM_CHECKOUT_UNAVAILABLE",
  "INVALID_SEATS",
  "OWNER_ONLY",
  "NOT_IN_ORG",
  "MEMBER_NOT_FOUND",
  "INVITE_NOT_FOUND",
  "CANNOT_REMOVE_OWNER",
  "rate-limited",
]);

/** Refusals after which an invite link can never succeed: its token is forgotten. */
export const TERMINAL_INVITE_CODES = new Set([
  "INVITE_EXPIRED",
  "INVITE_USED",
  "INVITE_INVALID",
  "ALREADY_IN_ORG",
]);

/** The `code` of an apiFetch error (`API <status>: {"error":…,"code":…}`), or null. */
export function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const start = err.message.indexOf("{");
  if (start === -1) return null;
  try {
    const body = JSON.parse(err.message.slice(start)) as { code?: unknown };
    return typeof body.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

/** The seat count typed so far, or null while it is not a whole number in range. */
export function parseSeats(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw.trim())) return null;
  const seats = Number(raw.trim());
  return seats >= MIN_SEATS && seats <= MAX_SEATS ? seats : null;
}

/** The localized message key for an org route refusal; a generic one for anything else. */
export function orgErrorKey(err: unknown): string {
  const code = apiErrorCode(err);
  return code && KNOWN_CODES.has(code)
    ? `settings.org.error.${code}`
    : "settings.org.error.generic";
}
