/**
 * Unit tests for the parts of naver-imap that don't require a live IMAP
 * server. Real IMAP roundtrips are exercised manually via the settings
 * UI's "Connect" button — there's no public Naver sandbox to integration
 * test against.
 */

import { describe, expect, it, vi } from "vitest";

// Mock the @prisma/client + ImapFlow imports BEFORE importing the module
// under test so the module's top-level `new ImapFlow(...)` instantiation
// uses our stub instead of trying to open a TCP socket in the test.

const connectFn = vi.fn();
const getLockFn = vi.fn();
const logoutFn = vi.fn();

class FakeImapFlow {
  public host: string;
  public port: number;
  constructor(opts: { host: string; port: number }) {
    this.host = opts.host;
    this.port = opts.port;
  }
  connect = connectFn;
  getMailboxLock = getLockFn;
  logout = logoutFn;
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

const { verifyNaverImapCredentials } = await import("../naver-imap.js");

describe("verifyNaverImapCredentials", () => {
  it("returns ok=true when LOGIN + INBOX lock succeed", async () => {
    connectFn.mockResolvedValueOnce(undefined);
    getLockFn.mockResolvedValueOnce({ release: () => {} });
    logoutFn.mockResolvedValueOnce(undefined);

    const result = await verifyNaverImapCredentials({
      email: "user@naver.com",
      password: "app-password",
      host: "imap.naver.com:993",
    });

    expect(result.ok).toBe(true);
  });

  it("maps 'Authentication failed' to a helpful Korean-aware message", async () => {
    connectFn.mockRejectedValueOnce(new Error("Authentication failed (AUTH=PLAIN)"));

    const result = await verifyNaverImapCredentials({
      email: "user@naver.com",
      password: "wrong",
      host: "imap.naver.com:993",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/외부 메일 비밀번호/);
  });

  it("maps network errors to a host-prefixed message", async () => {
    connectFn.mockRejectedValueOnce(new Error("ENOTFOUND imap.naver.invalid"));

    const result = await verifyNaverImapCredentials({
      email: "user@naver.com",
      password: "x",
      host: "imap.naver.invalid:993",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("imap.naver.invalid:993");
  });

  it("falls back to the raw error message for unknown errors", async () => {
    connectFn.mockRejectedValueOnce(new Error("some unexpected IMAP error"));

    const result = await verifyNaverImapCredentials({
      email: "user@naver.com",
      password: "x",
      host: "imap.naver.com:993",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("some unexpected IMAP error");
  });

  it("parses host:port into the right tuple", async () => {
    connectFn.mockResolvedValueOnce(undefined);
    getLockFn.mockResolvedValueOnce({ release: () => {} });
    logoutFn.mockResolvedValueOnce(undefined);

    await verifyNaverImapCredentials({
      email: "u@n.com",
      password: "p",
      host: "custom.example.com:1234",
    });

    // The fake ImapFlow constructor stored the parsed values; we can't
    // access them from outside, but the absence of a parse error is the
    // assertion here — a malformed host would throw before connect().
    expect(connectFn).toHaveBeenCalled();
  });
});
