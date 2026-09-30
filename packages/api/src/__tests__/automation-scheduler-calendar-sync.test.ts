/**
 * The scheduler's calendar step (every 15 minutes per user), driven through one
 * real tick of `startAutomationScheduler`. Characterises the PRIMARY calendar
 * sync — the exact Google request, the row mapping and the failure handling —
 * so the step C2 refactor (provider seam) and the linked-account sync (behind
 * LINKED_CALENDAR_SYNC_ENABLED) are provably additive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetCancelledScanStateForTests } from "../pim/calendar-cancellation.js";

const m = vi.hoisted(() => ({
  eventsList: vi.fn(),
  cancelledList: vi.fn(),
  googleCalendar: vi.fn(),
  getAuthedClient: vi.fn(),
  buildLinkedCalendarClient: vi.fn(),
  isEntitled: vi.fn((_plan: string, _role?: string) => true),
  captureError: vi.fn(),
  overrides: new Map<string, (...args: unknown[]) => unknown>(),
  calls: [] as string[],
}));

vi.mock("googleapis", () => ({
  google: {
    calendar: m.googleCalendar.mockImplementation(() => ({
      // The cancellation scan (C2b) is a second events.list; it gets its own mock so
      // every assertion on `eventsList` below stays about the sync's own listing.
      events: {
        list: (args: { showDeleted?: boolean }) =>
          args.showDeleted
            ? (m.cancelledList(args) ?? { data: { items: [] } })
            : m.eventsList(args),
      },
    })),
  },
}));

vi.mock("../mail/gmail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mail/gmail.js")>()),
  getAuthedClient: m.getAuthedClient,
  buildLinkedCalendarClient: m.buildLinkedCalendarClient,
  getLinkedInboxClients: vi.fn(async () => []),
  renewExpiringGmailWatches: vi.fn(async () => ({ renewed: 0, failed: 0 })),
}));

vi.mock("../sentry.js", () => ({ captureError: m.captureError, initSentry: vi.fn() }));

vi.mock("../billing/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/stripe.js")>()),
  isEntitled: m.isEntitled,
}));

// Fire-and-forget jobs a tick launches; none of them is under test and several
// would reach the network.
vi.mock("../pim/daily-digest.js", () => ({ sendDailyDigests: vi.fn(async () => {}) }));
vi.mock("../pim/weekly-report.js", () => ({ sendWeeklySignalReports: vi.fn(async () => {}) }));
vi.mock("../llm/openrouter-catalog-check.js", () => ({
  runOpenRouterCatalogCheck: vi.fn(async () => {}),
}));
vi.mock("../llm/openrouter-key-health.js", () => ({
  runOpenRouterKeyCheck: vi.fn(async () => {}),
}));
vi.mock("../judge/calibration-snapshot.js", () => ({
  runDailyCalibrationSnapshots: vi.fn(async () => {}),
}));
vi.mock("../learning/ontology-proposals-store.js", () => ({
  recomputeOntologyProposalsSafe: vi.fn(async () => {}),
}));
vi.mock("../judge/judge-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../judge/judge-health.js")>()),
  runJudgeHeartbeatCheck: vi.fn(async () => {}),
}));

/** A prisma whose every table method resolves to a harmless empty value. */
vi.mock("../db.js", () => {
  const EMPTY: Record<string, unknown> = {
    findMany: [],
    findFirst: null,
    findUnique: null,
    count: 0,
    groupBy: [],
    deleteMany: { count: 0 },
    updateMany: { count: 0 },
  };
  const tables = new Map<string, Record<string, unknown>>();
  const table = (name: string) => {
    const cached = tables.get(name);
    if (cached) return cached;
    const made = new Proxy(
      {},
      {
        get: (_target, method: string) => {
          const key = `${name}.${method}`;
          return (...args: unknown[]) => {
            m.calls.push(key);
            const override = m.overrides.get(key);
            if (override) return Promise.resolve(override(...args));
            return Promise.resolve(method in EMPTY ? EMPTY[method] : {});
          };
        },
      },
    );
    tables.set(name, made as Record<string, unknown>);
    return made;
  };
  const prisma = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name === "$queryRawUnsafe") {
          return (sql: string) => {
            m.calls.push(`$queryRawUnsafe:${sql.includes("unlock") ? "unlock" : "lock"}`);
            return Promise.resolve([{ locked: true, unlocked: true }]);
          };
        }
        if (name === "$queryRaw") return () => Promise.resolve([]);
        if (name === "$transaction") {
          return (arg: unknown) =>
            typeof arg === "function"
              ? (arg as (tx: unknown) => unknown)(prisma)
              : Promise.all(arg as unknown[]);
        }
        return table(name);
      },
    },
  );
  return { prisma, db: prisma };
});

