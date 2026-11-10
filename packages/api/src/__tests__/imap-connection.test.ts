/**
 * The IMAP client construction and the per-row connection guards are shared by
 * the poller (imap-accounts.ts / imap-sync.ts), the connect route's verify
 * handshake and the flag actions (providers/imap*.ts), so there is exactly one
 * copy of "which host may we open a TLS socket to, and how".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ctor = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  on: vi.fn(),
  logout: vi.fn(),
  close: vi.fn(),
}));

class FakeImapFlow {
  constructor(opts: Record<string, unknown>) {
    ctor.calls.push(opts);
  }
  on = ctor.on;
  logout = ctor.logout;
  close = ctor.close;
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));

const { checkImapRow, createImapClient, endImapSession, parseImapHost } = await import(
  "../mail/imap-connection.js"
);
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");

const NAVER = IMAP_PROVIDERS.NAVER;
const ICLOUD = IMAP_PROVIDERS.ICLOUD;

beforeEach(() => {
  vi.clearAllMocks();
  ctor.calls.length = 0;
  ctor.logout.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("parseImapHost", () => {
  it("splits host and port and defaults the port to 993", () => {
    expect(parseImapHost("imap.naver.com:993")).toEqual({ host: "imap.naver.com", port: 993 });
    expect(parseImapHost("imap.mail.me.com")).toEqual({ host: "imap.mail.me.com", port: 993 });
  });
});

describe("createImapClient", () => {
  it("opens a TLS connection with the mailbox credentials and no logger", () => {
    createImapClient({
      provider: NAVER,
      host: "imap.naver.com:993",
      email: "me@naver.com",
      password: "app-pw",
      socketTimeout: 12_000,
    });
    expect(ctor.calls).toEqual([
      {
        host: "imap.naver.com",
        port: 993,
        secure: true,
        auth: { user: "me@naver.com", pass: "app-pw" },
        logger: false,
        socketTimeout: 12_000,
      },
    ]);
  });

  it("adds the connect and greeting timeouts only when the caller asks for them", () => {
    createImapClient({
      provider: ICLOUD,
      host: "imap.mail.me.com:993",
      email: "me@icloud.com",
      password: "pw",
      socketTimeout: 15_000,
      connectionTimeout: 10_000,
      greetingTimeout: 9_000,
    });
    expect(ctor.calls[0]).toMatchObject({
      socketTimeout: 15_000,
      connectionTimeout: 10_000,
      greetingTimeout: 9_000,
    });
  });

  it("refuses to construct a client for a host outside the allowlist (the sink check)", () => {
    for (const host of [
      "169.254.169.254:993",
      "localhost:993",
      "imap.naver.com:143",
      "imap.naver.com.evil.io:993",
    ]) {
      expect(() =>
        createImapClient({
          provider: NAVER,
          host,
          email: "me@naver.com",
          password: "pw",
          socketTimeout: 1_000,
        }),
      ).toThrow(/not allowed/i);
    }
    expect(ctor.calls).toHaveLength(0);
  });

  it("refuses an allowlisted host that belongs to the other provider (host pin)", () => {
    expect(() =>
      createImapClient({
        provider: NAVER,
        host: "imap.mail.me.com:993",
        email: "me@naver.com",
        password: "pw",
        socketTimeout: 1_000,
      }),
    ).toThrow(/not allowed/i);
    expect(() =>
      createImapClient({
        provider: ICLOUD,
        host: "imap.naver.com:993",
        email: "me@icloud.com",
        password: "pw",
        socketTimeout: 1_000,
      }),
    ).toThrow(/not allowed/i);
    expect(ctor.calls).toHaveLength(0);
  });

  it("does not put the rejected host, email or password into the error", () => {
    try {
      createImapClient({
        provider: NAVER,
        host: "169.254.169.254:993",
        email: "me@naver.com",
        password: "super-secret",
        socketTimeout: 1_000,
      });
      expect.unreachable("createImapClient must throw");
    } catch (err) {
      const text = (err as Error).message;
      expect(text).not.toContain("169.254.169.254");
      expect(text).not.toContain("me@naver.com");
      expect(text).not.toContain("super-secret");
    }
  });

  describe("error listener", () => {
    function client(accountId?: string) {
      createImapClient({
        provider: NAVER,
        host: "imap.naver.com:993",
        email: "me@naver.com",
        password: "super-secret",
        socketTimeout: 1_000,
        ...(accountId ? { accountId } : {}),
      });
      const call = ctor.on.mock.calls.find(([event]) => event === "error");
      return call?.[1] as ((err: unknown) => void) | undefined;
    }

    it("registers one, so a late socket error cannot crash the process", () => {
      const listener = client("row-9");
      expect(listener).toBeTypeOf("function");
      expect(() => listener?.(new Error("read ECONNRESET"))).not.toThrow();
    });

    it("logs the provider scope and account id but never credentials or the email", () => {
      const listener = client("row-9");
      listener?.(new Error("read ECONNRESET"));
      const logged = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .flat()
        .join("\n");
      expect(logged).toContain("naver-imap");
      expect(logged).toContain("row-9");
      expect(logged).toContain("read ECONNRESET");
      expect(logged).not.toContain("super-secret");
      expect(logged).not.toContain("me@naver.com");
    });

    it("tolerates a non-Error value", () => {
      const listener = client();
      expect(() => listener?.("boom")).not.toThrow();
    });
  });
});

describe("endImapSession", () => {
  it("logs out, then hard-closes", async () => {
    await endImapSession({ logout: ctor.logout, close: ctor.close } as never);
    expect(ctor.logout).toHaveBeenCalledTimes(1);
    expect(ctor.close).toHaveBeenCalledTimes(1);
  });

  it("still hard-closes when LOGOUT fails, and never throws", async () => {
    ctor.logout.mockRejectedValue(new Error("NoConnection"));
    await expect(
      endImapSession({ logout: ctor.logout, close: ctor.close } as never),
    ).resolves.toBeUndefined();
    expect(ctor.close).toHaveBeenCalledTimes(1);
  });
});

describe("checkImapRow", () => {
  const goodRow = {
    email: "me@naver.com",
    imapHost: "imap.naver.com:993",
    imapPasswordCipher: "cipher",
  };

  it("accepts a complete row and returns the narrowed credentials", () => {
    expect(checkImapRow(goodRow, NAVER)).toEqual({
      ok: true,
      email: "me@naver.com",
      host: "imap.naver.com:993",
      passwordCipher: "cipher",
    });
    expect(
      checkImapRow(
        { email: "me@icloud.com", imapHost: "imap.mail.me.com:993", imapPasswordCipher: "c" },
        ICLOUD,
      ),
    ).toMatchObject({ ok: true, host: "imap.mail.me.com:993" });
  });

  it.each([
    ["email", { email: null }],
    ["host", { imapHost: null }],
    ["password cipher", { imapPasswordCipher: null }],
    ["empty password cipher", { imapPasswordCipher: "" }],
  ])("flags a row without %s as missing-credentials", (_label, over) => {
    expect(checkImapRow({ ...goodRow, ...over }, NAVER)).toEqual({
      ok: false,
      reason: "missing-credentials",
    });
  });

  it.each([
    "169.254.169.254:993",
    "localhost:993",
    "imap.naver.com:143",
    "imap.naver.com.evil.io:993",
    "imap.naver.com:993:1",
  ])("flags host %s as not allowlisted", (imapHost) => {
    expect(checkImapRow({ ...goodRow, imapHost }, NAVER)).toEqual({
      ok: false,
      reason: "host-not-allowlisted",
    });
  });

  it("flags an allowlisted host that belongs to the other provider", () => {
    expect(checkImapRow({ ...goodRow, imapHost: "imap.mail.me.com:993" }, NAVER)).toEqual({
      ok: false,
      reason: "host-provider-mismatch",
    });
    expect(checkImapRow(goodRow, ICLOUD)).toEqual({ ok: false, reason: "host-provider-mismatch" });
  });
});
