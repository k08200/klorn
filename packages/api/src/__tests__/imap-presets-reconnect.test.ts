/**
 * A preset whose app password is refused behaves like Naver and iCloud (#1735): the
 * first failing poll flags the row for reconnect (only against the password it used),
 * records "auth" for Account Health, and sends the reconnect alert in the preset's
 * name. The client is only ever built for the preset's fixed host, over TLS with the
 * default certificate check. Real imap-accounts, imap-sync and imap-connection;
 * imapflow and the database are faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  ctorCalls: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  getMailboxLock: vi.fn(),
  logout: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  decryptToken: vi.fn(),
  captureError: vi.fn(),
  notify: vi.fn(),
}));

class FakeImapFlow {
  constructor(opts: Record<string, unknown>) {
    fake.ctorCalls.push(opts);
  }
  connect = fake.connect;
  getMailboxLock = fake.getMailboxLock;
  mailbox = { uidValidity: 7n };
  logout = fake.logout;
  close = fake.close;
  on = fake.on;
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));
vi.mock("../db.js", () => {
  const prisma = {
    linkedInboxAccount: {
      findMany: (...args: unknown[]) => fake.findMany(...args),
      updateMany: (...args: unknown[]) => fake.updateMany(...args),
    },
  };
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({
  captureError: (...args: unknown[]) => fake.captureError(...args),
}));
vi.mock("../crypto-tokens.js", () => ({
  encryptToken: vi.fn(),
  decryptToken: (...args: unknown[]) => fake.decryptToken(...args),
}));
vi.mock("../mail/gmail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mail/gmail.js")>()),
  notifyLinkedInboxReconnect: (...args: unknown[]) => fake.notify(...args),
}));
vi.mock("../judge/attention-mirror.js", () => ({ upsertAttentionForEmailJudgement: vi.fn() }));
vi.mock("../judge/poc-judge.js", () => ({ judgeEmail: vi.fn() }));

const { syncImapAccountsForUser } = await import("../mail/imap-accounts.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { IMAP_PRESET_KEYS } = await import("../mail/imap-preset-keys.js");
const { resetPollFailureState } = await import("../mail/imap-poll-failures.js");
const { resetPollBackoffState } = await import("../mail/imap-poll-backoff.js");
const { resetImapSessionState } = await import("../mail/providers/imap-session.js");

const authRejected = () =>
  Object.assign(new Error("Command failed"), { authenticationFailed: true });
const flagCalls = () =>
  fake.updateMany.mock.calls.filter(
    (call) => (call[0] as { data: { needsReconnect?: boolean } }).data.needsReconnect === true,
  );

beforeEach(() => {
  vi.clearAllMocks();
  resetImapSessionState();
  resetPollFailureState();
  resetPollBackoffState();
  fake.ctorCalls.length = 0;
  fake.connect.mockRejectedValue(authRejected());
  fake.logout.mockResolvedValue(undefined);
  fake.decryptToken.mockReturnValue("app-pw");
  fake.updateMany.mockResolvedValue({ count: 1 });
  fake.notify.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a preset's refused app password says reconnect after one poll", () => {
  it.each(IMAP_PRESET_KEYS)("%s", async (key) => {
    const provider = IMAP_PROVIDERS[key];
    const host = provider.defaultHost as string;
    fake.findMany.mockResolvedValue([
      {
        id: "row-p",
        email: "me@example.com",
        imapHost: host,
        imapPasswordCipher: "v2:p",
        inboxUidValidity: "7",
      },
    ]);

    await syncImapAccountsForUser("u1", provider);

    // Only the preset's fixed host, implicit TLS, and no certificate override.
    expect(fake.ctorCalls).toHaveLength(1);
    const opts = fake.ctorCalls[0] as Record<string, unknown>;
    expect(opts.host).toBe(host.split(":")[0]);
    expect(opts.port).toBe(993);
    expect(opts.secure).toBe(true);
    expect(opts).not.toHaveProperty("tls");
    expect(opts.auth).toEqual({ user: "me@example.com", pass: "app-pw" });

    expect(flagCalls()[0]).toEqual([
      {
        where: { id: "row-p", userId: "u1", imapPasswordCipher: "v2:p", needsReconnect: false },
        data: { needsReconnect: true },
      },
    ]);
    expect(fake.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ imapPasswordCipher: "v2:p" }),
        data: { syncErrorCode: "auth", syncErrorAt: expect.any(Date) },
      }),
    );
    expect(fake.notify).toHaveBeenCalledWith("u1", "row-p", key);
  });

  it("a row whose stored host belongs to another preset is never connected", async () => {
    fake.findMany.mockResolvedValue([
      {
        id: "row-x",
        email: "me@example.com",
        imapHost: "imap.fastmail.com:993",
        imapPasswordCipher: "v2:x",
        inboxUidValidity: "7",
      },
    ]);
    await syncImapAccountsForUser("u1", IMAP_PROVIDERS.YAHOO);
    expect(fake.ctorCalls).toHaveLength(0);
    expect(flagCalls()).toHaveLength(0);
  });
});

describe("reconnect alert copy", () => {
  it("names every preset", async () => {
    const { reconnectProviderLabel } = await import("../notify/reconnect-notification.js");
    for (const key of IMAP_PRESET_KEYS) {
      expect(reconnectProviderLabel(key)).toMatch(/\S/);
    }
  });
});
