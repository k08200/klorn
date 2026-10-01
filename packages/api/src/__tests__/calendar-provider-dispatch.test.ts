/**
 * C2 provider seam (pim/calendar-providers/): dispatch by account provider, an
 * explicit unsupported result for every non-Google provider, and the Google
 * session's neutral event shape. The primary-calendar behaviour it wraps is
 * pinned by calendar-google-characterisation.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getAuthedClient: vi.fn(),
  buildLinkedCalendarClient: vi.fn(),
  linkedAccountFindFirst: vi.fn(),
  linkedAccountFindMany: vi.fn(),
  eventsList: vi.fn(),
  googleCalendar: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    calendar: m.googleCalendar.mockImplementation(() => ({ events: { list: m.eventsList } })),
  },
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: m.getAuthedClient,
  buildLinkedCalendarClient: m.buildLinkedCalendarClient,
}));
vi.mock("../db.js", () => {
  const prisma = {
    linkedCalendarAccount: {
      findFirst: m.linkedAccountFindFirst,
      findMany: m.linkedAccountFindMany,
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  calendarActionsForProvider,
  connectLinkedCalendars,
  connectPrimaryCalendar,
  listLinkedCalendarAccounts,
} from "../pim/calendar-providers/dispatch.js";
import { googleCalendarActions } from "../pim/calendar-providers/google.js";
import { isCalendarUnsupported } from "../pim/calendar-providers/types.js";

const PRIMARY_AUTH = { tag: "primary" };
const LINKED_AUTH = { tag: "linked" };

beforeEach(() => {
  vi.clearAllMocks();
  m.getAuthedClient.mockResolvedValue(PRIMARY_AUTH);
  m.buildLinkedCalendarClient.mockImplementation((_userId: string, row: { id: string }) =>
    row.id === "acct-1" ? { client: LINKED_AUTH, id: "acct-1", email: "me@work.com" } : null,
  );
  m.eventsList.mockResolvedValue({ data: { items: [] } });
});

describe("calendarActionsForProvider", () => {
  it("serves GOOGLE with the Google implementation", () => {
    expect(calendarActionsForProvider("GOOGLE")).toBe(googleCalendarActions);
    expect(googleCalendarActions.provider).toBe("GOOGLE");
  });

  it.each([
    "OUTLOOK",
    "ICLOUD",
    "NAVER",
    "DEVICE",
    "LOCAL",
  ] as const)("answers an explicit unsupported result for %s, never 'not connected'", async (provider) => {
    const actions = calendarActionsForProvider(provider);
    expect(actions.provider).toBe(provider);

    const result = await actions.connect({
      userId: "u1",
      linkedAccountId: "acct-x",
      linked: linkedRow("acct-x", { provider }) as never,
    });

    expect(result).not.toBeNull();
    expect(isCalendarUnsupported(result)).toBe(true);
    expect(result).toEqual({
      unsupported: true,
      error: `Calendar provider ${provider} is not supported from Klorn yet.`,
    });
    expect(m.getAuthedClient).not.toHaveBeenCalled();
    expect(m.buildLinkedCalendarClient).not.toHaveBeenCalled();
  });
});

function linkedRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    userId: "u1",
    provider: "GOOGLE",
    email: `${id}@work.com`,
    accessToken: "enc-at",
    refreshToken: "enc-rt",
    expiresAt: null,
    needsReconnect: false,
    ...overrides,
  };
}

describe("Google connect", () => {
  it("opens the primary calendar with the primary token's client, once", async () => {
    const session = await googleCalendarActions.connect({ userId: "u1", linkedAccountId: null });

    expect(session).not.toBeNull();
    expect(m.getAuthedClient).toHaveBeenCalledTimes(1);
    expect(m.getAuthedClient).toHaveBeenCalledWith("u1");
    expect(m.buildLinkedCalendarClient).not.toHaveBeenCalled();
  });

  it("answers null when the primary account is not connected", async () => {
    m.getAuthedClient.mockResolvedValue(null);
    expect(await googleCalendarActions.connect({ userId: "u1", linkedAccountId: null })).toBeNull();
  });

  it("opens a linked account from the row it is handed, with that account's own client and no read", async () => {
    const row = linkedRow("acct-1");
    const session = await googleCalendarActions.connect({
      userId: "u1",
      linkedAccountId: "acct-1",
      linked: row as never,
    });
    if (!session || isCalendarUnsupported(session)) throw new Error("expected a session");

    await session.listEvents({ timeMin: "2026-10-01T00:00:00Z", maxResults: 5 });

    expect(m.buildLinkedCalendarClient).toHaveBeenCalledWith("u1", row);
    expect(m.googleCalendar).toHaveBeenCalledWith({ version: "v3", auth: LINKED_AUTH });
    expect(m.getAuthedClient).not.toHaveBeenCalled();
    expect(m.linkedAccountFindFirst).not.toHaveBeenCalled();
    expect(m.linkedAccountFindMany).not.toHaveBeenCalled();
  });

  it("answers null for a linked row whose token is unusable", async () => {
    m.buildLinkedCalendarClient.mockReturnValue(null);
    expect(
      await googleCalendarActions.connect({
        userId: "u1",
        linkedAccountId: "acct-1",
        linked: linkedRow("acct-1") as never,
      }),
    ).toBeNull();
  });
});

describe("connectPrimaryCalendar", () => {
  it("returns the Google session, or null when not connected", async () => {
    const session = await connectPrimaryCalendar("u1");
    expect(session?.provider).toBe("GOOGLE");

    m.getAuthedClient.mockResolvedValue(null);
    expect(await connectPrimaryCalendar("u1")).toBeNull();
  });
});

describe("Google session — the neutral event shape", () => {
  async function session() {
    const s = await connectPrimaryCalendar("u1");
    if (!s) throw new Error("expected a session");
    return s;
  }

  it("normalises an event, leaving instants null when no timeZone was named", async () => {
    m.eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "e1",
            summary: "Planning",
            description: "",
            location: "Room 4",
            start: { dateTime: "2026-10-02T09:00:00+09:00" },
            end: { dateTime: "2026-10-02T10:00:00+09:00" },
            hangoutLink: "https://hangouts.google.com/x",
          },
        ],
      },
    });

    const [event] = await (await session()).listEvents({
      timeMin: "2026-10-01T00:00:00Z",
      maxResults: 10,
    });

    expect(event).toEqual({
      externalId: "e1",
      summary: "Planning",
      description: null,
      location: "Room 4",
      meetingLink: "https://hangouts.google.com/x",
      start: "2026-10-02T09:00:00+09:00",
      end: "2026-10-02T10:00:00+09:00",
      allDay: false,
      startTime: null,
      endTime: null,
    });
  });

  it("parses instants in the named zone and flags all-day events", async () => {
    m.eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "t",
            start: { dateTime: "2026-10-02T09:00:00" },
            end: { dateTime: "2026-10-02T10:00:00" },
          },
          { id: "d", start: { date: "2026-10-03" }, end: { date: "2026-10-04" } },
        ],
      },
    });

    const [timed, allDay] = await (await session()).listEvents({
      timeMin: "2026-10-01T00:00:00Z",
      maxResults: 10,
      timeZone: "Asia/Seoul",
    });

    expect(timed?.startTime).toEqual(new Date("2026-10-02T00:00:00.000Z"));
    expect(timed?.allDay).toBe(false);
    expect(allDay?.allDay).toBe(true);
    expect(allDay?.startTime).toEqual(new Date("2026-10-03"));
  });

  it("maps an event with no id or times to empty strings and null instants, for the caller to skip", async () => {
    m.eventsList.mockResolvedValue({ data: { items: [{ summary: "odd" }] } });

    const [event] = await (await session()).listEvents({
      timeMin: "2026-10-01T00:00:00Z",
      maxResults: 10,
      timeZone: "Asia/Seoul",
    });

    expect(event).toMatchObject({
      externalId: "",
      start: "",
      end: "",
      startTime: null,
      endTime: null,
    });
  });
});

describe("Google session — meetingLink is https only (#1348 server follow-up)", () => {
  async function linkOf(item: Record<string, unknown>) {
    m.eventsList.mockResolvedValue({ data: { items: [{ id: "e1", ...item }] } });
    const s = await connectPrimaryCalendar("u1");
    if (!s) throw new Error("expected a session");
    const [event] = await s.listEvents({ timeMin: "2026-10-01T00:00:00Z", maxResults: 10 });
    if (!event) throw new Error("expected an event");
    return event.meetingLink;
  }

  const video = (uri: unknown) => ({
    conferenceData: { entryPoints: [{ entryPointType: "video", uri }] },
  });

  it.each([
    "https://meet.google.com/abc-defg-hij",
    "https://zoom.us/j/123?pwd=x",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d",
  ])("keeps the conferenceData video uri %s", async (uri) => {
    expect(await linkOf(video(uri))).toBe(uri);
  });

  it("keeps an https hangoutLink, normalised", async () => {
    expect(await linkOf({ hangoutLink: "HTTPS://Meet.Google.com/abc-defg-hij" })).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
  });

  it.each([
    ["javascript:", "javascript:alert(document.cookie)"],
    ["http:", "http://meet.google.com/abc-defg-hij"],
    ["a custom scheme", "zoommtg://zoom.us/join?confno=1"],
    ["userinfo", "https://meet.google.com@evil.example.com/x"],
    ["over 2048 characters", `https://meet.google.com/${"a".repeat(2048)}`],
  ])("drops a conferenceData uri with %s", async (_label, uri) => {
    expect(await linkOf(video(uri))).toBeNull();
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["http:", "http://meet.google.com/abc-defg-hij"],
    ["userinfo", "https://u:p@meet.google.com/abc-defg-hij"],
  ])("drops a hangoutLink with %s", async (_label, hangoutLink) => {
    expect(await linkOf({ hangoutLink })).toBeNull();
  });

  it("falls back to a valid hangoutLink when the video uri is unsafe", async () => {
    expect(
      await linkOf({
        ...video("javascript:alert(1)"),
        hangoutLink: "https://meet.google.com/abc-defg-hij",
      }),
    ).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("prefers the video uri over the hangoutLink when both are valid (main's order)", async () => {
    expect(
      await linkOf({
        ...video("https://zoom.us/j/123?pwd=x"),
        hangoutLink: "https://meet.google.com/abc-defg-hij",
      }),
    ).toBe("https://zoom.us/j/123?pwd=x");
  });

  it("ignores a non-video entry point", async () => {
    expect(
      await linkOf({
        conferenceData: {
          entryPoints: [{ entryPointType: "phone", uri: "https://tel.example/1" }],
        },
      }),
    ).toBeNull();
  });
});

describe("listLinkedCalendarAccounts", () => {
  it("reads the user's accounts of every provider as full rows, oldest first: the one read a check pays", async () => {
    const rows = [linkedRow("acct-1")];
    m.linkedAccountFindMany.mockResolvedValue(rows);

    const accounts = await listLinkedCalendarAccounts("u1");

    expect(m.linkedAccountFindMany).toHaveBeenCalledTimes(1);
    expect(m.linkedAccountFindMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      orderBy: { createdAt: "asc" },
    });
    expect(accounts).toEqual(rows);
  });
});

describe("connectLinkedCalendars", () => {
  beforeEach(() => {
    m.buildLinkedCalendarClient.mockImplementation((_u: string, row: { id: string }) => ({
      client: { tag: row.id },
      id: row.id,
      email: `${row.id}@work.com`,
    }));
  });

  it("connects every account from the listed rows, in list order, each with its own client", async () => {
    m.linkedAccountFindMany.mockResolvedValue([linkedRow("acct-1"), linkedRow("acct-2")]);

    const connected = await connectLinkedCalendars("u1", { skipNeedsReconnect: false });

    expect(connected.map((c) => [c.id, c.email])).toEqual([
      ["acct-1", "acct-1@work.com"],
      ["acct-2", "acct-2@work.com"],
    ]);
    expect(connected.every((c) => c.session.provider === "GOOGLE")).toBe(true);
    expect(m.buildLinkedCalendarClient).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ id: "acct-1" }),
    );
    expect(m.buildLinkedCalendarClient).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ id: "acct-2" }),
    );
  });

  it("costs one read however many accounts there are: no lookup per account", async () => {
    m.linkedAccountFindMany.mockResolvedValue([
      linkedRow("acct-1"),
      linkedRow("acct-2"),
      linkedRow("acct-3"),
    ]);

    await connectLinkedCalendars("u1", { skipNeedsReconnect: false });

    expect(m.linkedAccountFindMany).toHaveBeenCalledTimes(1);
    expect(m.linkedAccountFindFirst).not.toHaveBeenCalled();
    expect(m.buildLinkedCalendarClient).toHaveBeenCalledTimes(3);
  });

  it("skips accounts flagged needsReconnect when asked to, without trying their token", async () => {
    m.linkedAccountFindMany.mockResolvedValue([
      linkedRow("acct-1"),
      linkedRow("acct-2", { needsReconnect: true }),
    ]);

    const connected = await connectLinkedCalendars("u1", { skipNeedsReconnect: true });

    expect(connected.map((c) => c.id)).toEqual(["acct-1"]);
    expect(m.buildLinkedCalendarClient).not.toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ id: "acct-2" }),
    );
  });

  it("still tries a flagged account when not asked to skip: a refresh can clear the flag", async () => {
    m.linkedAccountFindMany.mockResolvedValue([linkedRow("acct-2", { needsReconnect: true })]);

    const connected = await connectLinkedCalendars("u1", { skipNeedsReconnect: false });

    expect(connected.map((c) => c.id)).toEqual(["acct-2"]);
  });

  it("skips an account whose provider has no implementation yet, silently and without touching Google", async () => {
    m.linkedAccountFindMany.mockResolvedValue([
      linkedRow("acct-out", { provider: "OUTLOOK" }),
      linkedRow("acct-1"),
    ]);

    const connected = await connectLinkedCalendars("u1", { skipNeedsReconnect: false });

    expect(connected.map((c) => c.id)).toEqual(["acct-1"]);
    expect(m.buildLinkedCalendarClient).not.toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ id: "acct-out" }),
    );
  });

  it("skips an account whose token is unusable (connect answers null)", async () => {
    m.linkedAccountFindMany.mockResolvedValue([linkedRow("acct-1"), linkedRow("acct-bad")]);
    m.buildLinkedCalendarClient.mockImplementation((_u: string, row: { id: string }) =>
      row.id === "acct-bad"
        ? null
        : { client: { tag: row.id }, id: row.id, email: `${row.id}@work.com` },
    );

    const connected = await connectLinkedCalendars("u1", { skipNeedsReconnect: false });

    expect(connected.map((c) => c.id)).toEqual(["acct-1"]);
  });

  it("answers [] for a user with no linked accounts", async () => {
    m.linkedAccountFindMany.mockResolvedValue([]);
    expect(await connectLinkedCalendars("u1", { skipNeedsReconnect: true })).toEqual([]);
  });
});
