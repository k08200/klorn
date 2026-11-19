/**
 * A refused IMAP login, as the REAL imapflow throws it over REAL TLS (loopback
 * only; DNS is faked and the socket aimed at a local server, as in
 * imap-pinned-wire.test.ts), read by Klorn's own classifiers.
 *
 * The other tests build these errors by hand (sync-error-code.test.ts) or with a
 * fake imapflow. This pins that the library still builds them that way: the
 * login backoff stops a mailbox after four credential refusals
 * (imap-auth-backoff.ts), so an upgrade that turned a busy server, a throttled
 * login or a dropped connection into `authenticationFailed` without a transient
 * response code would lock users out, and one that dropped the flag from a real
 * refusal would send a revoked password every five minutes.
 *
 * imapflow 1.x set `authenticationFailed` on every LOGIN that failed, a throttled
 * one included, so Microsoft 365 throttling counted as a refused password. 2.x
 * sets it only on a tagged NO or BAD that is not throttling (ETHROTTLE): a
 * throttled login now reads as throttled and does not advance the backoff. A
 * connection lost mid-LOGIN rejects connect() before LOGIN settles, in both.
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
// sync-error-code.ts imports the Prisma client; nothing here touches the database.
vi.mock("../db.js", () => ({ prisma: {}, db: {} }));

const { createImapClient, endImapSession } = await import("../mail/imap-connection.js");
const { IMAP_PROVIDERS } = await import("../mail/imap-providers.js");
const { imapSyncErrorCode, isCredentialRefusal } = await import("../mail/sync-error-code.js");
const { classifyVerifyFailure } = await import("../mail/imap-verify-failure.js");

const HAS_OPENSSL = opensslAvailable();
if (!HAS_OPENSSL) {
  console.warn("[imap-login-refusal-wire] openssl not found on PATH: these wire tests are SKIPPED");
}

const HOST = "imap.example.com";
const PUBLIC_IP = "93.184.216.34";
const USER = "refusal-probe@example.com";
const PASSWORD = "refusal-probe-app-pw";

/** How the server answers the login: a tagged status line, or a dropped connection. */
type Answer = { reply: (tag: string) => string } | "drop";

interface LoginServer {
  port: number;
  /** Command verbs the server received, in order. */
  verbs: string[];
  stop: () => Promise<void>;
}

let certDir = "";
let identity: Identity;
const servers: LoginServer[] = [];

