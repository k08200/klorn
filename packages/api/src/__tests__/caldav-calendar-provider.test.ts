/**
 * C3: the ICLOUD and NAVER implementations of the calendar provider seam, over a
 * fake CalDAV server. A linked account opens a read-only session from its stored
 * (encrypted) app password; `listWindow` reads every VEVENT calendar of the account
 * and says whether the result is COMPLETE, which is what allows the sync to remove
 * vanished rows. Anything left out (a failed calendar, a cap, an unreadable object)
 * makes it incomplete. And CALDAV_CALENDAR_ENABLED gates all of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("googleapis", () => ({ google: { calendar: vi.fn(() => ({})) } }));
vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(),
  buildLinkedCalendarClient: vi.fn(),
  markLinkedCalendarForReconnect: vi.fn(async () => {}),
}));
vi.mock("../db.js", () => {
  const prisma = {
    linkedCalendarAccount: { findMany: vi.fn(), updateMany: vi.fn() },
    automationConfig: { findUnique: vi.fn(async () => ({ timezone: "Asia/Seoul" })) },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({
  decryptToken: (t: string) => {
    if (!t.startsWith("enc:")) throw new Error("bad cipher");
    return t.slice(4);
  },
  encryptToken: (t: string) => `enc:${t}`,
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  bulkEvents,
  ENDLESS_SECONDLY,
  ICLOUD_ALL_DAY,
  ICLOUD_TIMED,
  MALFORMED,
  NAVER_WEEKLY,
  UTC_WITH_DURATION,
} from "../__fixtures__/caldav/ics.js";
import {
  fakeCaldavServer,
  ICLOUD_CALENDARS,
  ICLOUD_HOME_PATH,
  ICLOUD_PARTITION,
  icloudReportXml,
  icloudRoutes,
  NAVER_CALENDARS,
  naverReportXml,
  naverRoutes,
} from "../__fixtures__/caldav/server.js";
import { caldavCalendarEnabled } from "../config.js";
import { _resetCaldavBackoffForTests } from "../pim/caldav/caldav-backoff.js";
import { CALDAV_MAX_CALENDARS } from "../pim/caldav/caldav-client.js";
import { CaldavLimitError } from "../pim/caldav/caldav-errors.js";
import type { CaldavTransport } from "../pim/caldav/caldav-http.js";
import {
  CALDAV_LISTING_MAX_OCCURRENCES,
  caldavCalendarActions,
} from "../pim/calendar-providers/caldav.js";
import { calendarActionsForProvider } from "../pim/calendar-providers/dispatch.js";
import {
  CalendarReadOnlyError,
  type CalendarSession,
  isCalendarUnsupported,
} from "../pim/calendar-providers/types.js";

const QUERY = {
  timeMin: "2026-10-01T00:00:00.000Z",
  timeMax: "2026-10-31T00:00:00.000Z",
  maxResults: 100,
  timeZone: "Asia/Seoul",
};

function linkedRow(provider: "ICLOUD" | "NAVER", overrides: Record<string, unknown> = {}) {
  return {
    id: `acct-${provider.toLowerCase()}`,
    userId: "u1",
    provider,
    email: provider === "ICLOUD" ? "me@icloud.com" : "kim_01@naver.com",
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    caldavUrl: null,
    caldavPasswordCipher: "enc:app-password",
    needsReconnect: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function sessionFor(
  provider: "ICLOUD" | "NAVER",
  transport: CaldavTransport,
  row = linkedRow(provider),
): Promise<CalendarSession> {
  const actions = caldavCalendarActions(provider, {
    transport,
    resolve: async () => ["17.248.1.10"],
  });
  const session = await actions.connect({
    userId: "u1",
    linkedAccountId: row.id,
    linked: row as never,
  });
  if (!session || isCalendarUnsupported(session)) throw new Error("expected a session");
  return session;
}

const [HOME, WORK] = ICLOUD_CALENDARS as [string, string];

// One account id is reused across tests: a failure must not back the next one off.
beforeEach(() => {
  _resetCaldavBackoffForTests();
});

describe("connect", () => {
  it("opens no session for the primary calendar (CalDAV only ever links)", async () => {
    const actions = caldavCalendarActions("ICLOUD");
    expect(await actions.connect({ userId: "u1", linkedAccountId: null })).toBeNull();
  });

  it.each([
    ["no password stored", { caldavPasswordCipher: null }],
    ["an undecryptable password", { caldavPasswordCipher: "garbage" }],
    ["another provider's row", { provider: "OUTLOOK" }],
  ])("answers not connected for %s", async (_label, overrides) => {
    const row = linkedRow("ICLOUD", overrides);
    const actions = caldavCalendarActions("ICLOUD", { transport: fakeCaldavServer({}) });
    expect(
      await actions.connect({ userId: "u1", linkedAccountId: row.id, linked: row as never }),
    ).toBeNull();
  });

  it("authenticates with the Apple ID for iCloud and the Naver ID for Naver", async () => {
    const seen: string[] = [];
    const record: CaldavTransport = async (req) => {
      seen.push(Buffer.from((req.headers.Authorization ?? "").slice(6), "base64").toString());
      return { status: 401, location: null, body: "" };
    };
    await (await sessionFor("ICLOUD", record)).listEvents(QUERY).catch(() => {});
    await (await sessionFor("NAVER", record)).listEvents(QUERY).catch(() => {});
    expect(seen).toEqual(["me@icloud.com:app-password", "kim_01:app-password"]);
  });
});

describe("listWindow: complete only when nothing was left out", () => {
  it("iCloud: reads every VEVENT calendar, merges in start order, complete", async () => {
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: { status: 207, body: icloudReportXml([ICLOUD_TIMED, ICLOUD_ALL_DAY]) },
        [WORK]: { status: 207, body: icloudReportXml([UTC_WITH_DURATION]) },
      }),
    );
    const listing = await (await sessionFor("ICLOUD", server)).listWindow?.(QUERY);
    expect(listing?.complete).toBe(true);
    expect(listing?.window).toEqual({ timeMin: QUERY.timeMin, timeMax: QUERY.timeMax });
    expect(listing?.events.map((e) => e.externalId)).toEqual([
      "7A1C0F2E-0001-4B7E-9E1A-EXAMPLE00001",
      "7A1C0F2E-0002-4B7E-9E1A-EXAMPLE00002",
      "utc-duration@example.com",
    ]);
    // Reminders (VTODO only), the inbox and notifications are never queried.
    expect(server.calls.filter((c) => c.startsWith("REPORT"))).toHaveLength(2);
  });

  it("asks the server for a range a day wider than the window on both sides", async () => {
    let body = "";
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: (req) => {
          body = req.body;
          return { status: 207, body: icloudReportXml([]) };
        },
        [WORK]: { status: 207, body: icloudReportXml([]) },
      }),
    );
    await (await sessionFor("ICLOUD", server)).listWindow?.(QUERY);
    expect(body).toContain('start="20260930T000000Z" end="20261101T000000Z"');
  });

  it("Naver: the weekly series expands in the window, complete", async () => {
    const server = fakeCaldavServer(
      naverRoutes({
        [NAVER_CALENDARS[0] as string]: { status: 207, body: naverReportXml([NAVER_WEEKLY]) },
      }),
    );
    const session = await sessionFor("NAVER", server);
    expect(session.provider).toBe("NAVER");
    const listing = await session.listWindow?.(QUERY);
    expect(listing?.complete).toBe(true);
    expect(listing?.events).toHaveLength(2);
  });

  it("no calendar found at all: NOT complete (an empty answer must never wipe the window)", async () => {
    const routes = icloudRoutes({});
    routes[`PROPFIND ${ICLOUD_PARTITION} ${ICLOUD_HOME_PATH}`] = {
      status: 207,
      body: '<multistatus xmlns="DAV:"></multistatus>',
    };
    const listing = await (await sessionFor("ICLOUD", fakeCaldavServer(routes))).listWindow?.(
      QUERY,
    );
    expect(listing?.events).toEqual([]);
    expect(listing?.complete).toBe(false);
  });

  // A collection whose type discovery could not read may be an event calendar: it
  // was not fetched, so the listing is not "every calendar".
  it.each([
    [
      "its resourcetype answered 500",
      `<response><href>${ICLOUD_HOME_PATH}hidden/</href><propstat><prop><resourcetype/></prop><status>HTTP/1.1 500 Internal Server Error</status></propstat></response>`,
    ],
    [
      "the entry answered 403 with no propstat",
      `<response><href>${ICLOUD_HOME_PATH}hidden/</href><status>HTTP/1.1 403 Forbidden</status></response>`,
    ],
  ])("a collection discovery could not classify (%s): NOT complete", async (_case, entry) => {
    const routes = icloudRoutes({
      [HOME]: { status: 207, body: icloudReportXml([UTC_WITH_DURATION]) },
      [WORK]: { status: 207, body: icloudReportXml([]) },
    });
    const key = `PROPFIND ${ICLOUD_PARTITION} ${ICLOUD_HOME_PATH}`;
    const calendars = (routes[key] as { body: string }).body;
    routes[key] = {
      status: 207,
      body: calendars.replace("</multistatus>", `${entry}</multistatus>`),
    };
    const listing = await (await sessionFor("ICLOUD", fakeCaldavServer(routes))).listWindow?.(
      QUERY,
    );
    expect(listing?.events.map((e) => e.externalId)).toEqual(["utc-duration@example.com"]);
    expect(listing?.complete).toBe(false);
  });

  it("an object answered without its data (404): NOT complete", async () => {
    const missing = icloudReportXml([UTC_WITH_DURATION]).replace(
      "</multistatus>",
      `<response><href>${HOME}gone.ics</href><status>HTTP/1.1 404 Not Found</status></response></multistatus>`,
    );
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: { status: 207, body: missing },
        [WORK]: { status: 207, body: icloudReportXml([]) },
      }),
    );
    const listing = await (await sessionFor("ICLOUD", server)).listWindow?.(QUERY);
    expect(listing?.events.map((e) => e.externalId)).toEqual(["utc-duration@example.com"]);
    expect(listing?.complete).toBe(false);
  });

  it("a 507 (the server cut its answer short): NOT complete", async () => {
    const cut = icloudReportXml([UTC_WITH_DURATION]).replace(
      "</multistatus>",
      `<response><href>${HOME}</href><status>HTTP/1.1 507 Insufficient Storage</status></response></multistatus>`,
    );
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: { status: 207, body: cut },
        [WORK]: { status: 207, body: icloudReportXml([]) },
      }),
    );
    const listing = await (await sessionFor("ICLOUD", server)).listWindow?.(QUERY);
    expect(listing?.events.map((e) => e.externalId)).toEqual(["utc-duration@example.com"]);
    expect(listing?.complete).toBe(false);
  });

  it("a series the iteration cap cut short: NOT complete", async () => {
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: { status: 207, body: icloudReportXml([ENDLESS_SECONDLY, UTC_WITH_DURATION]) },
        [WORK]: { status: 207, body: icloudReportXml([]) },
      }),
    );
    const listing = await (await sessionFor("ICLOUD", server)).listWindow?.(QUERY);
    expect(listing?.events.map((e) => e.externalId)).toEqual(["utc-duration@example.com"]);
    expect(listing?.complete).toBe(false);
  });

  it("one calendar failing: the rest are listed, and the listing is NOT complete", async () => {
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: { status: 503 },
        [WORK]: { status: 207, body: icloudReportXml([UTC_WITH_DURATION]) },
      }),
    );
    const listing = await (await sessionFor("ICLOUD", server)).listWindow?.(QUERY);
    expect(listing?.events.map((e) => e.externalId)).toEqual(["utc-duration@example.com"]);
    expect(listing?.complete).toBe(false);
  });

  it("every calendar failing throws, so the failure policy sees it", async () => {
    const server = fakeCaldavServer(
      icloudRoutes({ [HOME]: { status: 503 }, [WORK]: { status: 500 } }),
    );
    const session = await sessionFor("ICLOUD", server);
    await expect(session.listWindow?.(QUERY)).rejects.toMatchObject({ status: 503 });
  });

  it("a 401 on any calendar throws at once: the password was revoked", async () => {
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: { status: 401 },
        [WORK]: { status: 207, body: icloudReportXml([UTC_WITH_DURATION]) },
      }),
    );
    const session = await sessionFor("ICLOUD", server);
    await expect(session.listWindow?.(QUERY)).rejects.toMatchObject({ status: 401 });
  });

  it("more events than the CalDAV cap: capped at it, and NOT complete", async () => {
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: {
          status: 207,
          body: icloudReportXml(bulkEvents(CALDAV_LISTING_MAX_OCCURRENCES + 1)),
        },
        [WORK]: { status: 207, body: icloudReportXml([]) },
      }),
    );
    const listing = await (await sessionFor("ICLOUD", server)).listWindow?.(QUERY);
    expect(listing?.events).toHaveLength(CALDAV_LISTING_MAX_OCCURRENCES);
    expect(listing?.complete).toBe(false);
  });

  it("more events than the query's page but under the CalDAV cap: complete; listEvents keeps the page", async () => {
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: { status: 207, body: icloudReportXml(bulkEvents(150)) },
        [WORK]: { status: 207, body: icloudReportXml([]) },
      }),
    );
    const session = await sessionFor("ICLOUD", server);
    const listing = await session.listWindow?.({ ...QUERY, maxResults: 100 });
    expect(listing?.events).toHaveLength(150);
    expect(listing?.complete).toBe(true);
    expect(await session.listEvents({ ...QUERY, maxResults: 100 })).toHaveLength(100);
  });

  it(`more than ${CALDAV_MAX_CALENDARS} calendars: the rest are left out, and NOT complete`, async () => {
    const names = Array.from({ length: CALDAV_MAX_CALENDARS + 1 }, (_, n) => `c${n}/`);
    const collections = names
      .map(
        (name) =>
          `<response><href>${ICLOUD_HOME_PATH}${name}</href><propstat><prop><resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
      )
      .join("");
    const routes = icloudRoutes(
      Object.fromEntries(
        names.map((name) => [
          `${ICLOUD_HOME_PATH}${name}`,
          { status: 207, body: icloudReportXml([]) },
        ]),
      ),
    );
    routes[`PROPFIND ${ICLOUD_PARTITION} ${ICLOUD_HOME_PATH}`] = {
      status: 207,
      body: `<multistatus xmlns="DAV:">${collections}</multistatus>`,
    };
    const server = fakeCaldavServer(routes);
    const listing = await (await sessionFor("ICLOUD", server)).listWindow?.(QUERY);
    expect(server.calls.filter((c) => c.startsWith("REPORT"))).toHaveLength(CALDAV_MAX_CALENDARS);
    expect(listing?.complete).toBe(false);
  });

  it("exactly maxResults events is still complete", async () => {
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: { status: 207, body: icloudReportXml(bulkEvents(100)) },
        [WORK]: { status: 207, body: icloudReportXml([]) },
      }),
    );
    const listing = await (await sessionFor("ICLOUD", server)).listWindow?.(QUERY);
    expect(listing?.events).toHaveLength(100);
    expect(listing?.complete).toBe(true);
  });

  it("an unreadable object: NOT complete", async () => {
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: { status: 207, body: icloudReportXml([ICLOUD_TIMED, MALFORMED]) },
        [WORK]: { status: 207, body: icloudReportXml([]) },
      }),
    );
    const listing = await (await sessionFor("ICLOUD", server)).listWindow?.(QUERY);
    expect(listing?.events).toHaveLength(1);
    expect(listing?.complete).toBe(false);
  });

  it("a response over the size cap: that calendar fails, NOT complete", async () => {
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: () => {
          // What the default transport throws when a body passes the cap.
          throw new CaldavLimitError("too-large");
        },
        [WORK]: { status: 207, body: icloudReportXml([UTC_WITH_DURATION]) },
      }),
    );
    const listing = await (await sessionFor("ICLOUD", server)).listWindow?.(QUERY);
    expect(listing?.complete).toBe(false);
  });

  it("listEvents is the same listing without the completeness", async () => {
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: { status: 207, body: icloudReportXml([ICLOUD_TIMED]) },
        [WORK]: { status: 207, body: icloudReportXml([]) },
      }),
    );
    const events = await (await sessionFor("ICLOUD", server)).listEvents(QUERY);
    expect(events.map((e) => e.externalId)).toEqual(["7A1C0F2E-0001-4B7E-9E1A-EXAMPLE00001"]);
  });
});

describe("read-only and free/busy", () => {
  it("refuses every write", async () => {
    const session = await sessionFor("ICLOUD", fakeCaldavServer({}));
    await expect(
      session.createEvent({
        summary: "x",
        startTime: "2026-10-05T09:00:00",
        endTime: "2026-10-05T10:00:00",
        allDay: false,
        timeZone: "UTC",
      }),
    ).rejects.toBeInstanceOf(CalendarReadOnlyError);
    await expect(session.updateEvent("id", { timeZone: "UTC" })).rejects.toBeInstanceOf(
      CalendarReadOnlyError,
    );
    await expect(session.deleteEvent("id")).rejects.toBeInstanceOf(CalendarReadOnlyError);
  });

  it("busyBlocks: timed, opaque events only, labelled generically, no titles", async () => {
    const server = fakeCaldavServer(
      icloudRoutes({
        [HOME]: { status: 207, body: icloudReportXml([ICLOUD_TIMED, ICLOUD_ALL_DAY]) },
        [WORK]: { status: 207, body: icloudReportXml([]) },
      }),
    );
    const blocks = await (await sessionFor("ICLOUD", server)).busyBlocks({
      timeMin: "2026-10-05T00:00:00.000Z",
      timeMax: "2026-10-10T00:00:00.000Z",
    });
    expect(blocks).toEqual([
      { start: "2026-10-05T13:00:00.000Z", end: "2026-10-05T14:00:00.000Z", calendar: "calendar" },
    ]);
    expect(JSON.stringify(blocks)).not.toContain("Design review");
  });

  it("other people's free/busy is unknown, never free", async () => {
    const session = await sessionFor("ICLOUD", fakeCaldavServer({}));
    expect(
      await session.peopleFreeBusy(["a@example.com"], {
        timeMin: QUERY.timeMin,
        timeMax: QUERY.timeMax,
      }),
    ).toEqual([{ email: "a@example.com", blocks: null, anyBusy: false }]);
  });
});

describe("CALDAV_CALENDAR_ENABLED", () => {
  const saved = process.env.CALDAV_CALENDAR_ENABLED;
  beforeEach(() => {
    delete process.env.CALDAV_CALENDAR_ENABLED;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CALDAV_CALENDAR_ENABLED;
    else process.env.CALDAV_CALENDAR_ENABLED = saved;
  });

  it("is OFF by default and read on every call (lenient parse)", () => {
    expect(caldavCalendarEnabled()).toBe(false);
    for (const on of ["true", " TRUE ", "1", "yes", "on"]) {
      process.env.CALDAV_CALENDAR_ENABLED = on;
      expect(caldavCalendarEnabled()).toBe(true);
    }
    for (const off of ["false", "0", "no", "off", "", "enabled"]) {
      process.env.CALDAV_CALENDAR_ENABLED = off;
      expect(caldavCalendarEnabled()).toBe(false);
    }
  });

  it.each([
    "ICLOUD",
    "NAVER",
  ] as const)("%s dispatches to the unsupported stub while off, and to CalDAV once on", async (provider) => {
    const row = linkedRow(provider);
    const ref = { userId: "u1", linkedAccountId: row.id, linked: row as never };
    const off = await calendarActionsForProvider(provider).connect(ref);
    expect(off !== null && isCalendarUnsupported(off)).toBe(true);
    process.env.CALDAV_CALENDAR_ENABLED = "true";
    const on = await calendarActionsForProvider(provider).connect(ref);
    expect(on !== null && !isCalendarUnsupported(on) && on.provider).toBe(provider);
  });
});
