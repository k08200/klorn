/**
 * Unit tests for the parts of imap-sync that don't require a live IMAP
 * server. Real IMAP roundtrips are exercised manually via the settings
 * UI's "Connect" button — there's no public Naver/iCloud sandbox to
 * integration test against.
 */

import { describe, expect, it, vi } from "vitest";

// Mock the @prisma/client + ImapFlow imports BEFORE importing the module
// under test so the module's top-level `new ImapFlow(...)` instantiation
// uses our stub instead of trying to open a TCP socket in the test.

const connectFn = vi.fn();
const getLockFn = vi.fn();
const logoutFn = vi.fn();
const closeFn = vi.fn();
const onFn = vi.fn();
const ctorOpts: Array<Record<string, unknown>> = [];

class FakeImapFlow {
  public host: string;
  public port: number;
  constructor(opts: { host: string; port: number }) {
    this.host = opts.host;
    this.port = opts.port;
    ctorOpts.push(opts);
  }
  connect = connectFn;
  getMailboxLock = getLockFn;
  logout = logoutFn;
  close = closeFn;
  on = onFn;
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));

vi.mock("../db.js", () => ({ prisma: {} }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../crypto-tokens.js", () => ({
  encryptToken: (s: string) => `enc:${s}`,
  decryptToken: (s: string) => s.replace(/^enc:/, ""),
}));
vi.mock("../judge/attention-mirror.js", () => ({
  upsertAttentionForEmailJudgement: vi.fn(),
}));
vi.mock("../judge/poc-judge.js", () => ({
  judgeEmail: vi.fn().mockResolvedValue({
    tier: "QUEUE",
    reason: "stub",
    features: { confidence: 0.5, senderTrust: 0.5, reversibility: 0.5, urgency: 0.5 },
    source: "fast-path",
  }),
}));

const { IMAP_UNREACHABLE_MESSAGE, IMAP_VERIFY_FAILED_MESSAGE, verifyImapCredentials } =
  await import("../mail/imap-sync.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");

