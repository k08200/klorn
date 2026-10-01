/**
 * Step B4, designs D3/D4/D6: what `createImapClient` builds for a generic (user
 * host) provider, with imapflow faked so the options it is given can be read.
 *
 *   - the library is never handed the user's name to resolve: its constructor host
 *     is the unresolvable placeholder, and the checked address is put in place only
 *     after Klorn's own resolution and check, on every connect;
 *   - TLS keeps the hostname as SNI and certificate name, verification on;
 *   - a blocked, mixed, unresolvable or rebound answer means no connection at all;
 *   - Naver and iCloud are byte-identical (fixed hosts, the exact allowlist, the
 *     library resolves them, the client is not wrapped).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  ctorCalls: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  close: vi.fn(),
  logout: vi.fn(),
  on: vi.fn(),
  resolve: vi.fn(),
}));

class FakeImapFlow {
  constructor(opts: Record<string, unknown>) {
    fake.ctorCalls.push(opts);
  }
  connect = fake.connect;
  close = fake.close;
  logout = fake.logout;
  on = fake.on;
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));
vi.mock("../mail/host-resolver.js", () => ({
  DNS_QUERY_TIMEOUT_MS: 3000,
  resolveHostAddresses: (...args: unknown[]) => fake.resolve(...args),
}));

const { checkImapRow, createImapClient } = await import("../mail/imap-connection.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { PinnedAddressError } = await import("../mail/pinned-address.js");

const GENERIC = IMAP_PROVIDERS.IMAP;
const NAVER = IMAP_PROVIDERS.NAVER;
const PUBLIC_IP = "93.184.216.34";

function build(over: Record<string, unknown> = {}) {
  return createImapClient({
    provider: GENERIC,
    host: "imap.example.com:993",
    email: "me@example.com",
    password: "pw",
    socketTimeout: 30_000,
    ...over,
  });
}

/** The options object the most recent client was constructed with. */
const lastOptions = () => fake.ctorCalls[fake.ctorCalls.length - 1];
const tlsOf = (opts: Record<string, unknown>) => opts.tls as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  fake.ctorCalls.length = 0;
  fake.connect.mockResolvedValue(undefined);
  fake.resolve.mockResolvedValue([PUBLIC_IP]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("generic client: what the library is given", () => {
  it("never receives the user's host name to resolve", () => {
    build();
    const opts = lastOptions();
    expect(opts.host).not.toBe("imap.example.com");
    // `.invalid` is reserved (RFC 2606) and can never resolve: if the pin were ever
    // not applied, the connection fails closed instead of resolving the name.
    expect(String(opts.host)).toMatch(/\.invalid$/);
  });

  it("does no DNS work until connect()", () => {
    build();
    expect(fake.resolve).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it("keeps TLS on, names the server for SNI and certificate checks, and pins the protocol floor", () => {
    build();
    const opts = lastOptions();
    expect(opts).toMatchObject({
      port: 993,
      secure: true,
      servername: "imap.example.com",
      auth: { user: "me@example.com", pass: "pw" },
      logger: false,
      socketTimeout: 30_000,
    });
    expect(tlsOf(opts)).toMatchObject({
      servername: "imap.example.com",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
  });

  it("never turns certificate verification off, however the client is built", () => {
    build();
    build({ connectionTimeout: 5_000, greetingTimeout: 5_000 });
    for (const opts of fake.ctorCalls) {
      expect(tlsOf(opts).rejectUnauthorized).toBe(true);
      expect(opts).not.toHaveProperty("rejectUnauthorized");
    }
  });

  it("bounds the connection and the greeting by default (a slow host cannot stall the poll)", () => {
    build();
    expect(lastOptions()).toMatchObject({ connectionTimeout: 15_000, greetingTimeout: 10_000 });
  });

  it("lets a caller tighten, and only tighten, those bounds", () => {
    build({ connectionTimeout: 4_000, greetingTimeout: 3_000 });
    expect(lastOptions()).toMatchObject({ connectionTimeout: 4_000, greetingTimeout: 3_000 });
  });

  it("stores the name in its folded form: the client is built for the ASCII host", () => {
    build({ host: "MÜNCHEN.de" });
    expect(lastOptions().servername).toBe("xn--mnchen-3ya.de");
    expect(tlsOf(lastOptions()).servername).toBe("xn--mnchen-3ya.de");
  });

  it("listens for errors like every other client (an unhandled one would crash the process)", () => {
    build();
    expect(fake.on).toHaveBeenCalledWith("error", expect.any(Function));
  });
});

describe("generic client: connect() resolves, checks, then pins", () => {
  it("connects to the checked address with the host name as the TLS name", async () => {
    let seenAtConnect: Record<string, unknown> | undefined;
    fake.connect.mockImplementation(async () => {
      seenAtConnect = { ...tlsOf(lastOptions()) };
    });

    const client = build();
    await client.connect();

    expect(fake.resolve).toHaveBeenCalledTimes(1);
    expect(fake.resolve).toHaveBeenCalledWith("imap.example.com");
    expect(seenAtConnect).toMatchObject({
      host: PUBLIC_IP,
      servername: "imap.example.com",
      rejectUnauthorized: true,
    });
  });

  it("the address is not in place before the check (resolution comes first)", async () => {
    const order: string[] = [];
    fake.resolve.mockImplementation(async () => {
      order.push(`resolve (tls.host=${String(tlsOf(lastOptions()).host)})`);
      return [PUBLIC_IP];
    });
    fake.connect.mockImplementation(async () => {
      order.push(`connect (tls.host=${String(tlsOf(lastOptions()).host)})`);
    });

    await build().connect();

    expect(order).toEqual(["resolve (tls.host=undefined)", `connect (tls.host=${PUBLIC_IP})`]);
  });

  it("refuses a name that resolves only to a private address, and connects to nothing", async () => {
    fake.resolve.mockResolvedValue(["10.0.0.5"]);
    const client = build();
    await expect(client.connect()).rejects.toBeInstanceOf(PinnedAddressError);
    expect(fake.connect).not.toHaveBeenCalled();
    expect(tlsOf(lastOptions()).host).toBeUndefined();
  });

  it("refuses a name with ANY private answer among public ones", async () => {
    fake.resolve.mockResolvedValue([PUBLIC_IP, "169.254.169.254", "8.8.8.8"]);
    await expect(build().connect()).rejects.toBeInstanceOf(PinnedAddressError);
    expect(fake.connect).not.toHaveBeenCalled();
    expect(tlsOf(lastOptions()).host).toBeUndefined();
  });

  it("refuses a name that does not resolve", async () => {
    fake.resolve.mockRejectedValue(new Error("queryA ENOTFOUND imap.example.com"));
    await expect(build().connect()).rejects.toBeInstanceOf(PinnedAddressError);
    expect(fake.connect).not.toHaveBeenCalled();
  });

  it("DNS rebinding: each NEW connection re-resolves, and a name gone private is refused", async () => {
    fake.resolve.mockResolvedValueOnce([PUBLIC_IP]).mockResolvedValueOnce(["127.0.0.1"]);

    await build().connect();
    expect(fake.connect).toHaveBeenCalledTimes(1);
    const firstTarget = tlsOf(fake.ctorCalls[0]).host;
    expect(firstTarget).toBe(PUBLIC_IP);

    await expect(build().connect()).rejects.toBeInstanceOf(PinnedAddressError);
    expect(fake.connect).toHaveBeenCalledTimes(1); // the second never reached the library
    expect(tlsOf(fake.ctorCalls[1]).host).toBeUndefined();
    expect(fake.resolve).toHaveBeenCalledTimes(2);
  });

  it("re-resolving picks up a changed public address (no stale pin across connections)", async () => {
    fake.resolve.mockResolvedValueOnce([PUBLIC_IP]).mockResolvedValueOnce(["8.8.4.4"]);
    await build().connect();
    await build().connect();
    expect(tlsOf(fake.ctorCalls[0]).host).toBe(PUBLIC_IP);
    expect(tlsOf(fake.ctorCalls[1]).host).toBe("8.8.4.4");
  });

  it("a close() that lands during resolution stops the connection before it starts", async () => {
    let answer: (addresses: string[]) => void = () => {};
    fake.resolve.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          answer = resolve;
        }),
    );

    const client = build();
    const connecting = client.connect();
    client.close();
    answer([PUBLIC_IP]);

    await expect(connecting).rejects.toThrow();
    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("close() still reaches the library", () => {
    build().close();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});

describe("generic client: a host the grammar refuses never builds a client", () => {
  it.each([
    "127.0.0.1:993",
    "169.254.169.254:993",
    "[::1]:993",
    "printer.local:993",
    "db.internal",
    "localhost",
    "imap.example.com:143",
    "user@imap.example.com",
    "",
  ])("%j", (host) => {
    expect(() => build({ host })).toThrow("IMAP host is not allowed for IMAP");
    expect(fake.ctorCalls).toHaveLength(0);
    expect(fake.resolve).not.toHaveBeenCalled();
  });
});

describe("fixed-host providers are unchanged", () => {
  it("Naver: the library gets the allowlisted host, no pin, no tls override, no wrapper", async () => {
    const client = createImapClient({
      provider: NAVER,
      host: "imap.naver.com:993",
      email: "me@naver.com",
      password: "pw",
      socketTimeout: 12_000,
    });
    expect(lastOptions()).toEqual({
      host: "imap.naver.com",
      port: 993,
      secure: true,
      auth: { user: "me@naver.com", pass: "pw" },
      logger: false,
      socketTimeout: 12_000,
    });
    expect(client.connect).toBe(fake.connect);
    await client.connect();
    expect(fake.resolve).not.toHaveBeenCalled();
  });

  it("Naver still refuses a host the generic grammar would accept", () => {
    expect(() =>
      createImapClient({
        provider: NAVER,
        host: "imap.example.com:993",
        email: "me@naver.com",
        password: "pw",
        socketTimeout: 12_000,
      }),
    ).toThrow("IMAP host is not allowed for Naver");
  });
});

describe("checkImapRow: generic rows", () => {
  const good = {
    email: "me@example.com",
    imapHost: "imap.example.com:993",
    imapPasswordCipher: "v2:c",
  };

  it("accepts a stored public host name", () => {
    expect(checkImapRow(good, GENERIC)).toEqual({
      ok: true,
      email: "me@example.com",
      host: "imap.example.com:993",
      passwordCipher: "v2:c",
    });
  });

  it.each([
    "127.0.0.1:993",
    "169.254.169.254:993",
    "10.0.0.1",
    "printer.local:993",
    "metadata.google.internal:993",
    "imap.example.com:143",
    "imap.example.com:587",
    "user@imap.example.com:993",
    "localhost",
    "[::1]:993",
  ])("a hand-edited row pointing at %j is refused at the boundary", (imapHost) => {
    expect(checkImapRow({ ...good, imapHost }, GENERIC)).toEqual({
      ok: false,
      reason: "host-not-allowlisted",
    });
  });

  it("missing credentials still win over the host checks", () => {
    expect(checkImapRow({ ...good, imapPasswordCipher: null }, GENERIC)).toEqual({
      ok: false,
      reason: "missing-credentials",
    });
  });

  it("a Naver row still needs the exact allowlisted host", () => {
    expect(
      checkImapRow({ ...good, email: "me@naver.com", imapHost: "imap.example.com:993" }, NAVER),
    ).toEqual({ ok: false, reason: "host-not-allowlisted" });
  });
});
