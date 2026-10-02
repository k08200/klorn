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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  ctorCalls: [] as Array<Record<string, unknown>>,
  connect: vi.fn(),
  close: vi.fn(),
  logout: vi.fn(),
  on: vi.fn(),
  resolve: vi.fn(),
  streamWrite: vi.fn(),
}));

class FakeImapFlow {
  constructor(opts: Record<string, unknown>) {
    fake.ctorCalls.push(opts);
  }
  connect = fake.connect;
  close = fake.close;
  logout = fake.logout;
  on = fake.on;
  /** imapflow pipes every byte the socket receives into this stream's write(). */
  streamer = { write: fake.streamWrite };
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow }));
vi.mock("../mail/host-resolver.js", () => ({
  DNS_QUERY_TIMEOUT_MS: 3000,
  resolveHostAddresses: (...args: unknown[]) => fake.resolve(...args),
}));

const { checkImapRow, createImapClient, FIXED_HOST_SESSION_DEADLINE_MS } = await import(
  "../mail/imap-connection.js"
);
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { PinnedAddressError } = await import("../mail/pinned-address.js");
const {
  createPinnedImapClient,
  GENERIC_CONNECTION_TIMEOUT_MS,
  GENERIC_SESSION_BYTE_BUDGET,
  GENERIC_MAX_LINE_BYTES,
  GENERIC_MAX_LITERAL_BYTES,
  GENERIC_MAX_RESPONSE_BYTES,
  GENERIC_SESSION_DEADLINE_MS,
} = await import("../mail/imap-pinned-client.js");

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

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  fake.ctorCalls.length = 0;
  fake.connect.mockResolvedValue(undefined);
  fake.resolve.mockResolvedValue([PUBLIC_IP]);
  fake.streamWrite.mockReturnValue(true);
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

describe("generic client: size limits on what a server may send", () => {
  it("bounds a line, a literal and a whole response to a few MiB, each a named constant", () => {
    build();
    expect(lastOptions()).toMatchObject({
      maxLineLength: GENERIC_MAX_LINE_BYTES,
      maxLiteralSize: GENERIC_MAX_LITERAL_BYTES,
      maxResponseSize: GENERIC_MAX_RESPONSE_BYTES,
    });
    const MIB = 1024 * 1024;
    for (const bytes of [
      GENERIC_MAX_LINE_BYTES,
      GENERIC_MAX_LITERAL_BYTES,
      GENERIC_MAX_RESPONSE_BYTES,
    ]) {
      expect(bytes).toBeGreaterThanOrEqual(MIB);
      expect(bytes).toBeLessThanOrEqual(16 * MIB);
    }
    // imapflow needs the response cap ABOVE the literal cap, or a literal at the cap cannot arrive.
    expect(GENERIC_MAX_RESPONSE_BYTES).toBeGreaterThan(GENERIC_MAX_LITERAL_BYTES);
  });

  it("a caller of the pinned client cannot raise them", () => {
    createPinnedImapClient({
      hostname: "imap.example.com",
      port: 993,
      logScope: "generic-imap",
      options: {
        maxLiteralSize: Number.POSITIVE_INFINITY,
        maxLineLength: Number.POSITIVE_INFINITY,
        maxResponseSize: Number.POSITIVE_INFINITY,
      },
    });
    expect(lastOptions()).toMatchObject({
      maxLineLength: GENERIC_MAX_LINE_BYTES,
      maxLiteralSize: GENERIC_MAX_LITERAL_BYTES,
      maxResponseSize: GENERIC_MAX_RESPONSE_BYTES,
    });
  });

  it("Naver and iCloud get no limits from here (their options are unchanged)", () => {
    createImapClient({
      provider: NAVER,
      host: "imap.naver.com:993",
      email: "me@naver.com",
      password: "pw",
      socketTimeout: 12_000,
    });
    expect(lastOptions()).not.toHaveProperty("maxLiteralSize");
    expect(lastOptions()).not.toHaveProperty("maxLineLength");
    expect(lastOptions()).not.toHaveProperty("maxResponseSize");
  });
});

