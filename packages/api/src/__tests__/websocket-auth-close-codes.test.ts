import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

// The WebSocket handshake's session check, over a real socket.
//
// The HTTP session check answers a database failure with a retryable 503
// (#1751); the socket used to catch the same failure together with a bad JWT
// and close with 4001, the "signed out" code. A transient pool timeout must
// close with 1013 "Try Again Later" instead, so a client reconnects with
// backoff and never treats the blip as a sign-out. 4001 stays for a session
// that is definitively gone: forged/expired JWT, kicked device, reset epoch.

type DeviceRow = { id: string; userId: string; lastActiveAt: Date; createdAt: Date };
type UserRow = { id: string; sessionsInvalidatedAt: Date | null };

const store = vi.hoisted(() => ({
  device: null as DeviceRow | null,
  user: null as UserRow | null,
  deviceError: null as Error | null,
  userError: null as Error | null,
  /** While set, the device lookup waits for it: a session check in flight. */
  deviceGate: null as Promise<void> | null,
  deviceReads: 0,
}));

const captureError = vi.hoisted(() => vi.fn());

vi.mock("../sentry.js", () => ({ captureError }));

vi.mock("../db.js", () => {
  const prisma = {
    device: {
      findUnique: vi.fn(async () => {
        store.deviceReads += 1;
        if (store.deviceGate) await store.deviceGate;
        if (store.deviceError) throw store.deviceError;
        return store.device;
      }),
      update: vi.fn(async () => ({})),
    },
    user: {
      findUnique: vi.fn(async () => {
        if (store.userError) throw store.userError;
        return store.user;
      }),
    },
  };
  return { prisma, db: prisma };
});

const { signToken } = await import("../auth.js");
const { initWebSocket, WS_AUTH_SUBPROTOCOL, WS_CLOSE_SESSION_CHECK_UNAVAILABLE } = await import(
  "../websocket.js"
);

const USER_ID = "u-ws";

function liveDevice(): DeviceRow {
  const now = new Date();
  return { id: "d-1", userId: USER_ID, lastActiveAt: now, createdAt: now };
}

function liveUser(overrides: Partial<UserRow> = {}): UserRow {
  return { id: USER_ID, sessionsInvalidatedAt: null, ...overrides };
}

/** What Prisma throws when the pool cannot hand out a connection in time. */
function poolTimeout(): Error {
  const err = new Error("Timed out fetching a new connection from the connection pool.");
  err.name = "PrismaClientKnownRequestError";
  (err as unknown as { code: string }).code = "P2024";
  return err;
}

