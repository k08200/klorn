import { createHmac, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of Klorn Teams seat management after purchase: the
// owner changes the seat count through Paddle (the webhook stays the source of
// truth for the stored seats), cancels at the period end or takes the cancel
// back, and opens the Paddle customer portal. Members never can. Paddle is a
// stubbed fetch in every test. Skipped unless KLORN_TEST_PG_URL is set.
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

const describePg = url ? describe : describe.skip;
const SECRET = "pdl_ntfset_seats_test";
const createdUsers: string[] = [];
let app: FastifyInstance;

interface Session {
  userId: string;
  token: string;
  email: string;
}

interface PaddleCall {
  url: string;
  method: string;
  body: unknown;
  bounded: boolean;
}

async function newSession(label: string): Promise<Session> {
  const email = `${label}-${randomUUID()}@seats.test`;
  const user = await prisma.user.create({ data: { email, name: label, emailVerified: true } });
  createdUsers.push(user.id);
  const token = signToken({ userId: user.id, email });
  await registerDevice(user.id, token, { deviceType: "web" });
  return { userId: user.id, token, email };
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
  const res = await call(owner, "POST", "/api/orgs", { name: "Seats Co" });
  expect(res.statusCode).toBe(201);
  return { owner, orgId: (res.json() as { org: { id: string } }).org.id };
}

async function addMember(orgId: string, label = "member"): Promise<Session> {
  const member = await newSession(label);
  await prisma.orgMembership.create({
    data: { orgId, userId: member.userId, role: "MEMBER" },
    select: { id: true },
  });
  return member;
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

function teamEvent(orgId: string, data: Record<string, unknown>) {
  return {
    event_id: `evt_${randomUUID()}`,
    event_type: "subscription.updated",
    occurred_at: new Date().toISOString(),
    data: {
      id: "sub_seat_1",
      status: "active",
      customer_id: "ctm_seat_1",
      custom_data: { orgId, kind: "team_seats" },
      items: [{ price: { id: "pri_team_month" }, quantity: 3 }],
      billing_cycle: { interval: "month", frequency: 1 },
      ...data,
    },
  };
}

/** An org with a live 3-seat subscription, written the way production writes it: by the webhook. */
async function subscribedOrg(subscriptionId: string, data: Record<string, unknown> = {}) {
  const org = await ownedOrg();
  const res = await webhook(teamEvent(org.orgId, { id: subscriptionId, ...data }));
  expect(res.statusCode).toBe(200);
  return org;
}

/**
 * A stand-in Paddle: GET /subscriptions/:id answers `live`, GET /customers/:id
 * answers `customer`, everything else answers `answer`. Every request is
 * recorded, with whether it carried an abort signal (a timeout).
 */
function stubPaddle(opts: {
  live?: Record<string, unknown>;
  customer?: Record<string, unknown>;
  answer?: Record<string, unknown>;
  fail?: (call: PaddleCall) => boolean;
}) {
  const calls: PaddleCall[] = [];
  const fetchMock = vi.fn(
    async (target: string, init?: { method?: string; body?: string; signal?: unknown }) => {
      const entry = {
        url: target,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body) : undefined,
        bounded: init?.signal instanceof AbortSignal,
      };
      calls.push(entry);
      if (opts.fail?.(entry)) {
        return { ok: false, status: 400, text: async () => '{"error":{"code":"bad_request"}}' };
      }
      const read = entry.url.includes("/customers/") ? opts.customer : opts.live;
      const data = { data: (entry.method === "GET" ? read : opts.answer) ?? {} };
      return { ok: true, status: 200, json: async () => data, text: async () => "" };
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function liveSubscription(over: Record<string, unknown> = {}) {
  return {
    id: "sub_seat_1",
    status: "active",
    scheduled_change: null,
    items: [{ price: { id: "pri_team_month" }, quantity: 3, status: "active" }],
    ...over,
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
  process.env.PADDLE_API_KEY = "test-key";
  process.env.PADDLE_TEAM_PRICE_ID_MONTHLY = "pri_team_month";
  delete process.env.PADDLE_TEAM_PRICE_ID_ANNUAL;
  captured.length = 0;
  if (url) {
    await prisma.organization.updateMany({
      where: { paddleSubscriptionId: { startsWith: "sub_seat_" } },
      data: { paddleSubscriptionId: null },
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (!url) return;
  delete process.env.TEAMS_ENABLED;
  delete process.env.PADDLE_WEBHOOK_SECRET;
  delete process.env.PADDLE_API_KEY;
  delete process.env.PADDLE_TEAM_PRICE_ID_MONTHLY;
  await app.close();
  await prisma.organization.deleteMany({
    where: { memberships: { some: { userId: { in: createdUsers } } } },
  });
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describePg("team seat changes (real Postgres)", () => {
  it("sets the quantity through Paddle on the live price, and leaves the stored seats to the webhook", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_1");
    // The configured price moved since this subscription was bought: a seat
    // change must not quietly migrate the organization onto the new price.
    process.env.PADDLE_TEAM_PRICE_ID_MONTHLY = "pri_team_month_v2";
    const calls = stubPaddle({ live: liveSubscription() });

    const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 5 });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "pending", seats: 5 });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls.every((c) => c.bounded)).toBe(true);
    expect(calls[1]?.url).toMatch(/\/subscriptions\/sub_seat_1$/);
    expect(calls[1]?.body).toEqual({
      items: [{ price_id: "pri_team_month", quantity: 5 }],
      proration_billing_mode: "prorated_immediately",
      on_payment_failure: "prevent_change",
    });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.seatsPurchased).toBe(3);
    const audit = await prisma.orgAuditEvent.findFirst({
      where: { orgId, action: "billing.seats_change_requested" },
    });
    expect(audit).toMatchObject({ actorUserId: owner.userId, detail: { from: 3, to: 5 } });

    // Paddle's subscription.updated is what moves the stored seats.
    const applied = await webhook(
      teamEvent(orgId, { items: [{ price: { id: "pri_team_month" }, quantity: 5 }] }),
    );
    expect(applied.statusCode).toBe(200);
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(after.seatsPurchased).toBe(5);
  });

  it("changes nothing when Paddle already bills that count", async () => {
    const { owner } = await subscribedOrg("sub_seat_2");
    const calls = stubPaddle({ live: liveSubscription({ id: "sub_seat_2" }) });
    const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 3 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unchanged", seats: 3 });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("compares with Paddle, not the stored count, while a webhook is on its way", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_3");
    // Paddle already moved to 6; the stored count (3) has not caught up.
    const calls = stubPaddle({
      live: liveSubscription({
        id: "sub_seat_3",
        items: [{ price: { id: "pri_team_month" }, quantity: 6 }],
      }),
    });
    const repeat = await call(owner, "POST", "/api/orgs/current/seats", { seats: 6 });
    expect(repeat.statusCode).toBe(202);
    expect(repeat.json()).toEqual({ status: "pending", seats: 6 });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(
      await prisma.orgAuditEvent.count({
        where: { orgId, action: "billing.seats_change_requested" },
      }),
    ).toBe(0);

    // Going back to the stored count must still reach Paddle.
    const back = await call(owner, "POST", "/api/orgs/current/seats", { seats: 3 });
    expect(back.statusCode).toBe(202);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(calls[2]?.body).toMatchObject({ items: [{ price_id: "pri_team_month", quantity: 3 }] });
  });

  it("refuses a count outside 2–150 or below the members, and anyone but the owner", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_4");
    const member = await addMember(orgId, "m1");
    await addMember(orgId, "m2");
    await addMember(orgId, "m3");
    const calls = stubPaddle({ live: liveSubscription({ id: "sub_seat_4" }) });
    for (const seats of [1, 151, 2.5, "4", null]) {
      const res = await call(owner, "POST", "/api/orgs/current/seats", { seats });
      expect(res.statusCode, String(seats)).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_SEATS" });
    }
    const below = await call(owner, "POST", "/api/orgs/current/seats", { seats: 3 });
    expect(below.statusCode).toBe(409);
    expect(below.json()).toMatchObject({ code: "SEATS_BELOW_MEMBERS" });
    // Authorization comes before the body: a member learns nothing either way.
    for (const seats of [6, 1]) {
      const byMember = await call(member, "POST", "/api/orgs/current/seats", { seats });
      expect(byMember.statusCode).toBe(403);
      expect(byMember.json()).toMatchObject({ code: "OWNER_ONLY" });
    }
    const stranger = await newSession("stranger");
    expect((await call(stranger, "POST", "/api/orgs/current/seats", { seats: 6 })).statusCode).toBe(
      404,
    );
    expect(calls).toEqual([]);
  });

  it("refuses without a live subscription, while past due, or with a cancel scheduled", async () => {
    const noSub = await ownedOrg();
    const calls = stubPaddle({ live: liveSubscription() });
    const none = await call(noSub.owner, "POST", "/api/orgs/current/seats", { seats: 4 });
    expect(none.json()).toMatchObject({ code: "NO_SUBSCRIPTION" });

    const pastDue = await subscribedOrg("sub_seat_5", { status: "past_due" });
    const late = await call(pastDue.owner, "POST", "/api/orgs/current/seats", { seats: 4 });
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: "SUBSCRIPTION_NOT_ACTIVE" });
    expect(calls).toEqual([]);

    const scheduled = await subscribedOrg("sub_seat_6", {
      scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" },
    });
    const stored = await call(scheduled.owner, "POST", "/api/orgs/current/seats", { seats: 4 });
    expect(stored.statusCode).toBe(409);
    expect(stored.json()).toMatchObject({ code: "CANCEL_SCHEDULED" });
    expect(calls).toEqual([]);

    // Paddle knows of a cancel the webhook has not delivered yet.
    const fresh = await subscribedOrg("sub_seat_7");
    const liveCalls = stubPaddle({
      live: liveSubscription({
        id: "sub_seat_7",
        scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" },
      }),
    });
    const live = await call(fresh.owner, "POST", "/api/orgs/current/seats", { seats: 4 });
    expect(live.json()).toMatchObject({ code: "CANCEL_SCHEDULED" });
    expect(liveCalls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("answers 502 and records nothing when Paddle refuses the change", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_8");
    stubPaddle({
      live: liveSubscription({ id: "sub_seat_8" }),
      fail: (c) => c.method === "PATCH",
    });
    const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 4 });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "BILLING_PROVIDER_ERROR" });
    expect(JSON.stringify(res.json())).not.toContain("bad_request");
    expect(
      await prisma.orgAuditEvent.count({
        where: { orgId, action: "billing.seats_change_requested" },
      }),
    ).toBe(0);
    expect(captured.length).toBeGreaterThan(0);
  });

  it("is off with a clear code while the Paddle key is unset", async () => {
    const { owner } = await subscribedOrg("sub_seat_9");
    delete process.env.PADDLE_API_KEY;
    const calls = stubPaddle({ live: liveSubscription({ id: "sub_seat_9" }) });
    const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 4 });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "TEAM_BILLING_UNAVAILABLE" });
    expect(calls).toEqual([]);
  });
});