describe("generic client: time bounds", () => {
  it("the DNS wait counts against the connect timeout: a resolver that never answers ends the connect on time", async () => {
    vi.useFakeTimers();
    fake.resolve.mockImplementation(() => new Promise(() => {}));
    const client = build();
    const outcome = client.connect().then(
      () => "connected",
      (err: Error) => err.message,
    );

    await vi.advanceTimersByTimeAsync(GENERIC_CONNECTION_TIMEOUT_MS - 1);
    expect(fake.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toMatch(/timed out/i);
    expect(fake.connect).not.toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("DNS and the socket share ONE budget: 4 s of DNS leaves the connection only the rest", async () => {
    vi.useFakeTimers();
    fake.resolve.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([PUBLIC_IP]), 4_000)),
    );
    fake.connect.mockImplementation(() => new Promise(() => {})); // the handshake never finishes
    const client = build();
    let settled = "pending";
    client.connect().then(
      () => {
        settled = "connected";
      },
      (err: Error) => {
        settled = err.message;
      },
    );

    await vi.advanceTimersByTimeAsync(GENERIC_CONNECTION_TIMEOUT_MS - 1);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    expect(settled).toMatch(/timed out/i); // at 15 s in total, not at 4 s + 15 s
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("a caller's tighter connect timeout is the whole budget", async () => {
    vi.useFakeTimers();
    fake.resolve.mockImplementation(() => new Promise(() => {}));
    const client = build({ connectionTimeout: 5_000 });
    const outcome = client.connect().then(
      () => "connected",
      (err: Error) => err.message,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcome).toMatch(/timed out/i);
  });

  it("a connect that succeeds leaves no connect timer behind", async () => {
    vi.useFakeTimers();
    const client = build();
    await client.connect();
    // Only the session deadline is still armed.
    expect(vi.getTimerCount()).toBe(1);
    client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a session that outlives its deadline is hard-closed, wherever it is stuck", async () => {
    vi.useFakeTimers();
    await build().connect();

    await vi.advanceTimersByTimeAsync(GENERIC_SESSION_DEADLINE_MS - 1);
    expect(fake.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(GENERIC_SESSION_DEADLINE_MS).toBeGreaterThanOrEqual(30_000);
    expect(GENERIC_SESSION_DEADLINE_MS).toBeLessThanOrEqual(180_000);
  });

  it("the deadline is cancelled when the connection closes by itself (no stray timer)", async () => {
    vi.useFakeTimers();
    await build().connect();
    const onClose = fake.on.mock.calls.find((call) => call[0] === "close")?.[1] as
      | (() => void)
      | undefined;
    expect(onClose).toBeTypeOf("function");
    onClose?.();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(GENERIC_SESSION_DEADLINE_MS * 2);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("a refused name leaves no timer behind either", async () => {
    vi.useFakeTimers();
    fake.resolve.mockResolvedValue(["10.0.0.5"]);
    await expect(build().connect()).rejects.toBeInstanceOf(PinnedAddressError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("generic client: what is logged when a name is refused", () => {
  it("keeps the resolver's error code, and no address or text of its own", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fake.resolve.mockRejectedValue(
      Object.assign(new Error("queryA ENOTFOUND imap.example.com"), { code: "ENOTFOUND" }),
    );
    await expect(build().connect()).rejects.toBeInstanceOf(PinnedAddressError);
    const line = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(line).toContain("unresolvable (ENOTFOUND)");
  });

  it("names the blocked class and the addresses for the ops log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fake.resolve.mockResolvedValue([PUBLIC_IP, "169.254.169.254"]);
    await expect(build().connect()).rejects.toBeInstanceOf(PinnedAddressError);
    const line = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(line).toContain("blocked-address");
    expect(line).toContain("169.254.169.254");
  });

  it("an error the library reports on a generic connection is logged on one line, capped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    build();
    const onError = fake.on.mock.calls.find((call) => call[0] === "error")?.[1] as (
      e: unknown,
    ) => void;
    onError(new Error(`server said\r\n[generic-imap] FORGED ${"Z".repeat(10_000)}`));
    const line = warn.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.length).toBeLessThan(600);
  });
});

describe("generic client: a byte budget for the whole session (every command, every response)", () => {
  const MIB = 1024 * 1024;
  const writeOf = (client: unknown) =>
    (client as { streamer: { write: (chunk: unknown) => boolean } }).streamer.write;

  it("is a small multiple of an honest poll: retained memory is ~2x the wire bytes, so it stays low", () => {
    const HONEST_POLL_BYTES = 3.5 * MIB; // a window of 50 messages, 64 KiB of text each
    expect(GENERIC_SESSION_BYTE_BUDGET).toBeGreaterThanOrEqual(2 * HONEST_POLL_BYTES);
    expect(GENERIC_SESSION_BYTE_BUDGET).toBeLessThanOrEqual(12 * MIB);
  });

  it("forwards bytes under the budget unchanged, and the stream's own answer with them", () => {
    const write = writeOf(build());
    const chunk = Buffer.alloc(4096, 1);
    fake.streamWrite.mockReturnValueOnce(false); // backpressure from the stream must still reach the socket
    expect(write(chunk)).toBe(false);
    expect(fake.streamWrite).toHaveBeenCalledWith(chunk);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("counts every response together: many chunks that are each small still add up", () => {
    const write = writeOf(build());
    const chunk = Buffer.alloc(MIB);
    const limit = GENERIC_SESSION_BYTE_BUDGET / MIB;
    for (let i = 0; i < limit; i++) write(chunk); // exactly the budget: allowed
    expect(fake.close).not.toHaveBeenCalled();
    expect(fake.streamWrite).toHaveBeenCalledTimes(limit);

    write(Buffer.alloc(1)); // one byte over
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("past the budget the session is hard-closed ONCE and nothing more reaches the parser", () => {
    const write = writeOf(build());
    write(Buffer.alloc(GENERIC_SESSION_BYTE_BUDGET - 10));
    fake.streamWrite.mockClear();

    write(Buffer.alloc(100)); // crosses the budget: dropped, session closed
    write(Buffer.alloc(MIB));
    write(Buffer.alloc(MIB));

    expect(fake.streamWrite).not.toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("answers 'keep sending' after the cut-off so the socket is not stalled on a closed stream", () => {
    const write = writeOf(build());
    write(Buffer.alloc(GENERIC_SESSION_BYTE_BUDGET + 1));
    expect(write(Buffer.alloc(10))).toBe(true);
  });

  it("counts string chunks by their bytes, not their characters", () => {
    const write = writeOf(build());
    // 3 bytes per character in UTF-8.
    write("\u20ac".repeat(Math.floor(GENERIC_SESSION_BYTE_BUDGET / 3) + 1));
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("logs the cut-off once, as one line, naming the host and the budget", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const write = writeOf(build());
    write(Buffer.alloc(GENERIC_SESSION_BYTE_BUDGET + 1));
    write(Buffer.alloc(MIB));
    write(Buffer.alloc(MIB));
    const lines = warn.mock.calls.map((call) => call.join(" ")).filter((l) => /budget/i.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("imap.example.com");
    expect(lines[0]).not.toMatch(/[\r\n]/);
  });

  it("the cut-off also cancels the session deadline (no timer is left to fire later)", async () => {
    vi.useFakeTimers();
    const client = build();
    await client.connect();
    expect(vi.getTimerCount()).toBe(1);
    writeOf(client)(Buffer.alloc(GENERIC_SESSION_BYTE_BUDGET + 1));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is per session: a new client starts from zero", () => {
    writeOf(build())(Buffer.alloc(GENERIC_SESSION_BYTE_BUDGET));
    const second = build();
    writeOf(second)(Buffer.alloc(GENERIC_SESSION_BYTE_BUDGET));
    expect(fake.close).not.toHaveBeenCalled();
  });
});

describe("every client: a wall-clock deadline on the whole session", () => {
  const fixed = (provider = NAVER, host = "imap.naver.com:993") =>
    createImapClient({
      provider,
      host,
      email: "me@naver.com",
      password: "pw",
      socketTimeout: 30_000,
    });

  it("is generous (minutes, not seconds), and well past every action and poll deadline", () => {
    expect(FIXED_HOST_SESSION_DEADLINE_MS).toBeGreaterThanOrEqual(2 * 60_000);
    expect(FIXED_HOST_SESSION_DEADLINE_MS).toBeLessThanOrEqual(15 * 60_000);
    expect(FIXED_HOST_SESSION_DEADLINE_MS).toBeGreaterThan(GENERIC_SESSION_DEADLINE_MS);
  });

  it.each([
    ["Naver", NAVER, "imap.naver.com:993"],
    ["iCloud", IMAP_PROVIDERS.ICLOUD, "imap.mail.me.com:993"],
  ] as const)("%s: a session that outlives it is hard-closed, and not before", async (_name, provider, host) => {
    vi.useFakeTimers();
    await fixed(provider, host).connect();

    await vi.advanceTimersByTimeAsync(FIXED_HOST_SESSION_DEADLINE_MS - 1);
    expect(fake.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("arms nothing until the client connects (a client that is never used costs no timer)", () => {
    vi.useFakeTimers();
    fixed();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a normal close cancels it, and so does the connection closing by itself", async () => {
    vi.useFakeTimers();
    const client = fixed();
    await client.connect();
    expect(vi.getTimerCount()).toBe(1);
    client.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(fake.close).toHaveBeenCalledTimes(1);

    fake.close.mockClear();
    const second = fixed();
    await second.connect();
    const onClose = fake.on.mock.calls
      .filter((call) => call[0] === "close")
      .at(-1)?.[1] as () => void;
    onClose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(FIXED_HOST_SESSION_DEADLINE_MS * 2);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("a connect that fails leaves no timer behind and rethrows the library's own error", async () => {
    vi.useFakeTimers();
    const boom = new Error("connect ECONNREFUSED");
    fake.connect.mockRejectedValueOnce(boom);
    await expect(fixed().connect()).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("changes nothing else about a fixed-host client: same options, same library connect, same close", async () => {
    const client = fixed();
    expect(lastOptions()).toEqual({
      host: "imap.naver.com",
      port: 993,
      secure: true,
      auth: { user: "me@naver.com", pass: "pw" },
      logger: false,
      socketTimeout: 30_000,
    });
    await client.connect();
    client.close();
    expect(fake.connect).toHaveBeenCalledTimes(1);
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
    // The library's own connect is what runs; only a session deadline is added
    // (below), and nothing is resolved by Klorn for a fixed host.
    await client.connect();
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.resolve).not.toHaveBeenCalled();
    // The byte stream is not wrapped for a fixed host: its server is a trusted one.
    expect((client as unknown as { streamer: { write: unknown } }).streamer.write).toBe(
      fake.streamWrite,
    );
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
