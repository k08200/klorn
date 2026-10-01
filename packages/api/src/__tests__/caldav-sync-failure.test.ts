/**
 * C3: a CalDAV account in the C2 linked-sync loop, through the real dispatcher and
 * the shared failure policy. A 401 (the app-specific password was revoked) flags
 * the account for reconnect and stays out of Sentry; any other failure is captured
 * with the domain only and leaves the account alone; a flagged account is skipped
 * until it is re-linked. Only the network edge is faked: the default transport and
 * the DNS resolver.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  transport: vi.fn(),
  findMany: vi.fn(),
  markReconnect: vi.fn(async () => {}),
  captureError: vi.fn(),
}));

vi.mock("googleapis", () => ({ google: { calendar: vi.fn(() => ({})) } }));
vi.mock("../mail/gmail.js", () => ({
  getAuthedClient: vi.fn(),
  buildLinkedCalendarClient: vi.fn(),
  markLinkedCalendarForReconnect: m.markReconnect,
}));
vi.mock("../db.js", () => {
  const prisma = {
    linkedCalendarAccount: { findMany: m.findMany },
    automationConfig: { findUnique: vi.fn(async () => ({ timezone: "Asia/Seoul" })) },
    user: { findUnique: vi.fn(async () => ({ id: "u1" })) },
    calendarEvent: { upsert: vi.fn(async () => ({})) },
  };
  return { prisma, db: prisma, INTERACTIVE_TX_OPTIONS: {} };
});
vi.mock("../crypto-tokens.js", () => ({ decryptToken: (t: string) => t.replace(/^enc:/, "") }));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));
vi.mock("../pim/caldav/caldav-transport.js", () => ({ httpsPinnedTransport: m.transport }));
vi.mock("../net/pinned-host.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../net/pinned-host.js")>()),
  resolveHostAddresses: vi.fn(async () => ["17.248.1.10"]),
}));

import { syncLinkedCalendars } from "../pim/calendar-sync.js";
import { _resetLinkedCalendarFailureLogForTests } from "../pim/linked-calendar-failure.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const ROW = {
  id: "acct-ic",
  userId: "u1",
  provider: "ICLOUD",
  email: "me@icloud.com",
  caldavPasswordCipher: "enc:pw",
  needsReconnect: false,
};
const saved = process.env.CALDAV_CALENDAR_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  _resetLinkedCalendarFailureLogForTests();
  process.env.CALDAV_CALENDAR_ENABLED = "true";
  m.findMany.mockResolvedValue([ROW]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  if (saved === undefined) delete process.env.CALDAV_CALENDAR_ENABLED;
  else process.env.CALDAV_CALENDAR_ENABLED = saved;
  vi.restoreAllMocks();
});

describe("a CalDAV account in the linked sync", () => {
  it("a 401 flags the account for reconnect and never reaches Sentry", async () => {
    m.transport.mockResolvedValue({ status: 401, location: null, body: "" });
    const result = await syncLinkedCalendars("u1", NOW);
    expect(result).toEqual({ accounts: 1, events: 0, failedAccounts: 1 });
    expect(m.markReconnect).toHaveBeenCalledWith("u1", "acct-ic");
    expect(m.captureError).not.toHaveBeenCalled();
  });

  it("a 503 is captured with the domain only, and the account is left alone", async () => {
    m.transport.mockResolvedValue({ status: 503, location: null, body: "internal detail" });
    await syncLinkedCalendars("u1", NOW);
    expect(m.markReconnect).not.toHaveBeenCalled();
    expect(m.captureError).toHaveBeenCalledTimes(1);
    const [, context] = m.captureError.mock.calls[0] as [Error, { extra: Record<string, string> }];
    expect(context.extra).toEqual({ userId: "u1", accountDomain: "icloud.com" });
    expect(JSON.stringify(m.captureError.mock.calls)).not.toContain("internal detail");
  });

  it("an account flagged needsReconnect is skipped: no request at all", async () => {
    m.findMany.mockResolvedValue([{ ...ROW, needsReconnect: true }]);
    const result = await syncLinkedCalendars("u1", NOW);
    expect(result.accounts).toBe(0);
    expect(m.transport).not.toHaveBeenCalled();
  });

  it("with CALDAV_CALENDAR_ENABLED off the account is skipped: no request, no decrypt", async () => {
    process.env.CALDAV_CALENDAR_ENABLED = "false";
    const result = await syncLinkedCalendars("u1", NOW);
    expect(result.accounts).toBe(0);
    expect(m.transport).not.toHaveBeenCalled();
  });
});
