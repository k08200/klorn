/**
 * Step B1 of docs/providers/unified-platform-plan.md: IMAP flag actions
 * (read, unread, star) for NAVER and ICLOUD.
 *
 * The imapflow client is faked (there is no public Naver/iCloud sandbox) by a
 * small stateful server: one flag set per UID. These pin: the exact imapflow
 * calls (`{uid: true}` on INBOX), that success is reported only when the server
 * confirmed the flag, that a malformed or foreign message id, an account of
 * another user, or a host that does not match the provider never opens a
 * connection, the auth/transport failure contract, that the connection is
 * always closed, the explicit timeouts, that credentials and message ids never
 * reach the logs, that a database failure never throws, and that every other
 * action stays `unsupported`. Coalescing, the session cap and the auth cooldown
 * are in imap-action-sessions.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ctorOpts: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  getMailboxLock: vi.fn(),
  messageFlagsAdd: vi.fn(),
  messageFlagsRemove: vi.fn(),
  fetch: vi.fn(),
  logout: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  release: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  decryptToken: vi.fn(),
  captureError: vi.fn(),
  server: new Map<number, Set<string>>(),
  ignoreStore: false,
}));

class FakeImapFlow {
  constructor(opts: Record<string, unknown>) {
    h.ctorOpts.push(opts);
  }
  connect = h.connect;
  getMailboxLock = h.getMailboxLock;
  messageFlagsAdd = h.messageFlagsAdd;
  messageFlagsRemove = h.messageFlagsRemove;
  fetch = h.fetch;
  logout = h.logout;
  close = h.close;
  on = h.on;
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));
vi.mock("../db.js", () => {
  const prisma = {
    linkedInboxAccount: { findFirst: h.findFirst },
    emailMessage: { updateMany: h.updateMany },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", () => ({ decryptToken: h.decryptToken }));
vi.mock("../sentry.js", () => ({ captureError: h.captureError }));

const { imapMailActions } = await import("../mail/providers/imap.js");
const {
  IMAP_ACTION_CONNECT_TIMEOUT_MS,
  IMAP_ACTION_GREETING_TIMEOUT_MS,
  IMAP_ACTION_SOCKET_TIMEOUT_MS,
  resetImapSessionState,
} = await import("../mail/providers/imap-session.js");
const { unsupportedMailActions } = await import("../mail/providers/unsupported.js");

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// A caller gets its result as soon as its run settles, before LOGOUT and the
// hard close finish; teardown assertions wait one macrotask first.
const PASSWORD = "sup3r-secret-app-pw";
const CIPHER = "v2:k:iv:ct:tag";

const NAVER_ROW = {
  id: "row-1",
  email: "me@naver.com",
  imapHost: "imap.naver.com:993",
  imapPasswordCipher: CIPHER,
};
const ICLOUD_ROW = {
  id: "row-2",
  email: "me@icloud.com",
  imapHost: "imap.mail.me.com:993",
  imapPasswordCipher: CIPHER,
};

const NAVER_MSG = "naver-imap:me@naver.com:101";
const ICLOUD_MSG = "icloud-imap:me@icloud.com:202";

const authError = () =>
  Object.assign(new Error("Command failed"), {
    authenticationFailed: true,
    serverResponseCode: "AUTHENTICATIONFAILED",
  });

const uidsOf = (range: string) => range.split(",").map(Number);

/** A stateful fake server holding `uids`, each with `flags` (default none). */
function armServer(uids: number[] = [101], flags: string[] = []) {
  h.server = new Map(uids.map((uid) => [uid, new Set(flags)]));
  h.ignoreStore = false;
  h.connect.mockResolvedValue(undefined);
  h.getMailboxLock.mockResolvedValue({ release: h.release });
  h.logout.mockResolvedValue(undefined);
  const store = (add: boolean) => async (range: string, flagList: string[]) => {
    if (!h.ignoreStore) {
      for (const uid of uidsOf(range)) {
        for (const flag of flagList) {
          if (add) h.server.get(uid)?.add(flag);
          else h.server.get(uid)?.delete(flag);
        }
      }
    }
    return true;
  };
  h.messageFlagsAdd.mockImplementation(store(true));
  h.messageFlagsRemove.mockImplementation(store(false));
  h.fetch.mockImplementation((range: string) =>
    (async function* () {
      for (const uid of uidsOf(range)) {
        const held = h.server.get(uid);
        if (held) yield { uid, flags: new Set(held) };
      }
    })(),
  );
}

