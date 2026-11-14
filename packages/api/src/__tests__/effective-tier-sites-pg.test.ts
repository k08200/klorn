import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the Klorn Teams v1.1 effective-plan wiring: the batch
// resolver the schedulers use, the seated roster the cost pool sums, the
// pooled daily cap against the real cost ledger, and the "a team seat already
// covers your Pro" signal on /me and /api/billing/status. Skipped unless
// KLORN_TEST_PG_URL points at a database with every migration applied.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { registerDevice, signToken } from "../auth.js";
import { checkCostGate } from "../billing/cost-guard.js";
import { __resetTeamPoolCacheForTest } from "../billing/team-cost-pool.js";
import { prisma } from "../db.js";
import { handleError } from "../error-handler.js";
import { effectivePlans, heldTeamSeat } from "../org/effective-tier.js";
import { registerApiRoutes } from "../register-api-routes.js";

const describePg = url ? describe : describe.skip;
const createdUsers: string[] = [];
let app: FastifyInstance;

interface Session {
  userId: string;
  token: string;
}

async function newUser(plan: "FREE" | "PRO" = "FREE"): Promise<Session> {
  const email = `tier-${randomUUID()}@teams.test`;
  const user = await prisma.user.create({ data: { email, name: "t", emailVerified: true, plan } });
  createdUsers.push(user.id);
  const token = signToken({ userId: user.id, email });
  await registerDevice(user.id, token, { deviceType: "web" });
  return { userId: user.id, token };
}

/** An organization billing `seats` seats; members join in the order given (first = owner). */
async function orgWith(members: Session[], seats: number, status = "active") {
  const org = await prisma.organization.create({
    data: {
      name: "Acme",
      slug: `acme-${randomUUID().slice(0, 8)}`,
      seatsPurchased: seats,
      subscriptionStatus: status,
    },
  });
  for (const [i, member] of members.entries()) {
    await prisma.orgMembership.create({
      data: {
        orgId: org.id,
        userId: member.userId,
        role: i === 0 ? "OWNER" : "MEMBER",
        joinedAt: new Date(Date.UTC(2026, 10, 1 + i)),
      },
    });
  }
  return org;
}

function get(session: Session, path: string) {
  return app.inject({
    method: "GET",
    url: path,
    headers: { authorization: `Bearer ${session.token}` },
  });
}

beforeAll(async () => {
  if (!url) return;
  app = Fastify();
  app.setErrorHandler(handleError);
  await registerApiRoutes(app);
  await app.ready();
});

beforeEach(() => {
  process.env.TEAMS_ENABLED = "true";
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  __resetTeamPoolCacheForTest();
});

afterAll(async () => {
  if (!url) return;
  delete process.env.TEAMS_ENABLED;
  await app.close();
  await prisma.organization.deleteMany({
    where: { memberships: { some: { userId: { in: createdUsers } } } },
  });
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describePg("effective plan wiring (real Postgres)", () => {
  it("resolves a batch in two queries' worth of real rows", async () => {
    const owner = await newUser();
    const seatedMember = await newUser("PRO");
    const unseated = await newUser();
    const lapsedOwner = await newUser();
    const loner = await newUser();
    await orgWith([owner, seatedMember, unseated], 2);
    await orgWith([lapsedOwner], 2, "past_due");
    const plans = await effectivePlans(
      [owner, seatedMember, unseated, lapsedOwner, loner].map((s) => ({
        id: s.userId,
        plan: s === seatedMember ? "PRO" : "FREE",
      })),
    );
    expect(plans.get(owner.userId)).toBe("TEAM");
    expect(plans.get(seatedMember.userId)).toBe("TEAM");
    expect(plans.get(unseated.userId)).toBe("FREE");
    expect(plans.get(lapsedOwner.userId)).toBe("FREE");
    expect(plans.get(loner.userId)).toBe("FREE");

    delete process.env.TEAMS_ENABLED;
    const off = await effectivePlans([{ id: owner.userId, plan: "FREE" }]);
    expect(off.get(owner.userId)).toBe("FREE");
  });

  it("names the seated roster and pools today's cost across it", async () => {
    const owner = await newUser();
    const me = await newUser();
    const unseated = await newUser();
    const org = await orgWith([owner, me, unseated], 2);
    expect(await heldTeamSeat(me.userId)).toEqual({
      orgId: org.id,
      seatsPurchased: 2,
      seatedUserIds: [owner.userId, me.userId],
    });
    expect(await heldTeamSeat(unseated.userId)).toBeNull();

    const dayKey = new Date().toISOString().slice(0, 10);
    await prisma.llmCostLedger.create({ data: { userId: owner.userId, dayKey, cents: 30 } });
    // An unseated member's spend is their own plan's, not the pool's.
    await prisma.llmCostLedger.create({ data: { userId: unseated.userId, dayKey, cents: 999 } });
    const result = await checkCostGate(me.userId);
    // pool 2 x 80 = 160 - the owner's 30 = 130, above the 100¢ own-plan cap.
    expect(result.capCents).toBe(130);
    expect(result.freeCapApplied).toBe(false);
  });

  it("tells a Pro subscriber with a seat that the seat already covers Pro", async () => {
    const owner = await newUser();
    const pro = await newUser("PRO");
    await orgWith([owner, pro], 2);

    const me = await get(pro, "/api/auth/me");
    expect(me.json()).toMatchObject({
      user: { plan: "PRO", effectiveTier: "TEAM", teamSeatCoversPersonalPlan: true },
    });
    const status = await get(pro, "/api/billing/status");
    expect(status.json()).toMatchObject({
      plan: "PRO",
      planName: "Team",
      teamSeatCoversPersonalPlan: true,
    });
    const ownerMe = await get(owner, "/api/auth/me");
    expect(ownerMe.json()).toMatchObject({
      user: { plan: "FREE", effectiveTier: "TEAM", teamSeatCoversPersonalPlan: false },
    });

    // A cancel already scheduled: nothing to point out.
    await prisma.user.update({
      where: { id: pro.userId },
      data: { subscriptionCancelAt: new Date(Date.now() + 86_400_000) },
    });
    const scheduled = await get(pro, "/api/billing/status");
    expect(scheduled.json()).toMatchObject({ teamSeatCoversPersonalPlan: false });

    // Flag off: exactly the pre-seat answer.
    await prisma.user.update({ where: { id: pro.userId }, data: { subscriptionCancelAt: null } });
    delete process.env.TEAMS_ENABLED;
    const off = await get(pro, "/api/billing/status");
    expect(off.json()).toMatchObject({
      plan: "PRO",
      planName: "Pro",
      teamSeatCoversPersonalPlan: false,
    });
    const offMe = await get(pro, "/api/auth/me");
    expect(offMe.json()).toMatchObject({
      user: { plan: "PRO", effectiveTier: "PRO", teamSeatCoversPersonalPlan: false },
    });
  });
});
