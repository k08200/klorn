/**
 * Step B1 of docs/providers/unified-platform-plan.md: IMAP flag actions
 * (read, unread, star) for NAVER and ICLOUD.
 *
 * The imapflow client is faked (there is no public Naver/iCloud sandbox).
 * These pin: the exact imapflow calls (`{uid: true}` on INBOX), that success is
 * reported only when the server confirmed the flag, that a malformed or foreign
 * message id, an account of another user, or a host that does not match the
 * provider never opens a connection, the auth/transport failure contract, that
 * the connection is always closed, the explicit timeouts, that credentials and
 * message ids never reach the logs, and that every other action stays
 * `unsupported`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ctorOpts: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  getMailboxLock: vi.fn(),
  messageFlagsAdd: vi.fn(),
  messageFlagsRemove: vi.fn(),
  fetchOne: vi.fn(),
  logout: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  release: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  decryptToken: vi.fn(),
  captureError: vi.fn(),
}));

class FakeImapFlow {
  constructor(opts: Record<string, unknown>) {
    h.ctorOpts.push(opts);
  }
  connect = h.connect;
  getMailboxLock = h.getMailboxLock;
  messageFlagsAdd = h.messageFlagsAdd;
  messageFlagsRemove = h.messageFlagsRemove;
  fetchOne = h.fetchOne;
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

const {
  imapMailActions,
  IMAP_ACTION_CONNECT_TIMEOUT_MS,
  IMAP_ACTION_GREETING_TIMEOUT_MS,
  IMAP_ACTION_SOCKET_TIMEOUT_MS,
} = await import("../mail/providers/imap.js");
const { unsupportedMailActions } = await import("../mail/providers/unsupported.js");

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

/** A server that stores the flag: the confirming FETCH shows the new state. */
function armServer(opts: { flagsAfter?: string[] | false } = {}) {
  h.connect.mockResolvedValue(undefined);
  h.getMailboxLock.mockResolvedValue({ release: h.release });
  h.messageFlagsAdd.mockResolvedValue(true);
  h.messageFlagsRemove.mockResolvedValue(true);
  h.logout.mockResolvedValue(undefined);
  h.fetchOne.mockImplementation(async () =>
    opts.flagsAfter === false ? false : { uid: 0, flags: new Set(opts.flagsAfter ?? []) },
  );
}

function armAccount(row: typeof NAVER_ROW | Record<string, unknown> | null = NAVER_ROW) {
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

  it("markAsRead adds \\Seen by UID on INBOX, confirms it, and mirrors it locally", async () => {
    armServer({ flagsAfter: ["\\Seen"] });
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(result).toEqual({ success: true });
    expect(h.getMailboxLock).toHaveBeenCalledWith("INBOX");
    expect(h.messageFlagsAdd).toHaveBeenCalledWith("101", ["\\Seen"], { uid: true });
    expect(h.messageFlagsRemove).not.toHaveBeenCalled();
    expect(h.fetchOne).toHaveBeenCalledWith("101", { flags: true }, { uid: true });
    expect(h.updateMany).toHaveBeenCalledTimes(1);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", gmailId: NAVER_MSG },
      data: { isRead: true },
    });
  });

  it("toggleRead(true) adds \\Seen and toggleRead(false) removes it", async () => {
    armServer({ flagsAfter: ["\\Seen"] });
    expect(await actions().toggleRead("u1", NAVER_MSG, true, "row-1")).toEqual({ success: true });
    expect(h.messageFlagsAdd).toHaveBeenCalledWith("101", ["\\Seen"], { uid: true });
    expect(h.updateMany).toHaveBeenLastCalledWith({
      where: { userId: "u1", gmailId: NAVER_MSG },
      data: { isRead: true },
    });

    vi.clearAllMocks();
    armAccount();
    armServer({ flagsAfter: [] });
    expect(await actions().toggleRead("u1", NAVER_MSG, false, "row-1")).toEqual({ success: true });
    expect(h.messageFlagsRemove).toHaveBeenCalledWith("101", ["\\Seen"], { uid: true });
    expect(h.messageFlagsAdd).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenLastCalledWith({
      where: { userId: "u1", gmailId: NAVER_MSG },
      data: { isRead: false },
    });
  });

  it("toggleStar(true) adds \\Flagged and toggleStar(false) removes it", async () => {
    armServer({ flagsAfter: ["\\Flagged"] });
    expect(await actions().toggleStar("u1", NAVER_MSG, true, "row-1")).toEqual({ success: true });
    expect(h.messageFlagsAdd).toHaveBeenCalledWith("101", ["\\Flagged"], { uid: true });
    expect(h.updateMany).toHaveBeenLastCalledWith({
      where: { userId: "u1", gmailId: NAVER_MSG },
      data: { isStarred: true },
    });

    vi.clearAllMocks();
    armAccount();
    armServer({ flagsAfter: ["\\Seen"] });
    expect(await actions().toggleStar("u1", NAVER_MSG, false, "row-1")).toEqual({ success: true });
    expect(h.messageFlagsRemove).toHaveBeenCalledWith("101", ["\\Flagged"], { uid: true });
    expect(h.updateMany).toHaveBeenLastCalledWith({
      where: { userId: "u1", gmailId: NAVER_MSG },
      data: { isStarred: false },
    });
  });

  it("resolves the account by (id, userId, provider) and connects with its decrypted credentials", async () => {
    armServer({ flagsAfter: ["\\Seen"] });
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
    armServer({ flagsAfter: ["\\Seen"] });
    await actions().markAsRead("u1", NAVER_MSG, "row-1");
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.logout).toHaveBeenCalledTimes(1);
  });
});