function armAccount(row: Record<string, unknown> | null = NAVER_ROW) {
  h.findFirst.mockResolvedValue(row);
  h.decryptToken.mockReturnValue(PASSWORD);
  h.updateMany.mockResolvedValue({ count: 1 });
}

function loggedText(): string {
  const spies = [console.warn, console.error, console.log] as unknown as Array<{
    mock: { calls: unknown[][] };
  }>;
  return spies
    .flatMap((s) => s.mock.calls.flat())
    .map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a)))
    .join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.ctorOpts.length = 0;
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

function expectNoConnection() {
  expect(h.ctorOpts).toHaveLength(0);
  expect(h.connect).not.toHaveBeenCalled();
  expect(h.messageFlagsAdd).not.toHaveBeenCalled();
  expect(h.messageFlagsRemove).not.toHaveBeenCalled();
  expect(h.updateMany).not.toHaveBeenCalled();
}

describe("read and star over IMAP flags — NAVER", () => {
  const actions = () => imapMailActions("NAVER");

  beforeEach(() => armAccount());

  it("markAsRead adds \\Seen by UID on INBOX, reads it back, and mirrors it locally", async () => {
    armServer([101]);
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(result).toEqual({ success: true });
    expect(h.getMailboxLock).toHaveBeenCalledWith("INBOX");
    expect(h.messageFlagsAdd).toHaveBeenCalledWith("101", ["\\Seen"], { uid: true });
    expect(h.messageFlagsRemove).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledWith("101", { flags: true }, { uid: true });
    expect(h.server.get(101)?.has("\\Seen")).toBe(true);
    expect(h.updateMany).toHaveBeenCalledTimes(1);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", gmailId: NAVER_MSG },
      data: { isRead: true },
    });
  });

  it("toggleRead(true) adds \\Seen and toggleRead(false) removes it", async () => {
    armServer([101]);
    expect(await actions().toggleRead("u1", NAVER_MSG, true, "row-1")).toEqual({ success: true });
    expect(h.messageFlagsAdd).toHaveBeenCalledWith("101", ["\\Seen"], { uid: true });
    expect(h.updateMany).toHaveBeenLastCalledWith({
      where: { userId: "u1", gmailId: NAVER_MSG },
      data: { isRead: true },
    });

    expect(await actions().toggleRead("u1", NAVER_MSG, false, "row-1")).toEqual({ success: true });
    expect(h.messageFlagsRemove).toHaveBeenCalledWith("101", ["\\Seen"], { uid: true });
    expect(h.server.get(101)?.has("\\Seen")).toBe(false);
    expect(h.updateMany).toHaveBeenLastCalledWith({
      where: { userId: "u1", gmailId: NAVER_MSG },
      data: { isRead: false },
    });
  });

  it("toggleStar(true) adds \\Flagged and toggleStar(false) removes it", async () => {
    armServer([101]);
    expect(await actions().toggleStar("u1", NAVER_MSG, true, "row-1")).toEqual({ success: true });
    expect(h.messageFlagsAdd).toHaveBeenCalledWith("101", ["\\Flagged"], { uid: true });
    expect(h.updateMany).toHaveBeenLastCalledWith({
      where: { userId: "u1", gmailId: NAVER_MSG },
      data: { isStarred: true },
    });

    expect(await actions().toggleStar("u1", NAVER_MSG, false, "row-1")).toEqual({ success: true });
    expect(h.messageFlagsRemove).toHaveBeenCalledWith("101", ["\\Flagged"], { uid: true });
    expect(h.updateMany).toHaveBeenLastCalledWith({
      where: { userId: "u1", gmailId: NAVER_MSG },
      data: { isStarred: false },
    });
  });

  it("resolves the account by (id, userId, provider) and connects with its decrypted credentials", async () => {
    armServer([101]);
    await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(h.findFirst).toHaveBeenCalledWith({
      where: { id: "row-1", userId: "u1", provider: "NAVER" },
      select: { id: true, email: true, imapHost: true, imapPasswordCipher: true },
    });
    expect(h.decryptToken).toHaveBeenCalledWith(CIPHER);
    expect(h.ctorOpts).toHaveLength(1);
    expect(h.ctorOpts[0]).toMatchObject({
      host: "imap.naver.com",
      port: 993,
      secure: true,
      auth: { user: "me@naver.com", pass: PASSWORD },
      logger: false,
    });
  });

  it("releases the mailbox lock and logs out after a confirmed change", async () => {
    armServer([101]);
    await actions().markAsRead("u1", NAVER_MSG, "row-1");
    await flush();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.logout).toHaveBeenCalledTimes(1);
  });
});

