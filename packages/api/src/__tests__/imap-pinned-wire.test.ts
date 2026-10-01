/**
 * Step B4, design D3, on the wire: the REAL imapflow over REAL TLS against a local
 * server (hermetic: loopback only; only DNS is faked). The mocked tests pin what
 * options are built; this pins what the library actually does with them:
 *
 *   - the socket is opened to the address Klorn resolved and checked (an IP
 *     literal, so there is nothing left for the library to resolve), on port 993;
 *   - the host name is the TLS server name (SNI) and the name the certificate is
 *     verified against, with verification on;
 *   - a certificate for another name, or one nobody trusts, fails the handshake
 *     and NOTHING is sent after it (no LOGIN, so no credential leaves);
 *   - a blocked answer opens no socket at all.
 *
 * The client is pointed at the local server by wrapping tls.connect: the options
 * the library passed are recorded first, then host/port are replaced by the local
 * server and the throwaway certificate is added as `ca` (the equivalent of
 * NODE_EXTRA_CA_CERTS). Verification itself is left as the product code set it.
 */

import net from "node:net";
import tls from "node:tls";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Identity,
  makeCertDir,
  makeIdentity,
  opensslAvailable,
  removeCertDir,
} from "./helpers/throwaway-cert.js";

const resolver = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../mail/host-resolver.js", () => ({
  DNS_QUERY_TIMEOUT_MS: 3000,
  resolveHostAddresses: (...args: unknown[]) => resolver.resolve(...args),
}));

const { createImapClient, endImapSession } = await import("../mail/imap-connection.js");
const { createPinnedImapClient, GENERIC_SESSION_BYTE_BUDGET } = await import(
  "../mail/imap-pinned-client.js"
);
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");

// No openssl, no throwaway certificate, no real-TLS proof: skip loudly rather than fail.
const HAS_OPENSSL = opensslAvailable();
if (!HAS_OPENSSL) {
  console.warn("[imap-pinned-wire] openssl not found on PATH: the real-TLS wire tests are SKIPPED");
}

const HOST = "imap.example.com";
const PUBLIC_IP = "93.184.216.34";

let certDir = "";
let good: Identity;
let wrongName: Identity;

beforeAll(() => {
  if (!HAS_OPENSSL) return;
  certDir = makeCertDir("klorn-imap-pin-");
  good = makeIdentity(certDir, "good", `DNS:${HOST}`);
  wrongName = makeIdentity(certDir, "wrong", "DNS:other.example");
});
afterAll(() => {
  if (certDir) removeCertDir(certDir);
});

interface FakeImapServer {
  port: number;
  /** SNI names the TLS handshakes carried. */
  serverNames: Array<string | false>;
  /** IMAP command lines the server received after the handshake. */
  commands: string[];
  /** How many of its connections have been closed (by either side). */
  closedConnections: () => number;
  /** Bytes the server had written to connections that have closed. */
  bytesWritten: () => number;
  stop: () => Promise<void>;
}

/** What the server answers to FETCH: nothing special, a literal far over any sane cap, or an endless drip. */
type FetchBehaviour = "ok" | "oversized-literal" | "drip" | "list-flood" | "fetch-flood";

const MIB = 1024 * 1024;
/** Each flooded item is far under every per-response cap (2 MiB line, 4 MiB literal, 8 MiB response). */
const FLOOD_ITEM_BYTES = MIB;
const FLOOD_ITEMS = 400; // 400 MiB if nothing stops it

const servers: FakeImapServer[] = [];

/** Write `count` items one after another, honouring backpressure, then the tagged OK. */
function flood(socket: net.Socket, tag: string, count: number, item: (n: number) => string): void {
  let sent = 0;
  const pump = (): void => {
    while (sent < count) {
      if (socket.destroyed) return;
      const room = socket.write(item(sent));
      sent += 1;
      if (!room) {
        socket.once("drain", pump);
        return;
      }
    }
    if (!socket.destroyed) socket.write(`${tag} OK done\r\n`);
  };
  pump();
}

