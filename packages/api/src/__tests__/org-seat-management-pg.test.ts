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
import { checkGlobalCostGate } from "../billing/cost-guard.js";
import {
  __resetGlobalCeilingCacheForTest,
  GLOBAL_BREAKER_TARGET_MULTIPLIER,
} from "../billing/global-cost-ceiling.js";
import { GLOBAL_DAILY_COST_CAP_CENTS, TEAM_SEAT_DAILY_COST_CAP_CENTS } from "../config.js";
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
  /** The failed answer's body; Paddle's error envelope names a code. */
  failBody?: string;
  /** Runs as each request arrives, before it is answered. */
  onCall?: (call: PaddleCall) => Promise<void>;
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
      await opts.onCall?.(entry);
      if (opts.fail?.(entry)) {
        const text = opts.failBody ?? '{"error":{"code":"bad_request"}}';
        return { ok: false, status: 400, text: async () => text };
      }
      const read = entry.url.includes("/customers/") ? opts.customer : opts.live;
      const data = { data: (entry.method === "GET" ? read : opts.answer) ?? {} };
      return { ok: true, status: 200, json: async () => data, text: async () => "" };
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** An owner who took the organization over by transfer: not the Paddle customer. */
async function transferredOrg(subscriptionId: string, data: Record<string, unknown> = {}) {
  const { owner, orgId } = await subscribedOrg(subscriptionId, data);
  const heir = await addMember(orgId, "heir");
  await transferTo(owner, heir);
  return { payer: owner, heir, orgId };
}