describe("read and star over IMAP flags — ICLOUD", () => {
  beforeEach(() => armAccount(ICLOUD_ROW));

  it("uses the icloud-imap id, the iCloud host and an ICLOUD-scoped account lookup", async () => {
    armServer([202]);
    const result = await imapMailActions("ICLOUD").markAsRead("u1", ICLOUD_MSG, "row-2");

    expect(result).toEqual({ success: true });
    expect(h.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "row-2", userId: "u1", provider: "ICLOUD" } }),
    );
    expect(h.ctorOpts[0]).toMatchObject({ host: "imap.mail.me.com", port: 993 });
    expect(h.messageFlagsAdd).toHaveBeenCalledWith("202", ["\\Seen"], { uid: true });
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", gmailId: ICLOUD_MSG },
      data: { isRead: true },
    });
  });

  it("refuses a NAVER message id on an iCloud mailbox without connecting", async () => {
    const result = await imapMailActions("ICLOUD").markAsRead("u1", NAVER_MSG, "row-2");
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("unsupported");
    expectNoConnection();
  });
});

describe("guards that must refuse before any connection", () => {
  const actions = () => imapMailActions("NAVER");
  const run = (id: string) => actions().markAsRead("u1", id, "row-1");

  it("errors when the caller passes no linked inbox account id", async () => {
    armAccount();
    for (const missing of [undefined, null, ""]) {
      const result = await actions().markAsRead("u1", NAVER_MSG, missing);
      expect(result).toMatchObject({ error: expect.any(String) });
      expect(result).not.toHaveProperty("unsupported");
    }
    expect(h.findFirst).not.toHaveBeenCalled();
    expectNoConnection();
  });

  it("errors when the account is not the caller's (lookup by id, userId and provider finds nothing)", async () => {
    armAccount(null);
    const result = await run(NAVER_MSG);
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("unsupported");
    expect(h.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "row-1", userId: "u1", provider: "NAVER" } }),
    );
    expectNoConnection();
  });

  it.each([
    ["malformed uid", "naver-imap:me@naver.com:abc"],
    ["uid zero", "naver-imap:me@naver.com:0"],
    ["range injection", "naver-imap:me@naver.com:1:*"],
    ["list injection", "naver-imap:me@naver.com:1,2"],
    ["another mailbox's email", "naver-imap:someone-else@naver.com:101"],
    ["another provider's prefix", "icloud-imap:me@naver.com:101"],
    ["a Gmail id", "18c2f0a1b2c3d4e5"],
    ["empty", ""],
  ])("refuses a %s", async (_label, id) => {
    armAccount();
    const result = await run(id);
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("unsupported");
    expectNoConnection();
  });

  it("refuses when the row's host belongs to the other provider (host pin)", async () => {
    armAccount({ ...NAVER_ROW, imapHost: "imap.mail.me.com:993" });
    const result = await run(NAVER_MSG);
    expect(result).toMatchObject({ error: expect.any(String) });
    expectNoConnection();
  });

  it("refuses a host outside the SSRF allowlist", async () => {
    armAccount({ ...NAVER_ROW, imapHost: "169.254.169.254:993" });
    const result = await run(NAVER_MSG);
    expect(result).toMatchObject({ error: expect.any(String) });
    expectNoConnection();
  });

  it("refuses a row that lost its credentials", async () => {
    armAccount({ ...NAVER_ROW, imapPasswordCipher: null });
    const result = await run(NAVER_MSG);
    expect(result).toMatchObject({ error: expect.any(String) });
    expectNoConnection();
  });

  it("errors, without connecting, when the stored password cannot be decrypted", async () => {
    armAccount();
    h.decryptToken.mockImplementation(() => {
      throw new Error("Malformed encrypted token");
    });
    const result = await run(NAVER_MSG);
    expect(result).toMatchObject({ error: expect.stringMatching(/reconnect/i) });
    expectNoConnection();
  });
});