/** TLS server speaking just enough IMAP for imapflow to log in. */
async function startServer(
  identity: Identity,
  fetchBehaviour: FetchBehaviour = "ok",
  floodItems: number = FLOOD_ITEMS,
): Promise<FakeImapServer> {
  const serverNames: Array<string | false> = [];
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  let closed = 0;
  let written = 0;

  const server = tls.createServer({ key: identity.key, cert: identity.cert }, (socket) => {
    sockets.add(socket);
    serverNames.push((socket as tls.TLSSocket).servername || false);
    let drip: ReturnType<typeof setInterval> | undefined;
    socket.on("close", () => {
      sockets.delete(socket);
      closed += 1;
      written += socket.bytesWritten;
      if (drip) clearInterval(drip);
    });
    socket.on("error", () => {});
    socket.write("* OK [CAPABILITY IMAP4rev1] ready\r\n");
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      let eol = pending.indexOf("\r\n");
      while (eol !== -1) {
        const line = pending.slice(0, eol);
        pending = pending.slice(eol + 2);
        eol = pending.indexOf("\r\n");
        commands.push(line);
        const [tag, verb = ""] = line.split(" ");
        if (verb.toUpperCase() === "LOGOUT") {
          socket.write(`* BYE bye\r\n${tag} OK done\r\n`);
          socket.end();
        } else if (verb.toUpperCase() === "CAPABILITY") {
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        } else if (verb.toUpperCase() === "LOGIN") {
          socket.write(`${tag} OK [CAPABILITY IMAP4rev1] logged in\r\n`);
        } else if (
          ["SELECT", "EXAMINE"].includes(verb.toUpperCase()) &&
          fetchBehaviour === "list-flood"
        ) {
          // The mailbox "does not exist": imapflow then LISTs, and the server floods that.
          socket.write(`${tag} NO nope\r\n`);
        } else if (verb.toUpperCase() === "NAMESPACE") {
          socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK done\r\n`);
        } else if (verb.toUpperCase() === "LIST" && /^\S+ LIST "" ""$/i.test(line)) {
          // imapflow's own probe for the hierarchy delimiter: answered honestly, not flooded.
          socket.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK done\r\n`);
        } else if (verb.toUpperCase() === "LIST" && fetchBehaviour === "list-flood") {
          flood(
            socket,
            tag,
            floodItems,
            (n) => `* LIST () "/" "${"A".repeat(FLOOD_ITEM_BYTES)}${n}"\r\n`,
          );
        } else if (verb.toUpperCase() === "FETCH" && fetchBehaviour === "fetch-flood") {
          // Every message is a 1 MiB literal: each response is far under every cap.
          flood(
            socket,
            tag,
            floodItems,
            (n) =>
              `* ${n + 1} FETCH (UID ${n + 1} BODY[TEXT] {${FLOOD_ITEM_BYTES}}\r\n${"x".repeat(FLOOD_ITEM_BYTES)})\r\n`,
          );
        } else if (["SELECT", "EXAMINE"].includes(verb.toUpperCase())) {
          socket.write(
            `* 1 EXISTS\r\n* OK [UIDVALIDITY 7] x\r\n* OK [UIDNEXT 6] x\r\n* FLAGS (\\Seen)\r\n${tag} OK [READ-WRITE] done\r\n`,
          );
        } else if (verb.toUpperCase() === "FETCH" && fetchBehaviour === "oversized-literal") {
          socket.write("* 1 FETCH (UID 5 BODY[TEXT] {50000000}\r\n");
        } else if (verb.toUpperCase() === "FETCH" && fetchBehaviour === "drip") {
          socket.write("* 1 FETCH (UID 5 BODY[TEXT] {100000}\r\n");
          drip = setInterval(() => socket.write("x"), 10);
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fake: FakeImapServer = {
    port: (server.address() as net.AddressInfo).port,
    serverNames,
    commands,
    closedConnections: () => closed,
    bytesWritten: () => written,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  servers.push(fake);
  return fake;
}

interface Attempt {
  host: unknown;
  port: unknown;
  servername: unknown;
  rejectUnauthorized: unknown;
}

const realConnect = tls.connect;
let attempts: Attempt[] = [];

/** Record what the library asked for, then aim it at the local server, trusting `ca`. */
function aimAt(server: FakeImapServer, ca: Buffer | undefined): void {
  vi.spyOn(tls, "connect").mockImplementation(((...args: unknown[]) => {
    const [options, ...rest] = args as [Record<string, unknown>, ...unknown[]];
    attempts.push({
      host: options.host,
      port: options.port,
      servername: options.servername,
      rejectUnauthorized: options.rejectUnauthorized,
    });
    const redirected = { ...options, host: "127.0.0.1", port: server.port, ...(ca ? { ca } : {}) };
    return (realConnect as (...a: unknown[]) => tls.TLSSocket)(redirected, ...rest);
  }) as typeof tls.connect);
}

function generic() {
  return createImapClient({
    provider: IMAP_PROVIDERS.IMAP,
    host: `${HOST}:993`,
    email: "me@example.com",
    password: "app-pw",
    socketTimeout: 5_000,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
  });
}

beforeEach(() => {
  attempts = [];
  resolver.resolve.mockReset();
  resolver.resolve.mockResolvedValue([PUBLIC_IP]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe.skipIf(!HAS_OPENSSL)("real imapflow, real TLS: the pinned connection", () => {
  it("connects to the checked address, on 993, and verifies the certificate against the host name", async () => {
    const server = await startServer(good);
    aimAt(server, good.cert);

    const client = generic();
    await client.connect();
    await endImapSession(client);

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toEqual({
      host: PUBLIC_IP,
      port: 993,
      servername: HOST,
      rejectUnauthorized: true,
    });
    // The library was handed an address, so it had no name of ours to resolve.
    expect(net.isIP(String(attempts[0].host))).not.toBe(0);
    // The server saw the host name in SNI, and a LOGIN over the verified channel.
    expect(server.serverNames).toEqual([HOST]);
    expect(server.commands.some((line) => /^\S+ LOGIN /i.test(line))).toBe(true);
  });

  it("refuses a certificate issued for another name, and sends nothing after the handshake", async () => {
    const server = await startServer(wrongName);
    // The certificate IS trusted (it is the `ca`); only the NAME is wrong, so this
    // fails on hostname verification alone.
    aimAt(server, wrongName.cert);

    const client = generic();
    await expect(client.connect()).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    await endImapSession(client);

    expect(server.commands).toEqual([]);
  });

  it("refuses a certificate nobody trusts, and sends nothing after the handshake", async () => {
    const server = await startServer(good);
    aimAt(server, undefined);

    const client = generic();
    await expect(client.connect()).rejects.toThrow();
    await endImapSession(client);

    expect(server.commands).toEqual([]);
  });

  it("opens no socket when the name resolves to a private address", async () => {
    const server = await startServer(good);
    aimAt(server, good.cert);
    resolver.resolve.mockResolvedValue(["10.0.0.5"]);

    await expect(generic().connect()).rejects.toThrow();

    expect(attempts).toEqual([]);
    expect(server.serverNames).toEqual([]);
  });

  it("opens no socket when ANY answer is private", async () => {
    const server = await startServer(good);
    aimAt(server, good.cert);
    resolver.resolve.mockResolvedValue([PUBLIC_IP, "169.254.169.254"]);

    await expect(generic().connect()).rejects.toThrow();

    expect(attempts).toEqual([]);
  });

  it("re-resolves for every connection: public, then rebound to loopback", async () => {
    const server = await startServer(good);
    aimAt(server, good.cert);
    resolver.resolve.mockResolvedValueOnce([PUBLIC_IP]).mockResolvedValueOnce(["127.0.0.1"]);

    const first = generic();
    await first.connect();
    await endImapSession(first);
    await expect(generic().connect()).rejects.toThrow();

    expect(attempts.map((a) => a.host)).toEqual([PUBLIC_IP]);
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
  });
});

/** Run a FETCH of the window the way the poll does, to the end. */
async function consumeFetch(client: ReturnType<typeof generic>): Promise<number> {
  const lock = await client.getMailboxLock("INBOX");
  let seen = 0;
  try {
    for await (const _message of client.fetch(
      "1:1",
      { envelope: true, flags: true, bodyParts: ["TEXT"] },
      { uid: false },
    )) {
      seen += 1;
    }
  } finally {
    lock.release();
  }
  return seen;
}

describe.skipIf(!HAS_OPENSSL)("real imapflow, real TLS: what a hostile server may send", () => {
  it("a literal over the cap is refused before a byte of it is read", async () => {
    const server = await startServer(good, "oversized-literal");
    aimAt(server, good.cert);

    const client = generic();
    const emitted: Array<{ code?: string }> = [];
    client.on("error", (err: { code?: string }) => emitted.push(err));
    await client.connect();

    // The stream is destroyed with LiteralTooLarge; the fetch that was waiting fails with it.
    await expect(consumeFetch(client)).rejects.toThrow();
    await vi.waitFor(() => expect(emitted.map((err) => err.code)).toContain("LiteralTooLarge"));
    await endImapSession(client);
  });

  it("a server that drips bytes forever is cut off by the session deadline", async () => {
    const server = await startServer(good, "drip");
    aimAt(server, good.cert);

    // The library's own inactivity timer is set far away: only OUR deadline can end this.
    const client = createPinnedImapClient({
      hostname: HOST,
      port: 993,
      logScope: "generic-imap",
      sessionDeadlineMs: 700,
      options: {
        auth: { user: "me@example.com", pass: "app-pw" },
        logger: false,
        socketTimeout: 120_000,
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
      },
    });
    const started = Date.now();
    await client.connect();
    await expect(consumeFetch(client)).rejects.toThrow();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(4_000);
    await vi.waitFor(() => expect(server.closedConnections()).toBe(1));
    await endImapSession(client);
  });

  it("a session that finishes inside the deadline is not cut", async () => {
    const server = await startServer(good);
    aimAt(server, good.cert);

    const client = createPinnedImapClient({
      hostname: HOST,
      port: 993,
      logScope: "generic-imap",
      sessionDeadlineMs: 2_000,
      options: {
        auth: { user: "me@example.com", pass: "app-pw" },
        logger: false,
        socketTimeout: 120_000,
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
      },
    });
    await client.connect();
    await expect(consumeFetch(client)).resolves.toBe(0);
    await endImapSession(client);
  });
});

describe.skipIf(!HAS_OPENSSL)("real imapflow, real TLS: a flood of small responses", () => {
  it("a LIST flood (400 x 1 MiB, each far under every per-response cap) is cut off by the session byte budget", async () => {
    const server = await startServer(good, "list-flood");
    aimAt(server, good.cert);

    const client = generic();
    await client.connect();
    // SELECT answers NO, imapflow LISTs, and the server floods the answer.
    await expect(client.getMailboxLock("INBOX")).rejects.toThrow();

    await vi.waitFor(() => expect(server.closedConnections()).toBe(1));
    // Without the budget the client would read all 400 MiB; with it, the budget plus what
    // the sockets were already holding.
    expect(server.bytesWritten()).toBeLessThan(GENERIC_SESSION_BYTE_BUDGET + 24 * MIB);
    expect(server.bytesWritten()).toBeLessThan((FLOOD_ITEMS * FLOOD_ITEM_BYTES) / 4);
    await endImapSession(client);
  });

  it("a FETCH flood (400 literals of 1 MiB) is cut off the same way", async () => {
    const server = await startServer(good, "fetch-flood");
    aimAt(server, good.cert);

    const client = generic();
    await client.connect();
    await expect(consumeFetch(client)).rejects.toThrow();

    await vi.waitFor(() => expect(server.closedConnections()).toBe(1));
    expect(server.bytesWritten()).toBeLessThan(GENERIC_SESSION_BYTE_BUDGET + 24 * MIB);
    expect(server.bytesWritten()).toBeLessThan((FLOOD_ITEMS * FLOOD_ITEM_BYTES) / 4);
    await endImapSession(client);
  });

  it("an honest transfer under the budget is untouched (8 messages of 1 MiB)", async () => {
    const server = await startServer(good, "fetch-flood", 8);
    aimAt(server, good.cert);

    const client = generic();
    await client.connect();
    await expect(consumeFetch(client)).resolves.toBe(8);
    expect(server.closedConnections()).toBe(0); // still open: nothing cut it
    await endImapSession(client);
  });
});
