/**
 * The reconnect alert at the stop of an IMAP poll (follow-up to #1785). The 1st
 * refused login flags the mailbox and alerts; the 4th stops the poll and asks for
 * the alert once more, because the 1st one may be hours old by then. Both used the
 * one per-account per-UTC-day dedupe key, so a stop on the same UTC day as the 1st
 * refusal (the 4 refusals span about 7¼ hours) was swallowed by the unique key and
 * the user never heard that polling had stopped.
 *
 * Founder decision (LOCKED 2026-11-17): the stop alert goes out once per stop
 * event under its own key, `reconnect:<slug>:<row>:stopped:<epoch ms>`, still
 * through every gate of the push (quiet hours included); the 1st refusal's alert
 * keeps its daily key.
 *
 * Real imap-accounts, imap-auth-backoff, gmail.notifyLinkedInboxReconnect and
 * reconnect-notification over the strict in-memory database (helpers/fake-db.ts,
 * which enforces the (userId, dedupeKey) unique key); the IMAP conversation and
 * the push channels are faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const fake = vi.hoisted(() => ({
  pushes: [] as unknown[][],
  frames: [] as unknown[][],
  syncImapInbox: vi.fn(),
}));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../crypto-tokens.js", () => ({ encryptToken: vi.fn(), decryptToken: () => "app-pw" }));
vi.mock("../mail/imap-sync.js", () => ({
  syncImapInbox: (...args: unknown[]) => fake.syncImapInbox(...args),
  syncImapMessage: vi.fn(),
}));
vi.mock("../notify/push.js", () => ({
  sendPushNotification: vi.fn(async (...args: unknown[]) => {
    fake.pushes.push(args);
    return { status: "sent", subscriptions: 1, attempted: 1, accepted: 1, failed: 0 };
  }),
}));
vi.mock("../websocket.js", () => ({
  pushNotification: vi.fn((...args: unknown[]) => {
    fake.frames.push(args);
  }),
}));

const { syncImapAccountsForUser } = await import("../mail/imap-accounts.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { resetPollFailureState } = await import("../mail/imap-poll-failures.js");
const { resetPollBackoffState } = await import("../mail/imap-poll-backoff.js");
const { resetImapSessionState } = await import("../mail/providers/imap-session.js");
const { ensureGmailReconnectNotification } = await import("../notify/reconnect-notification.js");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// 00:30 UTC: the 1st refusal and the 4th (7¼ hours later) fall on one UTC day.
const T0 = new Date("2026-11-17T00:30:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const YAHOO = IMAP_PROVIDERS.YAHOO;
const ADDRESS = "me@example.com";

const refused = () => Object.assign(new Error("Command failed"), { authenticationFailed: true });

let db: FakeDb;

function seed(row: Row = {}): void {
  db = createFakeDb({
    user: [{ id: "u1", email: "owner@example.com" }],
    linkedInboxAccount: [
      {
        id: "row-y",
        userId: "u1",
        provider: "YAHOO",
        email: ADDRESS,
        imapHost: "imap.mail.yahoo.com:993",
        imapPasswordCipher: "v2:old",
        inboxUidValidity: "7",
        needsReconnect: false,
        imapAuthFailures: 0,
        imapAuthRetryAt: null,
        createdAt: new Date(T0.getTime() - 30 * 24 * HOUR),
        ...row,
      },
    ],
    notification: [],
    emailMessage: [],
  } as Record<string, Row[]>);
  dbHolder.current = db;
}

function reconnectRows(): Row[] {
  return db.tables.notification.filter((r) => String(r.dedupeKey ?? "").startsWith("reconnect:"));
}

/** Restart: in-process poll state is gone; only the row remains. */
function restart(): void {
  resetImapSessionState();
  resetPollFailureState();
  resetPollBackoffState();
}

