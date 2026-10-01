/**
 * Step B4: generic IMAP rows are polled through the same pinned connection path as
 * every other generic connection. Real imap-accounts, imap-sync and
 * imap-connection; imapflow, the resolver and the database are faked.
 *
 *   - a generic row is selected by provider IMAP and its INBOX is opened over a
 *     connection whose target is the checked address, the name being the TLS name;
 *   - a row whose name has since turned private (rebinding after the connect route
 *     verified it) is not connected to, is counted as an error, and does not stamp
 *     "synced";
 *   - a stored host the grammar refuses never builds a client;
 *   - one account's failure does not block the next.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  ctorCalls: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  getMailboxLock: vi.fn(),
  logout: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  resolve: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  decryptToken: vi.fn(),
  captureError: vi.fn(),
}));

class FakeImapFlow {
  constructor(opts: Record<string, unknown>) {
    fake.ctorCalls.push(opts);
  }
  connect = fake.connect;
  getMailboxLock = fake.getMailboxLock;
  logout = fake.logout;
  close = fake.close;
  on = fake.on;
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));
vi.mock("../mail/host-resolver.js", () => ({
  DNS_QUERY_TIMEOUT_MS: 3000,
  resolveHostAddresses: (...args: unknown[]) => fake.resolve(...args),
}));
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
vi.mock("../judge/attention-mirror.js", () => ({ upsertAttentionForEmailJudgement: vi.fn() }));
vi.mock("../judge/poc-judge.js", () => ({ judgeEmail: vi.fn() }));

const { syncImapAccountsForUser } = await import("../mail/imap-accounts.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");

const GENERIC = IMAP_PROVIDERS.IMAP;
const PUBLIC_IP = "93.184.216.34";

const row = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  email: "me@example.com",
  imapHost: "imap.example.com:993",
  imapPasswordCipher: "v2:cipher",
  inboxUidValidity: "7",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  fake.ctorCalls.length = 0;
  fake.resolve.mockResolvedValue([PUBLIC_IP]);
  fake.connect.mockResolvedValue(undefined);
  // Stop the poll right after the INBOX is asked for: what matters here is the
  // connection, and everything after the lock is unchanged B2 code.
  fake.getMailboxLock.mockRejectedValue(new Error("stop after INBOX"));
  fake.logout.mockResolvedValue(undefined);
  fake.decryptToken.mockReturnValue("app-pw");
  fake.updateMany.mockResolvedValue({ count: 1 });
  fake.findMany.mockResolvedValue([row()]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("polling a generic IMAP row", () => {
  it("selects only this user's IMAP rows", async () => {
    await syncImapAccountsForUser("u1", GENERIC);
    expect(fake.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u1", provider: "IMAP" } }),
    );
  });

  it("opens INBOX over a connection to the checked address, with the name as the TLS name", async () => {
    let tlsAtConnect: Record<string, unknown> | undefined;
    fake.connect.mockImplementation(async () => {
      tlsAtConnect = { ...(fake.ctorCalls[0].tls as Record<string, unknown>) };
    });

    const result = await syncImapAccountsForUser("u1", GENERIC);

    expect(fake.resolve).toHaveBeenCalledWith("imap.example.com");
    expect(tlsAtConnect).toMatchObject({
      host: PUBLIC_IP,
      servername: "imap.example.com",
      rejectUnauthorized: true,
    });
    expect(fake.ctorCalls[0]).toMatchObject({
      port: 993,
      secure: true,
      auth: { user: "me@example.com", pass: "app-pw" },
    });
    expect(String(fake.ctorCalls[0].host)).toMatch(/\.invalid$/);
    expect(fake.getMailboxLock).toHaveBeenCalledWith("INBOX");
    // The stop after INBOX is this test's own failure, counted like any other.
    expect(result).toMatchObject({ errors: 1 });
  });

  it("a name that has turned private since it was verified is not connected to", async () => {
    fake.resolve.mockResolvedValue(["192.168.1.20"]);

    const result = await syncImapAccountsForUser("u1", GENERIC);

    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.getMailboxLock).not.toHaveBeenCalled();
    expect(fake.updateMany).not.toHaveBeenCalled(); // "synced just now" is not stamped
    expect(result).toMatchObject({ fetched: 0, inserted: 0, errors: 1 });
    // Reported like any failed poll: once by the sync, once by the account fan-out.
    const scopes = fake.captureError.mock.calls.map(
      (call) => (call[1] as { tags: { scope: string } }).tags.scope,
    );
    expect(scopes).toEqual(["generic-imap.sync", "generic-imap.account-sync"]);
  });

  it("every poll resolves again (nothing is remembered between ticks)", async () => {
    await syncImapAccountsForUser("u1", GENERIC);
    await syncImapAccountsForUser("u1", GENERIC);
    expect(fake.resolve).toHaveBeenCalledTimes(2);
  });

  it.each([
    "127.0.0.1:993",
    "169.254.169.254:993",
    "printer.local:993",
    "imap.example.com:143",
    "user@imap.example.com:993",
  ])("a stored host of %j never builds a client", async (imapHost) => {
    fake.findMany.mockResolvedValue([row({ imapHost })]);
    const result = await syncImapAccountsForUser("u1", GENERIC);
    expect(fake.ctorCalls).toHaveLength(0);
    expect(fake.resolve).not.toHaveBeenCalled();
    expect(result).toMatchObject({ errors: 0 });
  });

  it("one account's blocked name does not stop the next account", async () => {
    fake.findMany.mockResolvedValue([
      row({ id: "row-1", email: "a@example.com", imapHost: "rebound.example.com:993" }),
      row({ id: "row-2", email: "b@example.org", imapHost: "imap.example.org:993" }),
    ]);
    fake.resolve.mockImplementation(async (name: string) =>
      name === "rebound.example.com" ? ["10.1.1.1"] : [PUBLIC_IP],
    );

    const result = await syncImapAccountsForUser("u1", GENERIC);

    expect(fake.resolve).toHaveBeenCalledTimes(2);
    expect(fake.connect).toHaveBeenCalledTimes(1); // only the second account reached the library
    expect(fake.getMailboxLock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ errors: 2 }); // first blocked, second stopped after INBOX
  });
});
