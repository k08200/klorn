/**
 * C2 provider seam (pim/calendar-providers/): dispatch by account provider, an
 * explicit unsupported result for every non-Google provider, and the Google
 * session's neutral event shape. The primary-calendar behaviour it wraps is
 * pinned by calendar-google-characterisation.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getAuthedClient: vi.fn(),
  getLinkedCalendarClient: vi.fn(),
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
  getLinkedCalendarClient: m.getLinkedCalendarClient,
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
  calendarActionsFor,
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
  m.getLinkedCalendarClient.mockImplementation(async (_userId: string, id: string) =>
    id === "acct-1" ? { client: LINKED_AUTH, id: "acct-1", email: "me@work.com" } : null,
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

    const result = await actions.connect({ userId: "u1", linkedAccountId: "acct-x" });

    expect(result).not.toBeNull();
    expect(isCalendarUnsupported(result)).toBe(true);
    expect(result).toEqual({
      unsupported: true,
      error: `Calendar provider ${provider} is not supported from Klorn yet.`,
    });
    expect(m.getAuthedClient).not.toHaveBeenCalled();
    expect(m.getLinkedCalendarClient).not.toHaveBeenCalled();
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
    expect(m.getLinkedCalendarClient).not.toHaveBeenCalled();
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
    m.getLinkedCalendarClient.mockResolvedValue(null);
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

describe("listLinkedCalendarAccounts", () => {
  it("lists the user's accounts of every provider with what a caller needs to decide, oldest first", async () => {
    m.linkedAccountFindMany.mockResolvedValue([
      { id: "acct-1", email: "me@work.com", provider: "GOOGLE", needsReconnect: false },
    ]);

    const accounts = await listLinkedCalendarAccounts("u1");

    expect(m.linkedAccountFindMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: { id: true, email: true, provider: true, needsReconnect: true },
      orderBy: { createdAt: "asc" },
    });
    expect(accounts).toEqual([
      { id: "acct-1", email: "me@work.com", provider: "GOOGLE", needsReconnect: false },
    ]);
  });
});

describe("connectLinkedCalendars", () => {
  const account = (id: string, provider = "GOOGLE", needsReconnect = false) => ({
    id,
    email: `${id}@work.com`,
    provider,
    needsReconnect,
  });

  beforeEach(() => {
    // The provider lookup per account, as the dispatcher does it.
    m.linkedAccountFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => {
      const found = accounts.find((a) => a.id === where.id);
      return found ? { provider: found.provider } : null;
    });
    m.getLinkedCalendarClient.mockImplementation(async (_u: string, id: string) => ({
      client: { tag: id },
      id,
      email: `${id}@work.com`,
    }));
  });

  let accounts: ReturnType<typeof account>[] = [];

  it("connects every account through the seam's dispatch, in list order, each with its own client", async () => {
    accounts = [account("acct-1"), account("acct-2")];
    m.linkedAccountFindMany.mockResolvedValue(accounts);

    const connected = await connectLinkedCalendars("u1", { skipNeedsReconnect: false });

    expect(connected.map((c) => [c.id, c.email])).toEqual([
      ["acct-1", "acct-1@work.com"],
      ["acct-2", "acct-2@work.com"],
    ]);
    expect(connected.every((c) => c.session.provider === "GOOGLE")).toBe(true);
    // Dispatch resolved each account's provider row, then Google built its client.
    expect(m.linkedAccountFindFirst).toHaveBeenCalledWith({
      where: { id: "acct-1", userId: "u1" },
      select: { provider: true },
    });
    expect(m.getLinkedCalendarClient).toHaveBeenCalledWith("u1", "acct-1");
    expect(m.getLinkedCalendarClient).toHaveBeenCalledWith("u1", "acct-2");
  });

  it("skips accounts flagged needsReconnect when asked to, without trying their token", async () => {
    accounts = [account("acct-1"), account("acct-2", "GOOGLE", true)];
    m.linkedAccountFindMany.mockResolvedValue(accounts);

    const connected = await connectLinkedCalendars("u1", { skipNeedsReconnect: true });

    expect(connected.map((c) => c.id)).toEqual(["acct-1"]);
    expect(m.getLinkedCalendarClient).not.toHaveBeenCalledWith("u1", "acct-2");
  });

  it("still tries a flagged account when not asked to skip: a refresh can clear the flag", async () => {
    accounts = [account("acct-2", "GOOGLE", true)];
    m.linkedAccountFindMany.mockResolvedValue(accounts);

    const connected = await connectLinkedCalendars("u1", { skipNeedsReconnect: false });

    expect(connected.map((c) => c.id)).toEqual(["acct-2"]);
  });

  it("skips an account whose provider has no implementation yet, silently and without touching Google", async () => {
    accounts = [account("acct-out", "OUTLOOK"), account("acct-1")];
    m.linkedAccountFindMany.mockResolvedValue(accounts);

    const connected = await connectLinkedCalendars("u1", { skipNeedsReconnect: false });

    expect(connected.map((c) => c.id)).toEqual(["acct-1"]);
    expect(m.getLinkedCalendarClient).not.toHaveBeenCalledWith("u1", "acct-out");
  });

  it("skips an account whose token is unusable (connect answers null)", async () => {
    accounts = [account("acct-1"), account("acct-bad")];
    m.linkedAccountFindMany.mockResolvedValue(accounts);
    m.getLinkedCalendarClient.mockImplementation(async (_u: string, id: string) =>
      id === "acct-bad" ? null : { client: { tag: id }, id, email: `${id}@work.com` },
    );

    const connected = await connectLinkedCalendars("u1", { skipNeedsReconnect: false });

    expect(connected.map((c) => c.id)).toEqual(["acct-1"]);
  });

  it("answers [] for a user with no linked accounts", async () => {
    accounts = [];
    m.linkedAccountFindMany.mockResolvedValue([]);
    expect(await connectLinkedCalendars("u1", { skipNeedsReconnect: true })).toEqual([]);
  });
});