const USER = "user-1";
const NOW = new Date("2026-09-30T03:00:00.000Z"); // a Wednesday: no weekly jobs
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH = { tag: "primary-auth-client" };

function override(key: string, fn: (...args: unknown[]) => unknown) {
  m.overrides.set(key, fn);
}

type LinkedFixture = {
  client: unknown;
  id: string;
  email: string;
  needsReconnect?: boolean;
};

/** The linked accounts the seam lists, and the client each one resolves to. */
function setLinkedAccounts(accounts: LinkedFixture[]) {
  override("linkedCalendarAccount.findMany", () =>
    accounts.map((a) => ({
      id: a.id,
      email: a.email,
      provider: "GOOGLE",
      needsReconnect: a.needsReconnect ?? false,
    })),
  );
  m.buildLinkedCalendarClient.mockImplementation((_userId: string, row: { id: string }) => {
    const account = accounts.find((a) => a.id === row.id);
    return account ? { client: account.client, id: row.id, email: account.email } : null;
  });
}

function callsTo(key: string) {
  return m.calls.filter((c) => c === key).length;
}

/** Run exactly one scheduler tick and wait for it to release its lock. */
async function runOneTick() {
  vi.resetModules();
  const scheduler = await import("../automation-scheduler.js");
  scheduler.startAutomationScheduler();
  await untilTickEnds();
  scheduler.stopAutomationScheduler();
}

/**
 * Polls with the real setTimeout. `vi.waitFor` would advance the faked clock by
 * its poll interval under fake timers and shift every timestamp asserted here.
 */
