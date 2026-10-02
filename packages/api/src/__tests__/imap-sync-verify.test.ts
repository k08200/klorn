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

const { verifyImapCredentials } = await import("../mail/imap-sync.js");
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

  it("maps network errors to a host-prefixed message", async () => {
    // The host must be an allowlisted one now: createImapClient itself refuses
    // anything else, so "unreachable host" is modelled with the real host.
    connectFn.mockRejectedValueOnce(new Error("ENOTFOUND imap.naver.com"));

    const result = await verifyImapCredentials({
      provider: IMAP_PROVIDERS.NAVER,
      email: "user@naver.com",
      password: "x",
      host: "imap.naver.com:993",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("imap.naver.com:993");
  });

  it("falls back to the raw error message for unknown errors", async () => {
    connectFn.mockRejectedValueOnce(new Error("some unexpected IMAP error"));

    const result = await verifyImapCredentials({
      provider: IMAP_PROVIDERS.NAVER,
      email: "user@naver.com",
      password: "x",
      host: "imap.naver.com:993",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("some unexpected IMAP error");
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
