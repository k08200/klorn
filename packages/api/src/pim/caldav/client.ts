/**
 * CalDAV client — discovery, calendar listing, and a time-range event query.
 *
 * Why CalDAV at all: it is one protocol that reaches Apple iCloud, Fastmail,
 * Nextcloud, most university and company servers, and anything a phone's
 * built-in calendar app can already sync. Integrating those one vendor API at
 * a time never finishes; speaking the standard once reaches all of them.
 *
 * This module is pure I/O over `fetch` with no storage and no scheduling, so
 * it can be tested against fixtures without a network. Credentials arrive as
 * arguments; persisting them is a separate layer's job.
 */

import { escapeXml, findElements, findRawText, findText, hasElement } from "./xml.js";

export interface CalDavCredentials {
  /** Server root or discovery URL, e.g. https://caldav.icloud.com */
  readonly baseUrl: string;
  readonly username: string;
  /** For iCloud and Fastmail this must be an app-specific password. */
  readonly password: string;
}

export interface CalDavCalendar {
  /** Absolute URL of the calendar collection. */
  readonly url: string;
  readonly displayName: string;
}

/** Injectable for tests; defaults to the platform fetch. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class CalDavError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CalDavError";
  }
}

/**
 * True for an address the server must never be pointed at.
 *
 * Loopback, RFC 1918, carrier-grade NAT, link-local (which is where cloud
 * metadata lives, at 169.254.169.254) and their IPv6 equivalents. Exported so
 * the same judgement is used on the literal host and on the resolved address.
 */
export function isPrivateAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::" || host === "0.0.0.0") return true;
  if (/^::ffff:/.test(host)) return isPrivateAddress(host.replace(/^::ffff:/, ""));
  return (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^(fc|fd)[0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host)
  );
}

/**
 * Reject a URL we should not be making server-side requests to — syntax only.
 *
 * The user supplies this host, so it is an SSRF surface: a request to
 * `http://169.254.169.254/` from our own network is a credential-theft
 * primitive, not a calendar sync. This is the synchronous half — https and a
 * literal-address block. A hostname that *resolves* to a private address
 * passes here and is caught by `assertResolvesPublicly`.
 */
export function assertSafeCalDavUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CalDavError(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new CalDavError("CalDAV requires https — credentials travel on every request");
  }
  if (isPrivateAddress(url.hostname)) {
    throw new CalDavError(`Refusing to reach a private address: ${url.hostname}`);
  }
  return url;
}

/** Injectable DNS lookup, so the check is testable without a resolver. */
export type LookupLike = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

const defaultLookup: LookupLike = async (hostname) => {
  const { lookup } = await import("node:dns/promises");
  return await lookup(hostname, { all: true });
};

/**
 * Resolve the hostname and reject it if *any* answer is a private address.
 *
 * A name like `internal.attacker.com` can be public in the URL and resolve to
 * 127.0.0.1, so the syntactic check above is not enough — the plan (C3) calls
 * this out as required before the first request. Every answer is checked, not
 * just the first: a record set that mixes one public and one private address
 * would otherwise pass and then connect to whichever the stack picked.
 *
 * Known remaining gap: this does not *pin* the address, so a name that
 * re-resolves between this check and the request (DNS rebinding) is still
 * reachable. Closing that needs a custom connect hook on the HTTP agent and
 * is deliberately not attempted here.
 */
export async function assertResolvesPublicly(
  hostname: string,
  lookupImpl: LookupLike = defaultLookup,
): Promise<void> {
  // A literal address needs no resolution — and passing one to a resolver is
  // how you get a confusing failure instead of a clear refusal.
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) {
    if (isPrivateAddress(hostname)) {
      throw new CalDavError(`Refusing to reach a private address: ${hostname}`);
    }
    return;
  }

  let answers: ReadonlyArray<{ address: string }>;
  try {
    answers = await lookupImpl(hostname);
  } catch {
    throw new CalDavError(`Could not resolve CalDAV host: ${hostname}`);
  }
  if (answers.length === 0) throw new CalDavError(`Could not resolve CalDAV host: ${hostname}`);
  for (const { address } of answers) {
    if (isPrivateAddress(address)) {
      throw new CalDavError(
        `Refusing to reach ${hostname}: it resolves to a private address (${address})`,
      );
    }
  }
}

