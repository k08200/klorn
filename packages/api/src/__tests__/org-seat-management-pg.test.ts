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
const IN_FLIGHT_MESSAGE =
  "An earlier seat change is still being processed, so the current count is not certain yet. Try again in a few minutes.";
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
  /** The failed answer's status (400 unless set). */
  failStatus?: number;
  /** No answer at all: the request throws this (a timeout, the network). */
  throwOn?: (call: PaddleCall) => Error | null;
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
      const thrown = opts.throwOn?.(entry);
      if (thrown) throw thrown;
      if (opts.fail?.(entry)) {
        const text = opts.failBody ?? '{"error":{"code":"bad_request"}}';
        return { ok: false, status: opts.failStatus ?? 400, text: async () => text };
      }
      const read = entry.url.includes("/customers/") ? opts.customer : opts.live;
      const data = { data: (entry.method === "GET" ? read : opts.answer) ?? {} };
      return { ok: true, status: 200, json: async () => data, text: async () => "" };
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** The organization's seat change audit rows: action → details. */
async function seatChangeRows(orgId: string): Promise<Record<string, unknown[]>> {
  const rows = await prisma.orgAuditEvent.findMany({
    where: { orgId, action: { startsWith: "billing.seats_change_" } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { action: true, detail: true },
  });
  const byAction: Record<string, unknown[]> = {};
  for (const row of rows) byAction[row.action] = [...(byAction[row.action] ?? []), row.detail];
  return byAction;
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
    // Paddle answered and refused: nothing changed there, so nothing is on record.
    expect(
      await prisma.orgAuditEvent.count({
        where: { orgId, action: { startsWith: "billing.seats_change_" } },
      }),
    ).toBe(0);
    expect(captured.length).toBeGreaterThan(0);
  });

  it("keeps a change Paddle never answered on record: the request, then why it is unconfirmed", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_u1");
    stubPaddle({
      live: liveSubscription({ id: "sub_seat_u1" }),
      customer: { email: owner.email },
      throwOn: (c) =>
        c.method === "PATCH"
          ? new DOMException("The operation was aborted due to timeout", "TimeoutError")
          : null,
    });
    const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 4 });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "BILLING_PROVIDER_ERROR" });
    const rows = await seatChangeRows(orgId);
    expect(rows).toEqual({
      "billing.seats_change_requested": [{ from: 3, to: 4, payer: "email" }],
      "billing.seats_change_unconfirmed": [{ from: 3, to: 4, failure: "PROVIDER_UNAVAILABLE" }],
    });
    expect(JSON.stringify(rows)).not.toMatch(/abort|timeout/i);
  });

  it("records a Paddle server fault as unconfirmed, without Paddle's text", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_u2");
    stubPaddle({
      live: liveSubscription({ id: "sub_seat_u2" }),
      customer: { email: owner.email },
      fail: (c) => c.method === "PATCH",
      failStatus: 503,
      failBody: '{"error":{"code":"internal_error","detail":"upstream said something"}}',
    });
    const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 2 });
    expect(res.statusCode).toBe(502);
    const rows = await seatChangeRows(orgId);
    expect(rows).toEqual({
      "billing.seats_change_requested": [{ from: 3, to: 2 }],
      "billing.seats_change_unconfirmed": [{ from: 3, to: 2, failure: "PROVIDER_UNAVAILABLE" }],
    });
    expect(JSON.stringify(rows)).not.toMatch(/internal_error|upstream/);
  });

  it("counts an unconfirmed change against a request that read Paddle before it", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_u3");
    let raced = false;
    // While this request (3 → 2, a decrease) reads Paddle, another raises the
    // count to 4 and Paddle never answers it: Paddle may now hold 4, so "2"
    // is no longer known to be a decrease.
    const calls = stubPaddle({
      live: liveSubscription({ id: "sub_seat_u3" }),
      customer: { email: owner.email },
      // undici's shape for a dropped connection: "fetch failed" with a coded cause.
      throwOn: (c) =>
        c.method === "PATCH"
          ? new TypeError("fetch failed", {
              cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
            })
          : null,
      onCall: async (c) => {
        if (raced || c.method !== "GET") return;
        raced = true;
        const other = await call(owner, "POST", "/api/orgs/current/seats", { seats: 4 });
        expect(other.statusCode).toBe(502);
      },
    });
    const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 2 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "SEATS_CHANGED" });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(await seatChangeRows(orgId)).toEqual({
      "billing.seats_change_requested": [{ from: 3, to: 4, payer: "email" }],
      "billing.seats_change_unconfirmed": [{ from: 3, to: 4, failure: "PROVIDER_UNAVAILABLE" }],
    });
  });

  it("refuses a change whose live read came while an earlier change's Paddle call was still running", async () => {
    const { heir } = await transferredOrg("sub_seat_u6");
    let racer: ReturnType<typeof call> | null = null;
    // The heir (not the payer) lowers 10 → 5. While that call is still on its
    // way to Paddle, a second request reads the count (still 10, so "8" looks
    // like a decrease) after the first one's audit row was committed.
    const calls: PaddleCall[] = stubPaddle({
      live: liveSubscription({
        id: "sub_seat_u6",
        items: [{ price: { id: "pri_team_month" }, quantity: 10 }],
      }),
      onCall: async (c) => {
        if (c.method !== "PATCH" || racer) return;
        racer = call(heir, "POST", "/api/orgs/current/seats", { seats: 8 });
        while (calls.filter((x) => x.method === "GET").length < 2) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    });
    const first = await call(heir, "POST", "/api/orgs/current/seats", { seats: 5 });
    expect(first.statusCode).toBe(202);
    const second = await (racer as ReturnType<typeof call> | null);
    expect(second?.statusCode).toBe(409);
    // Nothing changed since the second request looked: the first change is
    // still on its way, which is a different answer from "it changed".
    expect(second?.json()).toEqual({
      code: "SEATS_CHANGE_IN_FLIGHT",
      error: IN_FLIGHT_MESSAGE,
    });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("keeps the request on record when the locked transaction fails after Paddle accepted", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_u4");
    const calls = stubPaddle({
      live: liveSubscription({ id: "sub_seat_u4" }),
      customer: { email: owner.email },
    });
    const patched = () => calls.some((c) => c.method === "PATCH");
    const realTransaction = prisma.$transaction.bind(prisma) as (
      work: (tx: unknown) => Promise<unknown>,
      options?: unknown,
    ) => Promise<unknown>;
    // The org lock's transaction rolls back after the Paddle call returned
    // (an expired transaction, a lost commit): Paddle holds the new count.
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((
      work: (tx: unknown) => Promise<unknown>,
      options?: unknown,
    ) =>
      realTransaction(async (tx) => {
        const result = await work(tx);
        if (patched()) throw new Error("commit lost");
        return result;
      }, options)) as never);
    try {
      const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 2 });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      spy.mockRestore();
    }
    expect(patched()).toBe(true);
    expect(await seatChangeRows(orgId)).toEqual({
      "billing.seats_change_requested": [{ from: 3, to: 2 }],
    });
  });

  it("starts no change from a count read while the last change is unconfirmed, for two minutes", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_u5");
    stubPaddle({
      live: liveSubscription({ id: "sub_seat_u5" }),
      customer: { email: owner.email },
      throwOn: (c) => (c.method === "PATCH" ? new DOMException("timed out", "TimeoutError") : null),
    });
    expect((await call(owner, "POST", "/api/orgs/current/seats", { seats: 4 })).statusCode).toBe(
      502,
    );
    // Paddle may still apply 4 after this request reads 3: "2" is no longer
    // known to be a decrease.
    const calls = stubPaddle({
      live: liveSubscription({ id: "sub_seat_u5" }),
      customer: { email: owner.email },
    });
    const blocked = await call(owner, "POST", "/api/orgs/current/seats", { seats: 2 });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ code: "SEATS_CHANGE_IN_FLIGHT", error: IN_FLIGHT_MESSAGE });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);

    // Three minutes on (both rows aged), the doubt is over.
    await prisma.orgAuditEvent.updateMany({
      where: { orgId, action: { startsWith: "billing.seats_change_" } },
      data: { createdAt: new Date(Date.now() - 3 * 60_000) },
    });
    const later = await call(owner, "POST", "/api/orgs/current/seats", { seats: 2 });
    expect(later.statusCode).toBe(202);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
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
      live: liveSubscription({ id: "sub_seat_11" }),
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

    // One live read (is a cancel already pending in Paddle?), then the cancel;
    // the repeat answers the stored date.
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[1]?.url).toMatch(/\/subscriptions\/sub_seat_11\/cancel$/);
    expect(calls[1]?.body).toEqual({ effective_from: "next_billing_period" });
    expect(calls.every((c) => c.bounded)).toBe(true);
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
    stubPaddle({ live: liveSubscription({ id: "sub_seat_16" }), fail: (c) => c.method === "POST" });
    const res = await call(owner, "POST", "/api/orgs/current/subscription/cancel");
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "BILLING_PROVIDER_ERROR" });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    expect(org.subscriptionCancelAt).toBeNull();
    expect(org.cancelRequestedByUserId).toBeNull();
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
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      effective_from: "next_billing_period",
    });
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

