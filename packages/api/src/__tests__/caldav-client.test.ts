/**
 * C3: the minimal CalDAV client against a fake server (iCloud-like and Naver-like
 * shapes), and the small XML reader under it.
 */

import { describe, expect, it, vi } from "vitest";
import { ICLOUD_TIMED, NAVER_WEEKLY } from "../__fixtures__/caldav/ics.js";
import {
  fakeCaldavServer,
  ICLOUD_CALENDARS,
  ICLOUD_HOME,
  ICLOUD_PARTITION,
  icloudReportXml,
  icloudRoutes,
  NAVER_CALENDARS,
  NAVER_ID,
  naverReportXml,
  naverRoutes,
} from "../__fixtures__/caldav/server.js";
import {
  CALDAV_MAX_CALENDARS,
  caldavUtcStamp,
  discoverEventCalendars,
  findCalendarHome,
  queryCalendarObjects,
} from "../pim/caldav/caldav-client.js";
import { CaldavHttpError, CaldavProtocolError } from "../pim/caldav/caldav-errors.js";
import type { CaldavConnection, CaldavTransport } from "../pim/caldav/caldav-http.js";
import { CALDAV_PROVIDERS, type CaldavProviderKey } from "../pim/caldav/caldav-providers.js";
import { parseXml, textBelow } from "../pim/caldav/caldav-xml.js";

function conn(
  provider: CaldavProviderKey,
  transport: CaldavTransport,
  username = provider === "ICLOUD" ? "me@icloud.com" : NAVER_ID,
): CaldavConnection {
  return {
    provider: CALDAV_PROVIDERS[provider],
    username,
    password: "app-password",
    deadline: Date.now() + 60_000,
    requestTimeoutMs: 5_000,
    transport,
    resolve: vi.fn(async () => ["17.248.1.10"]),
    now: () => Date.now(),
  };
}

const START = new Date("2026-10-01T00:00:00Z");
const END = new Date("2026-10-31T00:00:00Z");

describe("parseXml", () => {
  it("matches by local name whatever the prefix", () => {
    for (const doc of [
      '<d:multistatus xmlns:d="DAV:"><d:href>/a</d:href></d:multistatus>',
      '<D:multistatus xmlns:D="DAV:"><D:href>/a</D:href></D:multistatus>',
      '<multistatus xmlns="DAV:"><href>/a</href></multistatus>',
    ]) {
      const root = parseXml(doc);
      expect(root.name).toBe("multistatus");
      expect(textBelow(root, "href")).toBe("/a");
    }
  });

  it("decodes the predefined entities, numeric references and CDATA", () => {
    const root = parseXml(
      "<a><b>x &lt;y&gt; &amp; &quot;z&quot; &apos;w&apos; &#13;&#x41;</b><c><![CDATA[<raw & text>]]></c></a>",
    );
    expect(root.children[0]?.text).toBe("x <y> & \"z\" 'w' \rA");
    expect(root.children[1]?.text).toBe("<raw & text>");
  });

  it.each([
    ['<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>', "a DOCTYPE"],
    ["<a>&nbsp;</a>", "an undeclared entity"],
    ["<a>& b</a>", "a bare ampersand"],
    ["<a><b></a></b>", "mis-nested tags"],
    ["<a>", "an unclosed tag"],
    ["<a/><b/>", "two roots"],
    ["text<a/>", "text outside the root"],
    ["<a>&#x110000;</a>", "an out-of-range character reference"],
  ])("refuses %j (%s)", (doc) => {
    expect(() => parseXml(doc)).toThrow(CaldavProtocolError);
  });

  it("skips comments and the XML declaration", () => {
    expect(parseXml('<?xml version="1.0"?><!-- hi --><a>1</a>').text).toBe("1");
  });
});

