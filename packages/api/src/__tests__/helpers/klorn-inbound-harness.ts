/**
 * Shared fixture of the Klorn mailbox's inbound webhook tests (step E1b of
 * docs/providers/unified-platform-plan.md): the database stand-in behind the
 * tenant helpers, Svix signing with a test secret (verified by the REAL
 * `resend.webhooks.verify`), Resend clients whose network calls are spies, and
 * the env the route reads.
 *
 * It imports no app module, so the test files' `vi.mock` factories can load it.
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { Resend } from "resend";
import { expect, vi } from "vitest";

export interface Mailbox {
  id: string;
  userId: string;
  provider: string;
  email: string;
}

export const db = {
  addresses: new Map<string, string | null>(),
  mailboxes: [] as Mailbox[],
  wipes: new Map<string, Date | null>(),
  existing: new Set<string>(),
  systemCalls: [] as unknown[],
  tenantCalls: [] as string[],
};

export function resetDb(): void {
  db.addresses.clear();
  db.mailboxes = [];
  db.wipes.clear();
  db.existing.clear();
  db.systemCalls = [];
  db.tenantCalls = [];
}

export const DOMAIN = "klorn.ai";

export function addUser(handle: string, userId: string, mailbox: Partial<Mailbox> = {}): void {
  db.addresses.set(handle, userId);
  db.mailboxes = [
    ...db.mailboxes,
    { id: `lia-${handle}`, userId, provider: "KLORN", email: `${handle}@${DOMAIN}`, ...mailbox },
  ];
}

function tenantTx(boundUserId: string) {
  // A query in a tenant scope must name that tenant.
  const own = (where: { userId?: string }) => expect(where.userId).toBe(boundUserId);
  return {
    linkedInboxAccount: {
      findFirst: vi.fn(async ({ where }: { where: Partial<Omit<Mailbox, "id">> }) => {
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

/** The `../db-tenant.js` module as the tests see it. */
export function dbTenantModule() {
  return {
    withSystem: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        klornAddress: {
          findMany: vi.fn(
            async (args: { where: { handle: { in: string[] } }; select: Record<string, true> }) => {
              db.systemCalls = [...db.systemCalls, args];
              return args.where.handle.in
                .filter((handle) => db.addresses.has(handle))
                .map((handle) => ({ handle, userId: db.addresses.get(handle) ?? null }));
            },
          ),
        },
      }),
    ),
    withTenant: vi.fn(async (userId: string, fn: (tx: unknown) => Promise<unknown>) => {
      db.tenantCalls = [...db.tenantCalls, userId];
      return fn(tenantTx(userId));
    }),
  };
}

export const persistGmailEmail = vi.fn();
export const captureError = vi.fn();

/** Sentry events of one scope (`klorn-mailbox.<scope>`). */
export function reportsFor(scope: string) {
  return captureError.mock.calls.filter(
    ([, context]) => context?.tags?.scope === `klorn-mailbox.${scope}`,
  );
}

// ── Svix signing ─────────────────────────────────────────────────────────────

export const SECRET_BYTES = crypto.randomBytes(24);
export const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;
export const API_KEY = "re_test_inbound_full_access";
export const FORWARD_TO = "support-inbox@example.com";
export const EMAIL_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
export const ROUTE = "/api/mailbox/inbound/resend";

export function svixHeaders(
  body: string,
  secret: Buffer = SECRET_BYTES,
  timestamp = Math.floor(Date.now() / 1000),
) {
  const id = `msg_${crypto.randomUUID()}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": `v1,${signature}`,
  };
}

export function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export function receivedEvent(
  data: Record<string, unknown> = {},
  top: Record<string, unknown> = {},
) {
  const createdAt = agoIso(MINUTE);
  return {
    type: "email.received",
    created_at: createdAt,
    ...top,
    data: {
      email_id: EMAIL_ID,
      created_at: createdAt,
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

export function content(overrides: Record<string, unknown> = {}) {
  return {
    object: "email",
    id: EMAIL_ID,
    to: ["jane@klorn.ai"],
    from: "sender@example.com",
    created_at: agoIso(MINUTE),
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

// ── Resend network spies ─────────────────────────────────────────────────────

export const resendSpies = {
  created: vi.fn(),
  get: vi.fn(),
  forward: vi.fn(),
  send: vi.fn(),
};

export function ok<T>(data: T) {
  return { data, error: null, headers: {} };
}

export function resendError(statusCode: number | null, name = "application_error") {
  return { data: null, error: { statusCode, name, message: "x" }, headers: {} };
}

export function createResend(apiKey: string): Resend {
  resendSpies.created(apiKey);
  const client = new Resend(apiKey);
  vi.spyOn(client.emails.receiving, "get").mockImplementation(resendSpies.get);
  vi.spyOn(client.emails.receiving, "forward").mockImplementation(resendSpies.forward);
  vi.spyOn(client.emails, "send").mockImplementation(resendSpies.send);
  return client;
}

// ── Env and logs ─────────────────────────────────────────────────────────────

const ENV_KEYS = [
  "KLORN_MAILBOX_ENABLED",
  "RESEND_INBOUND_WEBHOOK_SECRET",
  "RESEND_INBOUND_API_KEY",
  "KLORN_MAILBOX_DOMAIN",
  "KLORN_MAILBOX_FORWARD_TO",
  "ROLLOUT_COHORT_USER_IDS",
] as const;
const savedEnv = new Map<string, string | undefined>();

export const logged: string[] = [];

/** The env of a configured, enabled route; fresh spies; console captured; no network. */
export function setUpInbound(): void {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.KLORN_MAILBOX_ENABLED = "true";
  process.env.RESEND_INBOUND_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.RESEND_INBOUND_API_KEY = API_KEY;
  process.env.KLORN_MAILBOX_DOMAIN = DOMAIN;
  process.env.KLORN_MAILBOX_FORWARD_TO = FORWARD_TO;
  resetDb();
  persistGmailEmail.mockReset();
  persistGmailEmail.mockResolvedValue({ emailId: "row-1", isNew: true });
  captureError.mockReset();
  for (const spy of Object.values(resendSpies)) spy.mockReset();
  resendSpies.get.mockResolvedValue(ok(content()));
  resendSpies.forward.mockResolvedValue(ok({ id: "fwd-1" }));
  resendSpies.send.mockResolvedValue(ok({ id: "send-1" }));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network disabled in tests");
    }),
  );
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "),
      );
    });
  }
}

export function tearDownInbound(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

// ── App ──────────────────────────────────────────────────────────────────────

type RoutesFactory = (app: FastifyInstance) => Promise<void>;

/** Mirror index.ts: the JSON parser keeps the exact bytes Resend signed. */
export async function buildInboundApp(
  routes: RoutesFactory,
  plugins: Array<(app: FastifyInstance) => Promise<void>> = [],
): Promise<FastifyInstance> {
  const app = Fastify();
  for (const plugin of plugins) await plugin(app);
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    try {
      const str = (body as string) || "{}";
      (req as unknown as { rawBody: string }).rawBody = str;
      done(null, JSON.parse(str));
    } catch (err) {
      done(err as Error, undefined);
    }
  });
  await app.register(routes, { prefix: "/api/mailbox" });
  await app.ready();
  return app;
}

export async function deliver(
  app: FastifyInstance,
  event: unknown,
  headers?: Record<string, string>,
) {
  const body = JSON.stringify(event);
  return app.inject({
    method: "POST",
    url: ROUTE,
    payload: body,
    headers: headers ?? svixHeaders(body),
  });
}
