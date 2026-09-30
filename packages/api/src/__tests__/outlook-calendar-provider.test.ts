/**
 * C4: the OUTLOOK implementation of CalendarProviderActions, read-only, over
 * Microsoft Graph. Graph is mocked at the HTTP layer so every request is pinned
 * exactly (URL, headers, body, time window, paging). Docs the requests follow:
 *   - GET  /me/calendarView  https://learn.microsoft.com/graph/api/calendar-list-calendarview
 *   - POST /me/calendar/getSchedule  https://learn.microsoft.com/graph/api/calendar-getschedule
 *   - paging via @odata.nextLink  https://learn.microsoft.com/graph/paging
 *   - Prefer: IdType="ImmutableId"  https://learn.microsoft.com/graph/outlook-immutable-id
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  fetch: vi.fn(),
  updateMany: vi.fn(async () => ({ count: 1 })),
  markLinkedCalendarForReconnect: vi.fn(async () => {}),
  captureError: vi.fn(),
}));

vi.mock("../crypto-tokens.js", () => ({
  decryptToken: (t: string) => t.replace(/^enc:/, ""),
  decryptOptional: (t: string | null | undefined) => (t ? t.replace(/^enc:/, "") : null),
  encryptToken: (t: string) => `enc:${t}`,
  encryptOptional: (t: string | null | undefined) => (t ? `enc:${t}` : null),
}));
vi.mock("../db.js", () => {
  const prisma = { linkedCalendarAccount: { updateMany: m.updateMany } };
  return { prisma, db: prisma };
});
vi.mock("../mail/gmail.js", () => ({
  markLinkedCalendarForReconnect: m.markLinkedCalendarForReconnect,
}));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));

import { outlookCalendarActions } from "../pim/calendar-providers/outlook.js";
import {
  CalendarReadOnlyError,
  type CalendarSession,
  isCalendarUnsupported,
} from "../pim/calendar-providers/types.js";
import { isRevokedGoogleGrantError } from "../pim/linked-calendar-failure.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const TOKEN = "graph-access-token";
const ACCOUNT_EMAIL = "me@contoso.com";

function linkedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "acct-out",
    userId: "u1",
    provider: "OUTLOOK",
    email: ACCOUNT_EMAIL,
    accessToken: `enc:${TOKEN}`,
    refreshToken: "enc:refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60_000),
    needsReconnect: false,
    ...overrides,
  };
}

async function session(): Promise<CalendarSession> {
  const result = await outlookCalendarActions.connect({
    userId: "u1",
    linkedAccountId: "acct-out",
    linked: linkedRow() as never,
  });
  if (!result || isCalendarUnsupported(result)) throw new Error("expected a session");
  return result;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

type FetchCall = { url: string; init: RequestInit & { headers: Record<string, string> } };
function calls(): FetchCall[] {
  return m.fetch.mock.calls.map((c) => ({
    url: String(c[0]),
    init: c[1] as FetchCall["init"],
  }));
}
function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

function timed(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    subject: "Planning",
    bodyPreview: "Agenda",
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    start: { dateTime: "2026-10-02T09:00:00.0000000", timeZone: "Asia/Seoul" },
    end: { dateTime: "2026-10-02T10:00:00.0000000", timeZone: "Asia/Seoul" },
    location: { displayName: "Room 4" },
    onlineMeeting: null,
    onlineMeetingUrl: null,
    ...extra,
  };
}

const LIST_QUERY = {
  timeMin: "2026-09-30T05:00:00.000Z",
  timeMax: "2026-10-30T05:00:00.000Z",
  maxResults: 100,
  timeZone: "Asia/Seoul",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", m.fetch);
  m.fetch.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("connect", () => {
  it("answers a session for a linked account, without any network call", async () => {
    const s = await session();
    expect(s.provider).toBe("OUTLOOK");
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("is never the primary calendar: the primary login is Google", async () => {
    expect(
      await outlookCalendarActions.connect({ userId: "u1", linkedAccountId: null }),
    ).toBeNull();
  });
});

describe("listEvents - GET /me/calendarView", () => {
  it("requests exactly the window, the page size, the order and the zone, with the bearer token", async () => {
    m.fetch.mockResolvedValueOnce(json({ value: [] }));

    await (await session()).listEvents(LIST_QUERY);

    expect(calls()).toHaveLength(1);
    const { url, init } = calls()[0] as FetchCall;
    expect(url.startsWith(`${GRAPH}/me/calendarView?`)).toBe(true);
    const p = paramsOf(url);
    expect(p.get("startDateTime")).toBe("2026-09-30T05:00:00.000Z");
    expect(p.get("endDateTime")).toBe("2026-10-30T05:00:00.000Z");
    expect(p.get("$top")).toBe("100");
    expect(p.get("$orderby")).toBe("start/dateTime");
    expect(p.get("$select")).toBe(
      "id,subject,bodyPreview,isAllDay,isCancelled,showAs,start,end,location,onlineMeeting,onlineMeetingUrl",
    );
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers.Prefer).toBe('outlook.timezone="Asia/Seoul", IdType="ImmutableId"');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("asks for UTC when no zone was named, and leaves the instants null", async () => {
    m.fetch.mockResolvedValueOnce(
      json({
        value: [
          timed("e1", {
            start: { dateTime: "2026-10-02T00:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-10-02T01:00:00.0000000", timeZone: "UTC" },
          }),
        ],
      }),
    );

    const [event] = await (await session()).listEvents({
      timeMin: LIST_QUERY.timeMin,
      timeMax: LIST_QUERY.timeMax,
      maxResults: 10,
    });

    expect((calls()[0] as FetchCall).init.headers.Prefer).toBe('IdType="ImmutableId"');
    expect(event).toMatchObject({
      start: "2026-10-02T00:00:00.000Z",
      end: "2026-10-02T01:00:00.000Z",
      startTime: null,
      endTime: null,
    });
  });

  it("drops a zone that could break out of the Prefer header", async () => {
    m.fetch.mockResolvedValueOnce(json({ value: [] }));

    await (await session()).listEvents({ ...LIST_QUERY, timeZone: 'Asia/Seoul", X-Injected="1' });

    expect((calls()[0] as FetchCall).init.headers.Prefer).toBe('IdType="ImmutableId"');
  });

  it("reads an open-ended query as the next 365 days, because calendarView needs both ends", async () => {
    m.fetch.mockResolvedValueOnce(json({ value: [] }));

    await (await session()).listEvents({ timeMin: "2026-09-30T05:00:00.000Z", maxResults: 5 });

    const p = paramsOf((calls()[0] as FetchCall).url);
    expect(p.get("startDateTime")).toBe("2026-09-30T05:00:00.000Z");
    expect(p.get("endDateTime")).toBe("2027-09-30T05:00:00.000Z");
  });

  it("follows @odata.nextLink verbatim, with the same headers, and joins the pages in order", async () => {
    const next = `${GRAPH}/me/calendarView?startDateTime=x&$skiptoken=abc`;
    m.fetch
      .mockResolvedValueOnce(json({ value: [timed("e1")], "@odata.nextLink": next }))
      .mockResolvedValueOnce(json({ value: [timed("e2")] }));

    const events = await (await session()).listEvents(LIST_QUERY);

    expect(events.map((e) => e.externalId)).toEqual(["e1", "e2"]);
    expect(calls()).toHaveLength(2);
    expect((calls()[1] as FetchCall).url).toBe(next);
    expect((calls()[1] as FetchCall).init.headers).toEqual((calls()[0] as FetchCall).init.headers);
  });

  it("stops at maxResults, and does not fetch another page once it has them", async () => {
    const next = `${GRAPH}/me/calendarView?$skiptoken=abc`;
    m.fetch.mockResolvedValueOnce(
      json({ value: [timed("e1"), timed("e2"), timed("e3")], "@odata.nextLink": next }),
    );

    const events = await (await session()).listEvents({ ...LIST_QUERY, maxResults: 2 });

    expect(events.map((e) => e.externalId)).toEqual(["e1", "e2"]);
    expect(calls()).toHaveLength(1);
  });

  it("asks for a page no larger than maxResults, and never above Graph's 1000", async () => {
    m.fetch.mockImplementation(async () => json({ value: [] }));

    await (await session()).listEvents({ ...LIST_QUERY, maxResults: 25 });
    await (await session()).listEvents({ ...LIST_QUERY, maxResults: 5000 });

    expect(paramsOf((calls()[0] as FetchCall).url).get("$top")).toBe("25");
    expect(paramsOf((calls()[1] as FetchCall).url).get("$top")).toBe("1000");
  });

  it("reads nothing, and makes no request, when maxResults is below 1", async () => {
    expect(await (await session()).listEvents({ ...LIST_QUERY, maxResults: 0 })).toEqual([]);
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("excludes cancelled events, and they do not count toward maxResults", async () => {
    m.fetch.mockResolvedValueOnce(
      json({
        value: [
          timed("cancelled-1", { isCancelled: true }),
          timed("keep-1"),
          timed("cancelled-2", { isCancelled: true }),
          timed("keep-2"),
        ],
      }),
    );

    const events = await (await session()).listEvents({ ...LIST_QUERY, maxResults: 2 });

    expect(events.map((e) => e.externalId)).toEqual(["keep-1", "keep-2"]);
  });

  it("gives up after a bounded number of pages rather than looping on a server that never ends", async () => {
    const next = `${GRAPH}/me/calendarView?$skiptoken=again`;
    m.fetch.mockImplementation(async () =>
      json({ value: [timed("c", { isCancelled: true })], "@odata.nextLink": next }),
    );

    const events = await (await session()).listEvents(LIST_QUERY);

    expect(events).toEqual([]);
    expect(calls().length).toBe(10);
  });

  it("refuses a nextLink that points outside Graph, and never sends the token there", async () => {
    m.fetch.mockResolvedValueOnce(
      json({ value: [timed("e1")], "@odata.nextLink": "https://evil.example.com/steal?x=1" }),
    );

    await expect((await session()).listEvents(LIST_QUERY)).rejects.toThrow(/nextLink/);

    expect(calls()).toHaveLength(1);
  });

  it("refuses an http:// nextLink even on the Graph host", async () => {
    m.fetch.mockResolvedValueOnce(
      json({ value: [], "@odata.nextLink": "http://graph.microsoft.com/v1.0/me/calendarView" }),
    );

    await expect((await session()).listEvents(LIST_QUERY)).rejects.toThrow(/nextLink/);
  });
});

describe("listEvents - the neutral event shape", () => {
  async function list(item: unknown, query = LIST_QUERY) {
    m.fetch.mockResolvedValueOnce(json({ value: [item] }));
    const [event] = await (await session()).listEvents(query);
    if (!event) throw new Error("expected an event");
    return event;
  }

  it("maps a timed event: Graph's naive time is read in the named zone and reported as an instant", async () => {
    const event = await list(
      timed("AAMk-1", {
        onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/x" },
      }),
    );

    expect(event).toEqual({
      externalId: "AAMk-1",
      summary: "Planning",
      description: "Agenda",
      location: "Room 4",
      meetingLink: "https://teams.microsoft.com/l/meetup-join/x",
      start: "2026-10-02T00:00:00.000Z",
      end: "2026-10-02T01:00:00.000Z",
      allDay: false,
      startTime: new Date("2026-10-02T00:00:00.000Z"),
      endTime: new Date("2026-10-02T01:00:00.000Z"),
    });
  });

  it("falls back to the query zone when Graph names a Windows zone it cannot parse", async () => {
    const event = await list(
      timed("e1", {
        start: { dateTime: "2026-10-02T09:00:00.0000000", timeZone: "Korea Standard Time" },
        end: { dateTime: "2026-10-02T10:00:00.0000000", timeZone: "Korea Standard Time" },
      }),
    );

    expect(event.startTime).toEqual(new Date("2026-10-02T00:00:00.000Z"));
  });

  it("maps an all-day event to its dates, and to midnight-UTC instants like a Google all-day row", async () => {
    const event = await list(
      timed("AAMk-d", {
        isAllDay: true,
        subject: "Holiday",
        start: { dateTime: "2026-10-05T00:00:00.0000000", timeZone: "Asia/Seoul" },
        end: { dateTime: "2026-10-06T00:00:00.0000000", timeZone: "Asia/Seoul" },
      }),
    );

    expect(event).toMatchObject({
      externalId: "AAMk-d",
      summary: "Holiday",
      start: "2026-10-05",
      end: "2026-10-06",
      allDay: true,
      startTime: new Date("2026-10-05"),
      endTime: new Date("2026-10-06"),
    });
  });

  it("uses the legacy onlineMeetingUrl when there is no joinUrl, and null when there is neither", async () => {
    expect(
      (await list(timed("e1", { onlineMeetingUrl: "https://join.example.com/abc" }))).meetingLink,
    ).toBe("https://join.example.com/abc");
    expect((await list(timed("e2"))).meetingLink).toBeNull();
  });

  it("maps empty text to null, and an event with no id or times to empty strings and null instants, for the caller to skip", async () => {
    const empty = await list(timed("e1", { subject: "", bodyPreview: "", location: null }));
    expect(empty).toMatchObject({ summary: null, description: null, location: null });

    const odd = await list({ subject: "odd" });
    expect(odd).toMatchObject({
      externalId: "",
      start: "",
      end: "",
      allDay: false,
      startTime: null,
      endTime: null,
    });
  });

  it("keeps an unparseable time as no instant rather than a wrong one", async () => {
    const event = await list(
      timed("e1", { start: { dateTime: "not-a-time", timeZone: "Asia/Seoul" } }),
    );

    expect(event.startTime).toBeNull();
    expect(event.start).toBe("not-a-time");
  });
});

describe("Graph failures", () => {
  it("a 401 rejects with its status, which the shared failure policy reads as a revoked grant", async () => {
    m.fetch.mockResolvedValueOnce(
      json(
        { error: { code: "InvalidAuthenticationToken", message: "token for x@y.z expired" } },
        401,
      ),
    );

    const err = await (await session()).listEvents(LIST_QUERY).catch((e: unknown) => e);

    expect(err).toMatchObject({ status: 401 });
    expect(isRevokedGoogleGrantError(err)).toBe(true);
  });

  it.each([
    403, 429, 500, 503,
  ])("a %i rejects and is NOT read as a revoked grant", async (status) => {
    m.fetch.mockResolvedValueOnce(
      json({ error: { code: "Whatever", message: "body text" } }, status),
    );

    const err = await (await session()).listEvents(LIST_QUERY).catch((e: unknown) => e);

    expect(err).toMatchObject({ status });
    expect(isRevokedGoogleGrantError(err)).toBe(false);
  });

  it("puts only the status and Graph's short code in the message, never the body", async () => {
    m.fetch.mockResolvedValueOnce(
      json(
        { error: { code: "ErrorAccessDenied", message: "secret subject line of a meeting" } },
        403,
      ),
    );

    const err = (await (await session()).listEvents(LIST_QUERY).catch((e: unknown) => e)) as Error;

    expect(err.message).toContain("403");
    expect(err.message).toContain("ErrorAccessDenied");
    expect(err.message).not.toContain("secret subject");
  });

  it("survives a non-JSON error body", async () => {
    m.fetch.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));

    await expect((await session()).listEvents(LIST_QUERY)).rejects.toMatchObject({ status: 502 });
  });
});

describe("busyBlocks - POST /me/calendar/getSchedule", () => {
  const WINDOW = { timeMin: "2026-10-02T00:00:00.000Z", timeMax: "2026-10-02T12:00:00.000Z" };

  function schedule(items: unknown[], extra: Record<string, unknown> = {}) {
    return json({
      value: [{ scheduleId: ACCOUNT_EMAIL, availabilityView: "2", scheduleItems: items, ...extra }],
    });
  }
  function item(status: string, start: string, end: string) {
    return {
      status,
      start: { dateTime: `${start}.0000000`, timeZone: "UTC" },
      end: { dateTime: `${end}.0000000`, timeZone: "UTC" },
    };
  }

  it("asks for the account's own schedule over the window, in UTC", async () => {
    m.fetch.mockResolvedValueOnce(schedule([]));

    await (await session()).busyBlocks(WINDOW);

    expect(calls()).toHaveLength(1);
    const { url, init } = calls()[0] as FetchCall;
    expect(url).toBe(`${GRAPH}/me/calendar/getSchedule`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Prefer).toContain('outlook.timezone="UTC"');
    expect(JSON.parse(String(init.body))).toEqual({
      schedules: [ACCOUNT_EMAIL],
      startTime: { dateTime: "2026-10-02T00:00:00", timeZone: "UTC" },
      endTime: { dateTime: "2026-10-02T12:00:00", timeZone: "UTC" },
      availabilityViewInterval: 1440,
    });
  });

  it("reports busy, tentative and out-of-office time as instants, and skips free and working-elsewhere", async () => {
    m.fetch.mockResolvedValueOnce(
      schedule([
        item("busy", "2026-10-02T01:00:00", "2026-10-02T02:00:00"),
        item("free", "2026-10-02T03:00:00", "2026-10-02T04:00:00"),
        item("workingElsewhere", "2026-10-02T04:00:00", "2026-10-02T05:00:00"),
        item("tentative", "2026-10-02T06:00:00", "2026-10-02T07:00:00"),
        item("oof", "2026-10-02T08:00:00", "2026-10-02T09:00:00"),
        item("unknown", "2026-10-02T10:00:00", "2026-10-02T11:00:00"),
      ]),
    );

    const blocks = await (await session()).busyBlocks(WINDOW);

    expect(blocks).toEqual([
      { start: "2026-10-02T01:00:00.000Z", end: "2026-10-02T02:00:00.000Z", calendar: "primary" },
      { start: "2026-10-02T06:00:00.000Z", end: "2026-10-02T07:00:00.000Z", calendar: "primary" },
      { start: "2026-10-02T08:00:00.000Z", end: "2026-10-02T09:00:00.000Z", calendar: "primary" },
      { start: "2026-10-02T10:00:00.000Z", end: "2026-10-02T11:00:00.000Z", calendar: "primary" },
    ]);
  });

  it("never emits the account's address as the calendar label (it goes to the model)", async () => {
    m.fetch.mockResolvedValueOnce(
      schedule([item("busy", "2026-10-02T01:00:00", "2026-10-02T02:00:00")]),
    );

    const blocks = await (await session()).busyBlocks(WINDOW);

    expect(JSON.stringify(blocks)).not.toContain(ACCOUNT_EMAIL);
  });

  it.each([
    400, 403, 404,
  ])("a %i (getSchedule is not supported for personal accounts) falls back to the calendar view", async (status) => {
    m.fetch
      .mockResolvedValueOnce(json({ error: { code: "ErrorNotSupported" } }, status))
      .mockResolvedValueOnce(
        json({
          value: [
            timed("busy-1", {
              start: { dateTime: "2026-10-02T01:00:00.0000000", timeZone: "UTC" },
              end: { dateTime: "2026-10-02T02:00:00.0000000", timeZone: "UTC" },
            }),
            timed("free-1", { showAs: "free" }),
            timed("cancelled-1", { isCancelled: true }),
            timed("elsewhere-1", { showAs: "workingElsewhere" }),
          ],
        }),
      );

    const blocks = await (await session()).busyBlocks(WINDOW);

    expect(blocks).toEqual([
      { start: "2026-10-02T01:00:00.000Z", end: "2026-10-02T02:00:00.000Z", calendar: "primary" },
    ]);
    const view = calls()[1] as FetchCall;
    expect(view.url.startsWith(`${GRAPH}/me/calendarView?`)).toBe(true);
    expect(paramsOf(view.url).get("startDateTime")).toBe(WINDOW.timeMin);
    expect(paramsOf(view.url).get("endDateTime")).toBe(WINDOW.timeMax);
    expect(view.init.headers.Prefer).toContain('outlook.timezone="UTC"');
  });

  it("falls back to the calendar view when the schedule answers 200 with a per-schedule error", async () => {
    m.fetch
      .mockResolvedValueOnce(schedule([], { error: { responseCode: "ErrorInvalidUser" } }))
      .mockResolvedValueOnce(json({ value: [] }));

    expect(await (await session()).busyBlocks(WINDOW)).toEqual([]);
    expect(calls()).toHaveLength(2);
  });

  it("counts an all-day event marked busy in the fallback, with its own span", async () => {
    m.fetch.mockResolvedValueOnce(json({ error: {} }, 400)).mockResolvedValueOnce(
      json({
        value: [
          timed("d1", {
            isAllDay: true,
            showAs: "oof",
            start: { dateTime: "2026-10-02T00:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-10-03T00:00:00.0000000", timeZone: "UTC" },
          }),
        ],
      }),
    );

    expect(await (await session()).busyBlocks(WINDOW)).toEqual([
      { start: "2026-10-02T00:00:00.000Z", end: "2026-10-03T00:00:00.000Z", calendar: "primary" },
    ]);
  });

  it.each([
    401, 408, 429, 500, 503,
  ])("a %i is a real failure: it rejects, with no fallback that could hide it", async (status) => {
    m.fetch.mockResolvedValueOnce(json({ error: { code: "x" } }, status));

    await expect((await session()).busyBlocks(WINDOW)).rejects.toMatchObject({ status });
    expect(calls()).toHaveLength(1);
  });
});

describe("primaryBusyBlocks", () => {
  it("lists timed, non-cancelled, busy events of the calendar view as conflict summaries", async () => {
    m.fetch.mockResolvedValueOnce(
      json({
        value: [
          timed("b1", {
            subject: "Review",
            start: { dateTime: "2026-10-02T01:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-10-02T02:00:00.0000000", timeZone: "UTC" },
          }),
          timed("allday", { isAllDay: true }),
          timed("free", { showAs: "free" }),
          timed("gone", { isCancelled: true }),
          timed("untitled", {
            subject: "",
            start: { dateTime: "2026-10-02T03:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-10-02T04:00:00.0000000", timeZone: "UTC" },
          }),
        ],
      }),
    );

    const blocks = await (await session()).primaryBusyBlocks({
      timeMin: "2026-10-02T00:00:00.000Z",
      timeMax: "2026-10-02T12:00:00.000Z",
    });

    expect(blocks).toEqual([
      {
        id: "b1",
        summary: "Review",
        start: "2026-10-02T01:00:00.000Z",
        end: "2026-10-02T02:00:00.000Z",
      },
      {
        id: "untitled",
        summary: "(No title)",
        start: "2026-10-02T03:00:00.000Z",
        end: "2026-10-02T04:00:00.000Z",
      },
    ]);
  });
});

describe("peopleFreeBusy - POST /me/calendar/getSchedule for other people", () => {
  const WINDOW = { timeMin: "2026-10-02T00:00:00.000Z", timeMax: "2026-10-02T12:00:00.000Z" };

  it("asks for every address in one request and maps each answer by address, case-insensitively", async () => {
    m.fetch.mockResolvedValueOnce(
      json({
        value: [
          {
            scheduleId: "Ann@Contoso.com",
            scheduleItems: [
              {
                status: "busy",
                start: { dateTime: "2026-10-02T01:00:00.0000000", timeZone: "UTC" },
                end: { dateTime: "2026-10-02T02:00:00.0000000", timeZone: "UTC" },
              },
            ],
          },
          { scheduleId: "bob@contoso.com", scheduleItems: [] },
        ],
      }),
    );

    const people = await (await session()).peopleFreeBusy(
      ["ann@contoso.com", "bob@contoso.com"],
      WINDOW,
    );

    expect(JSON.parse(String((calls()[0] as FetchCall).init.body)).schedules).toEqual([
      "ann@contoso.com",
      "bob@contoso.com",
    ]);
    expect(people).toEqual([
      {
        email: "ann@contoso.com",
        blocks: [{ start: "2026-10-02T01:00:00.000Z", end: "2026-10-02T02:00:00.000Z" }],
        anyBusy: true,
      },
      { email: "bob@contoso.com", blocks: [], anyBusy: false },
    ]);
  });

  it("reports a calendar it cannot read as unknown (blocks null), never as free", async () => {
    m.fetch.mockResolvedValueOnce(
      json({
        value: [
          { scheduleId: "ann@contoso.com", error: { responseCode: "ErrorMailRecipientNotFound" } },
        ],
      }),
    );

    const people = await (await session()).peopleFreeBusy(
      ["ann@contoso.com", "ghost@contoso.com"],
      WINDOW,
    );

    expect(people).toEqual([
      { email: "ann@contoso.com", blocks: null, anyBusy: false },
      { email: "ghost@contoso.com", blocks: null, anyBusy: false },
    ]);
  });

  it("a busy entry with no usable times still reads as busy: the safe direction", async () => {
    m.fetch.mockResolvedValueOnce(
      json({ value: [{ scheduleId: "ann@contoso.com", scheduleItems: [{ status: "busy" }] }] }),
    );

    const [ann] = await (await session()).peopleFreeBusy(["ann@contoso.com"], WINDOW);

    expect(ann).toEqual({ email: "ann@contoso.com", blocks: [], anyBusy: true });
  });

  it("asks for nothing when there is nobody to ask about", async () => {
    expect(await (await session()).peopleFreeBusy([], WINDOW)).toEqual([]);
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("rejects on a transport-level failure, for the caller's own policy (personal accounts answer not supported)", async () => {
    m.fetch.mockResolvedValueOnce(json({ error: { code: "ErrorNotSupported" } }, 400));

    await expect(
      (await session()).peopleFreeBusy(["ann@contoso.com"], WINDOW),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("read-only v1", () => {
  it("refuses create, update and delete without any request", async () => {
    const s = await session();

    await expect(
      s.createEvent({
        summary: "x",
        startTime: "2026-10-02T09:00:00",
        endTime: "2026-10-02T10:00:00",
        allDay: false,
        timeZone: "Asia/Seoul",
      }),
    ).rejects.toBeInstanceOf(CalendarReadOnlyError);
    await expect(
      s.updateEvent("e1", { summary: "y", timeZone: "Asia/Seoul" }),
    ).rejects.toBeInstanceOf(CalendarReadOnlyError);
    await expect(s.deleteEvent("e1")).rejects.toBeInstanceOf(CalendarReadOnlyError);

    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("names the provider in the refusal", async () => {
    await expect((await session()).deleteEvent("e1")).rejects.toThrow(/OUTLOOK/);
  });
});