async function untilTickEnds(timeoutMs = 4000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!m.calls.includes("$queryRawUnsafe:unlock")) {
    if (performance.now() > deadline) throw new Error("scheduler tick did not finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function eventUpserts(): Array<{
  where: unknown;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}> {
  return (upsertArgs as unknown[]).map(
    (a) =>
      a as { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> },
  );
}

let upsertArgs: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  _resetCancelledScanStateForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  m.overrides.clear();
  m.calls.length = 0;
  upsertArgs = [];
  m.getAuthedClient.mockResolvedValue(AUTH);
  setLinkedAccounts([]);
  m.isEntitled.mockReturnValue(true);
  m.eventsList.mockResolvedValue({ data: { items: [] } });
  override("automationConfig.findMany", () => [
    {
      userId: USER,
      dailyBriefing: false,
      emailAutoClassify: false,
      autonomousAgent: false,
      proactiveActions: false,
      phoneEscalationEnabled: false,
      focusWindowEnabled: false,
      attentionMode: "SUGGEST",
      timezone: "Asia/Seoul",
    },
  ]);
  override("user.findMany", () => [{ id: USER, plan: "PRO", role: "USER" }]);
  override("userToken.findMany", () => [{ userId: USER }]);
  override("user.findUnique", () => ({ id: USER, timezone: "Asia/Seoul" }));
  override("calendarEvent.upsert", (arg) => {
    upsertArgs.push(arg);
    return {};
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scheduler calendar step — primary calendar", () => {
  it("asks Google for the next 30 days of the primary calendar, capped at 100, in the user's zone", async () => {
    await runOneTick();

    expect(m.getAuthedClient).toHaveBeenCalledWith(USER);
    expect(m.googleCalendar).toHaveBeenCalledWith({ version: "v3", auth: AUTH });
    expect(m.eventsList).toHaveBeenCalledTimes(1);
    expect(m.eventsList).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: NOW.toISOString(),
      timeMax: new Date(NOW.getTime() + THIRTY_DAYS_MS).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 100,
      timeZone: "Asia/Seoul",
    });
  });

  it("also asks Google, in a second call, what was cancelled in that window in the last 7 days (C2b)", async () => {
    await runOneTick();

    expect(m.cancelledList).toHaveBeenCalledTimes(1);
    expect(m.cancelledList).toHaveBeenCalledWith({
      calendarId: "primary",
      timeMin: NOW.toISOString(),
      timeMax: new Date(NOW.getTime() + THIRTY_DAYS_MS).toISOString(),
      updatedMin: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      singleEvents: true,
      showDeleted: true,
      maxResults: 250,
      fields: "nextPageToken,items(id,status)",
    });
  });

  it("a failing cancellation call never fails the tick: the events are still upserted, no disconnect alert (C2b)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    m.eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "g-1",
            summary: "Kickoff",
            start: { dateTime: "2026-10-02T09:00:00+09:00" },
            end: { dateTime: "2026-10-02T10:00:00+09:00" },
          },
        ],
      },
    });
    m.cancelledList.mockRejectedValue(new Error("quota"));

    await runOneTick();

    expect(eventUpserts()).toHaveLength(1);
    expect(callsTo("notification.create")).toBe(0);
    expect(m.captureError).not.toHaveBeenCalled();
  });

  it("upserts each event by (userId, googleId) with the mapped fields", async () => {
    m.eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "g-timed",
            summary: "Planning",
            description: "Agenda",
            location: "Room 4",
            start: { dateTime: "2026-10-02T09:00:00+09:00" },
            end: { dateTime: "2026-10-02T10:00:00+09:00" },
            conferenceData: {
              entryPoints: [
                { entryPointType: "phone", uri: "tel:123" },
                { entryPointType: "video", uri: "https://meet.google.com/abc" },
              ],
            },
          },
          {
            id: "g-allday",
            start: { date: "2026-10-03" },
            end: { date: "2026-10-04" },
            hangoutLink: "https://hangouts.google.com/xyz",
          },
          { summary: "no id", start: { date: "2026-10-05" }, end: { date: "2026-10-06" } },
          { id: "g-no-times", start: {}, end: {} },
        ],
      },
    });

    await runOneTick();

    const rows = eventUpserts();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.where).toEqual({ userId_googleId: { userId: USER, googleId: "g-timed" } });
    expect(rows[0]?.create).toEqual({
      userId: USER,
      googleId: "g-timed",
      provider: "GOOGLE",
      externalId: "g-timed",
      sourceAccountId: null,
      sourceKey: "primary",
      title: "Planning",
      description: "Agenda",
      location: "Room 4",
      meetingLink: "https://meet.google.com/abc",
      allDay: false,
      startTime: new Date("2026-10-02T00:00:00.000Z"),
      endTime: new Date("2026-10-02T01:00:00.000Z"),
    });
    expect(rows[1]?.create).toEqual({
      userId: USER,
      googleId: "g-allday",
      provider: "GOOGLE",
      externalId: "g-allday",
      sourceAccountId: null,
      sourceKey: "primary",
      title: "Untitled",
      description: null,
      location: null,
      meetingLink: "https://hangouts.google.com/xyz",
      allDay: true,
      startTime: new Date("2026-10-03"),
      endTime: new Date("2026-10-04"),
    });
    // The update path never touches googleId and re-stamps provider/externalId.
    expect(rows[0]?.update).not.toHaveProperty("googleId");
    expect(rows[0]?.update).toMatchObject({ provider: "GOOGLE", externalId: "g-timed" });
  });

  it("reads a naive timed value in the user's timezone, not the server's", async () => {
    m.eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "g-naive",
            summary: "Naive",
            start: { dateTime: "2026-10-02T09:00:00" },
            end: { dateTime: "2026-10-02T10:00:00" },
          },
        ],
      },
    });

    await runOneTick();

    expect(eventUpserts()[0]?.create).toMatchObject({
      startTime: new Date("2026-10-02T00:00:00.000Z"),
      endTime: new Date("2026-10-02T01:00:00.000Z"),
    });
  });

  it("does not sync a user who never connected Google, and never asks for a client", async () => {
    override("userToken.findMany", () => []);
    await runOneTick();
    expect(m.getAuthedClient).not.toHaveBeenCalled();
    expect(m.googleCalendar).not.toHaveBeenCalled();
    expect(upsertArgs).toHaveLength(0);
  });

  it("skips quietly when the token cannot produce a client", async () => {
    m.getAuthedClient.mockResolvedValue(null);
    await runOneTick();
    expect(m.googleCalendar).not.toHaveBeenCalled();
    expect(upsertArgs).toHaveLength(0);
    expect(callsTo("notification.create")).toBe(0);
  });

  it("alerts once per day (winner-only notification) on a 401 and writes nothing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.eventsList.mockRejectedValue({
      response: { status: 401, data: { error: { message: "x" } } },
    });

    await runOneTick();

    expect(upsertArgs).toHaveLength(0);
    expect(callsTo("notification.create")).toBe(1);
    errSpy.mockRestore();
  });

  it("logs but does not alert on a transient failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.eventsList.mockRejectedValue({ response: { status: 500 }, message: "backend down" });

    await runOneTick();

    expect(callsTo("notification.create")).toBe(0);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("does not look at linked calendar accounts at all (today's behaviour)", async () => {
    await runOneTick();
    expect(m.buildLinkedCalendarClient).not.toHaveBeenCalled();
    expect(callsTo("linkedCalendarAccount.findMany")).toBe(0);
  });
});