async function transferTo(from: Session, to: Session): Promise<void> {
  const membershipId = (
    await prisma.orgMembership.findUniqueOrThrow({ where: { userId: to.userId } })
  ).id;
  const moved = await call(from, "POST", "/api/orgs/current/transfer", { membershipId });
  expect(moved.statusCode).toBe(200);
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
    const calls = stubPaddle({ live: liveSubscription(), customer: { email: owner.email } });

    const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 5 });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "pending", seats: 5 });
    // Adding seats charges the card on file: the payer check reads the
    // Paddle customer before the change.
    expect(calls.map((c) => `${c.method} ${c.url.replace(/^https:\/\/[^/]+/, "")}`)).toEqual([
      "GET /subscriptions/sub_seat_1",
      "GET /customers/ctm_seat_1",
      "PATCH /subscriptions/sub_seat_1",
    ]);
    expect(calls.every((c) => c.bounded)).toBe(true);
    expect(calls[2]?.body).toEqual({
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
      customer: { email: owner.email },
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

describePg("team seat increases: payer only (real Postgres)", () => {
  it("refuses an increase by an owner who does not pay, audits it without the email, and calls no PATCH", async () => {
    const { payer, heir, orgId } = await transferredOrg("sub_seat_20");
    const calls = stubPaddle({
      live: liveSubscription({ id: "sub_seat_20" }),
      customer: { email: payer.email },
    });

    const res = await call(heir, "POST", "/api/orgs/current/seats", { seats: 5 });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "SEATS_INCREASE_PAYER_ONLY" });
    expect(JSON.stringify(res.json())).not.toContain(payer.email);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    const refused = await prisma.orgAuditEvent.findMany({
      where: { orgId, action: "billing.seats_increase_refused" },
    });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      actorUserId: heir.userId,
      detail: { from: 3, to: 5, reason: "not_payer" },
    });
    expect(JSON.stringify(refused[0]?.detail)).not.toContain("@");
    expect(
      await prisma.orgAuditEvent.count({
        where: { orgId, action: "billing.seats_change_requested" },
      }),
    ).toBe(0);
  });

  it("lets any owner remove seats: a decrease needs no payer check", async () => {
    const { heir, orgId } = await transferredOrg("sub_seat_21");
    const calls = stubPaddle({
      live: liveSubscription({
        id: "sub_seat_21",
        items: [{ price: { id: "pri_team_month" }, quantity: 4 }],
      }),
      customer: { email: "someone-else@seats.test" },
    });

    const res = await call(heir, "POST", "/api/orgs/current/seats", { seats: 2 });

    expect(res.statusCode).toBe(202);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(calls.some((c) => c.url.includes("/customers/"))).toBe(false);
    const audit = await prisma.orgAuditEvent.findFirst({
      where: { orgId, action: "billing.seats_change_requested" },
    });
    expect(audit).toMatchObject({ actorUserId: heir.userId, detail: { from: 4, to: 2 } });
  });

  it("lets the payer add seats after taking ownership back", async () => {
    const { payer, heir, orgId } = await transferredOrg("sub_seat_22");
    const back = await call(heir, "POST", "/api/orgs/current/transfer", {
      membershipId: (
        await prisma.orgMembership.findUniqueOrThrow({ where: { userId: payer.userId } })
      ).id,
    });
    expect(back.statusCode).toBe(200);
    const calls = stubPaddle({
      live: liveSubscription({ id: "sub_seat_22" }),
      customer: { email: ` ${payer.email.toUpperCase()} ` },
    });
    const res = await call(payer, "POST", "/api/orgs/current/seats", { seats: 4 });
    expect(res.statusCode).toBe(202);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(
      await prisma.orgAuditEvent.count({
        where: { orgId, action: "billing.seats_increase_refused" },
      }),
    ).toBe(0);
  });

  it("refuses an increase from an unverified owner or with no payer on record, and audits the reason", async () => {
    const unverified = await subscribedOrg("sub_seat_23");
    await prisma.user.update({
      where: { id: unverified.owner.userId },
      data: { emailVerified: false },
    });
    const calls = stubPaddle({
      live: liveSubscription({ id: "sub_seat_23" }),
      customer: { email: unverified.owner.email },
    });
    const res = await call(unverified.owner, "POST", "/api/orgs/current/seats", { seats: 4 });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(
      await prisma.orgAuditEvent.findFirst({
        where: { orgId: unverified.orgId, action: "billing.seats_increase_refused" },
      }),
    ).toMatchObject({ detail: { from: 3, to: 4, reason: "email_not_verified" } });

    const noPayer = await subscribedOrg("sub_seat_24");
    await prisma.organization.update({
      where: { id: noPayer.orgId },
      data: { paddleCustomerId: null },
    });
    const noPayerCalls = stubPaddle({ live: liveSubscription({ id: "sub_seat_24" }) });
    const none = await call(noPayer.owner, "POST", "/api/orgs/current/seats", { seats: 4 });
    expect(none.statusCode).toBe(403);
    expect(none.json()).toMatchObject({ code: "SEATS_INCREASE_PAYER_ONLY" });
    expect(noPayerCalls.map((c) => c.method)).toEqual(["GET"]);
    expect(
      await prisma.orgAuditEvent.findFirst({
        where: { orgId: noPayer.orgId, action: "billing.seats_increase_refused" },
      }),
    ).toMatchObject({ detail: { reason: "no_payer_on_record" } });
  });

  it("refuses a change whose live read went stale: two decreases cannot add up to an unchecked increase", async () => {
    const { heir, orgId } = await transferredOrg("sub_seat_29");
    // While this request reads Paddle (10 seats, so "8" looks like a
    // decrease), another request lowers the count to 2 and commits.
    const calls = stubPaddle({
      live: liveSubscription({
        id: "sub_seat_29",
        items: [{ price: { id: "pri_team_month" }, quantity: 10 }],
      }),
      onCall: async (c) => {
        if (c.method !== "GET") return;
        await prisma.orgAuditEvent.create({
          data: {
            orgId,
            action: "billing.seats_change_requested",
            actorUserId: heir.userId,
            detail: { from: 10, to: 2 },
          },
        });
      },
    });

    const res = await call(heir, "POST", "/api/orgs/current/seats", { seats: 8 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "SEATS_CHANGED" });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(
      await prisma.orgAuditEvent.count({
        where: { orgId, action: "billing.seats_change_requested" },
      }),
    ).toBe(1);
  });

  it("answers 502 without changing anything when the payer lookup fails", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_30");
    const calls = stubPaddle({
      live: liveSubscription({ id: "sub_seat_30" }),
      fail: (c) => c.url.includes("/customers/"),
    });
    const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 4 });
    expect(res.statusCode).toBe(502);
    // A failed read before any change says nothing was changed.
    expect(res.json()).toMatchObject({ code: "BILLING_PROVIDER_READ_FAILED" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(
      await prisma.orgAuditEvent.count({
        where: {
          orgId,
          action: { in: ["billing.seats_change_requested", "billing.seats_increase_refused"] },
        },
      }),
    ).toBe(0);
  });

  it("answers CANCEL_SCHEDULED when a portal cancel lands between the live read and the change", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_25");
    // The live read saw nothing scheduled; by the PATCH, Paddle holds a
    // cancel and refuses the update (subscription_locked_pending_changes).
    const calls = stubPaddle({
      live: liveSubscription({ id: "sub_seat_25" }),
      customer: { email: owner.email },
      fail: (c) => c.method === "PATCH",
      failBody:
        '{"error":{"type":"request_error","code":"subscription_locked_pending_changes","detail":"Cannot update subscription, pending scheduled changes."}}',
    });

    const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 4 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "CANCEL_SCHEDULED" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
    // The expected refusal is not a provider fault: no report, no audit row.
    expect(captured).toEqual([]);
    expect(
      await prisma.orgAuditEvent.count({
        where: { orgId, action: "billing.seats_change_requested" },
      }),
    ).toBe(0);
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

  it("takes a scheduled cancel back once; a repeat finds nothing at Paddle and answers the same", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_14", {
      scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" },
    });
    const calls = stubPaddle({
      customer: { email: owner.email },
      answer: { next_billed_at: "2026-12-14T00:00:00Z" },
    });
    const res = await call(owner, "POST", "/api/orgs/current/subscription/resume");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resumed: true });
    // Resume restarts billing on the payer's card: the payer check comes first.
    expect(calls[0]?.url).toMatch(/\/customers\/ctm_seat_1$/);
    expect(calls[1]).toMatchObject({ method: "PATCH", body: { scheduled_change: null } });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.subscriptionCancelAt).toBeNull();
    expect(
      await prisma.orgAuditEvent.count({ where: { orgId, action: "billing.cancel_removed" } }),
    ).toBe(1);
    const twice = await call(owner, "POST", "/api/orgs/current/subscription/resume");
    expect(twice.statusCode).toBe(200);
    expect(twice.json()).toEqual({ resumed: true });
    // Nothing left to take back: no payer check, nothing changed.
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH", "GET"]);
  });

  it("takes back a cancel made in the portal before its webhook arrives", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_19");
    const calls = stubPaddle({
      live: liveSubscription({
        id: "sub_seat_19",
        scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" },
      }),
      customer: { email: owner.email },
    });
    const res = await call(owner, "POST", "/api/orgs/current/subscription/resume");
    expect(res.statusCode).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(calls[2]?.body).toEqual({ scheduled_change: null });
    expect(
      await prisma.orgAuditEvent.count({ where: { orgId, action: "billing.cancel_removed" } }),
    ).toBe(1);
  });
});

