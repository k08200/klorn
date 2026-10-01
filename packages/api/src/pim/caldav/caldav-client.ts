/**
 * A minimal, read-only CalDAV client (step C3): discovery and one calendar-query
 * per calendar. Every request goes through caldav-http.ts, so every URL here (the
 * pinned base URL and every href a server hands back) passes the host guard first.
 *
 * Discovery, RFC 4791 section 6 and RFC 5397:
 *   1. PROPFIND the base URL, Depth 0, for `current-user-principal`.
 *   2. PROPFIND the principal, Depth 0, for `calendar-home-set`.
 *   3. PROPFIND the home set, Depth 1: the child collections whose `resourcetype`
 *      is a calendar and whose `supported-calendar-component-set` (absent = any)
 *      includes VEVENT. At most CALDAV_MAX_CALENDARS, by href.
 * Events: REPORT calendar-query (RFC 4791 section 7.8) with a VEVENT time-range
 * filter; the server returns every calendar object with an instance in the range,
 * recurring ones as the whole object (master and overrides). Expansion is done
 * here, not asked of the server (`<C:expand>` is optional server behaviour).
 */

import { CaldavHttpError, CaldavProtocolError } from "./caldav-errors.js";
import { type CaldavConnection, caldavRequest } from "./caldav-http.js";
import {
  childrenNamed,
  descendantsNamed,
  firstChild,
  parseXml,
  textBelow,
  type XmlNode,
} from "./caldav-xml.js";

/** Calendars read per account. More are left out and the listing is marked incomplete. */
export const CALDAV_MAX_CALENDARS = 25;

const DAV_NS = 'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"';
const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';
const PRINCIPAL_BODY = `${XML_DECL}<D:propfind ${DAV_NS}><D:prop><D:current-user-principal/></D:prop></D:propfind>`;
const HOME_SET_BODY = `${XML_DECL}<D:propfind ${DAV_NS}><D:prop><C:calendar-home-set/></D:prop></D:propfind>`;
const CALENDARS_BODY = `${XML_DECL}<D:propfind ${DAV_NS}><D:prop><D:resourcetype/><C:supported-calendar-component-set/></D:prop></D:propfind>`;
/** Statuses at the base URL that mean "no RFC 5397 answer here", where a provider fallback applies. */
const NO_PRINCIPAL_STATUSES: ReadonlySet<number> = new Set([403, 404, 405]);
const HTTP_OK_LINE = /\s200\s/;
/** RFC 4918 507: the server cut the result set short. */
const HTTP_INSUFFICIENT_STORAGE_LINE = /\s507\s/;

/** The `prop` elements of a response whose propstat status is 200 (status absent counts as 200). */
function okProps(response: XmlNode): XmlNode[] {
  return childrenNamed(response, "propstat")
    .filter((propstat) => {
      const status = textBelow(propstat, "status");
      return status === undefined || HTTP_OK_LINE.test(` ${status} `);
    })
    .flatMap((propstat) => childrenNamed(propstat, "prop"));
}

function responsesOf(body: string): XmlNode[] {
  const root = parseXml(body);
  if (root.name !== "multistatus") throw new CaldavProtocolError("bad-xml");
  return childrenNamed(root, "response");
}

/** The first href inside the named property of any OK propstat, resolved against `base`. */
function hrefProperty(body: string, base: URL, property: string): URL | null {
  for (const response of responsesOf(body)) {
    for (const prop of okProps(response)) {
      const href = textBelow(firstChild(prop, property), "href");
      if (href) return new URL(href, base);
    }
  }
  return null;
}

async function findPrincipal(conn: CaldavConnection): Promise<URL> {
  const base = new URL(conn.provider.baseUrl);
  const fallback = conn.provider.fallbackPrincipalPath;
  try {
    const response = await caldavRequest(conn, {
      method: "PROPFIND",
      url: base,
      depth: "0",
      body: PRINCIPAL_BODY,
    });
    const principal = hrefProperty(response.body, response.url, "current-user-principal");
    if (principal) return principal;
  } catch (err) {
    // A 401 (bad or revoked password) and every guard or limit error propagate.
    if (!(err instanceof CaldavHttpError) || !NO_PRINCIPAL_STATUSES.has(err.status) || !fallback) {
      throw err;
    }
  }
  if (!fallback) throw new CaldavProtocolError("no-principal");
  return new URL(fallback(conn.username), base);
}

