import { createHmac, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the Klorn Teams seat billing scaffold: the owner-only
// quantity checkout (off with a clear code while the team prices are unset)
// and the Paddle webhook writing the organization's seats and status — never
// User.plan, even when the owner's Paddle customer id is the event's. Skipped
// unless KLORN_TEST_PG_URL is set.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

const captured = vi.hoisted(() => [] as unknown[]);
vi.mock("../sentry.js", () => ({ captureError: vi.fn((err: unknown) => captured.push(err)) }));
vi.mock("../mail/email.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mail/email.js")>()),
  sendOrgInviteEmail: vi.fn(async () => true),
}));

import { registerDevice, signToken } from "../auth.js";
import { prisma } from "../db.js";
import { handleError } from "../error-handler.js";
import { registerApiRoutes } from "../register-api-routes.js";
import { deleteUserAndAllData } from "../user-deletion.js";

const describePg = url ? describe : describe.skip;
const SECRET = "pdl_ntfset_teams_test";
const createdUsers: string[] = [];
let app: FastifyInstance;

interface Session {
  userId: string;
  token: string;
}

async function newSession(label: string): Promise<Session> {
  const email = `${label}-${randomUUID()}@billing.test`;
  const user = await prisma.user.create({ data: { email, name: label, emailVerified: true } });
  createdUsers.push(user.id);
  const token = signToken({ userId: user.id, email });
  await registerDevice(user.id, token, { deviceType: "web" });
  return { userId: user.id, token };
}