describe("discovery, iCloud-like", () => {
  it("finds the principal, the home set on the partition host, and only the VEVENT calendars", async () => {
    const server = fakeCaldavServer(icloudRoutes({}));
    const result = await discoverEventCalendars(conn("ICLOUD", server));
    expect(result.truncated).toBe(false);
    expect(result.calendars.map((url) => url.href)).toEqual(
      ICLOUD_CALENDARS.map((path) => `https://${ICLOUD_PARTITION}${path}`),
    );
    expect(server.calls).toEqual([
      "PROPFIND caldav.icloud.com /",
      "PROPFIND caldav.icloud.com /1234567890/principal/",
      `PROPFIND ${ICLOUD_PARTITION} /1234567890/calendars/`,
    ]);
  });

  it("findCalendarHome resolves the home set (an absolute href with :443)", async () => {
    const home = await findCalendarHome(conn("ICLOUD", fakeCaldavServer(icloudRoutes({}))));
    expect(home.href).toBe(ICLOUD_HOME.replace(":443", ""));
  });

  it("a wrong password is the server's 401, propagated as is", async () => {
    const server = fakeCaldavServer({ "PROPFIND caldav.icloud.com /": { status: 401 } });
    const err = await discoverEventCalendars(conn("ICLOUD", server)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaldavHttpError);
    expect((err as CaldavHttpError).status).toBe(401);
  });

  it("a principal answer with no href is a protocol error (iCloud has no fallback)", async () => {
    const server = fakeCaldavServer({
      "PROPFIND caldav.icloud.com /": {
        status: 207,
        body: '<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop/><status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>',
      },
    });
    const err = await discoverEventCalendars(conn("ICLOUD", server)).catch((e: unknown) => e);
    expect((err as CaldavProtocolError).code).toBe("no-principal");
  });

  it("a discovered href to a host outside the allowlist is refused before it is requested", async () => {
    const routes = icloudRoutes({});
    routes["PROPFIND caldav.icloud.com /1234567890/principal/"] = {
      status: 207,
      body: '<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">https://attacker.example/steal/</href></calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
    };
    const server = fakeCaldavServer(routes);
    const err = await discoverEventCalendars(conn("ICLOUD", server)).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("host");
    expect(server.calls.some((call) => call.includes("attacker"))).toBe(false);
  });

  it(`reads at most ${CALDAV_MAX_CALENDARS} calendars and says it left some out`, async () => {
    const many = Array.from(
      { length: CALDAV_MAX_CALENDARS + 2 },
      (_, n) =>
        `<response><href>/1234567890/calendars/c${String(n).padStart(2, "0")}/</href><propstat><prop><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
    ).join("");
    const routes = icloudRoutes({});
    routes[`PROPFIND ${ICLOUD_PARTITION} /1234567890/calendars/`] = {
      status: 207,
      body: `<multistatus xmlns="DAV:">${many}</multistatus>`,
    };
    const result = await discoverEventCalendars(conn("ICLOUD", fakeCaldavServer(routes)));
    expect(result.calendars).toHaveLength(CALDAV_MAX_CALENDARS);
    expect(result.truncated).toBe(true);
  });
});

describe("discovery, Naver-like", () => {
  it("falls back to /principals/users/<id>/ when the root has no principal answer", async () => {
    const server = fakeCaldavServer(naverRoutes({}));
    const result = await discoverEventCalendars(conn("NAVER", server));
    expect(result.calendars.map((url) => url.pathname)).toEqual(NAVER_CALENDARS);
    expect(server.calls[1]).toBe(
      `PROPFIND caldav.calendar.naver.com /principals/users/${NAVER_ID}/`,
    );
  });

  it("a 401 at the root is never papered over by the fallback", async () => {
    const server = fakeCaldavServer({ "PROPFIND caldav.calendar.naver.com /": { status: 401 } });
    const err = await discoverEventCalendars(conn("NAVER", server)).catch((e: unknown) => e);
    expect((err as CaldavHttpError).status).toBe(401);
    expect(server.calls).toHaveLength(1);
  });
});

describe("calendar-query REPORT", () => {
  it("asks for VEVENTs in the time range, Depth 1, and returns each object's text", async () => {
    let sentBody = "";
    let depth = "";
    const path = ICLOUD_CALENDARS[0] as string;
    const server = fakeCaldavServer({
      [`REPORT ${ICLOUD_PARTITION} ${path}`]: (req) => {
        sentBody = req.body;
        depth = req.headers.Depth ?? "";
        return { status: 207, body: icloudReportXml([ICLOUD_TIMED]) };
      },
    });
    const result = await queryCalendarObjects(
      conn("ICLOUD", server),
      new URL(`https://${ICLOUD_PARTITION}${path}`),
      START,
      END,
    );
    expect(depth).toBe("1");
    expect(sentBody).toContain('<C:comp-filter name="VEVENT">');
    expect(sentBody).toContain('<C:time-range start="20261001T000000Z" end="20261031T000000Z"/>');
    expect(result.objects).toEqual([ICLOUD_TIMED]);
    expect(result.unreadable).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("reads CDATA calendar data (Naver-like)", async () => {
    const path = NAVER_CALENDARS[0] as string;
    const server = fakeCaldavServer(
      naverRoutes({ [path]: { status: 207, body: naverReportXml([NAVER_WEEKLY]) } }),
    );
    const result = await queryCalendarObjects(
      conn("NAVER", server),
      new URL(`https://caldav.calendar.naver.com${path}`),
      START,
      END,
    );
    expect(result.objects).toEqual([NAVER_WEEKLY]);
  });

  it("a 507 response marks the result truncated; a response with no data is unreadable", async () => {
    const path = ICLOUD_CALENDARS[0] as string;
    const body = `<multistatus xmlns="DAV:"><response><href>${path}a.ics</href><propstat><prop><getetag>"1"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response><response><href>${path}</href><status>HTTP/1.1 507 Insufficient Storage</status></response></multistatus>`;
    const server = fakeCaldavServer({
      [`REPORT ${ICLOUD_PARTITION} ${path}`]: { status: 207, body },
    });
    const result = await queryCalendarObjects(
      conn("ICLOUD", server),
      new URL(`https://${ICLOUD_PARTITION}${path}`),
      START,
      END,
    );
    expect(result.truncated).toBe(true);
    expect(result.unreadable).toBe(1);
  });

  it("caldavUtcStamp is the RFC 5545 UTC form", () => {
    expect(caldavUtcStamp(new Date("2026-10-05T09:08:07.123Z"))).toBe("20261005T090807Z");
  });
});