/** A TLS server that greets, then answers LOGIN or AUTHENTICATE PLAIN with `answer`. */
async function startServer(answer: Answer, authPlain: boolean): Promise<LoginServer> {
  const caps = authPlain ? "IMAP4rev1 AUTH=PLAIN" : "IMAP4rev1";
  const verbs: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = tls.createServer({ key: identity.key, cert: identity.cert }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.write(`* OK [CAPABILITY ${caps}] ready\r\n`);
    let pending = "";
    let saslTag: string | null = null;
    const refuse = (tag: string): void => {
      if (answer === "drop") socket.destroy();
      else socket.write(`${answer.reply(tag)}\r\n`);
    };
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      let eol = pending.indexOf("\r\n");
      while (eol !== -1) {
        const line = pending.slice(0, eol);
        pending = pending.slice(eol + 2);
        eol = pending.indexOf("\r\n");
        if (saslTag) {
          // The SASL PLAIN response to our continuation request.
          const tag = saslTag;
          saslTag = null;
          refuse(tag);
          continue;
        }
        const [tag = "*", verb = "", ...rest] = line.split(" ");
        const upper = verb.toUpperCase();
        verbs.push(upper);
        if (upper === "LOGIN") {
          refuse(tag);
        } else if (upper === "AUTHENTICATE") {
          // `AUTHENTICATE PLAIN <initial response>` with SASL-IR, else a continuation first.
          if (rest.length > 1) refuse(tag);
          else {
            saslTag = tag;
            socket.write("+ \r\n");
          }
        } else if (upper === "CAPABILITY") {
          socket.write(`* CAPABILITY ${caps}\r\n${tag} OK done\r\n`);
        } else if (upper === "LOGOUT") {
          socket.write(`* BYE bye\r\n${tag} OK done\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fake: LoginServer = {
    port: (server.address() as net.AddressInfo).port,
    verbs,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  servers.push(fake);
  return fake;
}

/** Aim the library's TLS connect at the local server, trusting the throwaway certificate. */
function aimAt(server: LoginServer): void {
  const realConnect = tls.connect;
  vi.spyOn(tls, "connect").mockImplementation(((...args: unknown[]) => {
    const [options, ...rest] = args as [Record<string, unknown>, ...unknown[]];
    const redirected = { ...options, host: "127.0.0.1", port: server.port, ca: identity.cert };
    return (realConnect as (...a: unknown[]) => tls.TLSSocket)(redirected, ...rest);
  }) as typeof tls.connect);
}

/** Log in through Klorn's generic (pinned) client and return what connect() rejected with. */
async function loginError(answer: Answer, authPlain: boolean): Promise<unknown> {
  const server = await startServer(answer, authPlain);
  aimAt(server);
  const client = createImapClient({
    provider: IMAP_PROVIDERS.IMAP,
    host: `${HOST}:993`,
    email: USER,
    password: PASSWORD,
    socketTimeout: 5_000,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
  });
  try {
    await client.connect();
  } catch (err) {
    return err;
  } finally {
    await endImapSession(client);
  }
  throw new Error("the login was expected to fail");
}

/** The fields Klorn reads, and what Klorn makes of them. */
function observe(err: unknown) {
  const e = err as {
    authenticationFailed?: unknown;
    serverResponseCode?: unknown;
    responseStatus?: unknown;
    code?: unknown;
  };
  return {
    authenticationFailed: e.authenticationFailed === true,
    serverResponseCode: e.serverResponseCode ?? null,
    responseStatus: e.responseStatus ?? null,
    code: e.code ?? null,
    credentialRefusal: isCredentialRefusal(err),
    syncErrorCode: imapSyncErrorCode(err),
    verifyCode: classifyVerifyFailure(err, {
      provider: IMAP_PROVIDERS.IMAP,
      host: HOST,
      password: PASSWORD,
    }).code,
  };
}

const no = (code: string) => (tag: string) => `${tag} NO [${code}] refused`;

/** What a refusal of the credentials must read as. */
const REFUSED = { credentialRefusal: true, syncErrorCode: "auth", verifyCode: "IMAP_AUTH_FAILED" };
/** What a refusal for the moment must read as: never a credential refusal. */
const BUSY = { credentialRefusal: false, syncErrorCode: "throttled", verifyCode: "IMAP_AUTH_FAILED" };

let consoleCalls: unknown[][] = [];

beforeAll(() => {
  if (!HAS_OPENSSL) return;
  certDir = makeCertDir("klorn-imap-refusal-");
  identity = makeIdentity(certDir, "good", `DNS:${HOST}`);
});
afterAll(() => {
  if (certDir) removeCertDir(certDir);
});
beforeEach(() => {
  resolver.resolve.mockReset();
  resolver.resolve.mockResolvedValue([PUBLIC_IP]);
  consoleCalls = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

describe.skipIf(!HAS_OPENSSL)("real imapflow: a refused login, through Klorn's classifiers", () => {
  it.each([
    ["LOGIN", false],
    ["AUTHENTICATE PLAIN", true],
  ] as const)("%s refused with AUTHENTICATIONFAILED is a credential refusal", async (_, plain) => {
    const err = await loginError({ reply: no("AUTHENTICATIONFAILED") }, plain);
    expect(observe(err)).toEqual({
      authenticationFailed: true,
      serverResponseCode: "AUTHENTICATIONFAILED",
      responseStatus: "NO",
      code: null,
      ...REFUSED,
    });
  });

  it("a NO without a response code is a credential refusal", async () => {
    const err = await loginError({ reply: (tag) => `${tag} NO Invalid credentials` }, false);
    expect(observe(err)).toEqual({
      authenticationFailed: true,
      serverResponseCode: null,
      responseStatus: "NO",
      code: null,
      ...REFUSED,
    });
  });

  it.each([
    "UNAVAILABLE",
    "LIMIT",
    "INUSE",
    "SERVERBUG",
  ])("a LOGIN refused with %s is about the moment, not the password", async (rfc5530) => {
    const err = await loginError({ reply: no(rfc5530) }, false);
    expect(observe(err)).toEqual({
      authenticationFailed: true,
      serverResponseCode: rfc5530,
      responseStatus: "NO",
      code: null,
      ...BUSY,
    });
  });

  it("AUTHENTICATE PLAIN refused with UNAVAILABLE is about the moment, not the password", async () => {
    const err = await loginError({ reply: no("UNAVAILABLE") }, true);
    expect(observe(err)).toMatchObject({ serverResponseCode: "UNAVAILABLE", ...BUSY });
  });

  it("a throttled LOGIN (Microsoft 365's BAD with a backoff) is throttling, not a refusal", async () => {
    const err = await loginError(
      { reply: (tag) => `${tag} BAD Request is throttled. Suggested Backoff Time: 10 milliseconds` },
      false,
    );
    expect(observe(err)).toEqual({
      authenticationFailed: false,
      serverResponseCode: null,
      responseStatus: "BAD",
      code: "ETHROTTLE",
      credentialRefusal: false,
      syncErrorCode: "throttled",
      verifyCode: "IMAP_VERIFY_FAILED",
    });
  });

  it("a connection lost during LOGIN says nothing about the password", async () => {
    const err = await loginError("drop", false);
    expect(observe(err)).toEqual({
      authenticationFailed: false,
      serverResponseCode: null,
      responseStatus: null,
      // imapflow's code for a TLS connection the server closed after it was set up.
      code: "ClosedAfterConnectTLS",
      credentialRefusal: false,
      syncErrorCode: "error",
      verifyCode: "IMAP_VERIFY_FAILED",
    });
  });

  it("logs neither the user nor the password while a login fails", async () => {
    await loginError({ reply: no("AUTHENTICATIONFAILED") }, false);
    await loginError("drop", false);
    const printed = JSON.stringify(consoleCalls, (_, value) =>
      value instanceof Error ? { message: value.message, ...value } : value,
    );
    expect(printed).not.toContain(USER);
    expect(printed).not.toContain(PASSWORD);
  });
});