describePg("team subscription webhook: scheduled cancel (real Postgres)", () => {
  it("stores a scheduled cancel and clears it when Paddle removes it", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_10", {
      scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00.000Z" },
    });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.subscriptionCancelAt?.toISOString()).toBe("2026-12-14T00:00:00.000Z");
    const view = await call(owner, "GET", "/api/orgs/current");
    expect(view.json()).toMatchObject({ org: { seats: { cancelAt: "2026-12-14T00:00:00.000Z" } } });

    // An event that does not mention scheduled_change keeps the stored date.
    const silent = teamEvent(orgId, { id: "sub_seat_10" });
    await webhook(silent);
    const kept = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(kept.subscriptionCancelAt?.toISOString()).toBe("2026-12-14T00:00:00.000Z");

    await webhook(teamEvent(orgId, { id: "sub_seat_10", scheduled_change: null }));
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(after.subscriptionCancelAt).toBeNull();
  });
});

describePg("team subscription cancel and resume (real Postgres)", () => {
  it("schedules the cancel at the period end once, for the owner only, and audits it", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_11");
    const member = await addMember(orgId);
    const calls = stubPaddle({
      answer: { scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" } },
    });

    expect(
      (await call(member, "POST", "/api/orgs/current/subscription/cancel")).json(),
    ).toMatchObject({ code: "OWNER_ONLY" });
    expect(calls).toEqual([]);

    const first = await call(owner, "POST", "/api/orgs/current/subscription/cancel");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ cancelAt: "2026-12-14T00:00:00.000Z" });
    const again = await call(owner, "POST", "/api/orgs/current/subscription/cancel");
    expect(again.json()).toEqual({ cancelAt: "2026-12-14T00:00:00.000Z" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/\/subscriptions\/sub_seat_11\/cancel$/);
    expect(calls[0]?.body).toEqual({ effective_from: "next_billing_period" });
    expect(calls[0]?.bounded).toBe(true);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    // Seats stay until the period ends: only Paddle's final event ends them.
    expect(org).toMatchObject({ subscriptionStatus: "active", seatsPurchased: 3 });
    expect(org.subscriptionCancelAt?.toISOString()).toBe("2026-12-14T00:00:00.000Z");
    expect(
      await prisma.orgAuditEvent.count({ where: { orgId, action: "billing.cancel_scheduled" } }),
    ).toBe(1);
  });

  it("answers 502 and records nothing when Paddle refuses the cancel", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_16");
    stubPaddle({ fail: () => true });
    const res = await call(owner, "POST", "/api/orgs/current/subscription/cancel");
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "BILLING_PROVIDER_ERROR" });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.subscriptionCancelAt).toBeNull();
    expect(
      await prisma.orgAuditEvent.count({ where: { orgId, action: "billing.cancel_scheduled" } }),
    ).toBe(0);
  });

  it("cancels a past-due subscription at the period end, and the organization still cannot close", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_12", { status: "past_due" });
    const calls = stubPaddle({
      answer: { scheduled_change: { action: "cancel", effective_at: "2026-12-01T00:00:00Z" } },
    });
    const res = await call(owner, "POST", "/api/orgs/current/subscription/cancel");
    expect(res.statusCode).toBe(200);
    expect(calls[0]?.body).toEqual({ effective_from: "next_billing_period" });
    const leave = await call(owner, "POST", "/api/orgs/current/leave");
    expect(leave.statusCode).toBe(409);
    expect(leave.json()).toMatchObject({ code: "SUBSCRIPTION_ACTIVE" });
    expect(await prisma.organization.findUnique({ where: { id: orgId } })).not.toBeNull();
  });

  it("refuses a paused subscription and an organization without one", async () => {
    const calls = stubPaddle({});
    const paused = await subscribedOrg("sub_seat_13", { status: "paused" });
    const res = await call(paused.owner, "POST", "/api/orgs/current/subscription/cancel");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "SUBSCRIPTION_PAUSED" });
    const none = await ownedOrg();
    const missing = await call(none.owner, "POST", "/api/orgs/current/subscription/cancel");
    expect(missing.json()).toMatchObject({ code: "NO_SUBSCRIPTION" });
    expect(calls).toEqual([]);
  });

  it("takes a scheduled cancel back once; a repeat answers the same without Paddle", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_14", {
      scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" },
    });
    const calls = stubPaddle({ answer: { next_billed_at: "2026-12-14T00:00:00Z" } });
    const res = await call(owner, "POST", "/api/orgs/current/subscription/resume");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resumed: true });
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { scheduled_change: null } });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.subscriptionCancelAt).toBeNull();
    expect(
      await prisma.orgAuditEvent.count({ where: { orgId, action: "billing.cancel_removed" } }),
    ).toBe(1);
    const twice = await call(owner, "POST", "/api/orgs/current/subscription/resume");
    expect(twice.statusCode).toBe(200);
    expect(twice.json()).toEqual({ resumed: true });
    expect(calls).toHaveLength(1);
  });
});

