/**
 * C4: linked OUTLOOK calendar accounts are synced into CalendarEvent rows by the
 * C2 loop, through the provider seam. Rows are provider OUTLOOK, externalId =
 * the Graph event id, sourceKey = the account id, over the same 30-day window and
 * 100-event cap as Google. Flag, entitlement and needsReconnect handling are the
 * loop's own (calendar-linked-sync.test.ts covers them for Google).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  fetch: vi.fn(),
  eventsList: vi.fn(),
  linkedRows: [] as Array<Record<string, unknown>>,
  markLinkedCalendarForReconnect: vi.fn(async () => {}),
  userFindUnique: vi.fn(),
  eventUpsert: vi.fn(async () => ({})),
  accountUpdateMany: vi.fn(async () => ({ count: 1 })),
  refreshOutlookTokens: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: { calendar: vi.fn(() => ({ events: { list: m.eventsList } })) },
}));
vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(async () => ({})),
  buildLinkedCalendarClient: (_u: string, row: { id: string; email: string }) => ({
    client: {},
    id: row.id,
    email: row.email,
  }),
  markLinkedCalendarForReconnect: m.markLinkedCalendarForReconnect,
}));
vi.mock("../crypto-tokens.js", () => ({
  decryptToken: (t: string) => t.replace(/^enc:/, ""),
  decryptOptional: (t: string | null | undefined) => (t ? t.replace(/^enc:/, "") : null),
  encryptToken: (t: string) => `enc:${t}`,
  encryptOptional: (t: string | null | undefined) => (t ? `enc:${t}` : null),
}));
vi.mock("../mail/outlook-oauth.js", () => ({ refreshOutlookTokens: m.refreshOutlookTokens }));
vi.mock("../db.js", () => {
  const prisma = {
    user: { findUnique: m.userFindUnique },
    calendarEvent: { upsert: m.eventUpsert },
    linkedCalendarAccount: {
      findMany: vi.fn(async () => m.linkedRows),
      updateMany: m.accountUpdateMany,
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));

import { syncLinkedCalendars } from "../pim/calendar-sync.js";
import { _resetLinkedCalendarFailureLogForTests } from "../pim/linked-calendar-failure.js";

const NOW = new Date("2026-09-30T05:00:00.000Z");
const GRAPH = "https://graph.microsoft.com/v1.0";
const KEYS = ["OUTLOOK_CALENDAR_ENABLED", "OUTLOOK_INBOX_ENABLED"] as const;
const saved: Record<string, string | undefined> = {};

function outlookRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    userId: "u1",
    provider: "OUTLOOK",
    email: `${id}@contoso.com`,
    accessToken: `enc:at-${id}`,
    refreshToken: `enc:rt-${id}`,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    needsReconnect: false,
    ...overrides,
  };
}
function googleRow(id: string) {
  return { ...outlookRow(id), provider: "GOOGLE" };
}

function graphEvent(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    subject: "Planning",
    bodyPreview: "",
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    start: { dateTime: "2026-10-02T09:00:00.0000000", timeZone: "Asia/Seoul" },
    end: { dateTime: "2026-10-02T10:00:00.0000000", timeZone: "Asia/Seoul" },
    location: null,
    onlineMeeting: null,
    onlineMeetingUrl: null,
    ...extra,
  };
}
function page(events: unknown[]): Response {
  return new Response(JSON.stringify({ value: events }), { status: 200 });
}

type UpsertArg = {
  where: { userId_provider_sourceKey_externalId: Record<string, string> };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};
function upserts(): UpsertArg[] {
  return m.eventUpsert.mock.calls.map((c) => (c as unknown[])[0] as UpsertArg);
}
function fetchUrls(): string[] {
  return m.fetch.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetLinkedCalendarFailureLogForTests();
  for (const k of KEYS) {
    saved[k] = process.env[k];
    process.env[k] = "true";
  }
  vi.stubGlobal("fetch", m.fetch);
  m.fetch.mockReset();
  m.fetch.mockResolvedValue(page([graphEvent("AAMk-1")]));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  m.linkedRows = [outlookRow("acct-out")];
  m.userFindUnique.mockResolvedValue({ id: "u1", timezone: "Asia/Seoul" });
  m.eventsList.mockResolvedValue({ data: { items: [] } });
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("flags", () => {
  it.each([
    ["both off", undefined, undefined],
    ["only the calendar flag", "true", undefined],
    ["only the inbox flag", undefined, "true"],
  ])("%s: an OUTLOOK account is skipped, with no Graph call and no row", async (_l, calendar, inbox) => {
    if (calendar === undefined) delete process.env.OUTLOOK_CALENDAR_ENABLED;
    else process.env.OUTLOOK_CALENDAR_ENABLED = calendar;
    if (inbox === undefined) delete process.env.OUTLOOK_INBOX_ENABLED;
    else process.env.OUTLOOK_INBOX_ENABLED = inbox;

    const result = await syncLinkedCalendars("u1", NOW);

    expect(result).toEqual({ accounts: 0, events: 0, failedAccounts: 0 });
    expect(m.fetch).not.toHaveBeenCalled();
    expect(m.eventUpsert).not.toHaveBeenCalled();
    expect(m.userFindUnique).not.toHaveBeenCalled();
  });
});

describe("syncing an OUTLOOK account", () => {
  it("lists the account's calendar over the same window, cap and zone as the Google sync", async () => {
    await syncLinkedCalendars("u1", NOW);

    expect(m.fetch).toHaveBeenCalledTimes(1);
    const url = new URL(fetchUrls()[0] as string);
    expect(url.origin + url.pathname).toBe(`${GRAPH}/me/calendarView`);
    expect(url.searchParams.get("startDateTime")).toBe("2026-09-30T05:00:00.000Z");
    expect(url.searchParams.get("endDateTime")).toBe("2026-10-30T05:00:00.000Z");
    expect(url.searchParams.get("$top")).toBe("100");
    const init = m.fetch.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer at-acct-out");
    expect(init.headers.Prefer).toContain('outlook.timezone="Asia/Seoul"');
  });

  it("writes OUTLOOK rows tagged with the account, keyed per source, with no googleId", async () => {
    const result = await syncLinkedCalendars("u1", NOW);

    expect(result).toEqual({ accounts: 1, events: 1, failedAccounts: 0 });
    const [row] = upserts();
    expect(row?.where).toEqual({
      userId_provider_sourceKey_externalId: {
        userId: "u1",
        provider: "OUTLOOK",
        sourceKey: "acct-out",
        externalId: "AAMk-1",
      },
    });
    expect(row?.create).toMatchObject({
      userId: "u1",
      provider: "OUTLOOK",
      externalId: "AAMk-1",
      sourceAccountId: "acct-out",
      sourceKey: "acct-out",
      title: "Planning",
      allDay: false,
      startTime: new Date("2026-10-02T00:00:00.000Z"),
      endTime: new Date("2026-10-02T01:00:00.000Z"),
    });
    expect(row?.create).not.toHaveProperty("googleId");
  });

  it("does not write a cancelled event, and stores an all-day event as all-day", async () => {
    m.fetch.mockResolvedValue(
      page([
        graphEvent("gone", { isCancelled: true }),
        graphEvent("holiday", {
          isAllDay: true,
          subject: "Holiday",
          start: { dateTime: "2026-10-05T00:00:00.0000000", timeZone: "Asia/Seoul" },
          end: { dateTime: "2026-10-06T00:00:00.0000000", timeZone: "Asia/Seoul" },
        }),
      ]),
    );

    await syncLinkedCalendars("u1", NOW);

    expect(upserts().map((u) => u.create.externalId)).toEqual(["holiday"]);
    expect(upserts()[0]?.create).toMatchObject({
      allDay: true,
      startTime: new Date("2026-10-05"),
      endTime: new Date("2026-10-06"),
    });
  });

  it("skips an event with no id or no usable times, like the Google sync", async () => {
    m.fetch.mockResolvedValue(page([{ subject: "no id" }, graphEvent("ok")]));

    await syncLinkedCalendars("u1", NOW);

    expect(upserts().map((u) => u.create.externalId)).toEqual(["ok"]);
  });

  it("leaves an account flagged needsReconnect alone until it is re-linked", async () => {
    m.linkedRows = [outlookRow("acct-out", { needsReconnect: true }), outlookRow("acct-2")];

    const result = await syncLinkedCalendars("u1", NOW);

    expect(result.accounts).toBe(1);
    expect(
      (m.fetch.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers.Authorization,
    ).toBe("Bearer at-acct-2");
    expect(m.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("two providers are never merged", () => {
  it("a Google and an Outlook event with the same id are two rows, one per provider", async () => {
    m.linkedRows = [googleRow("acct-g"), outlookRow("acct-out")];
    m.eventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: "shared-id",
            summary: "Invite",
            start: { dateTime: "2026-10-02T09:00:00+09:00" },
            end: { dateTime: "2026-10-02T10:00:00+09:00" },
          },
        ],
      },
    });
    m.fetch.mockResolvedValue(page([graphEvent("shared-id", { subject: "Invite" })]));

    await syncLinkedCalendars("u1", NOW);

    const keys = upserts().map((u) => u.where.userId_provider_sourceKey_externalId);
    expect(keys).toEqual([
      { userId: "u1", provider: "GOOGLE", sourceKey: "acct-g", externalId: "shared-id" },
      { userId: "u1", provider: "OUTLOOK", sourceKey: "acct-out", externalId: "shared-id" },
    ]);
  });

  it("two Outlook accounts with the same event id keep one row each", async () => {
    m.linkedRows = [outlookRow("acct-a"), outlookRow("acct-b")];
    m.fetch.mockImplementation(async () => page([graphEvent("same")]));

    await syncLinkedCalendars("u1", NOW);

    expect(upserts().map((u) => u.where.userId_provider_sourceKey_externalId.sourceKey)).toEqual([
      "acct-a",
      "acct-b",
    ]);
  });
});

describe("failures", () => {
  it("a 401 flags the account for reconnect, warns once per window, and never reaches Sentry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.fetch.mockImplementation(async () => new Response("{}", { status: 401 }));

    const first = await syncLinkedCalendars("u1", NOW);
    await syncLinkedCalendars("u1", NOW);
    await syncLinkedCalendars("u1", NOW);

    expect(first.failedAccounts).toBe(1);
    expect(m.markLinkedCalendarForReconnect).toHaveBeenCalledWith("u1", "acct-out");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(m.captureError).not.toHaveBeenCalled();
    expect(m.eventUpsert).not.toHaveBeenCalled();
  });

  it("a revoked refresh grant (invalid_grant) is handled the same way: flagged, throttled warn, no Sentry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.linkedRows = [outlookRow("acct-out", { expiresAt: new Date(Date.now() - 1000) })];
    m.refreshOutlookTokens.mockResolvedValue({ error: "invalid_grant" });

    await syncLinkedCalendars("u1", NOW);
    await syncLinkedCalendars("u1", NOW);

    expect(m.markLinkedCalendarForReconnect).toHaveBeenCalledWith("u1", "acct-out");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(m.captureError).not.toHaveBeenCalled();
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("a server error is captured with the domain only, does not flag the account, and never sinks the others", async () => {
    m.linkedRows = [outlookRow("acct-bad"), outlookRow("acct-good")];
    m.fetch
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(page([graphEvent("ok")]));

    const result = await syncLinkedCalendars("u1", NOW);

    expect(result).toEqual({ accounts: 2, events: 1, failedAccounts: 1 });
    expect(m.markLinkedCalendarForReconnect).not.toHaveBeenCalled();
    expect(upserts().map((u) => u.create.sourceAccountId)).toEqual(["acct-good"]);
    const captured = m.captureError.mock.calls[0]?.[1] as {
      tags: { scope: string };
      extra: Record<string, unknown>;
    };
    expect(captured.tags.scope).toBe("calendar.linked_sync_failed");
    expect(captured.extra).toMatchObject({ userId: "u1", accountDomain: "contoso.com" });
    expect(JSON.stringify(captured)).not.toContain("acct-bad@contoso.com");
  });

  it("a refresh that fails for a reason other than a revoked grant is captured, not flagged", async () => {
    m.linkedRows = [outlookRow("acct-out", { expiresAt: new Date(Date.now() - 1000) })];
    m.refreshOutlookTokens.mockResolvedValue({ error: "server_error" });

    const result = await syncLinkedCalendars("u1", NOW);

    expect(result.failedAccounts).toBe(1);
    expect(m.markLinkedCalendarForReconnect).not.toHaveBeenCalled();
    expect(m.captureError).toHaveBeenCalledTimes(1);
  });

  it("an account whose token cannot be decrypted is skipped and flagged, not counted", async () => {
    m.linkedRows = [outlookRow("acct-out", { accessToken: null, refreshToken: null })];

    const result = await syncLinkedCalendars("u1", NOW);

    expect(result).toEqual({ accounts: 0, events: 0, failedAccounts: 0 });
    expect(m.markLinkedCalendarForReconnect).toHaveBeenCalledWith("u1", "acct-out");
    expect(m.fetch).not.toHaveBeenCalled();
  });

  it("an account unlinked mid-sync (foreign key, P2003) is skipped quietly", async () => {
    m.eventUpsert.mockRejectedValueOnce({ code: "P2003" });

    const result = await syncLinkedCalendars("u1", NOW);

    expect(result).toEqual({ accounts: 1, events: 0, failedAccounts: 0 });
    expect(m.captureError).not.toHaveBeenCalled();
  });
});