/** The organization's own checkout event, naming its buyer. */
function checkoutEvent(orgId: string, subscriptionId: string, payerUserId: string, over = {}) {
  return teamEvent(orgId, {
    id: subscriptionId,
    custom_data: { orgId, kind: "team_seats", payerUserId },
    ...over,
  });
}

describePg("team payer recorded at checkout (real Postgres)", () => {
  async function payerOf(orgId: string): Promise<string | null> {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    return org.payerUserId;
  }

  it("names the buyer in the checkout, stores them as payer, and lets them add seats while Paddle bills another email — but not open that customer's portal", async () => {
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
    // The recorded payer needs no email lookup for a seat increase.
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(
      await prisma.orgAuditEvent.findFirst({
        where: { orgId, action: "billing.seats_change_requested" },
      }),
    ).toMatchObject({ detail: { from: 3, to: 5, payer: "recorded" } });

    // The portal is the Paddle customer's whole account, and the customer is
    // whoever's email was typed at checkout: it keeps the email match.
    const portal = await call(owner, "POST", "/api/orgs/current/billing-portal");
    expect(portal.statusCode).toBe(409);
    expect(portal.json()).toMatchObject({ code: "PORTAL_PAYER_ONLY" });
    expect(calls.some((c) => c.url.includes("portal-sessions"))).toBe(false);
    expect(
      await prisma.orgAuditEvent.findFirst({ where: { orgId, action: "billing.portal_refused" } }),
    ).toMatchObject({ detail: { reason: "not_payer" } });
  });

  it("does not let the recorded payer undo a portal cancel while Paddle bills another email", async () => {
    // Only the paying email reaches the portal: a cancel made there is the
    // Paddle customer's own decision, and the recorded payer may not be them.
    const { owner, orgId } = await ownedOrg("buyer");
    await webhook(
      checkoutEvent(orgId, "sub_seat_41", owner.userId, {
        scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" },
      }),
    );
    const calls = stubPaddle({ customer: { email: "accounts@company.test" } });
    const res = await call(owner, "POST", "/api/orgs/current/subscription/resume");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "RESUME_PAYER_ONLY" });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    const refused = await prisma.orgAuditEvent.findFirst({
      where: { orgId, action: "billing.resume_refused" },
    });
    expect(refused).toMatchObject({ detail: { reason: "recorded_payer_portal_cancel" } });
    expect(JSON.stringify(refused?.detail)).not.toContain("@");

    // The paying email still can.
    vi.unstubAllGlobals();
    const paying = stubPaddle({ customer: { email: owner.email } });
    const byEmail = await call(owner, "POST", "/api/orgs/current/subscription/resume");
    expect(byEmail.statusCode).toBe(200);
    expect(paying.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(
      await prisma.orgAuditEvent.findFirst({ where: { orgId, action: "billing.cancel_removed" } }),
    ).toMatchObject({ detail: { payer: "email" } });
  });

  it("lets the recorded payer take back a cancel another owner scheduled in Klorn", async () => {
    const { owner, orgId } = await ownedOrg("buyer");
    await webhook(checkoutEvent(orgId, "sub_seat_45", owner.userId));
    const heir = await addMember(orgId, "heir");
    await transferTo(owner, heir);
    await cancelInKlorn(heir, "sub_seat_45");
    await transferTo(heir, owner);
    const calls = stubPaddle({ customer: { email: "accounts@company.test" } });
    const res = await call(owner, "POST", "/api/orgs/current/subscription/resume");
    expect(res.statusCode).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
    expect(
      await prisma.orgAuditEvent.findFirst({ where: { orgId, action: "billing.cancel_removed" } }),
    ).toMatchObject({ actorUserId: owner.userId, detail: { payer: "recorded" } });
  });

  it("re-checks the recorded payer's Klorn-cancel basis under the lock", async () => {
    const { owner, orgId } = await ownedOrg("buyer");
    await webhook(checkoutEvent(orgId, "sub_seat_46", owner.userId));
    const heir = await addMember(orgId, "heir");
    await transferTo(owner, heir);
    await cancelInKlorn(heir, "sub_seat_46");
    await transferTo(heir, owner);
    // No stored date (a late event), so resume asks Paddle; meanwhile the
    // webhook forgets the Klorn cancel (removed, then re-made in the portal).
    await prisma.organization.update({
      where: { id: orgId },
      data: { subscriptionCancelAt: null },
    });
    const calls = stubPaddle({
      live: liveSubscription({
        id: "sub_seat_46",
        scheduled_change: { action: "cancel", effective_at: CANCEL_END },
      }),
      customer: { email: "accounts@company.test" },
      onCall: async (c) => {
        if (c.method !== "GET" || !c.url.includes("/subscriptions/")) return;
        await prisma.organization.update({
          where: { id: orgId },
          data: { cancelRequestedByUserId: null, cancelRequestedAt: null },
        });
      },
    });
    const res = await call(owner, "POST", "/api/orgs/current/subscription/resume");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "RESUME_PAYER_ONLY" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("does not take back a cancel on a subscription that was replaced after the payer check", async () => {
    const { owner, orgId } = await subscribedOrg("sub_seat_42", {
      scheduled_change: { action: "cancel", effective_at: "2026-12-14T00:00:00Z" },
    });
    // While the payer check reads Paddle, subscription 42 ends and 43 attaches.
    const calls = stubPaddle({
      customer: { email: owner.email },
      onCall: async (c) => {
        if (!c.url.includes("/customers/")) return;
        await prisma.organization.update({
          where: { id: orgId },
          data: { paddleSubscriptionId: "sub_seat_43" },
        });
      },
    });
    const res = await call(owner, "POST", "/api/orgs/current/subscription/resume");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NO_SUBSCRIPTION" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("clears the payer of an organization that loses its subscription id to drift", async () => {
    const first = await ownedOrg("first");
    await webhook(checkoutEvent(first.orgId, "sub_seat_44", first.owner.userId));
    expect(await payerOf(first.orgId)).toBe(first.owner.userId);
    const second = await ownedOrg("second");
    await webhook(checkoutEvent(second.orgId, "sub_seat_44", second.owner.userId));
    const lost = await prisma.organization.findUniqueOrThrow({ where: { id: first.orgId } });
    expect(lost).toMatchObject({ paddleSubscriptionId: null, payerUserId: null });
    expect(await payerOf(second.orgId)).toBe(second.owner.userId);
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
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
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

const CANCEL_END = "2026-12-14T00:00:00Z";
const CANCEL_END_ISO = "2026-12-14T00:00:00.000Z";

/** An event `ms` from now: webhooks carry Paddle's own occurred_at. */
function at(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function timedEvent(orgId: string, occurredAt: string, data: Record<string, unknown>) {
  return { ...teamEvent(orgId, data), occurred_at: occurredAt };
}

/** The owner schedules the period-end cancel through Klorn (nothing pending in Paddle). */
async function cancelInKlorn(owner: Session, subscriptionId: string): Promise<PaddleCall[]> {
  const calls = stubPaddle({
    live: liveSubscription({ id: subscriptionId }),
    answer: { scheduled_change: { action: "cancel", effective_at: CANCEL_END } },
  });
  const res = await call(owner, "POST", "/api/orgs/current/subscription/cancel");
  expect(res.statusCode).toBe(200);
  vi.unstubAllGlobals();
  return calls;
}

function orgRow(orgId: string) {
  return prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
}

/** An organization whose checkout recorded its owner as payer, attached with `quantity` seats. */
async function recordedPayerOrg(subscriptionId: string, quantity: number) {
  const { owner, orgId } = await ownedOrg("buyer");
  const attached = await webhook(
    checkoutEvent(orgId, subscriptionId, owner.userId, {
      items: [{ price: { id: "pri_team_month" }, quantity }],
    }),
  );
  expect(attached.statusCode).toBe(200);
  return { owner, orgId };
}

function liveWith(subscriptionId: string, quantity: number) {
  return liveSubscription({
    id: subscriptionId,
    items: [{ price: { id: "pri_team_month" }, quantity, status: "active" }],
  });
}

describePg("team resume: the owner who scheduled the cancel in Klorn (real Postgres)", () => {
  it("records who scheduled the cancel and when, and lets that owner take it back without being the payer", async () => {
    const { payer, heir, orgId } = await transferredOrg("sub_seat_50");
    const before = Date.now();
    const cancelCalls = await cancelInKlorn(heir, "sub_seat_50");
    expect(cancelCalls.map((c) => c.method)).toEqual(["GET", "POST"]);
    const scheduled = await orgRow(orgId);
    expect(scheduled.cancelRequestedByUserId).toBe(heir.userId);
    expect(scheduled.cancelRequestedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(before - 1_000);
    expect(scheduled.subscriptionCancelAt?.toISOString()).toBe(CANCEL_END_ISO);

    const calls = stubPaddle({ customer: { email: payer.email } });
    const res = await call(heir, "POST", "/api/orgs/current/subscription/resume");
    expect(res.statusCode).toBe(200);
    // No payer check: this owner takes back their own cancel.
    expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
    expect(await orgRow(orgId)).toMatchObject({
      subscriptionCancelAt: null,
      cancelRequestedByUserId: null,
      cancelRequestedAt: null,
    });
    expect(
      await prisma.orgAuditEvent.findFirst({ where: { orgId, action: "billing.cancel_removed" } }),
    ).toMatchObject({ actorUserId: heir.userId, detail: { via: "canceler" } });
  });

  it("forgets the canceler once Paddle reports the cancel removed, so a later portal cancel stays payer-only", async () => {
    const { heir, orgId } = await transferredOrg("sub_seat_51");
    await cancelInKlorn(heir, "sub_seat_51");
    // The payer takes it back in Paddle's portal, then cancels there.
    await webhook(timedEvent(orgId, at(60_000), { id: "sub_seat_51", scheduled_change: null }));
    expect((await orgRow(orgId)).cancelRequestedByUserId).toBeNull();
    await webhook(
      timedEvent(orgId, at(120_000), {
        id: "sub_seat_51",
        scheduled_change: { action: "cancel", effective_at: CANCEL_END },
      }),
    );
    const calls = stubPaddle({ customer: { email: "accounts@company.test" } });
    const res = await call(heir, "POST", "/api/orgs/current/subscription/resume");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "RESUME_PAYER_ONLY" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("forgets the canceler when the removal's event arrives after a newer one", async () => {
    const { heir, orgId } = await transferredOrg("sub_seat_52");
    await cancelInKlorn(heir, "sub_seat_52");
    // The portal re-cancel's event (newer) lands first; the removal's event
    // (older, but after the Klorn cancel) lands late and is stale for the rest.
    await webhook(
      timedEvent(orgId, at(120_000), {
        id: "sub_seat_52",
        scheduled_change: { action: "cancel", effective_at: CANCEL_END },
      }),
    );
    await webhook(timedEvent(orgId, at(60_000), { id: "sub_seat_52", scheduled_change: null }));
    const org = await orgRow(orgId);
    expect(org.cancelRequestedByUserId).toBeNull();
    expect(org.cancelRequestedAt).toBeNull();
    expect(org.subscriptionCancelAt?.toISOString()).toBe(CANCEL_END_ISO);
    const calls = stubPaddle({ customer: { email: "accounts@company.test" } });
    const res = await call(heir, "POST", "/api/orgs/current/subscription/resume");
    expect(res.json()).toMatchObject({ code: "RESUME_PAYER_ONLY" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("keeps the canceler through a late event from before the cancel", async () => {
    const { owner, orgId } = await ownedOrg("buyer");
    await webhook(timedEvent(orgId, at(-600_000), { id: "sub_seat_53" }));
    const heir = await addMember(orgId, "heir");
    await transferTo(owner, heir);
    await cancelInKlorn(heir, "sub_seat_53");
    // Newer than the last event applied, older than the cancel: applied, and
    // it clears the stored date, but says nothing about the Klorn cancel.
    await webhook(timedEvent(orgId, at(-300_000), { id: "sub_seat_53", scheduled_change: null }));
    const org = await orgRow(orgId);
    expect(org.subscriptionCancelAt).toBeNull();
    expect(org.cancelRequestedByUserId).toBe(heir.userId);

    const calls = stubPaddle({
      live: liveSubscription({
        id: "sub_seat_53",
        scheduled_change: { action: "cancel", effective_at: CANCEL_END },
      }),
      customer: { email: owner.email },
    });
    const res = await call(heir, "POST", "/api/orgs/current/subscription/resume");
    expect(res.statusCode).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
  });

  it("does not let a canceler who is no longer an owner take it back", async () => {
    const { payer, heir } = await transferredOrg("sub_seat_54");
    await cancelInKlorn(heir, "sub_seat_54");
    await transferTo(heir, payer);
    const calls = stubPaddle({});
    const res = await call(heir, "POST", "/api/orgs/current/subscription/resume");
    expect(res.json()).toMatchObject({ code: "OWNER_ONLY" });
    expect(calls).toEqual([]);
  });

  it("re-checks the canceler under the lock", async () => {
    const { heir, orgId } = await transferredOrg("sub_seat_55");
    await cancelInKlorn(heir, "sub_seat_55");
    // No stored date (a late event), so resume asks Paddle; meanwhile the
    // removal's webhook forgets the canceler.
    await prisma.organization.update({
      where: { id: orgId },
      data: { subscriptionCancelAt: null },
    });
    const calls = stubPaddle({
      live: liveSubscription({
        id: "sub_seat_55",
        scheduled_change: { action: "cancel", effective_at: CANCEL_END },
      }),
      onCall: async (c) => {
        if (!c.url.includes("/subscriptions/")) return;
        await prisma.organization.update({
          where: { id: orgId },
          data: { cancelRequestedByUserId: null, cancelRequestedAt: null },
        });
      },
    });
    const res = await call(heir, "POST", "/api/orgs/current/subscription/resume");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "RESUME_PAYER_ONLY" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("records no canceler and sends no cancel when Paddle already holds a portal cancel", async () => {
    const { heir, orgId } = await transferredOrg("sub_seat_56");
    const calls = stubPaddle({
      live: liveSubscription({
        id: "sub_seat_56",
        scheduled_change: { action: "cancel", effective_at: CANCEL_END },
      }),
      customer: { email: "accounts@company.test" },
    });
    const res = await call(heir, "POST", "/api/orgs/current/subscription/cancel");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cancelAt: CANCEL_END_ISO });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    const org = await orgRow(orgId);
    expect(org.subscriptionCancelAt?.toISOString()).toBe(CANCEL_END_ISO);
    expect(org.cancelRequestedByUserId).toBeNull();
    expect(
      await prisma.orgAuditEvent.count({ where: { orgId, action: "billing.cancel_scheduled" } }),
    ).toBe(0);

    const resume = await call(heir, "POST", "/api/orgs/current/subscription/resume");
    expect(resume.json()).toMatchObject({ code: "RESUME_PAYER_ONLY" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("forgets the canceler when the cancel takes effect", async () => {
    const { heir, orgId } = await transferredOrg("sub_seat_57");
    await cancelInKlorn(heir, "sub_seat_57");
    await webhook(
      timedEvent(orgId, at(60_000), {
        id: "sub_seat_57",
        status: "canceled",
        scheduled_change: null,
      }),
    );
    expect(await orgRow(orgId)).toMatchObject({
      paddleSubscriptionId: null,
      cancelRequestedByUserId: null,
      cancelRequestedAt: null,
      seatsAtAttach: null,
    });
  });

  it("keeps the canceler through a later event that does not mention the scheduled change", async () => {
    const { heir, orgId } = await transferredOrg("sub_seat_58");
    await cancelInKlorn(heir, "sub_seat_58");
    const silent = timedEvent(orgId, at(60_000), { id: "sub_seat_58" });
    delete (silent.data as { scheduled_change?: unknown }).scheduled_change;
    await webhook(silent);
    expect((await orgRow(orgId)).cancelRequestedByUserId).toBe(heir.userId);
  });

  it("forgets a stale canceler when a new subscription attaches", async () => {
    const { owner, orgId } = await ownedOrg("buyer");
    await prisma.organization.update({
      where: { id: orgId },
      data: { cancelRequestedByUserId: owner.userId, cancelRequestedAt: new Date() },
    });
    await webhook(timedEvent(orgId, at(0), { id: "sub_seat_59" }));
    expect(await orgRow(orgId)).toMatchObject({
      paddleSubscriptionId: "sub_seat_59",
      cancelRequestedByUserId: null,
      cancelRequestedAt: null,
    });
  });

  it("answers BILLING_PROVIDER_READ_FAILED and sends no cancel when the first Paddle read fails", async () => {
    const { heir, orgId } = await transferredOrg("sub_seat_68");
    const calls = stubPaddle({ fail: (c) => c.method === "GET" });
    const res = await call(heir, "POST", "/api/orgs/current/subscription/cancel");
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "BILLING_PROVIDER_READ_FAILED" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(await orgRow(orgId)).toMatchObject({
      subscriptionCancelAt: null,
      cancelRequestedByUserId: null,
    });
    expect(
      await prisma.orgAuditEvent.count({ where: { orgId, action: "billing.cancel_scheduled" } }),
    ).toBe(0);
  });
});

describePg("recorded-payer seat cap (real Postgres)", () => {
  it("stores the attach count once: later quantities do not move it, the end clears it", async () => {
    const { owner, orgId } = await recordedPayerOrg("sub_seat_60", 3);
    expect((await orgRow(orgId)).seatsAtAttach).toBe(3);
    await webhook(
      checkoutEvent(orgId, "sub_seat_60", owner.userId, {
        items: [{ price: { id: "pri_team_month" }, quantity: 9 }],
      }),
    );
    expect(await orgRow(orgId)).toMatchObject({ seatsPurchased: 9, seatsAtAttach: 3 });
    await webhook(checkoutEvent(orgId, "sub_seat_60", owner.userId, { status: "canceled" }));
    expect((await orgRow(orgId)).seatsAtAttach).toBeNull();
  });

  it("clears the attach count of an organization that loses its subscription id to drift", async () => {
    const first = await recordedPayerOrg("sub_seat_67", 4);
    await recordedPayerOrg("sub_seat_67", 6);
    expect((await orgRow(first.orgId)).seatsAtAttach).toBeNull();
  });

  it("lets the recorded payer add up to twice the attach count, and refuses past it without the paying email", async () => {
    const { owner, orgId } = await recordedPayerOrg("sub_seat_61", 3);
    const calls = stubPaddle({
      live: liveWith("sub_seat_61", 3),
      customer: { email: "accounts@company.test" },
    });
    const allowed = await call(owner, "POST", "/api/orgs/current/seats", { seats: 6 });
    expect(allowed.statusCode).toBe(202);
    // Within the cap: no email lookup.
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);

    const refused = await call(owner, "POST", "/api/orgs/current/seats", { seats: 7 });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "SEATS_INCREASE_CAPPED" });
    expect((refused.json() as { error: string }).error).toContain("at most 6 seats");
    expect(JSON.stringify(refused.json())).not.toContain("accounts@company.test");
    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH", "GET", "GET"]);
    const audit = await prisma.orgAuditEvent.findFirst({
      where: { orgId, action: "billing.seats_increase_refused" },
    });
    expect(audit).toMatchObject({
      actorUserId: owner.userId,
      detail: { from: 3, to: 7, cap: 6, reason: "recorded_payer_cap" },
    });
    expect(JSON.stringify(audit?.detail)).not.toContain("@");
  });

  it("caps each step at ten seats over Paddle's live count", async () => {
    const { owner } = await recordedPayerOrg("sub_seat_62", 12);
    const calls = stubPaddle({
      live: liveWith("sub_seat_62", 12),
      customer: { email: "accounts@company.test" },
    });
    const over = await call(owner, "POST", "/api/orgs/current/seats", { seats: 23 });
    expect(over.json()).toMatchObject({ code: "SEATS_INCREASE_CAPPED" });
    const step = await call(owner, "POST", "/api/orgs/current/seats", { seats: 22 });
    expect(step.statusCode).toBe(202);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("measures the step from Paddle's live count, not the stored one", async () => {
    const { owner } = await recordedPayerOrg("sub_seat_63", 20);
    // Paddle already bills 25 (an increase whose webhook is on its way).
    const calls = stubPaddle({
      live: liveWith("sub_seat_63", 25),
      customer: { email: "accounts@company.test" },
    });
    const over = await call(owner, "POST", "/api/orgs/current/seats", { seats: 36 });
    expect(over.json()).toMatchObject({ code: "SEATS_INCREASE_CAPPED" });
    const step = await call(owner, "POST", "/api/orgs/current/seats", { seats: 35 });
    expect(step.statusCode).toBe(202);
    expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
      items: [{ price_id: "pri_team_month", quantity: 35 }],
    });
  });

  it("lifts the cap when the recorded payer's verified email is also Paddle's", async () => {
    const { owner, orgId } = await recordedPayerOrg("sub_seat_64", 3);
    const calls = stubPaddle({
      live: liveWith("sub_seat_64", 3),
      customer: { email: owner.email },
    });
    const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 40 });
    expect(res.statusCode).toBe(202);
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
    expect(
      await prisma.orgAuditEvent.findFirst({
        where: { orgId, action: "billing.seats_change_requested" },
      }),
    ).toMatchObject({ detail: { from: 3, to: 40, payer: "email" } });
  });

  it("adds no seats on the recorded payer alone when the attach count is unknown, but removes them", async () => {
    const { owner, orgId } = await recordedPayerOrg("sub_seat_65", 5);
    await prisma.organization.update({ where: { id: orgId }, data: { seatsAtAttach: null } });
    const calls = stubPaddle({
      live: liveWith("sub_seat_65", 5),
      customer: { email: "accounts@company.test" },
    });
    const up = await call(owner, "POST", "/api/orgs/current/seats", { seats: 6 });
    expect(up.statusCode).toBe(403);
    expect(up.json()).toMatchObject({ code: "SEATS_INCREASE_CAPPED" });
    expect((up.json() as { error: string }).error).toContain("can't add seats now");
    const down = await call(owner, "POST", "/api/orgs/current/seats", { seats: 4 });
    expect(down.statusCode).toBe(202);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("answers 502 and changes nothing when the email lookup for a capped increase fails", async () => {
    const { owner, orgId } = await recordedPayerOrg("sub_seat_66", 3);
    const calls = stubPaddle({
      live: liveWith("sub_seat_66", 3),
      fail: (c) => c.url.includes("/customers/"),
    });
    const res = await call(owner, "POST", "/api/orgs/current/seats", { seats: 7 });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "BILLING_PROVIDER_READ_FAILED" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(
      await prisma.orgAuditEvent.count({
        where: { orgId, action: "billing.seats_increase_refused" },
      }),
    ).toBe(0);
  });
});

describePg("owner billing hint on GET /api/orgs/current (real Postgres)", () => {
  async function billingOf(session: Session) {
    const res = await call(session, "GET", "/api/orgs/current");
    expect(res.statusCode).toBe(200);
    return res;
  }

  it("tells the recorded payer whose email Paddle does not bill: payer, no portal, capped", async () => {
    const { owner } = await recordedPayerOrg("sub_seat_70", 3);
    stubPaddle({ customer: { email: "accounts@company.test" } });
    const res = await billingOf(owner);
    expect((res.json() as { me: { billing?: unknown } }).me.billing).toEqual({
      isPayer: true,
      portal: false,
      seatCap: 6,
      // A portal cancel takes the paying email to undo.
      canResume: false,
    });
    // The viewer's own standing only: no payer id, no Paddle email.
    expect(res.body).not.toContain(owner.userId);
    expect(res.body).not.toContain("accounts@company.test");
  });

  it("tells the owner whose verified email Paddle bills: payer, portal, no cap", async () => {
    const { owner } = await subscribedOrg("sub_seat_71");
    stubPaddle({ customer: { email: owner.email } });
    const res = await billingOf(owner);
    expect((res.json() as { me: { billing?: unknown } }).me.billing).toEqual({
      isPayer: true,
      portal: true,
      seatCap: null,
      canResume: true,
    });
  });

  it("tells an owner who does not pay, until they schedule a cancel in Klorn", async () => {
    const { payer, heir } = await transferredOrg("sub_seat_72");
    stubPaddle({ customer: { email: payer.email } });
    const before = await billingOf(heir);
    expect((before.json() as { me: { billing?: unknown } }).me.billing).toEqual({
      isPayer: false,
      portal: false,
      seatCap: null,
      canResume: false,
    });
    expect(before.body).not.toContain(payer.email);
    vi.unstubAllGlobals();
    await cancelInKlorn(heir, "sub_seat_72");
    stubPaddle({ customer: { email: payer.email } });
    const after = await billingOf(heir);
    expect((after.json() as { me: { billing?: { canResume: boolean } } }).me.billing).toMatchObject(
      { isPayer: false, canResume: true },
    );
  });

  it("adds nothing for a member, or without a subscription that bills", async () => {
    const { orgId } = await subscribedOrg("sub_seat_73");
    const member = await addMember(orgId);
    const none = await ownedOrg();
    const calls = stubPaddle({});
    const asMember = (await billingOf(member)).json() as { me: Record<string, unknown> };
    expect(asMember.me).not.toHaveProperty("billing");
    const asOwner = (await billingOf(none.owner)).json() as { me: Record<string, unknown> };
    expect(asOwner.me).not.toHaveProperty("billing");
    expect(calls).toEqual([]);
  });

  it("answers unknown, not false, when Paddle cannot be asked, and asks again only after a while", async () => {
    const { owner } = await subscribedOrg("sub_seat_74", { customer_id: "ctm_seat_74" });
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow);
    try {
      const failing = stubPaddle({ fail: () => true });
      const failed = (await billingOf(owner)).json() as { me: { billing?: unknown } };
      expect(failed.me.billing).toEqual({
        isPayer: null,
        portal: null,
        seatCap: null,
        canResume: null,
      });
      // A failure answers "unknown" for a short while without asking again.
      await billingOf(owner);
      expect(failing.filter((c) => c.url.includes("/customers/"))).toHaveLength(1);
      vi.unstubAllGlobals();

      clock.mockReturnValue(realNow + 31_000);
      const calls = stubPaddle({ customer: { email: owner.email } });
      const known = (await billingOf(owner)).json() as { me: { billing?: unknown } };
      expect(known.me.billing).toMatchObject({ isPayer: true, portal: true });
      await billingOf(owner);
      expect(calls.filter((c) => c.url.includes("/customers/"))).toHaveLength(1);

      // A good answer is remembered for two minutes, then asked again.
      clock.mockReturnValue(realNow + 31_000 + 121_000);
      await billingOf(owner);
      expect(calls.filter((c) => c.url.includes("/customers/"))).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("shares one Paddle read between concurrent page loads", async () => {
    const { owner } = await subscribedOrg("sub_seat_75", { customer_id: "ctm_seat_75" });
    const calls = stubPaddle({ customer: { email: owner.email } });
    const views = await Promise.all([billingOf(owner), billingOf(owner), billingOf(owner)]);
    for (const view of views) {
      expect((view.json() as { me: { billing?: unknown } }).me.billing).toMatchObject({
        isPayer: true,
      });
    }
    expect(calls.filter((c) => c.url.includes("/customers/"))).toHaveLength(1);
  });

  it("shows the recorded payer the cap while Paddle cannot confirm the email", async () => {
    const { owner } = await recordedPayerOrg("sub_seat_76", 3);
    stubPaddle({ fail: () => true });
    const res = (await billingOf(owner)).json() as { me: { billing?: unknown } };
    expect(res.me.billing).toEqual({ isPayer: true, portal: null, seatCap: 6, canResume: null });
  });

  it("keeps the page when the hint itself fails", async () => {
    const { owner } = await subscribedOrg("sub_seat_77", { customer_id: "ctm_seat_77" });
    stubPaddle({ customer: { email: owner.email } });
    const readOrg = vi
      .spyOn(prisma.organization, "findUniqueOrThrow")
      .mockRejectedValueOnce(new Error("db down"));
    try {
      const res = await billingOf(owner);
      const body = res.json() as { org: unknown; me: Record<string, unknown> };
      expect(body.org).toMatchObject({ seats: { status: "active" } });
      expect(body.me).not.toHaveProperty("billing");
      expect(captured.length).toBeGreaterThan(0);
    } finally {
      readOrg.mockRestore();
    }
  });
});