describePg("team payer recorded at checkout (real Postgres)", () => {
  /** The organization's own checkout event, naming its buyer. */
  function checkoutEvent(orgId: string, subscriptionId: string, payerUserId: string, over = {}) {
    return teamEvent(orgId, {
      id: subscriptionId,
      custom_data: { orgId, kind: "team_seats", payerUserId },
      ...over,
    });
  }

  async function payerOf(orgId: string): Promise<string | null> {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    return org.payerUserId;
  }

  it("names the buyer in the checkout, stores them as payer, and lets them add seats and open the portal while Paddle bills another email", async () => {
    const { owner, orgId } = await ownedOrg("buyer");
    const checkoutCalls = stubPaddle({ answer: { checkout: { url: "https://pay.example/c/1" } } });
    const checkout = await call(owner, "POST", "/api/orgs/current/checkout", {
      interval: "month",
      seats: 3,
    });
    expect(checkout.statusCode).toBe(200);
    expect(checkoutCalls[0]?.body).toMatchObject({
      custom_data: { orgId, kind: "team_seats", payerUserId: owner.userId },
    });

    expect((await webhook(checkoutEvent(orgId, "sub_seat_31", owner.userId))).statusCode).toBe(200);
    expect(await payerOf(orgId)).toBe(owner.userId);

    // The buyer paid with a work address that is not their Klorn login.
    const calls = stubPaddle({
      live: liveSubscription({ id: "sub_seat_31" }),
      customer: { email: "accounts@company.test" },
      answer: { urls: { general: { overview: "https://customer-portal.paddle.com/cpl_9" } } },
    });
    const seats = await call(owner, "POST", "/api/orgs/current/seats", { seats: 5 });
    expect(seats.statusCode).toBe(202);
    const portal = await call(owner, "POST", "/api/orgs/current/billing-portal");
    expect(portal.statusCode).toBe(200);
    // The recorded payer needs no email lookup.
    expect(calls.some((c) => c.url.includes("/customers/ctm_seat_1") && c.method === "GET")).toBe(
      false,
    );
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH", "POST"]);
  });

  it("loses the payer's rights with ownership, and a later event cannot move the payer", async () => {
    const { owner, orgId } = await ownedOrg("buyer");
    await webhook(checkoutEvent(orgId, "sub_seat_32", owner.userId));
    const heir = await addMember(orgId, "heir");
    await transferTo(owner, heir);
    // A later event for the same subscription naming the new owner (Paddle
    // keeps the checkout's custom data; this one is forged) changes nothing.
    await webhook(checkoutEvent(orgId, "sub_seat_32", heir.userId));
    expect(await payerOf(orgId)).toBe(owner.userId);

    const calls = stubPaddle({
      live: liveSubscription({ id: "sub_seat_32" }),
      customer: { email: "accounts@company.test" },
    });
    const byHeir = await call(heir, "POST", "/api/orgs/current/seats", { seats: 5 });
    expect(byHeir.statusCode).toBe(403);
    expect(byHeir.json()).toMatchObject({ code: "SEATS_INCREASE_PAYER_ONLY" });
    const byFormerOwner = await call(owner, "POST", "/api/orgs/current/seats", { seats: 5 });
    expect(byFormerOwner.json()).toMatchObject({ code: "OWNER_ONLY" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("never stores a payer who is not an owner of that organization at webhook time", async () => {
    const { owner, orgId } = await ownedOrg("buyer");
    const member = await addMember(orgId);
    const stranger = await newSession("stranger");
    await webhook(checkoutEvent(orgId, "sub_seat_33", member.userId));
    expect(await payerOf(orgId)).toBeNull();
    expect(captured.length).toBeGreaterThan(0);

    const other = await ownedOrg("other");
    await webhook(checkoutEvent(other.orgId, "sub_seat_34", stranger.userId));
    expect(await payerOf(other.orgId)).toBeNull();

    // The owner's later event fills a payer the first event could not store.
    await webhook(checkoutEvent(orgId, "sub_seat_33", owner.userId));
    expect(await payerOf(orgId)).toBe(owner.userId);
  });

  it("stores no payer from an event mapped only by subscription id, and clears it when the subscription ends", async () => {
    const { owner, orgId } = await ownedOrg("buyer");
    await webhook(checkoutEvent(orgId, "sub_seat_35", owner.userId));
    expect(await payerOf(orgId)).toBe(owner.userId);
    await webhook(checkoutEvent(orgId, "sub_seat_35", owner.userId, { status: "canceled" }));
    expect(await payerOf(orgId)).toBeNull();

    const legacy = await subscribedOrg("sub_seat_36");
    const foreign = teamEvent(legacy.orgId, {
      id: "sub_seat_36",
      custom_data: { kind: "team_seats", payerUserId: legacy.owner.userId },
    });
    await webhook(foreign);
    expect(await payerOf(legacy.orgId)).toBeNull();
  });
});

describePg("team resume: payer only (real Postgres)", () => {
  it("refuses an owner who does not pay, audits the reason, and changes nothing", async () => {
    const { payer, heir, orgId } = await transferredOrg("sub_seat_37", {
      scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" },
    });
    const calls = stubPaddle({ customer: { email: payer.email } });

    const res = await call(heir, "POST", "/api/orgs/current/subscription/resume");

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "RESUME_PAYER_ONLY" });
    expect(JSON.stringify(res.json())).not.toContain(payer.email);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.subscriptionCancelAt?.toISOString()).toBe("2026-12-14T00:00:00.000Z");
    const refused = await prisma.orgAuditEvent.findMany({
      where: { orgId, action: "billing.resume_refused" },
    });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ actorUserId: heir.userId, detail: { reason: "not_payer" } });
    expect(JSON.stringify(refused[0]?.detail)).not.toContain("@");
    expect(
      await prisma.orgAuditEvent.count({ where: { orgId, action: "billing.cancel_removed" } }),
    ).toBe(0);
  });

  it("refuses a portal cancel's undo by a non-payer before its webhook arrives", async () => {
    const { payer, heir } = await transferredOrg("sub_seat_38");
    const calls = stubPaddle({
      live: liveSubscription({
        id: "sub_seat_38",
        scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" },
      }),
      customer: { email: payer.email },
    });
    const res = await call(heir, "POST", "/api/orgs/current/subscription/resume");
    expect(res.json()).toMatchObject({ code: "RESUME_PAYER_ONLY" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("still lets any owner cancel at the period end", async () => {
    const { heir, orgId } = await transferredOrg("sub_seat_39");
    const calls = stubPaddle({
      answer: { scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" } },
    });
    const res = await call(heir, "POST", "/api/orgs/current/subscription/cancel");
    expect(res.statusCode).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
    expect(
      await prisma.orgAuditEvent.count({ where: { orgId, action: "billing.cancel_scheduled" } }),
    ).toBe(1);
  });

  it("answers BILLING_PROVIDER_READ_FAILED when the live read fails before any change", async () => {
    const { owner } = await subscribedOrg("sub_seat_40");
    stubPaddle({ fail: (c) => c.method === "GET" });
    const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 4 });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "BILLING_PROVIDER_READ_FAILED" });
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
    // The refusal is audited by reason class only: never either email.
    const refused = await prisma.orgAuditEvent.findMany({
      where: { orgId, action: "billing.portal_refused" },
    });
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      actorUserId: member.userId,
      detail: { reason: "not_payer" },
    });
    expect(JSON.stringify(refused[0]?.detail)).not.toContain("@");
  });

  it("audits a portal refusal for an unverified owner and for a Paddle customer without an email", async () => {
    const unverified = await subscribedOrg("sub_seat_26", { customer_id: "ctm_seat_26" });
    await prisma.user.update({
      where: { id: unverified.owner.userId },
      data: { emailVerified: false },
    });
    const calls = stubPaddle({ customer: { email: unverified.owner.email } });
    const res = await call(unverified.owner, "POST", "/api/orgs/current/billing-portal");
    expect(res.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(calls).toEqual([]);
    expect(
      await prisma.orgAuditEvent.findFirst({
        where: { orgId: unverified.orgId, action: "billing.portal_refused" },
      }),
    ).toMatchObject({ detail: { reason: "email_not_verified" } });

    const blank = await subscribedOrg("sub_seat_27", { customer_id: "ctm_seat_27" });
    stubPaddle({ customer: { id: "ctm_seat_27" } });
    const none = await call(blank.owner, "POST", "/api/orgs/current/billing-portal");
    expect(none.json()).toMatchObject({ code: "PORTAL_PAYER_ONLY" });
    expect(
      await prisma.orgAuditEvent.findFirst({
        where: { orgId: blank.orgId, action: "billing.portal_refused" },
      }),
    ).toMatchObject({ detail: { reason: "no_payer_email" } });
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

describePg("global cost ceiling counts paid seat pools (real Postgres)", () => {
  it("raises the global ceiling by the breaker share of every active paid pool, and not while Teams is off", async () => {
    const base = GLOBAL_DAILY_COST_CAP_CENTS;
    expect(base).toBeGreaterThan(0);
    await subscribedOrg("sub_seat_28", {
      items: [{ price: { id: "pri_team_month" }, quantity: 150 }],
    });
    __resetGlobalCeilingCacheForTest();

    const open = await checkGlobalCostGate();
    // Other suites may hold active organizations in the same database, so the
    // ceiling is at least this organization's share above the base.
    const share = 150 * TEAM_SEAT_DAILY_COST_CAP_CENTS * GLOBAL_BREAKER_TARGET_MULTIPLIER;
    expect(open.capCents).toBeGreaterThanOrEqual(base + share);
    // The point of it: a 150-seat pool fits under the ceiling.
    expect(open.capCents).toBeGreaterThan(150 * TEAM_SEAT_DAILY_COST_CAP_CENTS);

    delete process.env.TEAMS_ENABLED;
    __resetGlobalCeilingCacheForTest();
    const closed = await checkGlobalCostGate();
    expect(closed.capCents).toBe(base);
  });
});