describe("a database failure never throws", () => {
  const actions = () => imapMailActions("NAVER");

  it("answers {error}, without connecting, when the account lookup throws", async () => {
    armAccount();
    h.findFirst.mockRejectedValue(new Error("connection pool exhausted"));
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("unsupported");
    expectNoConnection();
    expect(h.captureError).toHaveBeenCalledTimes(1);
  });

  it("answers {error} that says the server changed, when the local update throws after a confirmed change", async () => {
    armAccount();
    armServer([101]);
    h.updateMany.mockRejectedValue(new Error("deadlock detected"));
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(result).toMatchObject({ error: expect.stringMatching(/local copy|next sync/i) });
    expect(result).not.toHaveProperty("success");
    expect(h.server.get(101)?.has("\\Seen")).toBe(true);
    expect(h.captureError).toHaveBeenCalledTimes(1);
  });
});

describe("database errors are logged without their raw text", () => {
  // Prisma error text can embed the query arguments, and for an IMAP row that
  // includes the gmailId, which contains the mailbox address.
  const rawPrismaError = () =>
    Object.assign(
      new Error(
        "Invalid `prisma.emailMessage.updateMany()` invocation: where: { gmailId: 'naver-imap:me@naver.com:101' }",
      ),
      { name: "PrismaClientKnownRequestError", code: "P2034" },
    );

  function expectSanitized() {
    const text = loggedText();
    expect(text).not.toContain("me@naver.com");
    expect(text).not.toContain("naver-imap:");
    expect(text).not.toContain("invocation");
    expect(text).toContain("row-1");
    expect(text).toContain("PrismaClientKnownRequestError");
    const captured = JSON.stringify(
      h.captureError.mock.calls.map(([e, ctx]) => [String(e), (e as Error)?.message, ctx]),
    );
    expect(captured).not.toContain("me@naver.com");
    expect(captured).not.toContain("naver-imap:");
    expect(captured).not.toContain("invocation");
    expect(h.captureError).toHaveBeenCalledTimes(1);
    expect(h.captureError.mock.calls[0][1]).toMatchObject({
      extra: { userId: "u1", linkedInboxAccountId: "row-1" },
    });
  }

  it("for a failed account lookup", async () => {
    armAccount();
    h.findFirst.mockRejectedValue(rawPrismaError());
    const result = await imapMailActions("NAVER").markAsRead("u1", NAVER_MSG, "row-1");
    expect(result).toMatchObject({ error: expect.any(String) });
    expectSanitized();
  });

  it("for a failed local update after a confirmed change", async () => {
    armAccount();
    armServer([101]);
    h.updateMany.mockRejectedValue(rawPrismaError());
    const result = await imapMailActions("NAVER").markAsRead("u1", NAVER_MSG, "row-1");
    expect(result).toMatchObject({ error: expect.stringMatching(/local copy/i) });
    expectSanitized();
  });

  it("keeps the error code, when there is one, and survives a non-Error throw", async () => {
    armAccount();
    h.findFirst.mockRejectedValue(rawPrismaError());
    await imapMailActions("NAVER").markAsRead("u1", NAVER_MSG, "row-1");
    expect(loggedText()).toContain("P2034");

    vi.clearAllMocks();
    armAccount();
    h.findFirst.mockRejectedValue("a bare string mentioning me@naver.com");
    const result = await imapMailActions("NAVER").markAsRead("u1", NAVER_MSG, "row-1");
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(loggedText()).not.toContain("me@naver.com");
  });
});

