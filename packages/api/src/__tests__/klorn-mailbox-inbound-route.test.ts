/**
 * POST /api/mailbox/inbound/resend — the Klorn mailbox's inbound webhook (step
 * E1b of docs/providers/unified-platform-plan.md).
 *
 * Fixture events are signed with a test secret by the Svix scheme and pass
 * through the REAL `resend.webhooks.verify`. Only the network is mocked: the
 * client's `emails.receiving.get` / `.forward` (and `fetch` throws, so nothing
 * can leave the process), plus the database (the tenant helpers and the shared
 * store, whose own behaviour has its own tests).
 */

import crypto from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import { Prisma } from "@prisma/client";
import Fastify, { type FastifyInstance } from "fastify";
import { Resend } from "resend";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Database fixture ─────────────────────────────────────────────────────────

interface Mailbox {
  id: string;
  userId: string;
  provider: string;
  email: string;
}

const db = vi.hoisted(() => ({
  addresses: new Map<string, string | null>(),
  mailboxes: [] as Mailbox[],
  wipes: new Map<string, Date | null>(),
  existing: new Set<string>(),
  systemCalls: [] as unknown[],
  tenantCalls: [] as string[],
}));

function tenantTx(boundUserId: string) {
  const own = (where: { userId?: string }) => {
    // A query in a tenant scope must name that tenant.
    expect(where.userId).toBe(boundUserId);
  };
  return {
    linkedInboxAccount: {
      findFirst: vi.fn(async ({ where }: { where: Omit<Mailbox, "id"> }) => {
        own(where);
        // Prisma semantics: a filter left out constrains nothing, so a lookup that
        // forgot the provider or the email would find the wrong row here too.
        const row = db.mailboxes.find((m) =>
          (["userId", "provider", "email"] as const).every(
            (field) => where[field] === undefined || m[field] === where[field],
          ),
        );
        return row ? { id: row.id } : null;
      }),
    },
    dataWipe: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => {
        own(where);
        return db.wipes.has(where.userId) ? { purgedAt: db.wipes.get(where.userId) } : null;
      }),
    },
    emailMessage: {
      findUnique: vi.fn(
        async ({ where }: { where: { userId_gmailId: { userId: string; gmailId: string } } }) => {
          own(where.userId_gmailId);
          const key = `${where.userId_gmailId.userId}|${where.userId_gmailId.gmailId}`;
          return db.existing.has(key) ? { id: "existing-row" } : null;
        },
      ),
    },
  };
}

vi.mock("../db-tenant.js", () => ({
  withSystem: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      klornAddress: {
        findMany: vi.fn(
          async (args: { where: { handle: { in: string[] } }; select: Record<string, true> }) => {
            db.systemCalls.push(args);
            return args.where.handle.in
              .filter((handle) => db.addresses.has(handle))
              .map((handle) => ({ handle, userId: db.addresses.get(handle) ?? null }));
          },
        ),
      },
    }),
  ),
  withTenant: vi.fn(async (userId: string, fn: (tx: unknown) => Promise<unknown>) => {
    db.tenantCalls.push(userId);
    return fn(tenantTx(userId));
  }),
}));

const persistGmailEmail = vi.hoisted(() => vi.fn());
vi.mock("../judge/email-firewall.js", () => ({ persistGmailEmail }));
const captureError = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureError }));

import { klornMailboxEnabled } from "../config.js";
import { DataWipeFenceError } from "../privacy/data-wipe-fence.js";
import {
  KLORN_INBOUND_RATE_LIMIT,
  klornMailboxInboundRoutes,
} from "../routes/klorn-mailbox-inbound.js";

// ── Svix signing ─────────────────────────────────────────────────────────────

const SECRET_BYTES = crypto.randomBytes(24);
const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
const API_KEY = "re_test_inbound_full_access";
const DOMAIN = "klorn.ai";
const FORWARD_TO = "support-inbox@example.com";
const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const ROUTE = "/api/mailbox/inbound/resend";