async function findHomeSet(conn: CaldavConnection, principal: URL): Promise<URL> {
  const response = await caldavRequest(conn, {
    method: "PROPFIND",
    url: principal,
    depth: "0",
    body: HOME_SET_BODY,
  });
  const home = hrefProperty(response.body, response.url, "calendar-home-set");
  if (!home) throw new CaldavProtocolError("no-home-set");
  return home;
}

function isEventCalendar(prop: XmlNode): boolean {
  if (!firstChild(firstChild(prop, "resourcetype"), "calendar")) return false;
  const supported = firstChild(prop, "supported-calendar-component-set");
  if (!supported) return true;
  return childrenNamed(supported, "comp").some(
    (comp) => (comp.attrs.name ?? "").toUpperCase() === "VEVENT",
  );
}

export interface CalendarCollections {
  readonly calendars: readonly URL[];
  /** True when the account has more calendars than CALDAV_MAX_CALENDARS. */
  readonly truncated: boolean;
}

async function listEventCalendars(conn: CaldavConnection, home: URL): Promise<CalendarCollections> {
  const response = await caldavRequest(conn, {
    method: "PROPFIND",
    url: home,
    depth: "1",
    body: CALENDARS_BODY,
  });
  const found = new Map<string, URL>();
  for (const entry of responsesOf(response.body)) {
    const href = firstChild(entry, "href")?.text.trim();
    if (!href) continue;
    if (!okProps(entry).some(isEventCalendar)) continue;
    const url = new URL(href, response.url);
    found.set(url.href, url);
  }
  const sorted = [...found.values()].sort((a, b) => a.href.localeCompare(b.href));
  return {
    calendars: sorted.slice(0, CALDAV_MAX_CALENDARS),
    truncated: sorted.length > CALDAV_MAX_CALENDARS,
  };
}

/** Discovery steps 1 and 2: proves the credentials work. Throws on any failure. */
export async function findCalendarHome(conn: CaldavConnection): Promise<URL> {
  return findHomeSet(conn, await findPrincipal(conn));
}

/** Discovery, all three steps. */
export async function discoverEventCalendars(conn: CaldavConnection): Promise<CalendarCollections> {
  return listEventCalendars(conn, await findCalendarHome(conn));
}

/** RFC 5545 UTC form, as the time-range filter takes it: 20261005T000000Z. */
export function caldavUtcStamp(instant: Date): string {
  return instant
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function calendarQueryBody(start: Date, end: Date): string {
  return (
    `${XML_DECL}<C:calendar-query ${DAV_NS}>` +
    "<D:prop><D:getetag/><C:calendar-data/></D:prop>" +
    '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">' +
    `<C:time-range start="${caldavUtcStamp(start)}" end="${caldavUtcStamp(end)}"/>` +
    "</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>"
  );
}

export interface CalendarObjects {
  /** The iCalendar text of each calendar object returned. */
  readonly objects: readonly string[];
  /** Responses that should have carried calendar data and did not. */
  readonly unreadable: number;
  /** True when the server reported a cut-off result set (507). */
  readonly truncated: boolean;
}

/** One calendar-query REPORT over [start, end). Throws on a failed request or an unreadable answer. */
export async function queryCalendarObjects(
  conn: CaldavConnection,
  calendar: URL,
  start: Date,
  end: Date,
): Promise<CalendarObjects> {
  const response = await caldavRequest(conn, {
    method: "REPORT",
    url: calendar,
    depth: "1",
    body: calendarQueryBody(start, end),
  });
  const objects: string[] = [];
  let unreadable = 0;
  let truncated = false;
  for (const entry of responsesOf(response.body)) {
    const status = firstChild(entry, "status")?.text ?? "";
    if (HTTP_INSUFFICIENT_STORAGE_LINE.test(` ${status} `)) {
      truncated = true;
      continue;
    }
    const data = okProps(entry)
      .flatMap((prop) => descendantsNamed(prop, "calendar-data"))
      .map((node) => node.text)
      .find((text) => text.trim() !== "");
    if (data === undefined) {
      // The calendar collection itself can be listed with no data; anything else is a miss.
      if (status === "" || HTTP_OK_LINE.test(` ${status} `)) unreadable += 1;
      continue;
    }
    objects.push(data);
  }
  return { objects, unreadable, truncated };
}
