/**
 * The IMAP client construction and the per-row connection guards are shared by
 * the poller (imap-accounts.ts / imap-sync.ts) and the flag actions
 * (providers/imap.ts), so there is exactly one copy of "which host may we open
 * a TLS socket to, and how".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ctor = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

class FakeImapFlow {
  constructor(opts: Record<string, unknown>) {
    ctor.calls.push(opts);
  }
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));

const { createImapClient, parseImapHost, rejectImapRow } = await import(
  "../mail/imap-connection.js"
);
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");

beforeEach(() => {
  ctor.calls.length = 0;
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
});

describe("rejectImapRow", () => {
  const NAVER = IMAP_PROVIDERS.NAVER;
  const ICLOUD = IMAP_PROVIDERS.ICLOUD;
  const goodRow = {
    email: "me@naver.com",
    imapHost: "imap.naver.com:993",
    imapPasswordCipher: "cipher",
  };

  it("accepts a complete row whose host is allowlisted and pinned to the provider", () => {
    expect(rejectImapRow(goodRow, NAVER)).toBeNull();
    expect(
      rejectImapRow(
        { email: "me@icloud.com", imapHost: "imap.mail.me.com:993", imapPasswordCipher: "c" },
        ICLOUD,
      ),
    ).toBeNull();
  });

  it.each([
    ["email", { email: null }],
    ["host", { imapHost: null }],
    ["password cipher", { imapPasswordCipher: null }],
    ["empty password cipher", { imapPasswordCipher: "" }],
  ])("flags a row without %s as missing-credentials", (_label, over) => {
    expect(rejectImapRow({ ...goodRow, ...over }, NAVER)).toBe("missing-credentials");
  });

  it.each([
    "169.254.169.254:993",
    "localhost:993",
    "imap.naver.com:143",
    "imap.naver.com.evil.io:993",
    "imap.naver.com:993:1",
  ])("flags host %s as not allowlisted", (imapHost) => {
    expect(rejectImapRow({ ...goodRow, imapHost }, NAVER)).toBe("host-not-allowlisted");
  });

  it("flags an allowlisted host that belongs to the other provider", () => {
    expect(rejectImapRow({ ...goodRow, imapHost: "imap.mail.me.com:993" }, NAVER)).toBe(
      "host-provider-mismatch",
    );
    expect(rejectImapRow(goodRow, ICLOUD)).toBe("host-provider-mismatch");
  });
});
