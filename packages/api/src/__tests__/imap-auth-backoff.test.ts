/**
 * A refused app password is backed off, then given up on (follow-up to #1756). A
 * fixed-host mailbox (Naver, iCloud, the app-password presets) used to be polled
 * every five minutes whatever its login answered: a revoked password was sent 288
 * times a day to providers that lock or challenge an account after repeated
 * failures. Now each consecutive refusal of the credentials waits longer (15 min,
 * 1 h, 6 h) and the 4th stops the poll until the user reconnects. A transient
 * refusal or a network failure is not about the password and keeps today's
 * schedule. The state is on the row, so a restart does not forget it.
 *
 * Real imap-accounts and imap-auth-backoff; the IMAP conversation (imap-sync) and
 * the database are faked, and the row is stateful so the schedule can be replayed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  syncImapInbox: vi.fn(),
  decryptToken: vi.fn(() => "app-pw"),
  captureError: vi.fn(),
  notify: vi.fn(async () => undefined),
  rows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
}));

/** Does `row` satisfy a Prisma `where` of plain equalities, `OR` and `{ not }`? */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === "OR") {
      return (want as Array<Record<string, unknown>>).some((branch) => matches(row, branch));
    }
    if (want !== null && typeof want === "object" && !(want instanceof Date)) {
      if ("not" in (want as object)) return row[key] !== (want as { not: unknown }).not;
      if ("in" in (want as object)) return (want as { in: unknown[] }).in.includes(row[key]);
    }
    return (row[key] ?? null) === want || (row[key] === undefined && want === 0);
  });
}