function svixHeaders(body: string, secret: Buffer = SECRET_BYTES) {
  const id = `msg_${crypto.randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

function receivedEvent(data: Record<string, unknown> = {}) {
  return {
    type: "email.received",
    created_at: "2026-10-22T10:00:01.000Z",
    data: {
      email_id: EMAIL_ID,
      created_at: "2026-10-22T10:00:00.000Z",
      from: "sender@example.com",
      to: ["jane@klorn.ai"],
      cc: [],
      bcc: [],
      received_for: [],
      message_id: "<m1@example.com>",
      subject: "Secret merger plans",
      attachments: [],
      ...data,
    },
  };
}

function content(overrides: Record<string, unknown> = {}) {
  return {
    object: "email",
    id: EMAIL_ID,
    to: ["jane@klorn.ai"],
    from: "sender@example.com",
    created_at: "2026-10-22T10:00:00.000Z",
    subject: "Secret merger plans",
    bcc: null,
    cc: null,
    reply_to: null,
    received_for: [],
    html: "<p>Hello Jane</p>",
    text: "Hello Jane, here are the plans.",
    headers: { from: "Sam Sender <sender@example.com>", to: "jane@klorn.ai" },
    message_id: "<m1@example.com>",
    attachments: [],
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    ...overrides,
  };
}

// ── Network mocks ────────────────────────────────────────────────────────────

const receivingGet = vi.fn();
const receivingForward = vi.fn();

function createResend(apiKey: string): Resend {
  const client = new Resend(apiKey);
  vi.spyOn(client.emails.receiving, "get").mockImplementation(receivingGet);
  vi.spyOn(client.emails.receiving, "forward").mockImplementation(receivingForward);
  return client;
}

function ok<T>(data: T) {
  return { data, error: null, headers: {} };
}

function resendError(statusCode: number | null, name = "application_error") {
  return { data: null, error: { statusCode, name, message: "x" }, headers: {} };
}

async function buildApp(options: { withRateLimit?: boolean; timeoutMs?: number } = {}) {
  const app = Fastify();
  if (options.withRateLimit) await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  // Mirror index.ts: the JSON parser keeps the exact bytes Resend signed.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    try {
      const str = (body as string) || "{}";
      (req as unknown as { rawBody: string }).rawBody = str;
      done(null, JSON.parse(str));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  await app.register(
    klornMailboxInboundRoutes({
      gate: klornMailboxEnabled,
      createResend,
      resendTimeoutMs: options.timeoutMs ?? 2_000,
    }),
    { prefix: "/api/mailbox" },
  );
  await app.ready();
  return app;
}

async function deliver(app: FastifyInstance, event: unknown, headers?: Record<string, string>) {
  const body = JSON.stringify(event);
  return app.inject({
    method: "POST",
    url: ROUTE,
    payload: body,
    headers: headers ?? svixHeaders(body),
  });
}

function addUser(handle: string, userId: string, mailbox: Partial<Mailbox> = {}) {
  db.addresses.set(handle, userId);
  db.mailboxes.push({
    id: `lia-${handle}`,
    userId,
    provider: "KLORN",
    email: `${handle}@${DOMAIN}`,
    ...mailbox,
  });
}

const ENV_KEYS = [
  "KLORN_MAILBOX_ENABLED",
  "RESEND_INBOUND_WEBHOOK_SECRET",
  "RESEND_INBOUND_API_KEY",
  "KLORN_MAILBOX_DOMAIN",
  "KLORN_MAILBOX_FORWARD_TO",
  "ROLLOUT_COHORT_USER_IDS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

let logged: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.KLORN_MAILBOX_ENABLED = "true";
  process.env.RESEND_INBOUND_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.RESEND_INBOUND_API_KEY = API_KEY;
  process.env.KLORN_MAILBOX_DOMAIN = DOMAIN;
  process.env.KLORN_MAILBOX_FORWARD_TO = FORWARD_TO;

  db.addresses.clear();
  db.mailboxes = [];
  db.wipes.clear();
  db.existing.clear();
  db.systemCalls = [];
  db.tenantCalls = [];
  persistGmailEmail.mockReset();
  persistGmailEmail.mockResolvedValue({ emailId: "row-1", isNew: true });
  captureError.mockReset();
  receivingGet.mockReset();
  receivingGet.mockResolvedValue(ok(content()));
  receivingForward.mockReset();
  receivingForward.mockResolvedValue(ok({ id: "fwd-1" }));

  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network disabled in tests");
    }),
  );
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "),
      );
    });
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("the dark route", () => {
  it("answers Fastify's default 404 while the flag is off, like an unregistered route", async () => {
    process.env.KLORN_MAILBOX_ENABLED = "false";
    const app = await buildApp();
    const body = JSON.stringify(receivedEvent());
    const dark = await app.inject({
      method: "POST",
      url: ROUTE,
      payload: body,
      headers: svixHeaders(body),
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/mailbox/inbound/other",
      payload: body,
      headers: svixHeaders(body),
    });

    expect(dark.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(dark.json()).toEqual({
      message: `Route POST:${ROUTE} not found`,
      error: "Not Found",
      statusCode: 404,
    });
    expect(missing.json()).toEqual({
      message: "Route POST:/api/mailbox/inbound/other not found",
      error: "Not Found",
      statusCode: 404,
    });
    expect(receivingGet).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "0",
    "off",
    "cohort-typo",
  ])("stays dark for KLORN_MAILBOX_ENABLED=%j", async (value) => {
    process.env.KLORN_MAILBOX_ENABLED = value;
    expect(klornMailboxEnabled()).toBe(false);
  });

  it.each([
    "true",
    "1",
    "yes",
    "on",
    " TRUE ",
    "cohort",
    " Cohort ",
  ])("is live for KLORN_MAILBOX_ENABLED=%j", (value) => {
    process.env.KLORN_MAILBOX_ENABLED = value;
    expect(klornMailboxEnabled()).toBe(true);
  });

  it("serves every recipient under `cohort`: the route is not per user (the claim, E3, is)", async () => {
    process.env.KLORN_MAILBOX_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "";
    addUser("jane", "u-jane");
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 1 });
  });
});

describe("configuration", () => {
  it.each([
    "RESEND_INBOUND_WEBHOOK_SECRET",
    "RESEND_INBOUND_API_KEY",
    "KLORN_MAILBOX_DOMAIN",
  ])("answers 503 and logs an error when %s is missing", async (key) => {
    process.env[key] = "  ";
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());

    expect(res.statusCode).toBe(503);
    expect(logged.some((line) => line.includes(key))).toBe(true);
    // The error names the variable, never a value.
    expect(logged.join("\n")).not.toContain(SECRET_BYTES.toString("base64"));
    expect(logged.join("\n")).not.toContain(API_KEY);
    expect(receivingGet).not.toHaveBeenCalled();
    expect(persistGmailEmail).not.toHaveBeenCalled();
  });

  it("sets its own rate limit above the global 100 a minute", async () => {
    expect(KLORN_INBOUND_RATE_LIMIT).toEqual({ max: 600, timeWindow: "1 minute" });
    const app = await buildApp({ withRateLimit: true });
    const statuses = new Set<number>();
    for (let i = 0; i < 120; i++) {
      const res = await app.inject({
        method: "POST",
        url: ROUTE,
        payload: "{}",
        headers: { "content-type": "application/json" },
      });
      statuses.add(res.statusCode);
    }
    expect([...statuses]).toEqual([401]);
  });
});

describe("verification", () => {
  it("answers 401 for a signature made with another secret", async () => {
    const app = await buildApp();
    const body = JSON.stringify(receivedEvent());
    const res = await app.inject({
      method: "POST",
      url: ROUTE,
      payload: body,
      headers: svixHeaders(body, crypto.randomBytes(24)),
    });
    expect(res.statusCode).toBe(401);
    expect(receivingGet).not.toHaveBeenCalled();
  });

  it("answers 401 when the body was changed after signing", async () => {
    const app = await buildApp();
    const signedBody = JSON.stringify(receivedEvent());
    const res = await app.inject({
      method: "POST",
      url: ROUTE,
      payload: JSON.stringify(receivedEvent({ to: ["victim@klorn.ai"] })),
      headers: svixHeaders(signedBody),
    });
    expect(res.statusCode).toBe(401);
  });

  it("answers 401 without the Svix headers", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: ROUTE,
      payload: JSON.stringify(receivedEvent()),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("answers 204 for any other event type, and does nothing", async () => {
    const app = await buildApp();
    const res = await deliver(app, { type: "email.delivered", created_at: "x", data: {} });
    expect(res.statusCode).toBe(204);
    expect(db.systemCalls).toHaveLength(0);
    expect(receivingGet).not.toHaveBeenCalled();
  });

  it("drops a signed event whose email_id is not an id, without calling Resend", async () => {
    addUser("jane", "u-jane");
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ email_id: "../../api-keys" }));
    expect(res.statusCode).toBe(200);
    expect(receivingGet).not.toHaveBeenCalled();
    expect(persistGmailEmail).not.toHaveBeenCalled();
  });
});

describe("routing", () => {
  it("stores one copy for a Klorn recipient through the shared store", async () => {
    addUser("jane", "u-jane");
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 1, dropped: 0, forwarded: 0 });
    expect(receivingGet).toHaveBeenCalledTimes(1);
    expect(receivingGet).toHaveBeenCalledWith(EMAIL_ID);
    expect(persistGmailEmail).toHaveBeenCalledTimes(1);
    const [userId, raw, options] = persistGmailEmail.mock.calls[0];
    expect(userId).toBe("u-jane");
    expect(raw).toMatchObject({
      gmailId: `klorn:jane@klorn.ai:${EMAIL_ID}`,
      from: "Sam Sender <sender@example.com>",
      subject: "Secret merger plans",
      body: "Hello Jane, here are the plans.",
      labels: ["INBOX", "UNREAD"],
      receivedAt: new Date("2026-10-22T10:00:00.000Z"),
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    });
    expect(options).toEqual({ userEmail: "jane@klorn.ai", linkedInboxAccountId: "lia-jane" });
  });

  it("looks the handles up once, under withSystem, selecting handle and userId only", async () => {
    addUser("jane", "u-jane");
    addUser("sam", "u-sam");
    const app = await buildApp();
    await deliver(app, receivedEvent({ to: ["jane@klorn.ai"], cc: ["sam@klorn.ai"] }));

    expect(db.systemCalls).toHaveLength(1);
    expect(db.systemCalls[0]).toEqual({
      where: { handle: { in: ["jane", "sam"] } },
      select: { handle: true, userId: true },
    });
    expect(db.tenantCalls.sort()).toEqual(["u-jane", "u-sam"]);
  });

  it("gives two Klorn recipients two copies with distinct ids, fetching the content once", async () => {
    addUser("jane", "u-jane");
    addUser("sam", "u-sam");
    const app = await buildApp();
    const res = await deliver(
      app,
      receivedEvent({ to: ["jane@klorn.ai"], bcc: [], received_for: ["sam@klorn.ai"] }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 2 });
    expect(receivingGet).toHaveBeenCalledTimes(1);
    const ids = persistGmailEmail.mock.calls.map((call) => call[1].gmailId).sort();
    expect(ids).toEqual([`klorn:jane@klorn.ai:${EMAIL_ID}`, `klorn:sam@klorn.ai:${EMAIL_ID}`]);
    const users = persistGmailEmail.mock.calls.map((call) => call[0]).sort();
    expect(users).toEqual(["u-jane", "u-sam"]);
  });

  it("deduplicates one recipient named in several fields and cases", async () => {
    addUser("jane", "u-jane");
    const app = await buildApp();
    await deliver(
      app,
      receivedEvent({
        to: ["JANE@KLORN.AI"],
        cc: ["jane@klorn.ai"],
        received_for: ["Jane@Klorn.ai"],
      }),
    );
    expect(persistGmailEmail).toHaveBeenCalledTimes(1);
  });

  it("drops unknown, tombstoned, reserved, plus-tagged and non-ASCII recipients without fetching", async () => {
    db.addresses.set("gone", null); // a deleted account's handle
    const app = await buildApp();
    const res = await deliver(
      app,
      receivedEvent({
        to: ["nobody@klorn.ai", "gone@klorn.ai", "support@klorn.ai"],
        cc: ["jane+news@klorn.ai", "Kate@klorn.ai", "friend@example.com"],
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 0, dropped: 5, forwarded: 0 });
    expect(receivingGet).not.toHaveBeenCalled();
    expect(persistGmailEmail).not.toHaveBeenCalled();
    // Only well-formed, non-reserved handles reach the lookup.
    expect(db.systemCalls[0]).toMatchObject({ where: { handle: { in: ["nobody", "gone"] } } });
  });

  it("drops a live handle whose user has no KLORN mailbox with exactly that address", async () => {
    // A generic IMAP row may carry any name, including a Klorn address.
    addUser("jane", "u-jane", { provider: "IMAP" });
    addUser("sam", "u-sam", { email: "SAM@klorn.ai" });
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["jane@klorn.ai", "sam@klorn.ai"] }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 0, dropped: 2 });
    expect(receivingGet).not.toHaveBeenCalled();
  });

  it("drops mail received before the recipient's data wipe, and keeps mail after it", async () => {
    addUser("jane", "u-jane");
    addUser("sam", "u-sam");
    db.wipes.set("u-jane", new Date("2026-10-22T11:00:00.000Z")); // after the event
    db.wipes.set("u-sam", new Date("2026-10-22T09:00:00.000Z")); // before the event
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["jane@klorn.ai", "sam@klorn.ai"] }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 1, dropped: 1 });
    expect(persistGmailEmail.mock.calls.map((call) => call[0])).toEqual(["u-sam"]);
  });

  it("does not fetch when the only recipient's wipe postdates the event", async () => {
    addUser("jane", "u-jane");
    db.wipes.set("u-jane", new Date("2026-10-22T11:00:00.000Z"));
    const app = await buildApp();
    await deliver(app, receivedEvent());
    expect(receivingGet).not.toHaveBeenCalled();
  });
});

describe("idempotency", () => {
  it("answers a replay of a stored message without fetching or rewriting it", async () => {
    addUser("jane", "u-jane");
    db.existing.add(`u-jane|klorn:jane@klorn.ai:${EMAIL_ID}`);
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 1, dropped: 0 });
    expect(receivingGet).not.toHaveBeenCalled();
    expect(persistGmailEmail).not.toHaveBeenCalled();
  });

  it("delivers the same event twice to one row id", async () => {
    addUser("jane", "u-jane");
    const app = await buildApp();
    const event = receivedEvent();
    await deliver(app, event);
    db.existing.add(`u-jane|${persistGmailEmail.mock.calls[0][1].gmailId}`);
    const again = await deliver(app, event);

    expect(again.statusCode).toBe(200);
    expect(persistGmailEmail).toHaveBeenCalledTimes(1);
  });

  it("counts a concurrent duplicate (P2002) as stored", async () => {
    addUser("jane", "u-jane");
    persistGmailEmail.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: Prisma.prismaVersion.client,
      }),
    );
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 1, dropped: 0 });
    expect(captureError).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  it("answers 503 while a recipient's data wipe is running, so Resend retries", async () => {
    addUser("jane", "u-jane");
    addUser("sam", "u-sam");
    persistGmailEmail.mockImplementation(async (userId: string) => {
      if (userId === "u-jane") throw new DataWipeFenceError();
      return { emailId: "row-sam", isNew: true };
    });
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["jane@klorn.ai", "sam@klorn.ai"] }));

    expect(res.statusCode).toBe(503);
    expect(persistGmailEmail).toHaveBeenCalledTimes(2);
    expect(captureError).not.toHaveBeenCalled();
  });

  const clientVersion = Prisma.prismaVersion.client;
  const PG_INVALID_BYTES =
    'Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "22021", message: "invalid byte sequence for encoding \\"UTF8\\": 0x00", severity: "ERROR" }) })';
  it.each([
    ["a validation error", () => new Prisma.PrismaClientValidationError("bad", { clientVersion })],
    [
      "a value too long (P2000)",
      () => new Prisma.PrismaClientKnownRequestError("bad", { code: "P2000", clientVersion }),
    ],
    [
      "an invalid value (P2007)",
      () => new Prisma.PrismaClientKnownRequestError("bad", { code: "P2007", clientVersion }),
    ],
    [
      "a Postgres data exception (22021)",
      () => new Prisma.PrismaClientUnknownRequestError(PG_INVALID_BYTES, { clientVersion }),
    ],
  ])("drops a copy the database refuses for good (%s), with a 2xx", async (_label, error) => {
    addUser("jane", "u-jane");
    persistGmailEmail.mockRejectedValue(error());
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 0, dropped: 1 });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers 503 for an unknown store error and reports it without mail data", async () => {
    addUser("jane", "u-jane");
    persistGmailEmail.mockRejectedValue(new Error("connection reset for jane@klorn.ai"));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());

    expect(res.statusCode).toBe(503);
    expect(captureError).toHaveBeenCalledTimes(1);
    const [reported, context] = captureError.mock.calls[0];
    expect(String(reported)).not.toContain("@");
    expect(context).toMatchObject({ extra: { emailId: EMAIL_ID } });
  });

  it.each([
    ["a 5xx", resendError(500, "internal_server_error")],
    ["a 429", resendError(429, "rate_limit_exceeded")],
    ["a network error (no status)", resendError(null)],
    ["a key that cannot read received mail", resendError(401, "restricted_api_key")],
  ])("answers 503 when Resend returns %s", async (_label, response) => {
    addUser("jane", "u-jane");
    receivingGet.mockResolvedValue(response);
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(503);
    expect(persistGmailEmail).not.toHaveBeenCalled();
  });

  it("answers 503 when the Resend call throws", async () => {
    addUser("jane", "u-jane");
    receivingGet.mockRejectedValue(new TypeError("fetch failed"));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(503);
  });

  it("answers 503 when Resend does not answer in time", async () => {
    addUser("jane", "u-jane");
    receivingGet.mockImplementation(() => new Promise(() => {}));
    const app = await buildApp({ timeoutMs: 20 });
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(503);
    expect(persistGmailEmail).not.toHaveBeenCalled();
  });

  it("drops the message with a 2xx when Resend no longer has it (404)", async () => {
    addUser("jane", "u-jane");
    receivingGet.mockResolvedValue(resendError(404, "not_found"));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 0, dropped: 1 });
    expect(persistGmailEmail).not.toHaveBeenCalled();
  });
});

describe("authentication verdicts", () => {
  it("whitelists each verdict before it reaches the store", async () => {
    addUser("jane", "u-jane");
    receivingGet.mockResolvedValue(
      ok(content({ authentication: { spf: "PASS", dkim: "<img src=x>", dmarc: 7 } })),
    );
    const app = await buildApp();
    await deliver(app, receivedEvent());
    expect(persistGmailEmail.mock.calls[0][1].authentication).toEqual({
      spf: "pass",
      dkim: "unknown",
      dmarc: "unknown",
    });
  });
});

describe("system addresses", () => {
  it("forwards postmaster@ to the support inbox without parsing the raw message", async () => {
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["POSTMASTER@klorn.ai"] }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stored: 0, dropped: 0, forwarded: 1 });
    expect(receivingForward).toHaveBeenCalledTimes(1);
    const [options, requestOptions] = receivingForward.mock.calls[0];
    expect(options).toMatchObject({
      emailId: EMAIL_ID,
      to: FORWARD_TO,
      from: "postmaster@klorn.ai",
      // The SDK's passthrough mode runs postal-mime on the raw message.
      passthrough: false,
    });
    expect(typeof options.text).toBe("string");
    expect(requestOptions).toEqual({ idempotencyKey: `klorn-forward:${EMAIL_ID}:postmaster` });
    expect(receivingGet).not.toHaveBeenCalled();
    expect(db.systemCalls).toHaveLength(0);
  });

  it("forwards abuse@ alongside a user's copy", async () => {
    addUser("jane", "u-jane");
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["abuse@klorn.ai", "jane@klorn.ai"] }));
    expect(res.json()).toMatchObject({ stored: 1, forwarded: 1 });
    expect(receivingForward.mock.calls[0][0]).toMatchObject({ from: "abuse@klorn.ai" });
  });

  it("drops a system address and counts it when no forward target is set", async () => {
    delete process.env.KLORN_MAILBOX_FORWARD_TO;
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["postmaster@klorn.ai"] }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ forwarded: 0, dropped: 1 });
    expect(receivingForward).not.toHaveBeenCalled();
  });

  it("answers 503 when the forward fails transiently", async () => {
    receivingForward.mockResolvedValue(resendError(502));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["postmaster@klorn.ai"] }));
    expect(res.statusCode).toBe(503);
  });

  it("drops a system copy Resend refuses as invalid", async () => {
    receivingForward.mockResolvedValue(resendError(422, "validation_error"));
    const app = await buildApp();
    const res = await deliver(app, receivedEvent({ to: ["abuse@klorn.ai"] }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ forwarded: 0, dropped: 1 });
  });
});

describe("logs", () => {
  it("carry the email_id and counts, never an address, subject or body", async () => {
    addUser("jane", "u-jane");
    addUser("sam", "u-sam");
    db.addresses.set("gone", null);
    persistGmailEmail.mockImplementation(async (userId: string) => {
      if (userId === "u-sam") throw new Error("boom for sam@klorn.ai: Secret merger plans");
      return { emailId: "row", isNew: true };
    });
    const app = await buildApp();
    await deliver(
      app,
      receivedEvent({
        to: ["jane@klorn.ai", "sam@klorn.ai", "gone@klorn.ai", "postmaster@klorn.ai"],
        cc: ["friend@example.com"],
      }),
    );

    const all = logged.join("\n");
    expect(all).toContain(EMAIL_ID);
    expect(all).not.toContain("@");
    expect(all).not.toMatch(/jane|sam\b|gone|postmaster|friend/i);
    expect(all).not.toContain("Secret merger plans");
    expect(all).not.toContain("Hello Jane");
  });
});
