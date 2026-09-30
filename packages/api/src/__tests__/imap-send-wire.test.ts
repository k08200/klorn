/**
 * The whole send, end to end, with the REAL nodemailer over REAL TLS against a
 * local server (hermetic: loopback only). Only the IMAP client and the database
 * are faked. What this pins, and the mocked tests cannot:
 *
 *   - a server that stalls after DATA: when the 60 s deadline fires the SMTP
 *     socket is DESTROYED (the server sees it close), the caller is told delivery
 *     is not confirmed, and no Sent copy is filed. nodemailer's own
 *     `transport.close()` does not close an in-flight connection. This runs over
 *     implicit TLS and over STARTTLS, the path production uses on port 587, where
 *     nodemailer wraps the caller's socket in a TLS socket;
 *   - an abort BEFORE nodemailer has connected is not undone: nodemailer resolves
 *     DNS first and then calls `socket.connect()`, and Node's connect() on a
 *     destroyed socket reconnects it, so the session refuses to connect once
 *     aborted. The server never sees a connection;
 *   - a connection dropped after the message was handed over is "not confirmed",
 *     a connection that never came up, and a certificate or hostname failure
 *     (nothing could have been sent: no AUTH, no MAIL FROM) are "not sent";
 *   - the happy path delivers the exact bytes and files one Sent copy.
 *
 * TLS is real and certificate verification stays on: the test makes the client
 * trust a throwaway certificate (generated with openssl at run time, nothing
 * committed) by adding it as `ca` to `tls.connect`, the equivalent of
 * NODE_EXTRA_CA_CERTS. Only setTimeout and clearTimeout are faked, so the 60 s
 * deadline can be crossed without waiting while sockets run in real time.
 */

import { execFileSync } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { arm, h, loggedText, resetHarness, settle } from "./helpers/imap-send-harness.js";

vi.mock("imapflow", async () => ({
  ImapFlow: (await import("./helpers/imap-send-harness.js")).FakeImapFlow,
}));
vi.mock("../db.js", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  const prisma = {
    linkedInboxAccount: { findFirst: (...args: unknown[]) => h.findFirst(...args) },
    emailMessage: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  return { prisma, db: prisma };
});
vi.mock("../crypto-tokens.js", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  return { decryptToken: (...args: unknown[]) => h.decryptToken(...args) };
});
vi.mock("../sentry.js", async () => {
  const { h } = await import("./helpers/imap-send-harness.js");
  return { captureError: (...args: unknown[]) => h.captureError(...args) };
});

const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { imapSendActions } = await import("../mail/providers/imap-send.js");
const { resetImapSessionState, TASK_TOTAL_TIMEOUT_MS } = await import(
  "../mail/providers/imap-session.js"
);
const { classifySmtpFailure, openSmtpSession } = await import("../mail/smtp-transport.js");

const UNCONFIRMED =
  "Naver did not confirm delivery. The message may or may not have been sent; check your Sent folder before trying again.";
const NOT_SENT = "Could not reach Naver. The message was not sent; try again shortly.";

// --- throwaway certificates, generated at run time ---------------------------

interface Identity {
  key: Buffer;
  cert: Buffer;
}

let certDir = "";
/** Valid for 127.0.0.1 and localhost. */
let good: Identity;
/** Valid only for other.example: a hostname mismatch for anything we connect to. */
let wrongHost: Identity;

function makeIdentity(name: string, altNames: string): Identity {
  const config = path.join(certDir, `${name}.cnf`);
  fs.writeFileSync(
    config,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3",
      "prompt = no",
      "[dn]",
      `CN = ${name}`,
      "[v3]",
      `subjectAltName = ${altNames}`,
    ].join("\n"),
  );
  const keyFile = path.join(certDir, `${name}.key.pem`);
  const certFile = path.join(certDir, `${name}.cert.pem`);
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
      ].concat(["-days", "2", "-config", config]),
      { stdio: "ignore" },
    );
  } catch (err) {
    // No silent skip: this is the test that proves an aborted send cannot still be delivered.
    throw new Error(
      `imap-send-wire.test.ts needs the openssl binary to make a throwaway certificate: ${String(err)}`,
    );
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

beforeAll(() => {
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), "klorn-smtp-wire-"));
  good = makeIdentity("good", "IP:127.0.0.1,DNS:localhost");
  wrongHost = makeIdentity("wrong", "DNS:other.example");
});
afterAll(() => fs.rmSync(certDir, { recursive: true, force: true }));