vi.mock("../db.js", () => {
  const prisma = {
    linkedInboxAccount: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        fake.rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        fake.updates.push(args);
        let count = 0;
        fake.rows = fake.rows.map((row) => {
          if (!matches(row, args.where)) return row;
          count += 1;
          return { ...row, ...args.data };
        });
        return { count };
      },
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({
  captureError: (...args: unknown[]) => fake.captureError(...args),
}));
vi.mock("../crypto-tokens.js", () => ({
  encryptToken: vi.fn(),
  decryptToken: () => fake.decryptToken(),
}));
vi.mock("../mail/gmail.js", () => ({
  notifyLinkedInboxReconnect: (...args: unknown[]) => fake.notify(...(args as [])),
}));
vi.mock("../mail/imap-sync.js", () => ({
  syncImapInbox: (...args: unknown[]) => fake.syncImapInbox(...args),
  syncImapMessage: vi.fn(),
}));

const {
  authBackoffVerdict,
  AUTH_BACKOFF_CLEARED,
  IMAP_AUTH_FAILURE_LIMIT,
  IMAP_AUTH_RETRY_DELAYS_MS,
  nextAuthBackoff,
} = await import("../mail/imap-auth-backoff.js");
const { syncImapAccountsForUser } = await import("../mail/imap-accounts.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { isCredentialRefusal, imapSyncErrorCode } = await import("../mail/sync-error-code.js");
const { resetPollFailureState } = await import("../mail/imap-poll-failures.js");
const { resetPollBackoffState } = await import("../mail/imap-poll-backoff.js");
const { resetImapSessionState } = await import("../mail/providers/imap-session.js");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = new Date("2026-11-15T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

/** imapflow's shape for a refused LOGIN (it marks every one `authenticationFailed`). */
const refused = (serverResponseCode?: string) =>
  Object.assign(new Error("Command failed"), {
    authenticationFailed: true,
    ...(serverResponseCode ? { serverResponseCode } : {}),
  });
const reset = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
const SYNCED = { fetched: 0, inserted: 0, classified: 0, errors: 0, held: false };

const YAHOO = IMAP_PROVIDERS.YAHOO;

function seedRow(fields: Record<string, unknown> = {}): void {
  fake.rows = [
    {
      id: "row-y",
      userId: "u1",
      provider: "YAHOO",
      email: "me@example.com",
      imapHost: "imap.mail.yahoo.com:993",
      imapPasswordCipher: "v2:old",
      inboxUidValidity: "7",
      needsReconnect: false,
      imapAuthFailures: 0,
      imapAuthRetryAt: null,
      createdAt: T0,
      ...fields,
    },
  ];
}
const row = () => fake.rows[0] as Record<string, unknown>;
/** Restart: every in-process poll state is gone; only the row remains. */
function restart(): void {
  resetImapSessionState();
  resetPollFailureState();
  resetPollBackoffState();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  restart();
  fake.updates.length = 0;
  fake.syncImapInbox.mockRejectedValue(refused());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the schedule", () => {
  it("waits 15 min, 1 h and 6 h after the 1st, 2nd and 3rd refusal, and stops at the 4th", () => {
    expect(IMAP_AUTH_RETRY_DELAYS_MS).toEqual([15 * MINUTE, HOUR, 6 * HOUR]);
    expect(IMAP_AUTH_FAILURE_LIMIT).toBe(4);
    expect(nextAuthBackoff(0, T0)).toEqual({
      imapAuthFailures: 1,
      imapAuthRetryAt: at(15 * MINUTE),
    });
    expect(nextAuthBackoff(1, T0)).toEqual({ imapAuthFailures: 2, imapAuthRetryAt: at(HOUR) });
    expect(nextAuthBackoff(2, T0)).toEqual({ imapAuthFailures: 3, imapAuthRetryAt: at(6 * HOUR) });
    expect(nextAuthBackoff(3, T0)).toEqual({ imapAuthFailures: 4, imapAuthRetryAt: null });
  });

  it("stays stopped past the limit, and reads a missing or broken count as none", () => {
    expect(nextAuthBackoff(4, T0)).toEqual({ imapAuthFailures: 4, imapAuthRetryAt: null });
    expect(nextAuthBackoff(99, T0)).toEqual({ imapAuthFailures: 4, imapAuthRetryAt: null });
    expect(nextAuthBackoff(-3, T0)).toEqual({
      imapAuthFailures: 1,
      imapAuthRetryAt: at(15 * MINUTE),
    });
    expect(nextAuthBackoff(Number.NaN, T0)).toEqual({
      imapAuthFailures: 1,
      imapAuthRetryAt: at(15 * MINUTE),
    });
  });

  it("the cleared state is no failures and no retry time", () => {
    expect(AUTH_BACKOFF_CLEARED).toEqual({ imapAuthFailures: 0, imapAuthRetryAt: null });
  });
});

describe("authBackoffVerdict", () => {
  it.each([
    ["a row that never failed", { imapAuthFailures: 0, imapAuthRetryAt: null }, T0, "poll"],
    ["a row from before the columns", {}, T0, "poll"],
    [
      "before its retry time",
      { imapAuthFailures: 1, imapAuthRetryAt: at(15 * MINUTE) },
      at(14 * MINUTE),
      "wait",
    ],
    [
      "at its retry time",
      { imapAuthFailures: 1, imapAuthRetryAt: at(15 * MINUTE) },
      at(15 * MINUTE),
      "poll",
    ],
    [
      "after the 3rd refusal, 5 h on",
      { imapAuthFailures: 3, imapAuthRetryAt: at(6 * HOUR) },
      at(5 * HOUR),
      "wait",
    ],
    ["at the limit", { imapAuthFailures: 4, imapAuthRetryAt: null }, at(1000 * HOUR), "stopped"],
    ["past the limit", { imapAuthFailures: 7, imapAuthRetryAt: at(MINUTE) }, at(HOUR), "stopped"],
    ["a count without a retry time", { imapAuthFailures: 2, imapAuthRetryAt: null }, T0, "poll"],
  ] as const)("%s: %s", (_label, state, now, verdict) => {
    expect(authBackoffVerdict(state, now)).toBe(verdict);
  });
});

describe("what counts as a refused password", () => {
  it.each([
    ["a plain refused LOGIN", refused(), true, "auth"],
    ["AUTHENTICATIONFAILED", refused("AUTHENTICATIONFAILED"), true, "auth"],
    ["a refusal for the moment (UNAVAILABLE)", refused("UNAVAILABLE"), false, "throttled"],
    ["a rate limit (LIMIT)", refused("LIMIT"), false, "throttled"],
    ["a session in use (INUSE)", refused("inuse"), false, "throttled"],
    ["the server's own bug (SERVERBUG)", refused("SERVERBUG"), false, "throttled"],
    ["a dropped connection", reset(), false, "unreachable"],
    ["anything else", new Error("boom"), false, "error"],
  ] as const)("%s", (_label, err, credential, code) => {
    expect(isCredentialRefusal(err)).toBe(credential);
    expect(imapSyncErrorCode(err)).toBe(code);
  });
});

describe("the poll of a fixed-host mailbox whose password is refused", () => {
  it("records the 1st refusal against the password it used, and still flags and alerts", async () => {
    seedRow();
    await syncImapAccountsForUser("u1", YAHOO);

    expect(fake.updates).toContainEqual({
      where: { id: "row-y", userId: "u1", imapPasswordCipher: "v2:old", imapAuthFailures: 0 },
      data: { imapAuthFailures: 1, imapAuthRetryAt: at(15 * MINUTE) },
    });
    expect(row()).toMatchObject({
      imapAuthFailures: 1,
      needsReconnect: true,
      syncErrorCode: "auth",
    });
    expect(fake.notify).toHaveBeenCalledWith("u1", "row-y", "YAHOO");
  });

  it("does not log in again before the retry time, after a restart too", async () => {
    seedRow({ imapAuthFailures: 1, imapAuthRetryAt: at(15 * MINUTE), needsReconnect: true });
    restart();
    vi.setSystemTime(at(10 * MINUTE));
    await syncImapAccountsForUser("u1", YAHOO);
    expect(fake.syncImapInbox).not.toHaveBeenCalled();

    vi.setSystemTime(at(15 * MINUTE));
    await syncImapAccountsForUser("u1", YAHOO);
    expect(fake.syncImapInbox).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ imapAuthFailures: 2, imapAuthRetryAt: at(75 * MINUTE) });
  });

  it("stops at the 4th refusal and never logs in again, and says so once", async () => {
    seedRow({ imapAuthFailures: 3, imapAuthRetryAt: at(0), needsReconnect: true });
    await syncImapAccountsForUser("u1", YAHOO);
    expect(row()).toMatchObject({
      imapAuthFailures: 4,
      imapAuthRetryAt: null,
      needsReconnect: true,
    });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/row row-y.*polling stopped until the mailbox is reconnected/),
    );
    // The row was flagged at the 1st refusal; the stop says "reconnect" once more.
    expect(fake.notify).toHaveBeenCalledTimes(1);
    expect(fake.notify).toHaveBeenCalledWith("u1", "row-y", "YAHOO");

    for (const hours of [1, 6, 24, 24 * 30]) {
      vi.setSystemTime(at(hours * HOUR));
      await syncImapAccountsForUser("u1", YAHOO);
    }
    expect(fake.syncImapInbox).toHaveBeenCalledTimes(1);
    expect(fake.notify).toHaveBeenCalledTimes(1);
  });

  it("a stop that also sets the reconnect flag alerts once, not twice", async () => {
    seedRow({ imapAuthFailures: 3, imapAuthRetryAt: at(0), needsReconnect: false });
    await syncImapAccountsForUser("u1", YAHOO);
    expect(row()).toMatchObject({ imapAuthFailures: 4, needsReconnect: true });
    expect(fake.notify).toHaveBeenCalledTimes(1);
  });

  it("the 2nd and 3rd refusals of a flagged row send no new alert", async () => {
    seedRow({ imapAuthFailures: 1, imapAuthRetryAt: at(0), needsReconnect: true });
    await syncImapAccountsForUser("u1", YAHOO);
    vi.setSystemTime(at(2 * HOUR));
    await syncImapAccountsForUser("u1", YAHOO);
    expect(row()).toMatchObject({ imapAuthFailures: 3 });
    expect(fake.notify).not.toHaveBeenCalled();
  });

  it("a stopped row stays stopped even if its reconnect flag was cleared by hand", async () => {
    seedRow({ imapAuthFailures: 4, imapAuthRetryAt: null, needsReconnect: false });
    await syncImapAccountsForUser("u1", YAHOO);
    expect(fake.syncImapInbox).not.toHaveBeenCalled();
  });

  it("over 24 hours of five-minute ticks, a revoked password is sent exactly 4 times", async () => {
    seedRow();
    for (let tick = 0; tick <= (24 * HOUR) / (5 * MINUTE); tick++) {
      vi.setSystemTime(at(tick * 5 * MINUTE));
      if (tick % 50 === 0) restart(); // deploys in between change nothing
      await syncImapAccountsForUser("u1", YAHOO);
    }
    expect(fake.syncImapInbox).toHaveBeenCalledTimes(4);
    const loginTimes = fake.updates
      .filter((u) => typeof u.data.imapAuthFailures === "number" && u.data.imapAuthFailures > 0)
      .map((u) => u.data.imapAuthFailures);
    expect(loginTimes).toEqual([1, 2, 3, 4]);
    expect(row()).toMatchObject({ imapAuthFailures: IMAP_AUTH_FAILURE_LIMIT });
  });

  it.each(["NAVER", "ICLOUD", "DAUM"] as const)("%s follows the same schedule", async (key) => {
    const provider = IMAP_PROVIDERS[key];
    seedRow({ provider: key, imapHost: provider.defaultHost });
    for (let tick = 0; tick <= (8 * HOUR) / (5 * MINUTE); tick++) {
      vi.setSystemTime(at(tick * 5 * MINUTE));
      await syncImapAccountsForUser("u1", provider);
    }
    expect(fake.syncImapInbox).toHaveBeenCalledTimes(4);
  });

  it("a refusal recorded after the user reconnected does not count against the new password", async () => {
    seedRow();
    fake.syncImapInbox.mockImplementationOnce(async () => {
      fake.rows = [{ ...row(), imapPasswordCipher: "v2:new" }]; // relinked mid-poll
      throw refused();
    });
    await syncImapAccountsForUser("u1", YAHOO);
    expect(row()).toMatchObject({
      imapPasswordCipher: "v2:new",
      imapAuthFailures: 0,
      needsReconnect: false,
    });
  });

  it("a database failure recording the refusal still flags the row and records why", async () => {
    seedRow();
    const { prisma } = await import("../db.js");
    const updateMany = prisma.linkedInboxAccount.updateMany;
    const spy = vi.spyOn(prisma.linkedInboxAccount, "updateMany").mockImplementation((async (args: {
      data: Record<string, unknown>;
    }) => {
      if ("imapAuthFailures" in args.data) throw new Error("db down");
      return (updateMany as (a: unknown) => Promise<{ count: number }>)(args);
    }) as never);
    await syncImapAccountsForUser("u1", YAHOO);
    spy.mockRestore();
    expect(row()).toMatchObject({
      imapAuthFailures: 0,
      needsReconnect: true,
      syncErrorCode: "auth",
    });
    expect(fake.notify).toHaveBeenCalledWith("u1", "row-y", "YAHOO");
  });

  it("a generic (user-supplied host) row counts too, and its reconnect flag pauses it", async () => {
    fake.rows = [
      {
        ...(seedRow(), row()),
        provider: "IMAP",
        imapHost: "imap.purelymail.com:993",
      },
    ];
    await syncImapAccountsForUser("u1", IMAP_PROVIDERS.IMAP);
    expect(row()).toMatchObject({ imapAuthFailures: 1, needsReconnect: true });
    vi.setSystemTime(at(HOUR));
    await syncImapAccountsForUser("u1", IMAP_PROVIDERS.IMAP);
    expect(fake.syncImapInbox).toHaveBeenCalledTimes(1);
  });
});

