/**
 * The whole send, end to end, with the REAL nodemailer over REAL TLS against a
 * local server (hermetic: loopback only). Only the IMAP client and the database
 * are faked. What this pins, and the mocked tests cannot:
 *
 *   - a server that stalls after DATA: when the 60 s deadline fires the SMTP
 *     socket is DESTROYED (the server sees it close), the caller is told delivery
 *     is not confirmed, and no Sent copy is filed. nodemailer's own
 *     `transport.close()` does not close an in-flight connection, so without the
 *     sender owning and destroying the socket the message could still be
 *     delivered after the caller had its answer;
 *   - a connection dropped after the message was handed over is "not confirmed",
 *     a connection that never came up is "not sent";
 *   - the happy path delivers the exact bytes and files one Sent copy.
 *
 * TLS is real and certificate verification stays on: the test makes the client
 * trust a throwaway certificate (generated with openssl at run time, nothing
 * committed) by adding it as `ca` to `tls.connect`, the equivalent of
 * NODE_EXTRA_CA_CERTS. Only setTimeout and clearTimeout are faked, so the 60 s
 * deadline can be crossed without waiting while sockets run in real time.
 */

import { execFileSync } from "node:child_process";
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

const UNCONFIRMED =
  "Naver did not confirm delivery. The message may or may not have been sent; check your Sent folder before trying again.";
const NOT_SENT = "Could not reach Naver. The message was not sent; try again shortly.";

// --- a throwaway certificate, generated at run time ---------------------------

let certDir = "";
let cert = Buffer.alloc(0);
let key = Buffer.alloc(0);

beforeAll(() => {
  certDir = fs.mkdtempSync(path.join(os.tmpdir(), "klorn-smtp-wire-"));
  const config = path.join(certDir, "san.cnf");
  fs.writeFileSync(
    config,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3",
      "prompt = no",
      "[dn]",
      "CN = 127.0.0.1",
      "[v3]",
      "subjectAltName = IP:127.0.0.1,DNS:localhost",
    ].join("\n"),
  );
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
        path.join(certDir, "key.pem"),
        "-out",
        path.join(certDir, "cert.pem"),
        "-days",
        "2",
        "-config",
        config,
      ],
      { stdio: "ignore" },
    );
    key = fs.readFileSync(path.join(certDir, "key.pem"));
    cert = fs.readFileSync(path.join(certDir, "cert.pem"));
  } catch (err) {
    // No silent skip: this is the test that proves an aborted send cannot still be delivered.
    throw new Error(
      `imap-send-wire.test.ts needs the openssl binary to make a throwaway certificate: ${String(err)}`,
    );
  }
});
afterAll(() => fs.rmSync(certDir, { recursive: true, force: true }));

// --- a fake SMTP server over implicit TLS ---------------------------------------

type AfterData = "ok" | "stall" | "drop";

interface Server {
  port: number;
  commands: string[];
  data: () => string | null;
  closed: () => boolean;
  stop: () => Promise<void>;
}

const servers: Server[] = [];

async function startServer(afterData: AfterData): Promise<Server> {
  const commands: string[] = [];
  let data: string | null = null;
  let closed = false;
  const sockets = new Set<net.Socket>();

  const server = tls.createServer({ key, cert }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      closed = true;
      sockets.delete(socket);
    });
    socket.on("error", () => {});
    socket.write("220 fake.test ESMTP\r\n");
    let buffer = "";
    let inData = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data = buffer.slice(0, end + 2);
          inData = false;
          if (afterData === "ok") socket.write("250 2.0.0 queued\r\n");
          else if (afterData === "drop") socket.destroy();
          return; // "stall": never answer the end of DATA
        }
        const newline = buffer.indexOf("\r\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        commands.push(line.startsWith("AUTH") ? "AUTH ***" : line);
        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "EHLO") socket.write("250-fake.test\r\n250 AUTH PLAIN\r\n");
        else if (verb === "AUTH") socket.write("235 2.7.0 accepted\r\n");
        else if (verb === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fake: Server = {
    port: (server.address() as net.AddressInfo).port,
    commands,
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
const naver = imapSendActions("NAVER");
const send = () =>
  naver.sendEmail("u1", "bob@example.com", "Hi", "Hello", [], { linkedInboxAccountId: "row-1" });

function pointRegistryAt(port: number) {
  IMAP_PROVIDERS.NAVER.smtp = { host: "127.0.0.1", port, security: "implicit-tls" };
}

beforeEach(() => {
  resetHarness();
  resetImapSessionState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  arm();
  // Trust the throwaway certificate; verification itself stays on in the product code.
  vi.spyOn(tls, "connect").mockImplementation(((...args: unknown[]) => {
    const [options, ...rest] = args;
    const withCa =
      typeof options === "object" && options !== null ? { ...options, ca: cert } : options;
    return (realConnect as (...a: unknown[]) => tls.TLSSocket)(withCa, ...rest);
  }) as typeof tls.connect);
});
afterEach(async () => {
  IMAP_PROVIDERS.NAVER.smtp = realRegistry;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe("real nodemailer over real TLS, local server", () => {
  it("a server that stalls after DATA: the deadline destroys the socket, the caller is told 'not confirmed', no Sent copy", async () => {
    const server = await startServer("stall");
    pointRegistryAt(server.port);
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
    expect(server.commands.map((c) => c.split(" ")[0])).toEqual([
      "EHLO",
      "AUTH",
      "MAIL",
      "RCPT",
      "DATA",
    ]);
  });

  it("a connection dropped after the message was handed over: 'not confirmed', nothing filed", async () => {
    const server = await startServer("drop");
    pointRegistryAt(server.port);

    const result = await send();
    expect(result).toEqual({ error: UNCONFIRMED });
    expect(JSON.stringify(result)).not.toContain("Could not reach");
    await settle();
    expect(h.imapCtorOpts).toHaveLength(0);
    expect(loggedText()).not.toContain("bob@example.com");
  });

  it("a connection that never came up: 'not sent'", async () => {
    pointRegistryAt(await closedPort());
    const result = await send();
    expect(result).toEqual({ error: NOT_SENT });
  });

  it("the happy path delivers the exact bytes and files one Sent copy", async () => {
    const server = await startServer("ok");
    pointRegistryAt(server.port);

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
