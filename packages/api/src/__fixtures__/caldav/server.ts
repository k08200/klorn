/**
 * A fake CalDAV server for the C3 tests: a CaldavTransport that answers PROPFIND
 * and REPORT from a route table, in the multistatus shapes of RFC 4918 section 14
 * and RFC 4791 sections 7.8 and B. Two flavours, so the client is tested against
 * more than one server's habits:
 *   - iCloud-like: default `DAV:` namespace, the principal on caldav.icloud.com, the
 *     home set and calendars on a partition host with an explicit `:443`, the
 *     calendar data escaped (`&#13;` for CR), a VTODO-only reminders list, and the
 *     scheduling inbox next to the calendars.
 *   - Naver-like: `D:`/`C:` prefixes, no answer to current-user-principal at the
 *     root (404), the calendar data in CDATA.
 * No real account data: ids and hosts are invented.
 */

import type { CaldavTransport, TransportRequest } from "../../pim/caldav/caldav-http.js";

export const ICLOUD_PRINCIPAL_PATH = "/1234567890/principal/";
export const ICLOUD_PARTITION = "p42-caldav.icloud.com";
export const ICLOUD_HOME = `https://${ICLOUD_PARTITION}:443/1234567890/calendars/`;
export const ICLOUD_HOME_PATH = "/1234567890/calendars/";
export const ICLOUD_CALENDARS = ["home/", "work/"].map((c) => `${ICLOUD_HOME_PATH}${c}`);

export const NAVER_ID = "kim_01";
export const NAVER_PRINCIPAL_PATH = `/principals/users/${NAVER_ID}/`;
export const NAVER_HOME_PATH = `/calendars/${NAVER_ID}/`;
export const NAVER_CALENDARS = [`${NAVER_HOME_PATH}default/`];

export interface FakeReply {
  readonly status: number;
  readonly body?: string;
  readonly location?: string;
}

/** `METHOD host path` -> reply (or a function of the request). Unknown routes answer 404. */
export type FakeRoutes = Record<string, FakeReply | ((req: TransportRequest) => FakeReply)>;

export function fakeCaldavServer(routes: FakeRoutes): CaldavTransport & { calls: string[] } {
  const calls: string[] = [];
  const transport = async (req: TransportRequest) => {
    const key = `${req.method} ${req.url.hostname} ${req.url.pathname}`;
    calls.push(key);
    const route = routes[key];
    const reply = typeof route === "function" ? route(req) : (route ?? { status: 404 });
    return { status: reply.status, location: reply.location ?? null, body: reply.body ?? "" };
  };
  return Object.assign(transport, { calls });
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;");
}

export const ICLOUD_PRINCIPAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><current-user-principal><href>${ICLOUD_PRINCIPAL_PATH}</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;

export const ICLOUD_HOME_SET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:"><response><href>${ICLOUD_PRINCIPAL_PATH}</href><propstat><prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">${ICLOUD_HOME}</href></calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`;

function collection(href: string, resourcetype: string, comps: string[] | null): string {
  const supported =
    comps === null
      ? ""
      : `<supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav">${comps
          .map((c) => `<comp name="${c}"/>`)
          .join("")}</supported-calendar-component-set>`;
  return `<response><href>${href}</href><propstat><prop><resourcetype>${resourcetype}</resourcetype>${supported}</prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
}

const CAL = '<calendar xmlns="urn:ietf:params:xml:ns:caldav"/>';

export const ICLOUD_CALENDARS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<multistatus xmlns="DAV:">${[
  collection(ICLOUD_HOME_PATH, "<collection/>", null),
  collection(`${ICLOUD_HOME_PATH}home/`, `<collection/>${CAL}`, ["VEVENT"]),
  collection(`${ICLOUD_HOME_PATH}work/`, `<collection/>${CAL}`, ["VEVENT", "VTODO"]),
  collection(`${ICLOUD_HOME_PATH}reminders/`, `<collection/>${CAL}`, ["VTODO"]),
  collection(
    `${ICLOUD_HOME_PATH}inbox/`,
    '<collection/><schedule-inbox xmlns="urn:ietf:params:xml:ns:caldav"/>',
    null,
  ),
  collection(`${ICLOUD_HOME_PATH}notification/`, "<collection/>", null),
].join("")}</multistatus>`;

/** A calendar-query answer holding `objects`, the iCloud way (escaped text). */
export function icloudReportXml(objects: readonly string[]): string {
  const responses = objects
    .map(
      (data, n) =>
        `<response><href>${ICLOUD_HOME_PATH}home/event-${n}.ics</href><propstat><prop><getetag>"etag-${n}"</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav">${escapeXmlText(data)}</calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<multistatus xmlns="DAV:">${responses}</multistatus>`;
}

export const NAVER_HOME_SET_XML = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>${NAVER_PRINCIPAL_PATH}</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>${NAVER_HOME_PATH}</D:href></C:calendar-home-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`;

export const NAVER_CALENDARS_XML = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>${NAVER_HOME_PATH}default/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat><D:propstat><D:prop><C:supported-calendar-component-set/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response></D:multistatus>`;

/** A calendar-query answer holding `objects`, the Naver-like way (prefixed, CDATA). */
export function naverReportXml(objects: readonly string[]): string {
  const responses = objects
    .map(
      (data, n) =>
        `<D:response><D:href>${NAVER_HOME_PATH}default/${n}.ics</D:href><D:propstat><D:prop><D:getetag>"${n}"</D:getetag><C:calendar-data><![CDATA[${data}]]></C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}</D:multistatus>`;
}

/** The iCloud discovery routes, plus a REPORT answer per calendar path. */
export function icloudRoutes(reports: Record<string, FakeReply>): FakeRoutes {
  return {
    "PROPFIND caldav.icloud.com /": { status: 207, body: ICLOUD_PRINCIPAL_XML },
    [`PROPFIND caldav.icloud.com ${ICLOUD_PRINCIPAL_PATH}`]: {
      status: 207,
      body: ICLOUD_HOME_SET_XML,
    },
    [`PROPFIND ${ICLOUD_PARTITION} ${ICLOUD_HOME_PATH}`]: {
      status: 207,
      body: ICLOUD_CALENDARS_XML,
    },
    ...Object.fromEntries(
      Object.entries(reports).map(([path, reply]) => [`REPORT ${ICLOUD_PARTITION} ${path}`, reply]),
    ),
  };
}

/** The Naver discovery routes (root PROPFIND answers 404), plus REPORT answers. */
export function naverRoutes(reports: Record<string, FakeReply>): FakeRoutes {
  const host = "caldav.calendar.naver.com";
  return {
    [`PROPFIND ${host} /`]: { status: 404 },
    [`PROPFIND ${host} ${NAVER_PRINCIPAL_PATH}`]: { status: 207, body: NAVER_HOME_SET_XML },
    [`PROPFIND ${host} ${NAVER_HOME_PATH}`]: { status: 207, body: NAVER_CALENDARS_XML },
    ...Object.fromEntries(
      Object.entries(reports).map(([path, reply]) => [`REPORT ${host} ${path}`, reply]),
    ),
  };
}