// --- a fake SMTP server: implicit TLS, or plaintext with STARTTLS ---------------

type AfterData = "ok" | "stall" | "drop";
type Security = "implicit-tls" | "starttls";

interface Server {
  port: number;
  commands: string[];
  connections: () => number;
  data: () => string | null;
  closed: () => boolean;
  stop: () => Promise<void>;
}

const servers: Server[] = [];

async function startServer(
  afterData: AfterData,
  security: Security = "implicit-tls",
  identity: Identity = good,
): Promise<Server> {
  const commands: string[] = [];
  let data: string | null = null;
  let closed = false;
  let connections = 0;
  const sockets = new Set<net.Socket>();

  const attach = (stream: net.Socket, isInitial: boolean, canUpgrade: boolean) => {
    sockets.add(stream);
    stream.on("close", () => {
      closed = true;
      sockets.delete(stream);
    });
    stream.on("error", () => {});
    if (isInitial) stream.write("220 fake.test ESMTP\r\n");
    let buffer = "";
    let inData = false;
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data = buffer.slice(0, end + 2);
          inData = false;
          if (afterData === "ok") stream.write("250 2.0.0 queued\r\n");
          else if (afterData === "drop") stream.destroy();
          return; // "stall": never answer the end of DATA
        }
        const newline = buffer.indexOf("\r\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        commands.push(line.startsWith("AUTH") ? "AUTH ***" : line);
        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "EHLO") {
          stream.write(
            `250-fake.test\r\n${canUpgrade ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN\r\n`,
          );
        } else if (verb === "STARTTLS" && canUpgrade) {
          stream.write("220 2.0.0 ready to start TLS\r\n");
          stream.removeListener("data", onData);
          attach(new tls.TLSSocket(stream, { isServer: true, ...identity }), false, false);
          return;
        } else if (verb === "AUTH") stream.write("235 2.7.0 accepted\r\n");
        else if (verb === "DATA") {
          inData = true;
          stream.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          stream.write("221 bye\r\n");
          stream.end();
        } else stream.write("250 ok\r\n");
      }
    };
    stream.on("data", onData);
  };

  const server: net.Server =
    security === "implicit-tls"
      ? tls.createServer(identity, (socket) => attach(socket, true, false))
      : net.createServer((socket) => attach(socket, true, true));
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fake: Server = {
    port: (server.address() as net.AddressInfo).port,
    commands,
    connections: () => connections,
    data: () => data,
    closed: () => closed,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  servers.push(fake);
  return fake;
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Wait, in real time, for a condition that depends on real sockets. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// --- wiring ---------------------------------------------------------------------

const realRegistry = IMAP_PROVIDERS.NAVER.smtp;
const realConnect = tls.connect;
const realSetTimeout = globalThis.setTimeout;
const naver = imapSendActions("NAVER");
const send = () =>
  naver.sendEmail("u1", "bob@example.com", "Hi", "Hello", [], { linkedInboxAccountId: "row-1" });

/** The certificate the client trusts (as `ca`). Undefined: only the system roots. */
let trustedCa: Buffer | undefined;

function pointRegistryAt(port: number, security: Security = "implicit-tls", host = "127.0.0.1") {
  IMAP_PROVIDERS.NAVER.smtp = { host, port, security };
}

/** Real time, even while setTimeout is faked. */
const realSleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

beforeEach(() => {
  resetHarness();
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  arm();
  trustedCa = good.cert;
  // Trust the throwaway certificate; verification itself stays on in the product code.
  vi.spyOn(tls, "connect").mockImplementation(((...args: unknown[]) => {
    const [options, ...rest] = args;
    const withCa =
      typeof options === "object" && options !== null && trustedCa
        ? { ...options, ca: trustedCa }
        : options;
    return (realConnect as (...a: unknown[]) => tls.TLSSocket)(withCa, ...rest);
  }) as typeof tls.connect);
});
afterEach(async () => {
  IMAP_PROVIDERS.NAVER.smtp = realRegistry;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe.each<Security>([
  "implicit-tls",
  "starttls",
])("real nodemailer, real TLS, caller-owned socket, %s", (security) => {
  it("a server that stalls after DATA: the deadline destroys the socket, the caller is told 'not confirmed', no Sent copy", async () => {
    const server = await startServer("stall", security);
    pointRegistryAt(server.port, security);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const result = send();
    await until(() => server.data() !== null, "the message to reach the server");
    expect(server.closed()).toBe(false);

    await vi.advanceTimersByTimeAsync(TASK_TOTAL_TIMEOUT_MS);
    const answer = await result;

    // the server sees the connection close: the message cannot still be delivered
    await until(() => server.closed(), "the server to see the socket close");
    expect(answer).toEqual({ error: UNCONFIRMED });
    await settle();
    expect(h.imapCtorOpts).toHaveLength(0);
    expect(h.append).not.toHaveBeenCalled();
    const verbs = server.commands.map((c) => c.split(" ")[0]);
    expect(verbs.slice(-4)).toEqual(["AUTH", "MAIL", "RCPT", "DATA"]);
    expect(verbs.includes("STARTTLS")).toBe(security === "starttls");
  });

  it("a connection dropped after the message was handed over: 'not confirmed', nothing filed", async () => {
    const server = await startServer("drop", security);
    pointRegistryAt(server.port, security);

    const result = await send();
    expect(result).toEqual({ error: UNCONFIRMED });
    expect(JSON.stringify(result)).not.toContain("Could not reach");
    await settle();
    expect(h.imapCtorOpts).toHaveLength(0);
    expect(loggedText()).not.toContain("bob@example.com");
  });

  it("the happy path delivers the exact bytes and files one Sent copy", async () => {
    const server = await startServer("ok", security);
    pointRegistryAt(server.port, security);

    const result = await send();
    expect(result).toMatchObject({ success: true });
    await settle();
    await until(() => h.append.mock.calls.length > 0, "the Sent copy");

    const onWire = server.data() ?? "";
    expect(onWire.split("\r\n\r\n")[0]).toContain("From: me@naver.com");
    expect(onWire.split("\r\n\r\n")[0]).toContain("To: bob@example.com");
    const appended = h.append.mock.calls[0][1] as Buffer;
    expect(Buffer.from(onWire, "latin1").equals(appended)).toBe(true);
    expect(h.append).toHaveBeenCalledTimes(1);
    await until(() => server.closed(), "the server to see the connection end");
  });
});

describe("a connection that never came up", () => {
  it("is 'not sent'", async () => {
    pointRegistryAt(await closedPort());
    expect(await send()).toEqual({ error: NOT_SENT });
  });
});

describe("a certificate or hostname failure: nothing could have been sent", () => {
  it("an untrusted certificate after STARTTLS is 'not sent', with no AUTH and no MAIL FROM", async () => {
    const server = await startServer("ok", "starttls");
    pointRegistryAt(server.port, "starttls");
    trustedCa = undefined; // the server's certificate is self-signed and not trusted

    expect(await send()).toEqual({ error: NOT_SENT });
    expect(server.commands.map((c) => c.split(" ")[0])).toEqual(["EHLO", "STARTTLS"]);
    expect(server.data()).toBeNull();
    await settle();
    expect(h.imapCtorOpts).toHaveLength(0);
  });

  it("a certificate for another hostname after STARTTLS is 'not sent'", async () => {
    const server = await startServer("ok", "starttls", wrongHost);
    pointRegistryAt(server.port, "starttls");
    trustedCa = wrongHost.cert; // trusted, but it does not name 127.0.0.1

    expect(await send()).toEqual({ error: NOT_SENT });
    expect(server.commands.map((c) => c.split(" ")[0])).toEqual(["EHLO", "STARTTLS"]);
    expect(server.data()).toBeNull();
  });

  it("an untrusted certificate on implicit TLS is 'not sent'", async () => {
    const server = await startServer("ok", "implicit-tls");
    pointRegistryAt(server.port, "implicit-tls");
    trustedCa = undefined;

    expect(await send()).toEqual({ error: NOT_SENT });
    expect(server.commands).toEqual([]);
    expect(server.data()).toBeNull();
  });
});

describe("an abort before nodemailer has connected is not undone", () => {
  it("openSmtpSession: abort right after send() means the server never sees a connection", async () => {
    const server = await startServer("ok", "starttls");
    const provider = {
      ...IMAP_PROVIDERS.NAVER,
      smtp: { host: "127.0.0.1", port: server.port, security: "starttls" as const },
    };
    const session = await openSmtpSession(provider, { email: "me@naver.com", password: "pw" });

    const submitted = session
      .send({
        from: "me@naver.com",
        to: "bob@example.com",
        raw: Buffer.from("From: x\r\n\r\nhi\r\n"),
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    session.abort();
    const error = await submitted;
    await realSleep(300); // long enough for a reconnect to have happened

    expect(error).not.toBeNull();
    expect(server.connections()).toBe(0);
    expect(server.commands).toEqual([]);
    expect(server.data()).toBeNull();
    expect(classifySmtpFailure(error, session.connected)).toBe("not-sent");
  });

  it("a DNS stall that runs into the 60 s deadline: the late answer cannot connect", async () => {
    const server = await startServer("ok", "starttls");
    pointRegistryAt(server.port, "starttls", "localhost");
    const dnsStall = stallDns();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const result = send();
    await until(() => dnsStall.stalled() > 0, "nodemailer to start resolving the hostname");

    await vi.advanceTimersByTimeAsync(TASK_TOTAL_TIMEOUT_MS);
    expect(await result).toEqual({ error: UNCONFIRMED });

    dnsStall.release(); // the resolver finally answers: nodemailer goes on to connect()
    await realSleep(400);
    expect(server.connections()).toBe(0);
    expect(server.data()).toBeNull();
    expect(h.imapCtorOpts).toHaveLength(0);
    expect(h.append).not.toHaveBeenCalled();
  });
});

/**
 * Make every hostname lookup nodemailer starts hang until `release()`. nodemailer
 * resolves with a dns.Resolver (resolve4, resolve6) and falls back to dns.lookup.
 */
function stallDns() {
  let stalling = true;
  const pending: Array<() => void> = [];
  const realResolver4 = dns.Resolver.prototype.resolve4;
  const realLookup = dns.lookup;
  vi.spyOn(dns.Resolver.prototype, "resolve4").mockImplementation(function (
    this: dns.Resolver,
    ...args: unknown[]
  ) {
    const callback = args[args.length - 1] as (err: null, addresses: string[]) => void;
    if (!stalling) return (realResolver4 as (...a: unknown[]) => unknown).apply(this, args);
    pending.push(() => callback(null, ["127.0.0.1"]));
    return undefined as never;
  } as never);
  vi.spyOn(dns.Resolver.prototype, "resolve6").mockImplementation(((...args: unknown[]) => {
    (args[args.length - 1] as (err: null, addresses: string[]) => void)(null, []);
  }) as never);
  vi.spyOn(dns, "lookup").mockImplementation(((...args: unknown[]) => {
    const callback = args[args.length - 1] as (...a: unknown[]) => void;
    const options = args[1] as { all?: boolean } | undefined;
    if (!stalling) return (realLookup as (...a: unknown[]) => unknown)(...args);
    pending.push(() =>
      options?.all
        ? callback(null, [{ address: "127.0.0.1", family: 4 }])
        : callback(null, "127.0.0.1", 4),
    );
    return undefined as never;
  }) as never);
  return {
    stalled: () => pending.length,
    release() {
      stalling = false;
      for (const answer of pending.splice(0)) answer();
    },
  };
}