beforeEach(() => {
  fake.pushes = [];
  fake.frames = [];
  fake.syncImapInbox.mockReset();
  fake.syncImapInbox.mockRejectedValue(refused());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  restart();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the stop of a refused IMAP poll", () => {
  it("alerts at the stop even when the 1st refusal alerted earlier the same UTC day", async () => {
    seed();
    // 1st refusal at T0, then the retries 15 min, 1 h and 6 h apart: the 4th
    // refusal, at T0 + 7 h 15 min, stops the poll. One UTC day throughout.
    for (const ms of [0, 15 * MINUTE, 75 * MINUTE, 435 * MINUTE]) {
      vi.setSystemTime(at(ms));
      await syncImapAccountsForUser("u1", YAHOO);
    }
    expect(fake.syncImapInbox).toHaveBeenCalledTimes(4);
    expect(db.tables.linkedInboxAccount[0]).toMatchObject({ imapAuthFailures: 4 });

    const keys = reconnectRows().map((r) => r.dedupeKey);
    expect(keys).toEqual([
      "reconnect:yahoo:row-y:2026-11-17",
      `reconnect:yahoo:row-y:stopped:${at(435 * MINUTE).getTime()}`,
    ]);
    // Two alerts on every channel: the bell frame and the push, each through
    // sendPushNotification's gates (category opt-out, quiet hours, rate limit).
    expect(fake.frames).toHaveLength(2);
    expect(fake.pushes).toHaveLength(2);
    expect(fake.pushes[1]).toEqual([
      "u1",
      expect.objectContaining({ url: "/settings/accounts" }),
      "system",
    ]);
  });

  it("a stopped poll alerts once: later ticks never log in or alert again", async () => {
    seed({ imapAuthFailures: 3, imapAuthRetryAt: T0, needsReconnect: true });
    await syncImapAccountsForUser("u1", YAHOO);
    for (const hours of [1, 6, 24, 24 * 30]) {
      vi.setSystemTime(at(hours * HOUR));
      restart();
      await syncImapAccountsForUser("u1", YAHOO);
    }
    expect(fake.syncImapInbox).toHaveBeenCalledTimes(1);
    expect(reconnectRows().map((r) => r.dedupeKey)).toEqual([
      `reconnect:yahoo:row-y:stopped:${T0.getTime()}`,
    ]);
    expect(fake.pushes).toHaveLength(1);
  });

  it("the 2nd and 3rd refusals of a flagged row still send nothing", async () => {
    seed({ imapAuthFailures: 1, imapAuthRetryAt: T0, needsReconnect: true });
    await syncImapAccountsForUser("u1", YAHOO);
    vi.setSystemTime(at(2 * HOUR));
    await syncImapAccountsForUser("u1", YAHOO);
    expect(db.tables.linkedInboxAccount[0]).toMatchObject({ imapAuthFailures: 3 });
    expect(reconnectRows()).toEqual([]);
    expect(fake.pushes).toEqual([]);
  });

  it("never puts the mailbox address in a log line", async () => {
    seed({ imapAuthFailures: 3, imapAuthRetryAt: T0, needsReconnect: true });
    await syncImapAccountsForUser("u1", YAHOO);
    const logged = [console.warn, console.log, console.error]
      .flatMap((fn) => vi.mocked(fn).mock.calls)
      .map((args) => args.map(String).join(" "));
    expect(logged.some((line) => line.includes(ADDRESS))).toBe(false);
  });
});

describe("ensureGmailReconnectNotification — the stop key", () => {
  it("the same stop asked twice alerts once (the key names the stop)", async () => {
    seed();
    const stoppedAt = at(HOUR);
    const opts = { linkedInboxAccountId: "row-y", provider: "YAHOO" as const, stoppedAt };
    expect(await ensureGmailReconnectNotification("u1", opts)).not.toBeNull();
    expect(await ensureGmailReconnectNotification("u1", opts)).toBeNull();
    expect(fake.pushes).toHaveLength(1);
  });

  it("a later stop of the same mailbox (after a reconnect) alerts again", async () => {
    seed();
    const base = { linkedInboxAccountId: "row-y", provider: "YAHOO" as const };
    await ensureGmailReconnectNotification("u1", { ...base, stoppedAt: at(HOUR) });
    await ensureGmailReconnectNotification("u1", { ...base, stoppedAt: at(9 * HOUR) });
    expect(reconnectRows()).toHaveLength(2);
  });

  it("without a stop the key stays the daily one (the 1st refusal, every other caller)", async () => {
    seed();
    await ensureGmailReconnectNotification("u1", {
      linkedInboxAccountId: "row-y",
      provider: "YAHOO",
    });
    await ensureGmailReconnectNotification("u1", {
      linkedInboxAccountId: "row-y",
      provider: "YAHOO",
    });
    expect(reconnectRows().map((r) => r.dedupeKey)).toEqual(["reconnect:yahoo:row-y:2026-11-17"]);
  });
});