describe("failure contract", () => {
  const actions = () => imapMailActions("NAVER");

  beforeEach(() => armAccount());

  it("answers a soft error on an authentication failure, closes the client and writes nothing locally", async () => {
    armServer();
    h.connect.mockRejectedValue(authError());
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(result).toMatchObject({ error: expect.stringMatching(/reconnect/i) });
    expect(result).not.toHaveProperty("unsupported");
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.messageFlagsAdd).not.toHaveBeenCalled();
    await flush();
    expect(h.close).toHaveBeenCalled();
  });

  it("answers a soft error (never throws) on a transport failure", async () => {
    armServer();
    h.connect.mockRejectedValue(
      Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
    );
    const result = await actions().toggleStar("u1", NAVER_MSG, true, "row-1");

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("unsupported");
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.captureError).toHaveBeenCalledTimes(1);
  });

  it("does not report success when the server refuses the STORE", async () => {
    armServer([101]);
    h.messageFlagsAdd.mockResolvedValue(false);
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
    await flush();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("does not report success when the UID is gone from INBOX (STORE on a missing UID is a silent no-op)", async () => {
    armServer([]);
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(result).toMatchObject({ error: expect.stringMatching(/no longer|not found|INBOX/i) });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("does not report success when the server accepted the STORE but the flag did not stick (add)", async () => {
    armServer([101]);
    h.ignoreStore = true;
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("does not report success when the flag is still set after a remove", async () => {
    armServer([101], ["\\Flagged"]);
    h.ignoreStore = true;
    const result = await actions().toggleStar("u1", NAVER_MSG, false, "row-1");
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["add", true],
    ["remove", false],
  ])("never reports success when the read-back carries no FLAGS at all (%s)", async (_label, set) => {
    armServer([101]);
    // A FETCH response without a FLAGS item must not read as "flag absent" —
    // that would confirm every remove.
    h.fetch.mockImplementation(() =>
      (async function* () {
        yield { uid: 101 };
      })(),
    );
    const result = await actions().toggleRead("u1", NAVER_MSG, set, "row-1");
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("success");
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("accepts the confirming flags as an array as well as a Set", async () => {
    armServer([101]);
    h.fetch.mockImplementation(() =>
      (async function* () {
        yield { uid: 101, flags: ["\\Seen", "\\Flagged"] };
      })(),
    );
    expect(await actions().markAsRead("u1", NAVER_MSG, "row-1")).toEqual({ success: true });
  });
});

describe("the connection is always closed", () => {
  const actions = () => imapMailActions("NAVER");

  beforeEach(() => armAccount());

  it("logs out and releases the lock when the STORE throws", async () => {
    armServer([101]);
    h.messageFlagsAdd.mockRejectedValue(new Error("socket hang up"));
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(result).toMatchObject({ error: expect.any(String) });
    await flush();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("logs out and releases the lock when the confirming FETCH throws", async () => {
    armServer([101]);
    h.fetch.mockImplementation(() => {
      throw new Error("boom");
    });
    const result = await actions().toggleRead("u1", NAVER_MSG, true, "row-1");

    expect(result).toMatchObject({ error: expect.any(String) });
    await flush();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.logout).toHaveBeenCalledTimes(1);
  });

  it("falls back to a hard close when LOGOUT itself fails", async () => {
    armServer([101]);
    h.logout.mockRejectedValue(new Error("NoConnection"));
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(result).toEqual({ success: true });
    await flush();
    expect(h.close).toHaveBeenCalled();
  });

  it("closes the client even when connect() itself failed", async () => {
    armServer();
    h.connect.mockRejectedValue(new Error("ECONNREFUSED"));
    h.logout.mockRejectedValue(new Error("NoConnection"));
    await actions().markAsRead("u1", NAVER_MSG, "row-1");
    await flush();
    expect(h.close).toHaveBeenCalled();
  });

  it("registers an error listener so a late socket error cannot crash the process", async () => {
    armServer([101]);
    await actions().markAsRead("u1", NAVER_MSG, "row-1");
    const listener = h.on.mock.calls.find(([event]) => event === "error")?.[1];
    expect(listener).toBeTypeOf("function");
    expect(() => listener(new Error("late socket error"))).not.toThrow();
  });
});

describe("explicit timeouts", () => {
  it("passes named connect, greeting and socket timeouts to the client", async () => {
    armAccount();
    armServer([101]);
    await imapMailActions("NAVER").markAsRead("u1", NAVER_MSG, "row-1");

    expect(h.ctorOpts[0]).toMatchObject({
      connectionTimeout: IMAP_ACTION_CONNECT_TIMEOUT_MS,
      greetingTimeout: IMAP_ACTION_GREETING_TIMEOUT_MS,
      socketTimeout: IMAP_ACTION_SOCKET_TIMEOUT_MS,
    });
  });

  it("keeps every timeout finite and fail-fast (a user is waiting on the route)", () => {
    for (const ms of [
      IMAP_ACTION_CONNECT_TIMEOUT_MS,
      IMAP_ACTION_GREETING_TIMEOUT_MS,
      IMAP_ACTION_SOCKET_TIMEOUT_MS,
    ]) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(30_000);
    }
  });
});

describe("logging never leaks credentials or message ids", () => {
  it("keeps the password, the mailbox email and the message id out of logs and Sentry on auth failure", async () => {
    armAccount();
    armServer();
    h.connect.mockRejectedValue(authError());
    await imapMailActions("NAVER").markAsRead("u1", NAVER_MSG, "row-1");

    const text = loggedText();
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("me@naver.com");
    expect(text).not.toContain(NAVER_MSG);
    expect(JSON.stringify(h.captureError.mock.calls)).not.toContain(PASSWORD);
    expect(JSON.stringify(h.captureError.mock.calls)).not.toContain("me@naver.com");
  });

  it("keeps them out on a transport failure and does not reflect server text to the caller", async () => {
    armAccount();
    armServer();
    h.connect.mockRejectedValue(new Error("getaddrinfo ENOTFOUND imap.naver.com"));
    const result = await imapMailActions("NAVER").toggleRead("u1", NAVER_MSG, true, "row-1");

    expect(JSON.stringify(result)).not.toContain("ENOTFOUND");
    expect(loggedText()).not.toContain("me@naver.com");
    expect(loggedText()).not.toContain(NAVER_MSG);
  });
});

describe("everything else stays exactly as today", () => {
  it.each([
    "NAVER",
    "ICLOUD",
  ] as const)("%s: send, drafts, trash and archive answer the same unsupported result and never connect", async (provider) => {
    const flagged = imapMailActions(provider);
    const baseline = unsupportedMailActions(provider);

    expect(flagged.provider).toBe(provider);
    expect(await flagged.sendEmail("u1", "a@b.c", "s", "b")).toEqual(
      await baseline.sendEmail("u1", "a@b.c", "s", "b"),
    );
    expect(
      await flagged.createDraft("u1", { to: "a@b.c", subject: "s", body: "b", reply: {} }),
    ).toEqual(await baseline.createDraft("u1", { to: "a@b.c", subject: "s", body: "b" }));
    for (const name of ["trash", "untrash", "archive", "unarchive"] as const) {
      const got = await flagged[name]("u1", NAVER_MSG, "row-1");
      expect(got).toEqual(await baseline[name]("u1", NAVER_MSG, "row-1"));
      expect(got).toMatchObject({ unsupported: true });
    }
    expect(await flagged.getReplyHeaders("u1", NAVER_MSG, "row-1")).toEqual({});
    expectNoConnection();
    expect(h.findFirst).not.toHaveBeenCalled();
  });
});