function call(session: Session, method: string, path: string, payload?: unknown) {
  return app.inject({
    method: method as "POST",
    url: path,
    headers: { authorization: `Bearer ${session.token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function ownedOrg(label = "owner"): Promise<{ owner: Session; orgId: string }> {
  const owner = await newSession(label);
  const res = await call(owner, "POST", "/api/orgs", { name: "Billing Co" });
  expect(res.statusCode).toBe(201);
  return { owner, orgId: (res.json() as { org: { id: string } }).org.id };
}

function webhook(event: Record<string, unknown>) {
  const raw = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const h1 = createHmac("sha256", SECRET).update(`${ts}:${raw}`).digest("hex");
  return app.inject({
    method: "POST",
    url: "/api/webhook/paddle",
    headers: { "content-type": "application/json", "paddle-signature": `ts=${ts};h1=${h1}` },
    payload: raw,
  });
}

function teamEvent(
  orgId: string | null,
  data: Record<string, unknown>,
  occurredAt = new Date().toISOString(),
) {
  return {
    event_id: `evt_${randomUUID()}`,
    event_type: "subscription.updated",
    occurred_at: occurredAt,
    data: {
      id: "sub_team_1",
      status: "active",
      customer_id: "ctm_team_1",
      ...(orgId ? { custom_data: { orgId, kind: "team_seats" } } : {}),
      items: [{ price: { id: "pri_team_month" }, quantity: 5 }],
      billing_cycle: { interval: "month", frequency: 1 },
      ...data,
    },
  };
}

beforeAll(async () => {
  if (!url) return;
  app = Fastify();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, JSON.parse((body as string) || "{}"));
    } catch (err) {
      done(err as Error);
    }
  });
  app.setErrorHandler(handleError);
  await registerApiRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  process.env.TEAMS_ENABLED = "true";
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  process.env.PADDLE_TEAM_PRICE_ID_MONTHLY = "pri_team_month";
  delete process.env.PADDLE_TEAM_PRICE_ID_ANNUAL;
  captured.length = 0;
  if (url) {
    // Each test starts with the fixed Paddle ids unclaimed.
    await prisma.organization.updateMany({
      where: { paddleSubscriptionId: { startsWith: "sub_team_" } },
      data: { paddleSubscriptionId: null },
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PADDLE_API_KEY;
});

afterAll(async () => {
  if (!url) return;
  delete process.env.TEAMS_ENABLED;
  delete process.env.PADDLE_WEBHOOK_SECRET;
  delete process.env.PADDLE_TEAM_PRICE_ID_MONTHLY;
  await app.close();
  await prisma.organization.deleteMany({
    where: { memberships: { some: { userId: { in: createdUsers } } } },
  });
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describePg("team seat checkout (real Postgres)", () => {
  it("is off, with a clear code, while the team price or the Paddle key is unset", async () => {
    const { owner } = await ownedOrg();
    const res = await call(owner, "POST", "/api/orgs/current/checkout", {
      interval: "month",
      seats: 3,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "TEAM_CHECKOUT_UNAVAILABLE" });
    const view = await call(owner, "GET", "/api/orgs/current");
    expect(view.json()).toMatchObject({ org: { seats: { checkoutIntervals: [] } } });
  });

  it("refuses fewer than 2 or more than 150 seats, and a non-owner", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    const { owner } = await ownedOrg();
    for (const seats of [1, 151, 2.5, "3"]) {
      const res = await call(owner, "POST", "/api/orgs/current/checkout", {
        interval: "month",
        seats,
      });
      expect(res.statusCode, String(seats)).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_SEATS" });
    }
    const bad = await call(owner, "POST", "/api/orgs/current/checkout", {
      interval: "week",
      seats: 3,
    });
    expect(bad.json()).toMatchObject({ code: "INVALID_BODY" });
    const stranger = await newSession("stranger");
    const res = await call(stranger, "POST", "/api/orgs/current/checkout", {
      interval: "month",
      seats: 3,
    });
    expect(res.statusCode).toBe(404);
  });

  it("opens a quantity checkout for the organization and audits it", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { checkout: { url: "https://pay.example/c/1" } } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { owner, orgId } = await ownedOrg();
    const res = await call(owner, "POST", "/api/orgs/current/checkout", {
      interval: "month",
      seats: 4,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://pay.example/c/1" });
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body,
    );
    expect(body).toEqual({
      items: [{ price_id: "pri_team_month", quantity: 4 }],
      custom_data: { orgId, kind: "team_seats" },
    });
    const audit = await prisma.orgAuditEvent.findFirst({
      where: { orgId, action: "billing.checkout_started" },
    });
    expect(audit?.detail).toEqual({ interval: "month", seats: 4 });
  });

  it("refuses a second checkout while a subscription is live", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    const { owner, orgId } = await ownedOrg();
    await prisma.organization.update({
      where: { id: orgId },
      data: { subscriptionStatus: "active", paddleSubscriptionId: `sub_team_${randomUUID()}` },
    });
    const res = await call(owner, "POST", "/api/orgs/current/checkout", {
      interval: "month",
      seats: 3,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "SUBSCRIPTION_ACTIVE" });
  });
});

describePg("team subscription webhook (real Postgres)", () => {
  it("writes seats and status to the organization, and never touches User.plan", async () => {
    const { owner, orgId } = await ownedOrg();
    // The owner already pays for Pro with the same Paddle customer.
    await prisma.user.update({
      where: { id: owner.userId },
      data: { plan: "FREE", paddleCustomerId: `ctm_owner_${randomUUID()}` },
    });
    const ownerRow = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
    const res = await webhook(
      teamEvent(orgId, { customer_id: ownerRow.paddleCustomerId, id: "sub_team_1" }),
    );
    expect(res.statusCode).toBe(200);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org).toMatchObject({
      seatsPurchased: 5,
      subscriptionStatus: "active",
      billingInterval: "month",
      paddleSubscriptionId: "sub_team_1",
    });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });
    expect(after.plan).toBe("FREE");
    expect(after.paddleSubscriptionId).toBeNull();
    const view = await call(owner, "GET", "/api/orgs/current");
    expect(view.json()).toMatchObject({ me: { seated: true } });
  });

  it("maps a later event without custom data by its subscription id", async () => {
    const { orgId } = await ownedOrg();
    await webhook(teamEvent(orgId, { id: "sub_team_2" }));
    const res = await webhook(
      teamEvent(null, {
        id: "sub_team_2",
        items: [{ price: { id: "pri_team_month" }, quantity: 9 }],
      }),
    );
    expect(res.statusCode).toBe(200);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.seatsPurchased).toBe(9);
  });

  it("ignores an older event that arrives after a newer one", async () => {
    const { orgId } = await ownedOrg();
    const newer = new Date().toISOString();
    const older = new Date(Date.now() - 60_000).toISOString();
    await webhook(teamEvent(orgId, { id: "sub_team_3", status: "past_due" }, newer));
    await webhook(teamEvent(orgId, { id: "sub_team_3", status: "active" }, older));
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.subscriptionStatus).toBe("past_due");
  });

  it("ends the seats when the subscription is canceled", async () => {
    const { owner, orgId } = await ownedOrg();
    await webhook(teamEvent(orgId, { id: "sub_team_4" }));
    await webhook(teamEvent(orgId, { id: "sub_team_4", status: "canceled" }));
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org).toMatchObject({ subscriptionStatus: "canceled", paddleSubscriptionId: null });
    const view = await call(owner, "GET", "/api/orgs/current");
    expect(view.json()).toMatchObject({ me: { seated: false } });
  });

  it("cancels the subscription at period end when its last member deletes their account", async () => {
    process.env.PADDLE_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { scheduled_change: { effective_at: "2026-12-14T00:00:00Z" } } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { owner, orgId } = await ownedOrg();
    await webhook(teamEvent(orgId, { id: "sub_team_6" }));
    await deleteUserAndAllData(owner.userId);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(path).toContain("/subscriptions/sub_team_6/cancel");
    expect(JSON.parse(init.body)).toEqual({ effective_from: "next_billing_period" });
    expect(await prisma.organization.findUnique({ where: { id: orgId } })).not.toBeNull();
  });

  it("reports a team event it cannot map, and writes no account", async () => {
    const before = await prisma.user.count({ where: { plan: "PRO" } });
    const res = await webhook(teamEvent(randomUUID(), { id: "sub_team_5" }));
    expect(res.statusCode).toBe(200);
    expect(captured.length).toBe(1);
    expect(await prisma.user.count({ where: { plan: "PRO" } })).toBe(before);
  });
});
