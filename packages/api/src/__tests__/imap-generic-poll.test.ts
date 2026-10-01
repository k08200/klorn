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
  status: vi.fn(),
  release: vi.fn(),
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
  status = fake.status;
  mailbox = { uidValidity: 7n };
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
const { PinnedAddressError } = await import("../mail/pinned-address.js");
const { resetPollFailureState } = await import("../mail/imap-poll-failures.js");
const { IMAP_AUTH_COOLDOWN_MS, isCredentialCoolingDown, resetImapSessionState } = await import(
  "../mail/providers/imap-session.js"
);

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
  resetImapSessionState();
  resetPollFailureState();
  fake.ctorCalls.length = 0;
  fake.status.mockResolvedValue({ messages: 0 });
  fake.release.mockReturnValue(undefined);
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
    // Reported once, by the account fan-out (not also by the sync: that was a duplicate).
    const scopes = fake.captureError.mock.calls.map(
      (call) => (call[1] as { tags: { scope: string } }).tags.scope,
    );
    expect(scopes).toEqual(["generic-imap.account-sync"]);
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

const authRejected = () =>
  Object.assign(new Error("Command failed"), { authenticationFailed: true });
const connectError = (code: string) => Object.assign(new Error(`connect ${code}`), { code });
const CREDENTIAL_KEY = "row-1:v2:cipher";
const flagCalls = () =>
  fake.updateMany.mock.calls.filter(
    (call) => (call[0] as { data: { needsReconnect?: boolean } }).data.needsReconnect === true,
  );
const stampCalls = () =>
  fake.updateMany.mock.calls.filter(
    (call) => (call[0] as { data: { lastSyncedAt?: Date } }).data.lastSyncedAt !== undefined,
  );
const captureScopes = () =>
  fake.captureError.mock.calls.map((call) => (call[1] as { tags: { scope: string } }).tags.scope);

describe("a generic poll whose login was rejected", () => {
  beforeEach(() => {
    fake.connect.mockRejectedValue(authRejected());
  });

  it("flags the account for reconnect (scoped by id AND user) and starts the shared cooldown", async () => {
    const result = await syncImapAccountsForUser("u1", GENERIC);

    expect(result).toMatchObject({ errors: 1 });
    expect(fake.updateMany).toHaveBeenCalledWith({
      where: { id: "row-1", userId: "u1" },
      data: { needsReconnect: true },
    });
    expect(stampCalls()).toHaveLength(0);
    expect(isCredentialCoolingDown(CREDENTIAL_KEY)).toBe(true);
  });

  it("does not send the same password again on the next tick (the durable flag)", async () => {
    fake.findMany.mockResolvedValue([row({ needsReconnect: true })]);
    const result = await syncImapAccountsForUser("u1", GENERIC);
    expect(fake.resolve).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
    expect(result).toMatchObject({ errors: 0, fetched: 0 });
  });

  it("does not send it again within the cooldown even before the flag is read back", async () => {
    await syncImapAccountsForUser("u1", GENERIC); // rejected: cooldown starts
    fake.connect.mockClear();
    fake.resolve.mockClear();

    const result = await syncImapAccountsForUser("u1", GENERIC); // the row still says needsReconnect: false

    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.resolve).not.toHaveBeenCalled();
    expect(result).toMatchObject({ errors: 0 });
  });

  it("tries again once the cooldown has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await syncImapAccountsForUser("u1", GENERIC);
      expect(fake.connect).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + IMAP_AUTH_COOLDOWN_MS + 1);
      await syncImapAccountsForUser("u1", GENERIC);
      expect(fake.connect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a NEW password (a different stored cipher) is tried at once: the cooldown is per credential", async () => {
    await syncImapAccountsForUser("u1", GENERIC);
    fake.connect.mockClear();
    fake.findMany.mockResolvedValue([row({ imapPasswordCipher: "v2:other" })]);
    await syncImapAccountsForUser("u1", GENERIC);
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });

  it("an action's login rejection pauses the poll too (one shared cooldown)", async () => {
    const { startCredentialCooldown } = await import("../mail/providers/imap-session.js");
    startCredentialCooldown(GENERIC, "row-1", CREDENTIAL_KEY);
    await syncImapAccountsForUser("u1", GENERIC);
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it("a failure to write the flag does not stop the poll or throw", async () => {
    fake.updateMany.mockRejectedValue(new Error("db down"));
    await expect(syncImapAccountsForUser("u1", GENERIC)).resolves.toMatchObject({ errors: 1 });
    expect(isCredentialCoolingDown(CREDENTIAL_KEY)).toBe(true);
  });

  it("the next account is still polled", async () => {
    fake.findMany.mockResolvedValue([
      row({ id: "row-1", email: "a@example.com" }),
      row({ id: "row-2", email: "b@example.org", imapHost: "imap.example.org:993" }),
    ]);
    fake.connect.mockRejectedValueOnce(authRejected()).mockResolvedValueOnce(undefined);
    await syncImapAccountsForUser("u1", GENERIC);
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(flagCalls()).toHaveLength(1);
  });
});

describe("a generic poll that fails for any other reason", () => {
  it.each([
    ["a refused connection", () => connectError("ECONNREFUSED")],
    ["a timeout", () => connectError("ETIMEDOUT")],
    ["a certificate failure", () => connectError("ERR_TLS_CERT_ALTNAME_INVALID")],
    ["a blocked address", () => new PinnedAddressError("blocked-address", ["10.0.0.5"])],
    ["an unresolvable name", () => new PinnedAddressError("unresolvable")],
  ])("%s is retried next tick: no reconnect flag, no cooldown", async (_label, makeError) => {
    fake.connect.mockRejectedValue(makeError());
    fake.resolve.mockImplementation(async () => {
      const err = makeError();
      if (err instanceof PinnedAddressError) throw err;
      return ["93.184.216.34"];
    });

    await syncImapAccountsForUser("u1", GENERIC);
    await syncImapAccountsForUser("u1", GENERIC);

    expect(flagCalls()).toHaveLength(0);
    expect(isCredentialCoolingDown(CREDENTIAL_KEY)).toBe(false);
    expect(fake.resolve).toHaveBeenCalledTimes(2);
  });
});