describe("verifyImapCredentials", () => {
  it("returns ok=true when LOGIN + INBOX lock succeed", async () => {
    connectFn.mockResolvedValueOnce(undefined);
    getLockFn.mockResolvedValueOnce({ release: () => {} });
    logoutFn.mockResolvedValueOnce(undefined);

    const result = await verifyImapCredentials({
      provider: IMAP_PROVIDERS.NAVER,
      email: "user@naver.com",
      password: "app-password",
      host: "imap.naver.com:993",
    });

    expect(result.ok).toBe(true);
  });

  it("maps 'Authentication failed' to a helpful Korean-aware message", async () => {
    connectFn.mockRejectedValueOnce(new Error("Authentication failed (AUTH=PLAIN)"));

    const result = await verifyImapCredentials({
      provider: IMAP_PROVIDERS.NAVER,
      email: "user@naver.com",
      password: "wrong",
      host: "imap.naver.com:993",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/외부 메일 비밀번호/);
  });

  it("maps network errors to the static host-prefixed message, without the library text", async () => {
    // The host must be an allowlisted one now: createImapClient itself refuses
    // anything else, so "unreachable host" is modelled with the real host.
    connectFn.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND imap.naver.com"));

    const result = await verifyImapCredentials({
      provider: IMAP_PROVIDERS.NAVER,
      email: "user@naver.com",
      password: "x",
      host: "imap.naver.com:993",
    });

    expect(result).toEqual({
      ok: false,
      message: IMAP_UNREACHABLE_MESSAGE("imap.naver.com:993"),
      code: "IMAP_UNREACHABLE",
    });
    expect(result.message).not.toMatch(/ENOTFOUND|getaddrinfo/);
  });

  it("answers an unknown failure with a static generic message and IMAP_VERIFY_FAILED", async () => {
    connectFn.mockRejectedValueOnce(new Error("some unexpected IMAP error 10.0.0.9"));

    const result = await verifyImapCredentials({
      provider: IMAP_PROVIDERS.NAVER,
      email: "user@naver.com",
      password: "x",
      host: "imap.naver.com:993",
    });

    expect(result).toEqual({
      ok: false,
      message: IMAP_VERIFY_FAILED_MESSAGE,
      code: "IMAP_VERIFY_FAILED",
    });
    expect(result.message).not.toMatch(/unexpected|10\.0\.0\.9/);
  });

  it("uses the provider's auth-failure hint (Apple app-specific password for ICLOUD)", async () => {
    connectFn.mockRejectedValueOnce(new Error("Authentication failed (AUTH=PLAIN)"));

    const result = await verifyImapCredentials({
      provider: IMAP_PROVIDERS.ICLOUD,
      email: "user@icloud.com",
      password: "wrong",
      host: "imap.mail.me.com:993",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/app-specific password/);
  });

  it("maps imapflow's real LOGIN rejection (authenticationFailed) to the hint + IMAP_AUTH_FAILED", async () => {
    // imapflow 1.3.3 commands/login.js: a NO to LOGIN throws Error("Command failed")
    // with authenticationFailed = true — the message alone never says "authentication".
    connectFn.mockRejectedValueOnce(
      Object.assign(new Error("Command failed"), {
        authenticationFailed: true,
        serverResponseCode: "AUTHENTICATIONFAILED",
      }),
    );

    const result = await verifyImapCredentials({
      provider: IMAP_PROVIDERS.ICLOUD,
      email: "you@icloud.example",
      password: "abcd-efgh-ijkl-mnop",
      host: "imap.mail.me.com:993",
    });

    expect(result).toEqual({
      ok: false,
      message: IMAP_PROVIDERS.ICLOUD.authFailureHint,
      code: "IMAP_AUTH_FAILED",
    });
  });

  it("tags an unreachable host IMAP_UNREACHABLE", async () => {
    connectFn.mockRejectedValueOnce(new Error("Socket timeout"));

    const result = await verifyImapCredentials({
      provider: IMAP_PROVIDERS.ICLOUD,
      email: "you@icloud.example",
      password: "abcd-efgh-ijkl-mnop",
      host: "imap.mail.me.com:993",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("IMAP_UNREACHABLE");
  });

  it("connects with the 12 s verify timeout and the parsed host and port", async () => {
    connectFn.mockResolvedValueOnce(undefined);
    getLockFn.mockResolvedValueOnce({ release: () => {} });
    logoutFn.mockResolvedValueOnce(undefined);
    ctorOpts.length = 0;

    await verifyImapCredentials({
      provider: IMAP_PROVIDERS.NAVER,
      email: "u@n.com",
      password: "p",
      host: "imap.naver.com:993",
    });

    expect(ctorOpts).toHaveLength(1);
    expect(ctorOpts[0]).toMatchObject({
      host: "imap.naver.com",
      port: 993,
      secure: true,
      socketTimeout: 12_000,
    });
  });

  it("registers an error listener on the verify client", async () => {
    connectFn.mockResolvedValueOnce(undefined);
    getLockFn.mockResolvedValueOnce({ release: () => {} });
    logoutFn.mockResolvedValueOnce(undefined);
    onFn.mockClear();

    await verifyImapCredentials({
      provider: IMAP_PROVIDERS.NAVER,
      email: "u@n.com",
      password: "p",
      host: "imap.naver.com:993",
    });

    expect(onFn.mock.calls.some(([event]) => event === "error")).toBe(true);
  });

  it("closes the session when the handshake fails", async () => {
    connectFn.mockRejectedValueOnce(new Error("Authentication failed (AUTH=PLAIN)"));
    logoutFn.mockRejectedValueOnce(new Error("NoConnection"));
    closeFn.mockClear();

    const result = await verifyImapCredentials({
      provider: IMAP_PROVIDERS.NAVER,
      email: "u@n.com",
      password: "wrong",
      host: "imap.naver.com:993",
    });

    expect(result.ok).toBe(false);
    expect(closeFn).toHaveBeenCalled();
  });

  it("returns a failed result (never throws) for a host the client refuses to construct", async () => {
    ctorOpts.length = 0;
    const result = await verifyImapCredentials({
      provider: IMAP_PROVIDERS.NAVER,
      email: "u@n.com",
      password: "p",
      host: "custom.example.com:1234",
    });

    expect(result.ok).toBe(false);
    expect(ctorOpts).toHaveLength(0);
  });
});

const ICLOUD_ARGS = {
  provider: IMAP_PROVIDERS.ICLOUD,
  email: "you@icloud.example",
  password: "abcd-efgh-ijkl-mnop",
  host: "imap.mail.me.com:993",
};

/** A Node socket / imapflow error: the errno lives on `code`, the text may not repeat it. */
function codedError(code: string, message = "connection failed"): Error {
  return Object.assign(new Error(message), { code });
}

describe("verifyImapCredentials: network-level failures", () => {
  const NETWORK_CODES = [
    "ETIMEDOUT",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    // imapflow's own socket-level codes.
    "ETIMEOUT",
    "GREETING_TIMEOUT",
    "UPGRADE_TIMEOUT",
    "NoConnection",
    "EConnectionClosed",
  ];

  it.each(NETWORK_CODES)("classifies err.code %s as IMAP_UNREACHABLE", async (code) => {
    connectFn.mockRejectedValueOnce(codedError(code));
    const result = await verifyImapCredentials(ICLOUD_ARGS);
    expect(result).toEqual({
      ok: false,
      message: IMAP_UNREACHABLE_MESSAGE("imap.mail.me.com:993"),
      code: "IMAP_UNREACHABLE",
    });
  });

  it.each([
    "connect ETIMEDOUT 17.42.251.41:993",
    "connect ECONNREFUSED 17.42.251.41:993",
    "getaddrinfo EAI_AGAIN imap.mail.me.com",
    "read ECONNRESET",
    "connect EHOSTUNREACH 17.42.251.41:993",
    "Socket timeout",
    "Failed to receive greeting from server in required time",
  ])("classifies the code-less message %j as IMAP_UNREACHABLE", async (text) => {
    connectFn.mockRejectedValueOnce(new Error(text));
    const result = await verifyImapCredentials(ICLOUD_ARGS);
    expect(result.code).toBe("IMAP_UNREACHABLE");
    expect(result.message).toBe(IMAP_UNREACHABLE_MESSAGE("imap.mail.me.com:993"));
  });

  it("the unreachable message carries nothing from the failure", () => {
    expect(IMAP_UNREACHABLE_MESSAGE("imap.mail.me.com:993")).toBe(
      "Could not reach imap.mail.me.com:993. Check your connection and try again.",
    );
  });
});

describe("verifyImapCredentials: no raw library text reaches the client", () => {
  const RAW_FAILURES: ReadonlyArray<readonly [string, unknown]> = [
    ["TLS failure", new Error("self-signed certificate in certificate chain")],
    ["protocol error", new Error("wrong version number")],
    ["server text", new Error("NO [ALERT] internal relay 10.0.0.9 refused")],
    ["not an Error", "boom 10.0.0.9"],
    ["coded but not network", codedError("ERR_SSL_WRONG_VERSION_NUMBER", "ssl 10.0.0.9")],
  ];

  it.each(RAW_FAILURES)("%s → the static generic message", async (_label, err) => {
    connectFn.mockRejectedValueOnce(err);
    const result = await verifyImapCredentials(ICLOUD_ARGS);
    expect(result).toEqual({
      ok: false,
      message: IMAP_VERIFY_FAILED_MESSAGE,
      code: "IMAP_VERIFY_FAILED",
    });
  });

  it("the generic message is static and says nothing about the cause", () => {
    expect(IMAP_VERIFY_FAILED_MESSAGE).toBe("Could not verify this mailbox. Try again later.");
  });
});

describe("verifyImapCredentials: what is logged", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const logged = () => warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");

  it("logs the raw failure on the server, as one capped line", async () => {
    warn.mockClear();
    connectFn.mockRejectedValueOnce(
      codedError("ERR_X", `weird\r\n[icloud-imap] FORGED ${"A".repeat(50_000)}`),
    );
    await verifyImapCredentials(ICLOUD_ARGS);
    expect(warn).toHaveBeenCalled();
    for (const [line] of warn.mock.calls) {
      expect(String(line)).not.toMatch(/[\r\n]/);
      expect(String(line).length).toBeLessThan(800);
    }
    expect(logged()).toContain("ERR_X");
    expect(logged()).toContain("FORGED");
  });

  it("never logs the password, even if the library echoes it", async () => {
    warn.mockClear();
    const err = Object.assign(
      new Error(`A1 LOGIN you@icloud.example ${ICLOUD_ARGS.password} failed`),
      {
        code: "ERR_X",
        response: `A1 LOGIN you@icloud.example ${ICLOUD_ARGS.password}`,
        command: { password: ICLOUD_ARGS.password },
      },
    );
    connectFn.mockRejectedValueOnce(err);
    const result = await verifyImapCredentials(ICLOUD_ARGS);
    expect(result.message).not.toContain(ICLOUD_ARGS.password);
    expect(warn).toHaveBeenCalled();
    expect(logged()).not.toContain(ICLOUD_ARGS.password);
  });

  it("does not log a rejected login (the user's own typo, nothing to debug)", async () => {
    warn.mockClear();
    connectFn.mockRejectedValueOnce(new Error("Authentication failed (AUTH=PLAIN)"));
    await verifyImapCredentials(ICLOUD_ARGS);
    expect(warn).not.toHaveBeenCalled();
  });
});