type Outcome = { kind: "closed"; code: number; reason: string } | { kind: "message"; type: string };

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer();
  initWebSocket(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${port}/ws?type=web`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Connect, then report the first thing the server does: close or send. */
function connect(protocols?: string[]): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const ws = protocols ? new WebSocket(baseUrl, protocols) : new WebSocket(baseUrl);
    let welcome: Outcome | null = null;
    ws.once("message", (data) => {
      const { type } = JSON.parse(data.toString()) as { type: string };
      welcome = { kind: "message", type };
      ws.close();
    });
    // Resolve on close only, so an admitted socket is gone before the next test.
    ws.once("close", (code, reason) =>
      resolve(welcome ?? { kind: "closed", code, reason: reason.toString() }),
    );
    ws.once("error", reject);
  });
}

function connectWithToken(token: string): Promise<Outcome> {
  return connect([WS_AUTH_SUBPROTOCOL, token]);
}

// Each test runs a minute after the previous one on a fake clock (Date only —
// the socket's own timers stay real), so the once-per-30-seconds Sentry report
// never carries over between tests.
const REPORT_INTERVAL_MS = 30_000;
let clock = Date.now();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  clock += 2 * REPORT_INTERVAL_MS;
  vi.setSystemTime(clock);
  store.device = liveDevice();
  store.user = liveUser();
  store.deviceError = null;
  store.userError = null;
  store.deviceGate = null;
  store.deviceReads = 0;
  captureError.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("websocket handshake — database failure is retryable, not a sign-out", () => {
  it("uses the IANA 'Try Again Later' close code", () => {
    expect(WS_CLOSE_SESSION_CHECK_UNAVAILABLE).toBe(1013);
  });

  it("closes with 1013 (not 4001) when the device lookup throws", async () => {
    store.deviceError = poolTimeout();
    const outcome = await connectWithToken(signToken(USER_ID));
    expect(outcome).toMatchObject({ kind: "closed", code: 1013 });
  });

  it("closes with 1013 (not 4001) when the revocation-epoch lookup throws", async () => {
    store.userError = poolTimeout();
    const outcome = await connectWithToken(signToken(USER_ID));
    expect(outcome).toMatchObject({ kind: "closed", code: 1013 });
  });

  it("keeps database text out of the close reason and reports the failure", async () => {
    store.deviceError = poolTimeout();
    const outcome = await connectWithToken(signToken(USER_ID));
    if (outcome.kind !== "closed") throw new Error("expected a close");
    expect(outcome.reason).not.toMatch(/pool|prisma|P2024|connection|timed out/i);
    expect(outcome.reason.length).toBeGreaterThan(0);
    expect(captureError).toHaveBeenCalled();
  });

  it("closes with 4001 when one check ended the session even if the other threw", async () => {
    store.device = null; // kicked / logged out
    store.userError = poolTimeout();
    const outcome = await connectWithToken(signToken(USER_ID));
    expect(outcome).toMatchObject({ kind: "closed", code: 4001 });
  });
});

describe("websocket handshake — a definitively ended session is still 4001", () => {
  it("closes with 4001 when the device session is gone (logged out or kicked)", async () => {
    store.device = null;
    const outcome = await connectWithToken(signToken(USER_ID));
    expect(outcome).toEqual({
      kind: "closed",
      code: 4001,
      reason: "Session expired. Please log in again.",
    });
  });

  it("closes with 4001 when a password reset revoked the token's epoch", async () => {
    store.user = liveUser({ sessionsInvalidatedAt: new Date(Date.now() + 60_000) });
    const outcome = await connectWithToken(signToken(USER_ID));
    expect(outcome).toEqual({
      kind: "closed",
      code: 4001,
      reason: "Session expired. Please log in again.",
    });
  });

  it("closes with 4001 for a forged or expired JWT without touching the database", async () => {
    store.deviceError = poolTimeout(); // must not be reached
    const outcome = await connectWithToken("not.a-valid.jwt");
    expect(outcome).toEqual({ kind: "closed", code: 4001, reason: "Invalid or expired token" });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("leaves the missing-subprotocol path unchanged (4001, demo access off)", async () => {
    const outcome = await connect();
    expect(outcome).toEqual({
      kind: "closed",
      code: 4001,
      reason: "Authentication required — offer the auth subprotocol",
    });
  });

  it("admits a live session", async () => {
    const outcome = await connectWithToken(signToken(USER_ID));
    expect(outcome).toEqual({ kind: "message", type: "connected" });
  });
});

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `ready()` holds; polls on real timers (only Date is faked). */
async function until(ready: () => boolean): Promise<void> {
  while (!ready()) await settle(5);
}

/**
 * Open a live socket and read the user's client list from its welcome: the
 * server registered it last, so every earlier admission of this user shows.
 * By then any earlier handshake's session check has long answered.
 */
function clientsSeenByNextSocket(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseUrl, [WS_AUTH_SUBPROTOCOL, signToken(USER_ID)]);
    ws.once("message", (data) => {
      const { payload } = JSON.parse(data.toString()) as {
        payload: { clientId: string; connectedClients: Array<{ clientId: string }> };
      };
      const seen = payload.connectedClients.map((c) =>
        c.clientId === payload.clientId ? "self" : c.clientId,
      );
      ws.once("close", () => resolve(seen));
      ws.close();
    });
    ws.once("error", reject);
  });
}

describe("websocket handshake — the socket while its session check is in flight", () => {
  it("registers no client for a rejected socket", async () => {
    store.deviceError = poolTimeout();
    await connectWithToken(signToken(USER_ID));
    store.device = null;
    store.deviceError = null;
    await connectWithToken(signToken(USER_ID));
    store.device = liveDevice();
    expect(await clientsSeenByNextSocket()).toEqual(["self"]);
  });

  it("admits nothing when the peer left before the check answered", async () => {
    const gate = deferred();
    store.deviceGate = gate.promise;
    const ws = new WebSocket(baseUrl, [WS_AUTH_SUBPROTOCOL, signToken(USER_ID)]);
    await new Promise((resolve) => ws.once("open", resolve));
    await until(() => store.deviceReads > 0); // the check is in flight
    const closed = new Promise((resolve) => ws.once("close", resolve));
    ws.terminate();
    await closed;
    await settle(50); // the server sees the reset
    store.deviceGate = null;
    gate.release(); // the check answers "active" for a socket that is gone
    expect(await clientsSeenByNextSocket()).toEqual(["self"]);
  });

  it("survives a malformed frame sent while the check is in flight", async () => {
    const gate = deferred();
    store.deviceGate = gate.promise;
    const ws = new WebSocket(baseUrl, [WS_AUTH_SUBPROTOCOL, signToken(USER_ID)]);
    await new Promise((resolve) => ws.once("open", resolve));
    await until(() => store.deviceReads > 0); // the check is in flight
    ws.on("error", () => {});
    const closed = new Promise((resolve) => ws.once("close", resolve));
    // A masked, empty text frame with RSV1 set and no extension negotiated:
    // the server's frame parser rejects it and emits 'error' on the socket.
    const raw = (ws as unknown as { _socket: { write(b: Buffer): void } })._socket;
    raw.write(Buffer.from([0xc1, 0x80, 0, 0, 0, 0]));
    await closed;
    store.deviceGate = null;
    gate.release();
    // An 'error' with no listener would have crashed the process; the server
    // still answers, and the broken socket was never admitted.
    expect(await clientsSeenByNextSocket()).toEqual(["self"]);
  });

  it("survives a Host header that is not a valid URL host", async () => {
    const ws = new WebSocket(baseUrl, [WS_AUTH_SUBPROTOCOL, signToken(USER_ID)], {
      headers: { host: "%" },
    });
    const outcome = await new Promise<Outcome>((resolve, reject) => {
      ws.once("message", (data) => {
        const { type } = JSON.parse(data.toString()) as { type: string };
        ws.close();
        resolve({ kind: "message", type });
      });
      ws.once("close", (code, reason) =>
        resolve({ kind: "closed", code, reason: reason.toString() }),
      );
      ws.once("error", reject);
    });
    expect(outcome).toEqual({ kind: "message", type: "connected" });
  });
});
