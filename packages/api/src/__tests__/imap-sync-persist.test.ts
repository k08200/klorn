/**
 * syncImapInbox must go through the SHARED persist path (persistGmailEmail)
 * instead of its own raw upsert + inline judge (Phase 1 of the multi-provider
 * plan). That buys Naver mail everything the Gmail path already has: judge +
 * attention mirroring with PUSH interrupts, judge-health recording, commitment
 * mining, fromAddress normalization — and replaces the fragile "created in the
 * last 60s" is-new heuristic with the persist result's `isNew`.
 *
 * The IMAP roundtrip is faked (no public Naver sandbox); persistGmailEmail is
 * mocked at the module boundary and the test asserts the normalized
 * GmailRawEmail shape the IMAP path hands it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const imap = vi.hoisted(() => ({
  ctorOpts: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  getMailboxLock: vi.fn(),
  logout: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  status: vi.fn(),
  fetch: vi.fn(),
  release: vi.fn(),
}));

class FakeImapFlow {
  constructor(opts: Record<string, unknown>) {
    imap.ctorOpts.push(opts);
  }
  connect = imap.connect;
  getMailboxLock = imap.getMailboxLock;
  logout = imap.logout;
  close = imap.close;
  on = imap.on;
  status = imap.status;
  fetch = imap.fetch;
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));

const persistGmailEmail = vi.hoisted(() => vi.fn());
const judgeEmail = vi.hoisted(() => vi.fn());

vi.mock("../judge/email-firewall.js", () => ({ persistGmailEmail }));
vi.mock("../judge/poc-judge.js", () => ({ judgeEmail }));
vi.mock("../db.js", () => ({ prisma: {}, db: {} }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { syncImapInbox } = await import("../mail/imap-sync.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");

const RECEIVED = new Date("2026-08-01T09:00:00Z");

function fakeMessages() {
  return [
    {
      uid: 101,
      envelope: {
        from: [{ name: "Kim", address: "kim@example.com" }],
        to: [{ name: "", address: "me@naver.com" }],
        cc: null,
        subject: "회의 일정",
        date: RECEIVED,
      },
      flags: new Set<string>(),
      bodyParts: new Map([["text", Buffer.from("Hello   world")]]),
    },
    {
      uid: 102,
      envelope: {
        from: [{ name: "", address: "news@letter.com" }],
        to: [{ name: "", address: "me@naver.com" }],
        cc: [{ name: "", address: "cc@x.com" }],
        subject: "Weekly digest",
        date: RECEIVED,
      },
      flags: new Set(["\\Seen", "\\Flagged"]),
      bodyParts: new Map(),
    },
  ];
}

function armImap() {
  imap.connect.mockResolvedValue(undefined);
  imap.getMailboxLock.mockResolvedValue({ release: imap.release });
  imap.logout.mockResolvedValue(undefined);
  imap.status.mockResolvedValue({ messages: 2 });
  imap.fetch.mockImplementation(async function* () {
    for (const m of fakeMessages()) yield m;
  });
}

describe("syncImapInbox → shared persist path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    imap.ctorOpts.length = 0;
    armImap();
  });

  it("hands each message to persistGmailEmail as a normalized raw email", async () => {
    persistGmailEmail
      .mockResolvedValueOnce({ emailId: "e1", isNew: true })
      .mockResolvedValueOnce({ emailId: "e2", isNew: false });

    const result = await syncImapInbox({
      provider: IMAP_PROVIDERS.NAVER,
      userId: "u1",
      email: "me@naver.com",
      password: "app-pw",
      host: "imap.naver.com:993",
      linkedInboxAccountId: "acc-naver",
    });

    expect(persistGmailEmail).toHaveBeenCalledTimes(2);

    expect(persistGmailEmail).toHaveBeenNthCalledWith(
      1,
      "u1",
      expect.objectContaining({
        gmailId: "naver-imap:me@naver.com:101",
        threadId: null,
        from: "Kim <kim@example.com>",
        to: "me@naver.com",
        subject: "회의 일정",
        snippet: "Hello world",
        body: "Hello   world",
        labels: ["INBOX", "UNREAD"],
        isRead: false,
        isStarred: false,
        receivedAt: RECEIVED,
        attachments: [],
      }),
      // userEmail must be the Naver mailbox's own address — self-sent detection
      // and commitment senderIsUser compare against THIS inbox, not the
      // primary Google account (same pattern as email-sync's linked fan-out).
      expect.objectContaining({ linkedInboxAccountId: "acc-naver", userEmail: "me@naver.com" }),
    );

    expect(persistGmailEmail).toHaveBeenNthCalledWith(
      2,
      "u1",
      expect.objectContaining({
        gmailId: "naver-imap:me@naver.com:102",
        labels: ["INBOX", "IMPORTANT"],
        isRead: true,
        isStarred: true,
      }),
      expect.objectContaining({ linkedInboxAccountId: "acc-naver" }),
    );

    // isNew from the persist result replaces the 60s createdAt heuristic.
    expect(result).toEqual({ fetched: 2, inserted: 1, classified: 1, errors: 0 });

    // The inline judge is gone — classification happens inside the shared
    // persist path, exactly like Gmail ingestion.
    expect(judgeEmail).not.toHaveBeenCalled();
  });

  it("namespaces the dedup key with the provider idPrefix (icloud-imap: for ICLOUD)", async () => {
    persistGmailEmail.mockResolvedValue({ emailId: "e1", isNew: true });

    await syncImapInbox({
      provider: IMAP_PROVIDERS.ICLOUD,
      userId: "u1",
      email: "me@icloud.com",
      password: "app-pw",
      host: "imap.mail.me.com:993",
      linkedInboxAccountId: "acc-icloud",
    });

    expect(persistGmailEmail).toHaveBeenNthCalledWith(
      1,
      "u1",
      expect.objectContaining({ gmailId: "icloud-imap:me@icloud.com:101" }),
      expect.objectContaining({ linkedInboxAccountId: "acc-icloud", userEmail: "me@icloud.com" }),
    );
  });

  it("counts a persist failure as an error and keeps the loop going", async () => {
    persistGmailEmail
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ emailId: "e2", isNew: true });

    const result = await syncImapInbox({
      provider: IMAP_PROVIDERS.NAVER,
      userId: "u1",
      email: "me@naver.com",
      password: "app-pw",
      host: "imap.naver.com:993",
    });

    expect(result).toEqual({ fetched: 2, inserted: 1, classified: 1, errors: 1 });
  });
});

describe("syncImapInbox → connection hygiene", () => {
  const args = {
    provider: IMAP_PROVIDERS.NAVER,
    userId: "u1",
    email: "me@naver.com",
    password: "app-pw",
    host: "imap.naver.com:993",
    linkedInboxAccountId: "acc-naver",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    imap.ctorOpts.length = 0;
    armImap();
    persistGmailEmail.mockResolvedValue({ emailId: "e1", isNew: false });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("keeps the poll's 30 s socket timeout", async () => {
    await syncImapInbox(args);
    expect(imap.ctorOpts).toHaveLength(1);
    expect(imap.ctorOpts[0]).toMatchObject({
      host: "imap.naver.com",
      port: 993,
      secure: true,
      socketTimeout: 30_000,
    });
  });

  it("registers an error listener, so a late socket error cannot crash the process", async () => {
    await syncImapInbox(args);
    const listener = imap.on.mock.calls.find(([event]) => event === "error")?.[1];
    expect(listener).toBeTypeOf("function");
    expect(() => listener(new Error("read ECONNRESET"))).not.toThrow();
    const logged = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .flat()
      .join("\n");
    expect(logged).toContain("naver-imap");
    expect(logged).toContain("acc-naver");
    expect(logged).not.toContain("app-pw");
    expect(logged).not.toContain("me@naver.com");
  });

  it("logs out and releases the lock on success", async () => {
    await syncImapInbox(args);
    expect(imap.release).toHaveBeenCalledTimes(1);
    expect(imap.logout).toHaveBeenCalledTimes(1);
  });

  it("closes the session when the fetch throws, and still rethrows", async () => {
    imap.fetch.mockImplementation(() => {
      throw new Error("socket hang up");
    });
    await expect(syncImapInbox(args)).rejects.toThrow("socket hang up");
    expect(imap.release).toHaveBeenCalledTimes(1);
    expect(imap.logout).toHaveBeenCalledTimes(1);
    expect(imap.close).toHaveBeenCalled();
  });

  it("closes the session when connect() fails, and still rethrows", async () => {
    imap.connect.mockRejectedValue(new Error("ECONNREFUSED"));
    imap.logout.mockRejectedValue(new Error("NoConnection"));
    await expect(syncImapInbox(args)).rejects.toThrow("ECONNREFUSED");
    expect(imap.close).toHaveBeenCalled();
  });

  it("closes the session on the empty-mailbox early return", async () => {
    imap.status.mockResolvedValue({ messages: 0 });
    const result = await syncImapInbox(args);
    expect(result).toEqual({ fetched: 0, inserted: 0, classified: 0, errors: 0 });
    expect(imap.release).toHaveBeenCalledTimes(1);
    expect(imap.logout).toHaveBeenCalledTimes(1);
  });

  it("refuses to open a socket to a host outside the allowlist", async () => {
    await expect(syncImapInbox({ ...args, host: "169.254.169.254:993" })).rejects.toThrow(
      /not allowed/i,
    );
    expect(imap.ctorOpts).toHaveLength(0);
    expect(imap.connect).not.toHaveBeenCalled();
  });
});