describe("scheduler calendar step — linked calendars (LINKED_CALENDAR_SYNC_ENABLED)", () => {
  const KEY = "LINKED_CALENDAR_SYNC_ENABLED";
  const original = process.env[KEY];
  const WORK = { client: { tag: "work-client" }, id: "acct-work", email: "me@work.com" };

  function timed(id: string) {
    return {
      id,
      summary: id,
      start: { dateTime: "2026-10-02T09:00:00+09:00" },
      end: { dateTime: "2026-10-02T10:00:00+09:00" },
    };
  }

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  describe.each([
    ["unset", undefined],
    ["false", "false"],
    ["0", "0"],
    ["a typo", "truee"],
  ])("flag %s (off)", (_label, value) => {
    beforeEach(() => {
      if (value === undefined) delete process.env[KEY];
      else process.env[KEY] = value;
      setLinkedAccounts([WORK]);
    });

    it("behaves exactly as before: one Google call, primary rows only, linked accounts never looked up", async () => {
      m.eventsList.mockResolvedValue({ data: { items: [timed("g-primary")] } });

      await runOneTick();

      expect(m.buildLinkedCalendarClient).not.toHaveBeenCalled();
      expect(callsTo("linkedCalendarAccount.findMany")).toBe(0);
      expect(callsTo("linkedCalendarAccount.findFirst")).toBe(0);
      expect(m.getAuthedClient).toHaveBeenCalledTimes(1);
      // One API object for the listing, one for the cancellation scan (C2b).
      expect(m.googleCalendar).toHaveBeenCalledTimes(2);
      expect(m.googleCalendar).toHaveBeenCalledWith({ version: "v3", auth: AUTH });
      expect(m.eventsList).toHaveBeenCalledTimes(1);
      expect(callsTo("user.findUnique")).toBe(1);
      const rows = eventUpserts();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.create).toMatchObject({ googleId: "g-primary", sourceAccountId: null });
    });
  });

  describe("flag on", () => {
    beforeEach(() => {
      process.env[KEY] = "true";
      setLinkedAccounts([WORK]);
    });

    it("syncs the primary calendar first, then each linked account with its own client", async () => {
      m.eventsList
        .mockResolvedValueOnce({ data: { items: [timed("g-primary")] } })
        .mockResolvedValueOnce({ data: { items: [timed("g-linked")] } });

      await runOneTick();

      // Each account builds one API object for its listing and one for its cancellation scan.
      expect(m.googleCalendar.mock.calls.map((c) => (c[0] as { auth: unknown }).auth)).toEqual([
        AUTH,
        AUTH,
        WORK.client,
        WORK.client,
      ]);
      const rows = eventUpserts();
      expect(rows).toHaveLength(2);
      expect(rows[0]?.where).toEqual({ userId_googleId: { userId: USER, googleId: "g-primary" } });
      expect(rows[1]?.where).toEqual({
        userId_provider_sourceKey_externalId: {
          userId: USER,
          provider: "GOOGLE",
          sourceKey: "acct-work",
          externalId: "g-linked",
        },
      });
      expect(rows[1]?.create).toMatchObject({
        provider: "GOOGLE",
        externalId: "g-linked",
        sourceAccountId: "acct-work",
        sourceKey: "acct-work",
      });
    });

    it("uses the same window and caps for the linked calendar as for the primary one", async () => {
      await runOneTick();

      const [primary, linked] = m.eventsList.mock.calls.map((c) => c[0] as Record<string, unknown>);
      expect(linked).toEqual(primary);
      expect(linked).toMatchObject({ maxResults: 100, calendarId: "primary" });
    });

    it("still syncs linked calendars when the primary sync fails, and alerts once for the primary only", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      m.eventsList
        .mockRejectedValueOnce({ response: { status: 401 } })
        .mockResolvedValueOnce({ data: { items: [timed("g-linked")] } });

      await runOneTick();

      expect(eventUpserts().map((u) => u.create.sourceAccountId)).toEqual(["acct-work"]);
      expect(callsTo("notification.create")).toBe(1);
      errSpy.mockRestore();
    });

    it("a failing linked account never raises the Google-disconnected alert", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      m.eventsList
        .mockResolvedValueOnce({ data: { items: [timed("g-primary")] } })
        .mockRejectedValueOnce({ response: { status: 401 } });

      await runOneTick();

      expect(eventUpserts().map((u) => u.create.sourceAccountId)).toEqual([null]);
      expect(callsTo("notification.create")).toBe(0);
      warn.mockRestore();
    });

    it("an unexpected linked-sync error is contained: the tick still completes", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      override("linkedCalendarAccount.findMany", () => {
        throw new Error("decrypt blew up");
      });
      m.eventsList.mockResolvedValue({ data: { items: [timed("g-primary")] } });

      await runOneTick();

      expect(eventUpserts()).toHaveLength(1);
      expect(m.calls).toContain("$queryRawUnsafe:unlock");
      warn.mockRestore();
    });

    it("does nothing extra for a user with no linked accounts", async () => {
      setLinkedAccounts([]);

      await runOneTick();

      expect(m.eventsList).toHaveBeenCalledTimes(1);
      expect(callsTo("user.findUnique")).toBe(1);
    });

    it("reads the linked accounts once per cycle and looks nothing else up per account", async () => {
      setLinkedAccounts([WORK, { ...WORK, id: "acct-school", email: "me@school.edu" }]);

      await runOneTick();

      expect(callsTo("linkedCalendarAccount.findMany")).toBe(1);
      expect(callsTo("linkedCalendarAccount.findFirst")).toBe(0);
      expect(m.buildLinkedCalendarClient).toHaveBeenCalledTimes(2);
    });

    it("skips an account flagged needsReconnect until it is re-linked", async () => {
      setLinkedAccounts([{ ...WORK, needsReconnect: true }]);

      await runOneTick();

      expect(m.eventsList).toHaveBeenCalledTimes(1);
      expect(m.buildLinkedCalendarClient).not.toHaveBeenCalled();
    });

    it("never sends a revoked linked account's auth error to Sentry", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      m.eventsList
        .mockResolvedValueOnce({ data: { items: [] } })
        .mockRejectedValueOnce({ response: { status: 401 } });

      await runOneTick();

      expect(m.captureError).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    describe("entitlement", () => {
      it("syncs linked calendars for an entitled user, asking with the user's plan and role", async () => {
        await runOneTick();

        expect(m.isEntitled).toHaveBeenCalledWith("PRO", "USER");
        expect(m.eventsList).toHaveBeenCalledTimes(2);
      });

      it("does not sync linked calendars for a lapsed user (exactly like linking): primary still syncs, nothing linked is looked up", async () => {
        m.isEntitled.mockReturnValue(false);
        m.eventsList.mockResolvedValue({ data: { items: [timed("g-primary")] } });

        await runOneTick();

        expect(m.eventsList).toHaveBeenCalledTimes(1);
        expect(eventUpserts().map((u) => u.create.sourceAccountId)).toEqual([null]);
        expect(m.buildLinkedCalendarClient).not.toHaveBeenCalled();
        expect(callsTo("linkedCalendarAccount.findMany")).toBe(0);
      });
    });
  });
});