describe("failures that are not about the password keep today's schedule", () => {
  it.each([
    ["a transient refusal", refused("UNAVAILABLE"), "throttled"],
    ["a dropped connection", reset(), "unreachable"],
  ])("%s is not counted, and the next tick polls again", async (_label, err, code) => {
    seedRow();
    fake.syncImapInbox.mockRejectedValue(err);
    await syncImapAccountsForUser("u1", YAHOO);
    expect(row()).toMatchObject({
      imapAuthFailures: 0,
      imapAuthRetryAt: null,
      syncErrorCode: code,
    });

    vi.setSystemTime(at(5 * MINUTE));
    await syncImapAccountsForUser("u1", YAHOO);
    expect(fake.syncImapInbox).toHaveBeenCalledTimes(2);
  });

  it("a transient failure between two refusals neither resets nor advances the count", async () => {
    seedRow({ imapAuthFailures: 2, imapAuthRetryAt: at(0), needsReconnect: true });
    fake.syncImapInbox.mockRejectedValueOnce(reset());
    await syncImapAccountsForUser("u1", YAHOO);
    expect(row()).toMatchObject({ imapAuthFailures: 2 });
  });
});

describe("a successful login starts over", () => {
  it("clears the count and the retry time with the reconnect flag", async () => {
    seedRow({ imapAuthFailures: 2, imapAuthRetryAt: at(0), needsReconnect: true });
    fake.syncImapInbox.mockResolvedValue(SYNCED);
    await syncImapAccountsForUser("u1", YAHOO);
    expect(row()).toMatchObject({
      imapAuthFailures: 0,
      imapAuthRetryAt: null,
      needsReconnect: false,
      syncErrorCode: null,
    });
  });

  it("a held poll (its login worked) clears the count too", async () => {
    seedRow({ imapAuthFailures: 1, imapAuthRetryAt: at(0), needsReconnect: true });
    fake.syncImapInbox.mockResolvedValue({ ...SYNCED, held: true });
    await syncImapAccountsForUser("u1", YAHOO);
    expect(row()).toMatchObject({ imapAuthFailures: 0, imapAuthRetryAt: null });
  });

  it("a successful poll of a row that never failed writes no extra update", async () => {
    seedRow();
    fake.syncImapInbox.mockResolvedValue({ ...SYNCED, held: true });
    await syncImapAccountsForUser("u1", YAHOO);
    expect(fake.updates).toHaveLength(0);
  });
});