describePg("team billing portal (real Postgres)", () => {
  it("opens for the owner whose verified email pays, and for no one else", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_15", { customer_id: "ctm_seat_15" });
    const member = await addMember(orgId);
    const calls = stubPaddle({
      customer: { id: "ctm_seat_15", email: owner.email.toUpperCase() },
      answer: { urls: { general: { overview: "https://customer-portal.paddle.com/cpl_1" } } },
    });

    const res = await call(owner, "POST", "/api/orgs/current/billing-portal");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://customer-portal.paddle.com/cpl_1" });
    expect(calls.map((c) => c.url.replace(/^https:\/\/[^/]+/, ""))).toEqual([
      "/customers/ctm_seat_15",
      "/customers/ctm_seat_15/portal-sessions",
    ]);
    expect(
      await prisma.orgAuditEvent.count({ where: { orgId, action: "billing.portal_opened" } }),
    ).toBe(1);

    const byMember = await call(member, "POST", "/api/orgs/current/billing-portal");
    expect(byMember.json()).toMatchObject({ code: "OWNER_ONLY" });

    // Ownership moves: the portal is the payer's own Paddle account (their
    // other subscriptions, invoices, address), so it stays theirs.
    const transfer = await call(owner, "POST", "/api/orgs/current/transfer", {
      membershipId: (
        await prisma.orgMembership.findUniqueOrThrow({ where: { userId: member.userId } })
      ).id,
    });
    expect(transfer.statusCode).toBe(200);
    const newOwner = await call(member, "POST", "/api/orgs/current/billing-portal");
    expect(newOwner.statusCode).toBe(409);
    expect(newOwner.json()).toMatchObject({ code: "PORTAL_PAYER_ONLY" });
    expect(calls.filter((c) => c.url.includes("portal-sessions"))).toHaveLength(1);
  });

  it("stays closed after the subscription ends, even for a new owner who opens a checkout", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_17", { customer_id: "ctm_seat_17" });
    const member = await addMember(orgId);
    await webhook(teamEvent(orgId, { id: "sub_seat_17", status: "canceled" }));
    const calls = stubPaddle({
      customer: { email: member.email },
      answer: {
        checkout: { url: "https://pay.example/c/1" },
        urls: { general: { overview: "https://customer-portal.paddle.com/cpl_1" } },
      },
    });
    await call(owner, "POST", "/api/orgs/current/transfer", {
      membershipId: (
        await prisma.orgMembership.findUniqueOrThrow({ where: { userId: member.userId } })
      ).id,
    });
    const checkout = await call(member, "POST", "/api/orgs/current/checkout", {
      interval: "month",
      seats: 2,
    });
    expect(checkout.statusCode).toBe(200);
    const res = await call(member, "POST", "/api/orgs/current/billing-portal");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NO_SUBSCRIPTION" });
    expect(calls.filter((c) => c.url.includes("/customers/"))).toHaveLength(0);
  });

  it("refuses a portal link outside paddle.com, and an organization with no billing account", async () => {
    const { owner } = await subscribedOrg("sub_seat_18", { customer_id: "ctm_seat_18" });
    stubPaddle({
      customer: { email: owner.email },
      answer: { urls: { general: { overview: "https://evil.example/portal" } } },
    });
    const odd = await call(owner, "POST", "/api/orgs/current/billing-portal");
    expect(odd.statusCode).toBe(502);
    expect(JSON.stringify(odd.json())).not.toContain("evil.example");

    const calls = stubPaddle({});
    const none = await ownedOrg();
    const res = await call(none.owner, "POST", "/api/orgs/current/billing-portal");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NO_SUBSCRIPTION" });
    expect(calls).toEqual([]);
  });
});