describe("read and star over IMAP flags — ICLOUD", () => {
  beforeEach(() => armAccount(ICLOUD_ROW));

  it("uses the icloud-imap id, the iCloud host and an ICLOUD-scoped account lookup", async () => {
    armServer({ flagsAfter: ["\\Seen"] });
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
    expect(h.logout.mock.calls.length + h.close.mock.calls.length).toBeGreaterThan(0);
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
    armServer({ flagsAfter: ["\\Seen"] });
    h.messageFlagsAdd.mockResolvedValue(false);
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(h.fetchOne).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("does not report success when the UID is gone from INBOX (STORE on a missing UID is a silent no-op)", async () => {
    armServer({ flagsAfter: false });
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(result).toMatchObject({ error: expect.stringMatching(/no longer|not found|INBOX/i) });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("does not report success when the server accepted the STORE but the flag did not stick (add)", async () => {
    armServer({ flagsAfter: [] });
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("does not report success when the flag is still set after a remove", async () => {
    armServer({ flagsAfter: ["\\Flagged"] });
    const result = await actions().toggleStar("u1", NAVER_MSG, false, "row-1");
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("accepts the confirming flags as an array as well as a Set", async () => {
    armServer();
    h.fetchOne.mockResolvedValue({ uid: 101, flags: ["\\Seen", "\\Flagged"] });
    expect(await actions().markAsRead("u1", NAVER_MSG, "row-1")).toEqual({ success: true });
  });
});

describe("the connection is always closed", () => {
  const actions = () => imapMailActions("NAVER");

  beforeEach(() => armAccount());

  it("logs out and releases the lock when the STORE throws", async () => {
    armServer();
    h.messageFlagsAdd.mockRejectedValue(new Error("socket hang up"));
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.logout).toHaveBeenCalledTimes(1);
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("logs out and releases the lock when the confirming FETCH throws", async () => {
    armServer();
    h.fetchOne.mockRejectedValue(new Error("boom"));
    const result = await actions().toggleRead("u1", NAVER_MSG, true, "row-1");

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.logout).toHaveBeenCalledTimes(1);
  });

  it("falls back to a hard close when LOGOUT itself fails", async () => {
    armServer({ flagsAfter: ["\\Seen"] });
    h.logout.mockRejectedValue(new Error("NoConnection"));
    const result = await actions().markAsRead("u1", NAVER_MSG, "row-1");

    expect(result).toEqual({ success: true });
    expect(h.close).toHaveBeenCalled();
  });

  it("closes the client even when connect() itself failed", async () => {
    armServer();
    h.connect.mockRejectedValue(new Error("ECONNREFUSED"));
    h.logout.mockRejectedValue(new Error("NoConnection"));
    await actions().markAsRead("u1", NAVER_MSG, "row-1");
    expect(h.close).toHaveBeenCalled();
  });

  it("registers an error listener so a late socket error cannot crash the process", async () => {
    armServer({ flagsAfter: ["\\Seen"] });
    await actions().markAsRead("u1", NAVER_MSG, "row-1");
    const listener = h.on.mock.calls.find(([event]) => event === "error")?.[1];
    expect(listener).toBeTypeOf("function");
    expect(() => listener(new Error("late socket error"))).not.toThrow();
  });
});

describe("explicit timeouts", () => {
  it("passes named connect, greeting and socket timeouts to the client", async () => {
    armAccount();
    armServer({ flagsAfter: ["\\Seen"] });
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
    h.connect.mockRejectedValue(new Error(`getaddrinfo ENOTFOUND imap.naver.com ${PASSWORD}`));
    const result = await imapMailActions("NAVER").toggleRead("u1", NAVER_MSG, true, "row-1");

    expect(JSON.stringify(result)).not.toContain(PASSWORD);
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
