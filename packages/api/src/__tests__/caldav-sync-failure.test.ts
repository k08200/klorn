/**
 * C3: a CalDAV account in the C2 linked-sync loop, through the real dispatcher and
 * the shared failure policy. A 401 (the app-specific password was revoked) flags
 * the account for reconnect and stays out of Sentry; any other failure is captured
 * with the domain only and leaves the account alone; a flagged account is skipped
 * until it is re-linked. Only the network edge is faked: the default transport and
 * the DNS resolver.
 *
 * Review fixes (2026-10-02):
 *   - a flagged account opens no CalDAV session at all, so the conflict checks
 *     (which still try a flagged Google or Outlook account, whose refresh can
 *     clear the flag) never send a revoked app password to Apple or Naver again;
 *     only a re-link clears the flag, as for Outlook;
 *   - any other failure backs the account off (doubling from one sync tick, capped
 *     at six hours; a success or a re-link starts over), so a stalled server no
 *     longer costs the serial tick up to 45 s every cycle;
 *   - Sentry hears of a failure kind once per account per process.
 * Google and Outlook keep their policy: linked-calendar-failure.test.ts.
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
    // The window reconcile of a complete listing: nothing in the window.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ calendarEvent: { findMany: vi.fn(async () => []) } }),
    ),
  };
  return { prisma, db: prisma, INTERACTIVE_TX_OPTIONS: {} };
});
vi.mock("../crypto-tokens.js", () => ({ decryptToken: (t: string) => t.replace(/^enc:/, "") }));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));
vi.mock("../pim/caldav/caldav-transport.js", () => ({ httpsPinnedTransport: m.transport }));
vi.mock("../mail/host-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mail/host-resolver.js")>()),
  resolveHostAddresses: vi.fn(async () => ["17.248.1.10"]),
}));

import {
  fakeCaldavServer,
  ICLOUD_CALENDARS,
  icloudReportXml,
  icloudRoutes,
} from "../__fixtures__/caldav/server.js";
import {
  _resetCaldavBackoffForTests,
  CALDAV_BACKOFF_BASE_MS,
  CALDAV_BACKOFF_MAX_MS,
  caldavBackoffMs,
  clearCaldavBackoff,
  isCaldavBackedOff,
} from "../pim/caldav/caldav-backoff.js";
import { CaldavHttpError, CaldavLimitError } from "../pim/caldav/caldav-errors.js";
import { connectLinkedCalendars } from "../pim/calendar-providers/dispatch.js";
import { syncLinkedCalendars } from "../pim/calendar-sync.js";
import {
  _resetLinkedCalendarFailureLogForTests,
  handleLinkedCalendarFailure,
} from "../pim/linked-calendar-failure.js";

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
  _resetCaldavBackoffForTests();
  process.env.CALDAV_CALENDAR_ENABLED = "true";
  m.findMany.mockResolvedValue([ROW]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
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

describe("a CalDAV account flagged needsReconnect (the conflict-check path)", () => {
  // pim/calendar.ts connects with skipNeedsReconnect:false and asks each session
  // for busy blocks; a flagged Google account is still tried there on purpose.
  it("opens no session, so the revoked app password is never sent again", async () => {
    m.findMany.mockResolvedValue([{ ...ROW, needsReconnect: true }]);
    m.transport.mockResolvedValue({ status: 401, location: null, body: "" });
    const linked = await connectLinkedCalendars("u1", { skipNeedsReconnect: false });
    for (const { session } of linked) {
      await session
        .busyBlocks({ timeMin: "2026-10-03T00:00:00Z", timeMax: "2026-10-04T00:00:00Z" })
        .catch(() => {});
    }
    expect(linked).toEqual([]);
    expect(m.transport).not.toHaveBeenCalled();
  });

  it("an unflagged account on the same path still connects", async () => {
    const linked = await connectLinkedCalendars("u1", { skipNeedsReconnect: false });
    expect(linked.map((l) => l.id)).toEqual(["acct-ic"]);
  });
});

describe("backoff after a failure that is not a revoked password", () => {
  const T0 = new Date("2026-10-02T00:00:00.000Z").getTime();
  const [HOME, WORK] = ICLOUD_CALENDARS as [string, string];
  const healthy = fakeCaldavServer(
    icloudRoutes({
      [HOME]: { status: 207, body: icloudReportXml([]) },
      [WORK]: { status: 207, body: icloudReportXml([]) },
    }),
  );

  function at(ms: number): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ms);
  }

  it("doubles from one sync tick and is capped", () => {
    expect(CALDAV_BACKOFF_BASE_MS).toBe(15 * 60_000);
    expect(caldavBackoffMs(1)).toBe(CALDAV_BACKOFF_BASE_MS);
    expect(caldavBackoffMs(2)).toBe(2 * CALDAV_BACKOFF_BASE_MS);
    expect(caldavBackoffMs(3)).toBe(4 * CALDAV_BACKOFF_BASE_MS);
    expect(caldavBackoffMs(50)).toBe(CALDAV_BACKOFF_MAX_MS);
  });

  it("a 503 backs the account off: the next sync sends nothing until the delay passes", async () => {
    at(T0);
    m.transport.mockResolvedValue({ status: 503, location: null, body: "" });
    await syncLinkedCalendars("u1", NOW);
    expect(m.transport).toHaveBeenCalled();
    expect(isCaldavBackedOff("acct-ic", T0)).toBe(true);

    m.transport.mockClear();
    at(T0 + CALDAV_BACKOFF_BASE_MS - 1);
    expect(await syncLinkedCalendars("u1", NOW)).toEqual({
      accounts: 0,
      events: 0,
      failedAccounts: 0,
    });
    expect(m.transport).not.toHaveBeenCalled();

    at(T0 + CALDAV_BACKOFF_BASE_MS);
    await syncLinkedCalendars("u1", NOW);
    expect(m.transport).toHaveBeenCalled();
  });

  it("the conflict checks skip a backed-off account too (no 45 s wait on a stalled server)", async () => {
    at(T0);
    m.transport.mockRejectedValue(new CaldavLimitError("timeout"));
    await syncLinkedCalendars("u1", NOW);
    m.transport.mockClear();
    expect(await connectLinkedCalendars("u1", { skipNeedsReconnect: false })).toEqual([]);
    expect(m.transport).not.toHaveBeenCalled();
  });

  it("two failures in a row double the delay", async () => {
    at(T0);
    m.transport.mockResolvedValue({ status: 503, location: null, body: "" });
    await syncLinkedCalendars("u1", NOW);
    at(T0 + CALDAV_BACKOFF_BASE_MS);
    await syncLinkedCalendars("u1", NOW);
    const second = T0 + CALDAV_BACKOFF_BASE_MS;
    expect(isCaldavBackedOff("acct-ic", second + 2 * CALDAV_BACKOFF_BASE_MS - 1)).toBe(true);
    expect(isCaldavBackedOff("acct-ic", second + 2 * CALDAV_BACKOFF_BASE_MS)).toBe(false);
  });

  it("a successful listing clears the backoff: the next failure starts from one tick", async () => {
    at(T0);
    m.transport.mockResolvedValue({ status: 503, location: null, body: "" });
    await syncLinkedCalendars("u1", NOW);
    at(T0 + CALDAV_BACKOFF_BASE_MS);
    await syncLinkedCalendars("u1", NOW);

    const third = T0 + 3 * CALDAV_BACKOFF_BASE_MS;
    at(third);
    m.transport.mockImplementation(healthy);
    expect((await syncLinkedCalendars("u1", NOW)).failedAccounts).toBe(0);
    expect(isCaldavBackedOff("acct-ic", third)).toBe(false);

    m.transport.mockResolvedValue({ status: 503, location: null, body: "" });
    await syncLinkedCalendars("u1", NOW);
    expect(isCaldavBackedOff("acct-ic", third + CALDAV_BACKOFF_BASE_MS)).toBe(false);
  });

  it("a re-link clears it (clearCaldavBackoff, called by the link route)", async () => {
    at(T0);
    m.transport.mockResolvedValue({ status: 503, location: null, body: "" });
    await syncLinkedCalendars("u1", NOW);
    clearCaldavBackoff("acct-ic");
    expect(isCaldavBackedOff("acct-ic", T0)).toBe(false);
  });

  it("a 401 flags the account and does not back it off (the flag already stops it)", async () => {
    m.transport.mockResolvedValue({ status: 401, location: null, body: "" });
    await syncLinkedCalendars("u1", NOW);
    expect(m.markReconnect).toHaveBeenCalledWith("u1", "acct-ic");
    expect(isCaldavBackedOff("acct-ic", Date.now())).toBe(false);
  });
});

describe("Sentry hears of a CalDAV failure kind once per account per process", () => {
  const failure = (err: unknown, linkedAccountId = "acct-ic") => ({
    userId: "u1",
    linkedAccountId,
    email: "me@icloud.com",
    err,
    scope: "calendar.linked_sync_failed",
    action: "sync",
    provider: "ICLOUD" as const,
  });

  it("the same kind again is warned about but not captured; a new kind or account is", async () => {
    await handleLinkedCalendarFailure(failure(new CaldavHttpError(503)));
    await handleLinkedCalendarFailure(failure(new CaldavHttpError(503)));
    expect(m.captureError).toHaveBeenCalledTimes(1);
    await handleLinkedCalendarFailure(failure(new CaldavLimitError("deadline")));
    expect(m.captureError).toHaveBeenCalledTimes(2);
    await handleLinkedCalendarFailure(failure(new CaldavHttpError(503), "acct-other"));
    expect(m.captureError).toHaveBeenCalledTimes(3);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(4);
  });

  it("a sync that fails the same way every cycle reaches Sentry once", async () => {
    m.transport.mockResolvedValue({ status: 503, location: null, body: "" });
    await syncLinkedCalendars("u1", NOW);
    _resetCaldavBackoffForTests();
    await syncLinkedCalendars("u1", NOW);
    expect(m.transport).toHaveBeenCalled();
    expect(m.captureError).toHaveBeenCalledTimes(1);
  });

  it("for Google the shared policy is unchanged: every failure is captured", async () => {
    const google = { ...failure(new Error("boom")), provider: "GOOGLE" as const };
    await handleLinkedCalendarFailure(google);
    await handleLinkedCalendarFailure(google);
    expect(m.captureError).toHaveBeenCalledTimes(2);
  });
});
