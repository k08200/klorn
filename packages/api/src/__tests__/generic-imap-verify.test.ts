/**
 * Step B4, design D5: the connect route's verify step for a generic host. Whatever
 * goes wrong before an authenticated session (DNS, a blocked address, refused,
 * timeout, TLS or certificate failure, no IMAP greeting) produces ONE message, so
 * the endpoint is not a reachability oracle. Only a rejected LOGIN (which needs a
 * verified TLS session and an IMAP greeting first) keeps its own hint.
 *
 * Goes through the real verifyImapCredentials with imapflow and the resolver
 * faked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  connect: vi.fn(),
  getMailboxLock: vi.fn(),
  logout: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  resolve: vi.fn(),
}));

class FakeImapFlow {
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
vi.mock("../db.js", () => ({ prisma: {} }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../crypto-tokens.js", () => ({ encryptToken: vi.fn(), decryptToken: vi.fn() }));
vi.mock("../judge/attention-mirror.js", () => ({ upsertAttentionForEmailJudgement: vi.fn() }));
vi.mock("../judge/poc-judge.js", () => ({ judgeEmail: vi.fn() }));

const { GENERIC_CONNECT_FAILURE, verifyGenericImapCredentials } = await import(
  "../mail/generic-imap-verify.js"
);
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");

const GENERIC = IMAP_PROVIDERS.IMAP;
const args = {
  provider: GENERIC,
  email: "me@example.com",
  password: "pw",
  host: "imap.example.com:993",
};

beforeEach(() => {
  vi.clearAllMocks();
  fake.resolve.mockResolvedValue(["93.184.216.34"]);
  fake.connect.mockResolvedValue(undefined);
  fake.getMailboxLock.mockResolvedValue({ release: () => {} });
  fake.logout.mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("verifyGenericImapCredentials", () => {
  it("is ok after a LOGIN and an INBOX lock through the pinned connection", async () => {
    await expect(verifyGenericImapCredentials(args)).resolves.toEqual({ ok: true });
    expect(fake.resolve).toHaveBeenCalledWith("imap.example.com");
    expect(fake.getMailboxLock).toHaveBeenCalledWith("INBOX");
  });

  it("keeps the provider's own hint for a rejected login", async () => {
    fake.connect.mockRejectedValue(new Error("Authentication failed (AUTH=PLAIN)"));
    const result = await verifyGenericImapCredentials(args);
    expect(result).toEqual({ ok: false, message: GENERIC.authFailureHint });
    expect(result.message).not.toBe(GENERIC_CONNECT_FAILURE);
  });

  const LEAKY_FAILURES: ReadonlyArray<readonly [string, () => void]> = [
    [
      "connection refused",
      () => fake.connect.mockRejectedValue(new Error("connect ECONNREFUSED 93.184.216.34:993")),
    ],
    ["timeout", () => fake.connect.mockRejectedValue(new Error("Connection timeout"))],
    ["reset", () => fake.connect.mockRejectedValue(new Error("read ECONNRESET"))],
    [
      "certificate hostname mismatch",
      () =>
        fake.connect.mockRejectedValue(
          new Error(
            "Hostname/IP does not match certificate's altnames: Host: imap.example.com. is not in the cert's altnames: DNS:other.example",
          ),
        ),
    ],
    [
      "self-signed certificate",
      () => fake.connect.mockRejectedValue(new Error("self-signed certificate")),
    ],
    ["protocol error", () => fake.connect.mockRejectedValue(new Error("wrong version number"))],
    [
      "no greeting",
      () =>
        fake.connect.mockRejectedValue(
          new Error("Failed to receive greeting from server in required time"),
        ),
    ],
    [
      "unknown error",
      () => fake.connect.mockRejectedValue(new Error("some unexpected IMAP error 10.0.0.9")),
    ],
    ["not a real Error", () => fake.connect.mockRejectedValue("boom")],
    [
      "name does not resolve",
      () => fake.resolve.mockRejectedValue(new Error("queryA ENOTFOUND imap.example.com")),
    ],
    ["name has no addresses", () => fake.resolve.mockResolvedValue([])],
    ["name resolves to a private address", () => fake.resolve.mockResolvedValue(["10.0.0.5"])],
    [
      "name resolves to the metadata address",
      () => fake.resolve.mockResolvedValue(["169.254.169.254"]),
    ],
    [
      "name resolves to public and private addresses",
      () => fake.resolve.mockResolvedValue(["93.184.216.34", "192.168.1.9"]),
    ],
    [
      "INBOX cannot be opened",
      () => fake.getMailboxLock.mockRejectedValue(new Error("Mailbox doesn't exist: INBOX")),
    ],
  ];

  it.each(
    LEAKY_FAILURES,
  )("%s answers the one generic message, with nothing from the failure in it", async (_label, arrange) => {
    arrange();
    const result = await verifyGenericImapCredentials(args);
    expect(result).toEqual({ ok: false, message: GENERIC_CONNECT_FAILURE });
  });

  it("the generic message says nothing about why, the address or the port", () => {
    expect(GENERIC_CONNECT_FAILURE).toBe("Could not connect securely to that server.");
    expect(GENERIC_CONNECT_FAILURE).not.toMatch(/\d|ECONN|ENOTFOUND|refused|timeout|certificate/i);
  });

  it("an unexpected throw while verifying is the same message, never an exception", async () => {
    fake.logout.mockRejectedValue(new Error("logout exploded"));
    fake.connect.mockRejectedValue(new Error("x"));
    await expect(verifyGenericImapCredentials(args)).resolves.toEqual({
      ok: false,
      message: GENERIC_CONNECT_FAILURE,
    });
  });

  it("a host the grammar refuses is the same message and opens no connection", async () => {
    const result = await verifyGenericImapCredentials({ ...args, host: "127.0.0.1:993" });
    expect(result).toEqual({ ok: false, message: GENERIC_CONNECT_FAILURE });
    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.resolve).not.toHaveBeenCalled();
  });
});
