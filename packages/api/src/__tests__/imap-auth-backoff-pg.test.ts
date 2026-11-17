import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the IMAP login backoff (migration
// 20261115213000_imap_auth_backoff, mail/imap-auth-backoff.ts): the count and
// the retry time live on the LinkedInboxAccount row, so a restart obeys them;
// the 4th refused login stops the poll; a login that works and a reconnect
// start over. The real fan-out (imap-accounts.ts) and the real connect route
// write the row; only the IMAP conversation is faked (no mail server is ever
// contacted). Skipped unless KLORN_TEST_PG_URL points at a database with every
// migration applied; set DATABASE_URL to the same URL.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

const fake = vi.hoisted(() => ({
  syncImapInbox: vi.fn(),
  notify: vi.fn(async () => undefined),
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../crypto-tokens.js", () => ({
  encryptToken: (plain: string) => `enc:${plain}`,
  decryptToken: () => "app-pw",
}));
vi.mock("../mail/gmail.js", () => ({
  notifyLinkedInboxReconnect: (...args: unknown[]) => fake.notify(...(args as [])),
}));
vi.mock("../mail/imap-sync.js", () => ({
  syncImapInbox: (...args: unknown[]) => fake.syncImapInbox(...args),
  syncImapMessage: vi.fn(),
  verifyImapCredentials: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../mail/imap-first-sync.js", () => ({ startFirstImapSync: vi.fn(() => false) }));

import Fastify from "fastify";
import { registerDevice, signToken } from "../auth.js";
import { prisma } from "../db.js";
import { syncImapAccountsForUser } from "../mail/imap-accounts.js";
import { resetPollBackoffState } from "../mail/imap-poll-backoff.js";
import { resetPollFailureState } from "../mail/imap-poll-failures.js";
import { IMAP_PROVIDERS } from "../mail/imap-providers.js";
import { resetImapSessionState } from "../mail/providers/imap-session.js";
import { registerImapPresetRoutes } from "../routes/imap-preset-routes.js";

const describePg = url ? describe : describe.skip;
const createdUsers: string[] = [];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = new Date("2026-11-15T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const YAHOO = IMAP_PROVIDERS.YAHOO;
const ADDRESS = "me@example.com";
const refused = () => Object.assign(new Error("Command failed"), { authenticationFailed: true });
const SYNCED = { fetched: 0, inserted: 0, classified: 0, errors: 0, held: false };

async function newMailbox(fields: Record<string, unknown> = {}) {
  const user = await prisma.user.create({ data: { email: `imap-${randomUUID()}@test.local` } });
  createdUsers.push(user.id);
  const row = await prisma.linkedInboxAccount.create({
    data: {
      userId: user.id,
      provider: "YAHOO",
      email: ADDRESS,
      imapHost: "imap.mail.yahoo.com:993",
      imapPasswordCipher: "enc:old-pw",
      inboxUidValidity: "7",
      ...fields,
    },
  });
  return { userId: user.id, rowId: row.id };
}

const stored = (rowId: string) =>
  prisma.linkedInboxAccount.findUniqueOrThrow({
    where: { id: rowId },
    select: {
      imapAuthFailures: true,
      imapAuthRetryAt: true,
      needsReconnect: true,
      syncErrorCode: true,
      imapPasswordCipher: true,
    },
  });

/** A restart: every in-process poll state is gone, only the database remains. */
function restart(): void {
  resetImapSessionState();
  resetPollFailureState();
  resetPollBackoffState();
}

beforeEach(() => {
  vi.clearAllMocks();
  restart();
  fake.syncImapInbox.mockRejectedValue(refused());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describePg("IMAP login backoff (real Postgres)", () => {
  it("new rows start with no refusal on record", async () => {
    const { rowId } = await newMailbox();
    expect(await stored(rowId)).toMatchObject({ imapAuthFailures: 0, imapAuthRetryAt: null });
  });

  it("persists each refusal, obeys it across restarts, and stops at the 4th", async () => {
    const { userId, rowId } = await newMailbox();
    vi.useFakeTimers({ toFake: ["Date"] });

    vi.setSystemTime(T0);
    await syncImapAccountsForUser(userId, YAHOO);
    expect(await stored(rowId)).toEqual({
      imapAuthFailures: 1,
      imapAuthRetryAt: at(15 * MINUTE),
      needsReconnect: true,
      syncErrorCode: "auth",
      imapPasswordCipher: "enc:old-pw",
    });

    restart();
    vi.setSystemTime(at(10 * MINUTE));
    await syncImapAccountsForUser(userId, YAHOO);
    expect(fake.syncImapInbox).toHaveBeenCalledTimes(1); // still waiting, restart or not

    const schedule: Array<[number, number, Date | null]> = [
      [15 * MINUTE, 2, at(75 * MINUTE)],
      [75 * MINUTE, 3, at(75 * MINUTE + 6 * HOUR)],
      [75 * MINUTE + 6 * HOUR, 4, null],
    ];
    for (const [now, failures, retryAt] of schedule) {
      restart();
      vi.setSystemTime(at(now));
      await syncImapAccountsForUser(userId, YAHOO);
      expect(await stored(rowId)).toMatchObject({
        imapAuthFailures: failures,
        imapAuthRetryAt: retryAt,
      });
    }

    for (const hours of [8, 24, 24 * 7]) {
      restart();
      vi.setSystemTime(at(hours * HOUR));
      await syncImapAccountsForUser(userId, YAHOO);
    }
    expect(fake.syncImapInbox).toHaveBeenCalledTimes(4);
    expect(await stored(rowId)).toMatchObject({ imapAuthFailures: 4, needsReconnect: true });
  });

  it("does not count a refusal against a password the user replaced mid-poll", async () => {
    const { userId, rowId } = await newMailbox();
    fake.syncImapInbox.mockImplementationOnce(async () => {
      await prisma.linkedInboxAccount.update({
        where: { id: rowId },
        data: { imapPasswordCipher: "enc:new-pw" },
      });
      throw refused();
    });
    await syncImapAccountsForUser(userId, YAHOO);
    expect(await stored(rowId)).toMatchObject({
      imapAuthFailures: 0,
      imapAuthRetryAt: null,
      needsReconnect: false,
    });
  });

  it("a login that works clears the count, the retry time and the reconnect flag", async () => {
    const { userId, rowId } = await newMailbox({
      imapAuthFailures: 3,
      imapAuthRetryAt: new Date(Date.now() - MINUTE),
      needsReconnect: true,
      syncErrorCode: "auth",
    });
    fake.syncImapInbox.mockResolvedValue(SYNCED);
    await syncImapAccountsForUser(userId, YAHOO);
    expect(await stored(rowId)).toMatchObject({
      imapAuthFailures: 0,
      imapAuthRetryAt: null,
      needsReconnect: false,
      syncErrorCode: null,
    });
  });

  it("a reconnect through the connect route starts a stopped mailbox over", async () => {
    const original = process.env.IMAP_PRESETS_ENABLED;
    process.env.IMAP_PRESETS_ENABLED = "true";
    try {
      const { userId, rowId } = await newMailbox({
        imapAuthFailures: 4,
        imapAuthRetryAt: null,
        needsReconnect: true,
        syncErrorCode: "auth",
      });
      const token = signToken({ userId, email: ADDRESS });
      await registerDevice(userId, token, {});
      const app = Fastify();
      await registerImapPresetRoutes(app);
      await app.ready();
      const res = await app.inject({
        method: "POST",
        url: "/api/yahoo-imap/connect",
        headers: { authorization: `Bearer ${token}` },
        payload: { email: ADDRESS, password: "new-app-pw" },
      });
      await app.close();
      expect(res.statusCode).toBe(200);
      expect(await stored(rowId)).toEqual({
        imapAuthFailures: 0,
        imapAuthRetryAt: null,
        needsReconnect: false,
        syncErrorCode: null,
        imapPasswordCipher: "enc:new-app-pw",
      });

      fake.syncImapInbox.mockResolvedValue(SYNCED);
      await syncImapAccountsForUser(userId, YAHOO);
      expect(fake.syncImapInbox).toHaveBeenCalledTimes(1); // polled again
    } finally {
      if (original === undefined) delete process.env.IMAP_PRESETS_ENABLED;
      else process.env.IMAP_PRESETS_ENABLED = original;
    }
  });
});