describe("generic poll failures reach Sentry once per account and kind", () => {
  it("the same failure on every tick is one event, not one per tick", async () => {
    fake.connect.mockRejectedValue(connectError("ECONNREFUSED"));
    for (let tick = 0; tick < 5; tick++) await syncImapAccountsForUser("u1", GENERIC);
    expect(fake.captureError).toHaveBeenCalledTimes(1);
    expect(captureScopes()).toEqual(["generic-imap.account-sync"]);
    expect(fake.captureError.mock.calls[0][1]).toMatchObject({
      extra: { userId: "u1", linkedInboxAccountId: "row-1", failureKind: "ECONNREFUSED" },
    });
  });

  it("a different kind of failure is a new event", async () => {
    fake.connect.mockRejectedValueOnce(connectError("ECONNREFUSED"));
    await syncImapAccountsForUser("u1", GENERIC);
    fake.connect.mockRejectedValueOnce(connectError("ETIMEDOUT"));
    await syncImapAccountsForUser("u1", GENERIC);
    expect(fake.captureError).toHaveBeenCalledTimes(2);
  });

  it("a blocked name and an unresolvable name are different kinds", async () => {
    fake.resolve.mockResolvedValueOnce(["10.0.0.5"]);
    await syncImapAccountsForUser("u1", GENERIC);
    fake.resolve.mockResolvedValueOnce([]);
    await syncImapAccountsForUser("u1", GENERIC);
    const kinds = fake.captureError.mock.calls.map(
      (call) => (call[1] as { extra: { failureKind: string } }).extra.failureKind,
    );
    expect(kinds).toEqual(["blocked-address", "unresolvable"]);
  });

  it("a poll that succeeds re-arms the report: the next failure is reported again", async () => {
    fake.connect.mockRejectedValueOnce(connectError("ECONNREFUSED"));
    await syncImapAccountsForUser("u1", GENERIC);
    fake.getMailboxLock.mockResolvedValueOnce({ release: fake.release });
    fake.connect.mockResolvedValueOnce(undefined);
    await syncImapAccountsForUser("u1", GENERIC); // success
    fake.connect.mockRejectedValueOnce(connectError("ECONNREFUSED"));
    await syncImapAccountsForUser("u1", GENERIC);
    expect(fake.captureError).toHaveBeenCalledTimes(2);
  });

  it("each account is its own report", async () => {
    fake.findMany.mockResolvedValue([
      row({ id: "row-1", email: "a@example.com" }),
      row({ id: "row-2", email: "b@example.org", imapHost: "imap.example.org:993" }),
    ]);
    fake.connect.mockRejectedValue(connectError("ECONNREFUSED"));
    await syncImapAccountsForUser("u1", GENERIC);
    await syncImapAccountsForUser("u1", GENERIC);
    expect(fake.captureError).toHaveBeenCalledTimes(2);
  });

  it("an unexpected error without a usable code is the 'error' kind and still reported once", async () => {
    fake.connect.mockRejectedValue(new Error("weird\nthing"));
    await syncImapAccountsForUser("u1", GENERIC);
    await syncImapAccountsForUser("u1", GENERIC);
    expect(fake.captureError).toHaveBeenCalledTimes(1);
    expect(fake.captureError.mock.calls[0][1]).toMatchObject({ extra: { failureKind: "error" } });
  });

  it("the log line for a failed generic account is one capped line", async () => {
    fake.connect.mockRejectedValue(new Error(`bad\r\nFORGED ${"Y".repeat(20_000)}`));
    await syncImapAccountsForUser("u1", GENERIC);
    const lines = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => call.map(String).join(" "))
      .filter((line) => line.includes("row-1"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/[\r\n]/);
      expect(line.length).toBeLessThan(700);
    }
  });
});

describe("Naver and iCloud polls are unchanged", () => {
  const naverRow = () =>
    row({
      id: "row-n",
      email: "me@naver.com",
      imapHost: "imap.naver.com:993",
      imapPasswordCipher: "v2:n",
    });

  it("a rejected login is not flagged, not cooled down, and polled again; reported by both layers as before", async () => {
    fake.findMany.mockResolvedValue([naverRow()]);
    fake.connect.mockRejectedValue(authRejected());

    await syncImapAccountsForUser("u1", IMAP_PROVIDERS.NAVER);
    await syncImapAccountsForUser("u1", IMAP_PROVIDERS.NAVER);

    expect(flagCalls()).toHaveLength(0);
    expect(isCredentialCoolingDown("row-n:v2:n")).toBe(false);
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(captureScopes()).toEqual([
      "naver-imap.sync",
      "naver-imap.account-sync",
      "naver-imap.sync",
      "naver-imap.account-sync",
    ]);
    for (const call of fake.captureError.mock.calls) {
      expect((call[1] as { extra: Record<string, unknown> }).extra).not.toHaveProperty(
        "failureKind",
      );
    }
  });

  it("a row flagged needsReconnect is still polled (Naver's behaviour is not changed here)", async () => {
    fake.findMany.mockResolvedValue([{ ...naverRow(), needsReconnect: true }]);
    await syncImapAccountsForUser("u1", IMAP_PROVIDERS.NAVER);
    expect(fake.connect).toHaveBeenCalledTimes(1);
  });
});