function authHeader(creds: CalDavCredentials): string {
  return `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
}

/** Resolve an href from a response — servers return paths or absolute URLs. */
export function resolveHref(href: string, base: string): string {
  return new URL(href.trim(), base).toString();
}

async function propfind(
  creds: CalDavCredentials,
  url: string,
  depth: "0" | "1",
  body: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const res = await fetchImpl(url, {
    method: "PROPFIND",
    headers: {
      Authorization: authHeader(creds),
      "Content-Type": 'application/xml; charset="utf-8"',
      Depth: depth,
    },
    body,
    redirect: "follow",
  });
  if (res.status === 401 || res.status === 403) {
    throw new CalDavError(
      "CalDAV rejected the credentials. iCloud and Fastmail require an app-specific password, not the account password.",
      res.status,
    );
  }
  // 207 Multi-Status is the success case for PROPFIND; 200 is tolerated.
  if (res.status !== 207 && res.status !== 200) {
    throw new CalDavError(`CalDAV PROPFIND failed with HTTP ${res.status}`, res.status);
  }
  return await res.text();
}

const PRINCIPAL_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

const HOME_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;

const CALENDARS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`;

/**
 * Find the user's calendar home: root → current-user-principal → calendar-home-set.
 *
 * Both hops are required by RFC 6764 and neither can be skipped by guessing a
 * path: iCloud's home is under a numeric principal id that is not derivable
 * from the Apple ID.
 */
export async function discoverCalendarHome(
  creds: CalDavCredentials,
  fetchImpl: FetchLike = fetch,
  lookupImpl?: LookupLike,
): Promise<string> {
  const baseUrl = assertSafeCalDavUrl(creds.baseUrl);
  // The user-supplied host is resolved and checked once, here, before any
  // request carries the password. Hosts discovered later in the walk are
  // returned by the server itself and re-checked syntactically below.
  await assertResolvesPublicly(baseUrl.hostname, lookupImpl);
  const base = baseUrl.toString();

  const principalXml = await propfind(creds, base, "0", PRINCIPAL_BODY, fetchImpl);
  const principalBlock = findElements(principalXml, "current-user-principal")[0];
  const principalHref = principalBlock ? findText(principalBlock, "href") : undefined;
  if (!principalHref) {
    throw new CalDavError("Server did not return a current-user-principal");
  }
  const principalUrl = resolveHref(principalHref, base);
  assertSafeCalDavUrl(principalUrl);

  const homeXml = await propfind(creds, principalUrl, "0", HOME_BODY, fetchImpl);
  const homeBlock = findElements(homeXml, "calendar-home-set")[0];
  const homeHref = homeBlock ? findText(homeBlock, "href") : undefined;
  if (!homeHref) throw new CalDavError("Server did not return a calendar-home-set");

  const homeUrl = resolveHref(homeHref, principalUrl);
  assertSafeCalDavUrl(homeUrl);
  return homeUrl;
}

/**
 * List the calendar collections in a home.
 *
 * The home also contains inbox, outbox and plain collections; only entries
 * whose resourcetype includes `<calendar>` are calendars. Filtering on that
 * rather than on the URL shape is what keeps scheduling inboxes out of the
 * user's calendar list.
 */
export async function listCalendars(
  creds: CalDavCredentials,
  homeUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<CalDavCalendar[]> {
  assertSafeCalDavUrl(homeUrl);
  const xml = await propfind(creds, homeUrl, "1", CALENDARS_BODY, fetchImpl);

  const calendars: CalDavCalendar[] = [];
  for (const response of findElements(xml, "response")) {
    const href = findText(response, "href");
    if (!href) continue;
    const resourceType = findElements(response, "resourcetype")[0] ?? "";
    if (!hasElement(resourceType, "calendar")) continue;

    const url = resolveHref(href, homeUrl);
    // The home collection itself can carry the calendar type on some servers;
    // it is not a calendar the user picks.
    if (url === homeUrl) continue;
    calendars.push({ url, displayName: findText(response, "displayname") || url });
  }
  return calendars;
}

/** iCalendar's own UTC stamp format: 20260929T140000Z. */
export function toCalDavStamp(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
}

/**
 * Fetch the raw iCalendar documents for events overlapping a window.
 *
 * Uses REPORT/calendar-query with a time-range filter so the server does the
 * windowing. Asking for the whole collection and filtering locally is what
 * makes a CalDAV client unusable against a calendar with ten years of history.
 *
 * Returns the `calendar-data` payloads untouched; parsing is `ical.ts`'s job.
 */
export async function fetchEventDocuments(
  creds: CalDavCredentials,
  calendarUrl: string,
  start: Date,
  end: Date,
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  assertSafeCalDavUrl(calendarUrl);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${escapeXml(toCalDavStamp(start))}" end="${escapeXml(toCalDavStamp(end))}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

  const res = await fetchImpl(calendarUrl, {
    method: "REPORT",
    headers: {
      Authorization: authHeader(creds),
      "Content-Type": 'application/xml; charset="utf-8"',
      Depth: "1",
    },
    body,
    redirect: "follow",
  });
  if (res.status === 401 || res.status === 403) {
    throw new CalDavError("CalDAV rejected the credentials", res.status);
  }
  if (res.status !== 207 && res.status !== 200) {
    throw new CalDavError(`CalDAV REPORT failed with HTTP ${res.status}`, res.status);
  }

  const xml = await res.text();
  const documents: string[] = [];
  for (const response of findElements(xml, "response")) {
    const data = findRawText(response, "calendar-data");
    if (data?.trim()) documents.push(data);
  }
  return documents;
}
