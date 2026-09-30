/**
 * C2 provider seam (pim/calendar-providers/): dispatch by account provider, an
 * explicit unsupported result for every non-Google provider, and the Google
 * session's neutral event shape. The primary-calendar behaviour it wraps is
 * pinned by calendar-google-characterisation.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getAuthedClient: vi.fn(),
  getLinkedCalendarClients: vi.fn(),
  linkedAccountFindFirst: vi.fn(),
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
  getLinkedCalendarClients: m.getLinkedCalendarClients,
}));
vi.mock("../db.js", () => {
  const prisma = { linkedCalendarAccount: { findFirst: m.linkedAccountFindFirst } };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  calendarActionsFor,
  calendarActionsForProvider,
  connectPrimaryCalendar,
} from "../pim/calendar-providers/dispatch.js";
import { googleCalendarActions } from "../pim/calendar-providers/google.js";
import { isCalendarUnsupported } from "../pim/calendar-providers/types.js";

const PRIMARY_AUTH = { tag: "primary" };
const LINKED_AUTH = { tag: "linked" };

beforeEach(() => {
  vi.clearAllMocks();
  m.getAuthedClient.mockResolvedValue(PRIMARY_AUTH);
  m.getLinkedCalendarClients.mockResolvedValue([
    { client: LINKED_AUTH, id: "acct-1", email: "me@work.com" },
  ]);
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

    const result = await actions.connect({ userId: "u1", linkedAccountId: "acct-x" });

    expect(result).not.toBeNull();
    expect(isCalendarUnsupported(result)).toBe(true);
    expect(result).toEqual({
      unsupported: true,
      error: `Calendar provider ${provider} is not supported from Klorn yet.`,
    });
    expect(m.getAuthedClient).not.toHaveBeenCalled();
    expect(m.getLinkedCalendarClients).not.toHaveBeenCalled();
  });
});

describe("calendarActionsFor", () => {
  it("resolves the primary calendar (no linked id) to Google without a database lookup", async () => {
    expect(await calendarActionsFor("u1", null)).toBe(googleCalendarActions);
    expect(await calendarActionsFor("u1", undefined)).toBe(googleCalendarActions);
    expect(await calendarActionsFor("u1", "")).toBe(googleCalendarActions);
    expect(m.linkedAccountFindFirst).not.toHaveBeenCalled();
  });

  it("dispatches a linked account on its provider column, scoped to the user", async () => {
    m.linkedAccountFindFirst.mockResolvedValue({ provider: "OUTLOOK" });

    const actions = await calendarActionsFor("u1", "acct-9");

    expect(actions.provider).toBe("OUTLOOK");
    expect(m.linkedAccountFindFirst).toHaveBeenCalledWith({
      where: { id: "acct-9", userId: "u1" },
      select: { provider: true },
    });
  });

  it("resolves a stale or foreign id to Google, whose connect then answers not-connected", async () => {
    m.linkedAccountFindFirst.mockResolvedValue(null);

    const actions = await calendarActionsFor("u1", "gone");

    expect(actions).toBe(googleCalendarActions);
    expect(await actions.connect({ userId: "u1", linkedAccountId: "gone" })).toBeNull();
  });
});

describe("Google connect", () => {
  it("opens the primary calendar with the primary token's client, once", async () => {
    const session = await googleCalendarActions.connect({ userId: "u1", linkedAccountId: null });

    expect(session).not.toBeNull();
    expect(m.getAuthedClient).toHaveBeenCalledTimes(1);
    expect(m.getAuthedClient).toHaveBeenCalledWith("u1");
    expect(m.getLinkedCalendarClients).not.toHaveBeenCalled();
  });

  it("answers null when the primary account is not connected", async () => {
    m.getAuthedClient.mockResolvedValue(null);
    expect(await googleCalendarActions.connect({ userId: "u1", linkedAccountId: null })).toBeNull();
  });

  it("opens a linked account with that account's own client", async () => {
    const session = await googleCalendarActions.connect({
      userId: "u1",
      linkedAccountId: "acct-1",
    });
    if (!session || isCalendarUnsupported(session)) throw new Error("expected a session");

    await session.listEvents({ timeMin: "2026-10-01T00:00:00Z", maxResults: 5 });

    expect(m.googleCalendar).toHaveBeenCalledWith({ version: "v3", auth: LINKED_AUTH });
    expect(m.getAuthedClient).not.toHaveBeenCalled();
  });

  it("answers null for a linked id the user does not have, or whose token is unusable", async () => {
    expect(
      await googleCalendarActions.connect({ userId: "u1", linkedAccountId: "someone-elses" }),
    ).toBeNull();
    m.getLinkedCalendarClients.mockResolvedValue([]);
    expect(
      await googleCalendarActions.connect({ userId: "u1", linkedAccountId: "acct-1" }),
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
