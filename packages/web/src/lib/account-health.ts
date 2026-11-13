/**
 * Account Health (Settings -> Accounts): how one connected mail account is shown.
 * Pure, so the copy decisions are unit-tested (api/src/__tests__/web-account-health.test.ts).
 * The API sends codes (status, errorCode); every word is the user's locale.
 */

import type { AccountHealthStatus, InboxProvider, MailSyncErrorCode } from "@klorn/contract";

/** Product names, not translated. */
export const PROVIDER_LABEL: Record<InboxProvider, string> = {
  GOOGLE: "Gmail",
  OUTLOOK: "Outlook",
  ICLOUD: "iCloud Mail",
  NAVER: "Naver Mail",
  IMAP: "IMAP",
  KLORN: "Klorn",
};

/**
 * Where in Settings -> Accounts the account's own controls (reconnect) live; null
 * for a provider without a card on the web (generic IMAP, the Klorn address).
 */
export function accountSectionId(
  provider: InboxProvider,
  kind: "primary" | "linked",
): string | null {
  switch (provider) {
    case "GOOGLE":
      return kind === "primary" ? "account-connections" : "account-google";
    case "ICLOUD":
    case "NAVER":
    case "OUTLOOK":
      return `account-${provider.toLowerCase()}`;
    default:
      return null;
  }
}

/**
 * The Account health list and the iCloud/Naver cards load separately; each asks
 * the other to reload when it learns something (a reconnect, a click on Reconnect).
 */
export const ACCOUNT_HEALTH_REFRESH_EVENT = "klorn:account-health-refresh";
export const IMAP_STATUS_REFRESH_EVENT = "klorn:imap-status-refresh";

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  "auth",
  "unreachable",
  "throttled",
  "error",
]);

/** StatusChip's three shapes: never color alone (WCAG 1.4.1), always a label. */
export function statusChip(status: AccountHealthStatus): {
  chip: "connected" | "failed" | "pending";
  labelKey: string;
} {
  switch (status) {
    case "ok":
      return { chip: "connected", labelKey: "accountHealth.status.ok" };
    case "pending":
      return { chip: "pending", labelKey: "accountHealth.status.pending" };
    case "error":
      return { chip: "failed", labelKey: "accountHealth.status.error" };
    case "reconnect":
      return { chip: "failed", labelKey: "accountHealth.status.reconnect" };
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "Synced 5 min ago" as an i18n key and its variables. */
export function lastSyncCopy(
  lastSyncedAt: string | null,
  nowMs: number,
  provider: InboxProvider,
): { key: string; vars?: Record<string, string> } {
  if (provider === "KLORN") return { key: "accountHealth.sync.direct" };
  const at = lastSyncedAt ? Date.parse(lastSyncedAt) : Number.NaN;
  if (Number.isNaN(at)) return { key: "accountHealth.sync.never" };
  const age = Math.max(0, nowMs - at);
  if (age < MINUTE_MS) return { key: "accountHealth.sync.justNow" };
  if (age < HOUR_MS) {
    return { key: "accountHealth.sync.minutes", vars: { n: String(Math.floor(age / MINUTE_MS)) } };
  }
  if (age < DAY_MS) {
    return { key: "accountHealth.sync.hours", vars: { n: String(Math.floor(age / HOUR_MS)) } };
  }
  return { key: "accountHealth.sync.days", vars: { n: String(Math.floor(age / DAY_MS)) } };
}

/**
 * The plain-language reason for a failed or refused sync, or null when there
 * is nothing to explain. A refused iCloud login gets Apple's own cause: an
 * app-specific password is revoked when the Apple Account password changes.
 */
export function syncProblemKey(
  status: AccountHealthStatus,
  errorCode: MailSyncErrorCode | null,
  provider: InboxProvider,
): string | null {
  if (status === "reconnect" || errorCode === "auth") {
    return provider === "ICLOUD" ? "accountHealth.error.authApple" : "accountHealth.error.auth";
  }
  if (status !== "error" || !errorCode) return null;
  // A code this client does not know (a newer server) reads as the generic failure.
  return KNOWN_ERROR_CODES.has(errorCode)
    ? `accountHealth.error.${errorCode}`
    : "accountHealth.error.error";
}

/** An IMAP account as `/api/{kind}-imap/status` lists it. */
export interface ImapStatusAccount {
  email: string;
  lastSyncedAt: string | null;
  needsReconnect: boolean;
  syncErrorCode?: MailSyncErrorCode | null;
}

/** The same rule as the server's Account Health (api/src/mail/account-health.ts). */
export function imapAccountStatus(account: ImapStatusAccount): AccountHealthStatus {
  if (account.needsReconnect) return "reconnect";
  if (account.syncErrorCode) return "error";
  return account.lastSyncedAt ? "ok" : "pending";
}
