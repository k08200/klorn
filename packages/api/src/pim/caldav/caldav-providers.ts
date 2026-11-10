/**
 * The CalDAV providers Klorn reads calendars from (step C3 of
 * docs/providers/unified-platform-plan.md): iCloud and Naver ONLY in v1, each with
 * a base URL pinned here. No URL comes from a user or an account row; a generic
 * CalDAV server is a later step.
 *
 * Base URLs (checked 2026-10-01). Neither provider has an official page that names
 * its CalDAV server; both are the values every third-party client documents:
 *   - iCloud `https://caldav.icloud.com`. Apple's own forums show discovery handing
 *     out per-account partition hosts `pNN-caldav.icloud.com`
 *     (https://discussions.apple.com/thread/6447414,
 *     https://discussions.apple.com/thread/255132611). Third parties: Nylas
 *     (https://cli.nylas.com/guides/icloud-caldav-settings). Login: the Apple ID
 *     and an app-specific password (https://support.apple.com/en-us/102654).
 *   - Naver `https://caldav.calendar.naver.com`, principal
 *     `/principals/users/<Naver ID>`, port 443, the Naver ID and an application
 *     password (https://extrememanual.net/41175, https://blog.miyu.pe.kr/992). One
 *     guide calls it unofficial and possibly withdrawn at any time; Naver's help
 *     centre has no page for it. Recorded as a risk in the plan.
 *
 * The host guard (`checkCaldavUrl`) runs on EVERY URL the client requests: the base
 * URL, every href discovery returns and every redirect hop.
 */

import net from "node:net";
import { CaldavGuardError } from "./caldav-errors.js";

export type CaldavProviderKey = "ICLOUD" | "NAVER";

export interface CaldavProviderConfig {
  readonly provider: CaldavProviderKey;
  /** User-facing name. */
  readonly label: string;
  /** Where discovery starts. Pinned; never read from a row or a request. */
  readonly baseUrl: string;
  /** Hosts this provider serves, matched exactly (lowercase, no trailing dot). */
  readonly exactHosts: readonly string[];
  /** Host patterns this provider serves (iCloud's partition hosts). Anchored. */
  readonly hostPatterns: readonly RegExp[];
  /**
   * The principal to use when the server does not answer
   * `current-user-principal` (RFC 5397) at the base URL. Null: discovery must find it.
   */
  readonly fallbackPrincipalPath: ((username: string) => string) | null;
  /** Per user, NEW links only (a re-link is always allowed). Same ceiling as Outlook's. */
  readonly maxAccounts: number;
}

const MAX_CALDAV_ACCOUNTS_PER_PROVIDER = 10;

export const CALDAV_PROVIDERS: Readonly<Record<CaldavProviderKey, CaldavProviderConfig>> = {
  ICLOUD: {
    provider: "ICLOUD",
    label: "iCloud",
    baseUrl: "https://caldav.icloud.com/",
    exactHosts: ["caldav.icloud.com"],
    // Stricter than a `.icloud.com` suffix on purpose: only the partition hosts
    // discovery is known to hand out. Any other Apple host fails closed.
    hostPatterns: [/^p\d{1,4}-caldav\.icloud\.com$/],
    fallbackPrincipalPath: null,
    maxAccounts: MAX_CALDAV_ACCOUNTS_PER_PROVIDER,
  },
  NAVER: {
    provider: "NAVER",
    label: "Naver",
    baseUrl: "https://caldav.calendar.naver.com/",
    exactHosts: ["caldav.calendar.naver.com"],
    hostPatterns: [],
    // The path the third-party guides configure by hand. The username is checked
    // against NAVER_ID first, so it cannot add a path segment.
    fallbackPrincipalPath: (username) => `/principals/users/${username}/`,
    maxAccounts: MAX_CALDAV_ACCOUNTS_PER_PROVIDER,
  },
};

export function isCaldavProviderKey(value: unknown): value is CaldavProviderKey {
  return value === "ICLOUD" || value === "NAVER";
}

function hostAllowed(host: string, provider: CaldavProviderConfig): boolean {
  return (
    provider.exactHosts.includes(host) ||
    provider.hostPatterns.some((pattern) => pattern.test(host))
  );
}

function isIpLiteral(hostname: string): boolean {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return net.isIP(bare) !== 0;
}

/**
 * The URL, parsed, when the client may request it for `provider`; throws
 * CaldavGuardError otherwise. https only, no userinfo, no IP literal (the WHATWG
 * parser has already turned `0x7f000001` into `127.0.0.1`), port 443 only (the
 * parser drops an explicit `:443`, so any port left is another one), and a host the
 * provider serves. Resolving and pinning the address is the HTTP layer's job.
 */
export function checkCaldavUrl(raw: string | URL, provider: CaldavProviderConfig): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CaldavGuardError("malformed");
  }
  if (url.protocol !== "https:") throw new CaldavGuardError("scheme");
  if (url.username !== "" || url.password !== "") throw new CaldavGuardError("userinfo");
  if (isIpLiteral(url.hostname)) throw new CaldavGuardError("ip-literal");
  if (url.port !== "") throw new CaldavGuardError("port");
  if (!hostAllowed(url.hostname, provider)) throw new CaldavGuardError("host");
  return url;
}

/** A plain address: one @, no spaces or angle brackets. The route's schema checks the format too. */
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
/** A Naver ID: lowercase letters, digits, `-` and `_`, as Naver issues them. */
const NAVER_ID = /^[a-z0-9][a-z0-9_-]{0,29}$/;
const NAVER_DOMAIN = "@naver.com";
const MAX_IDENTITY_LENGTH = 200;

export interface CaldavAccountIdentity {
  /** What the server's Basic auth takes. */
  readonly username: string;
  /** What the LinkedCalendarAccount row is keyed and labelled by. */
  readonly accountEmail: string;
}

/**
 * The login name and the account address for what the user typed, or null when it
 * is not one this provider accepts. iCloud logs in with the Apple ID (an address).
 * Naver logs in with the Naver ID; `id@naver.com` is reduced to the ID, and the
 * account is listed as `id@naver.com`.
 */
export function caldavAccountIdentity(
  provider: CaldavProviderConfig,
  typed: string,
): CaldavAccountIdentity | null {
  const value = typed.trim().toLowerCase();
  if (value.length === 0 || value.length > MAX_IDENTITY_LENGTH) return null;
  if (provider.provider === "ICLOUD") {
    return EMAIL.test(value) ? { username: value, accountEmail: value } : null;
  }
  const id = value.endsWith(NAVER_DOMAIN) ? value.slice(0, -NAVER_DOMAIN.length) : value;
  return NAVER_ID.test(id) ? { username: id, accountEmail: `${id}${NAVER_DOMAIN}` } : null;
}

/** The login name for a stored account (the inverse of `accountEmail` above). */
export function caldavUsernameOf(
  provider: CaldavProviderConfig,
  accountEmail: string,
): string | null {
  return caldavAccountIdentity(provider, accountEmail)?.username ?? null;
}
