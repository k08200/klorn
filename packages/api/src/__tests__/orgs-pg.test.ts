import { createHash, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of Klorn Teams v1 (routes/orgs.ts, src/org/): the
// organization lifecycle through the real routes and sessions, the invite
// token's security (hash stored, single use, expiry, bound to the invited
// address), the audit log, the free/busy grant and the seat entitlement that
// is derived at read time and never written to User.plan. Skipped unless
// KLORN_TEST_PG_URL points at a database with every migration applied.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

const sentInvites = vi.hoisted(() => [] as Array<{ to: string; token: string; orgName: string }>);
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../mail/email.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mail/email.js")>();
  return {
    ...actual,
    sendOrgInviteEmail: vi.fn(async (input: { to: string; token: string; orgName: string }) => {
      sentInvites.push(input);
      return true;
    }),
  };
});

import { registerDevice, signToken } from "../auth.js";
import { prisma } from "../db.js";
import { handleError } from "../error-handler.js";
import { orgCeilingsFor } from "../org/ceilings.js";
import { effectiveTier } from "../org/effective-tier.js";
import { registerApiRoutes } from "../register-api-routes.js";
import { deleteUserAndAllData } from "../user-deletion.js";

const describePg = url ? describe : describe.skip;
const createdUsers: string[] = [];
let app: FastifyInstance;

interface Session {
  userId: string;
  email: string;
  token: string;
}

async function newSession(label = "member"): Promise<Session> {
  const email = `${label}-${randomUUID()}@teams.test`;
  const user = await prisma.user.create({ data: { email, name: label } });
  createdUsers.push(user.id);
  const token = signToken({ userId: user.id, email });
  await registerDevice(user.id, token, { deviceType: "web" });
  return { userId: user.id, email, token };
}

function call(session: Session | null, method: string, path: string, payload?: unknown) {
  return app.inject({
    method: method as "GET",
    url: path,
    headers: session ? { authorization: `Bearer ${session.token}` } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function createOrg(owner: Session, name = "Acme") {
  const res = await call(owner, "POST", "/api/orgs", { name });
  expect(res.statusCode).toBe(201);
  return res.json() as { org: { id: string }; me: { membershipId: string; role: string } };
}

async function invite(owner: Session, email: string): Promise<string> {
  const before = sentInvites.length;
  const res = await call(owner, "POST", "/api/orgs/current/invites", { email });
  expect(res.statusCode).toBe(201);
  expect(sentInvites.length).toBe(before + 1);
  return sentInvites[sentInvites.length - 1]?.token ?? "";
}

async function join(owner: Session, member: Session, shareFreeBusy = false) {
  const token = await invite(owner, member.email);
  const res = await call(member, "POST", "/api/orgs/invites/accept", { token, shareFreeBusy });
  expect(res.statusCode).toBe(200);
  return res.json() as { me: { membershipId: string } };
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

describePg("Klorn Teams lifecycle (real Postgres)", () => {
  it("answers the default 404 on every org route while TEAMS_ENABLED is off", async () => {
    process.env.TEAMS_ENABLED = "false";
    const owner = await newSession("owner");
    for (const [method, path] of [
      ["GET", "/api/orgs/current"],
      ["POST", "/api/orgs"],
      ["POST", "/api/orgs/invites/accept"],
    ] as const) {
      const authed = await call(owner, method, path, method === "GET" ? undefined : {});
      expect(authed.statusCode).toBe(404);
      expect(authed.json()).toEqual({
        message: `Route ${method}:${path} not found`,
        error: "Not Found",
        statusCode: 404,
      });
      const anonymous = await call(null, method, path, method === "GET" ? undefined : {});
      expect(anonymous.statusCode).toBe(404);
    }
  });

  it("opens only to the cohort in cohort mode", async () => {
    const inCohort = await newSession("cohort");
    const outside = await newSession("outside");
    process.env.TEAMS_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = inCohort.userId;
    expect((await call(inCohort, "GET", "/api/orgs/current")).statusCode).toBe(200);
    expect((await call(outside, "GET", "/api/orgs/current")).statusCode).toBe(404);
  });

  it("creates an organization with the caller as its only OWNER, once", async () => {
    const owner = await newSession("owner");
    expect((await call(owner, "GET", "/api/orgs/current")).json()).toEqual({ org: null });
    const created = await createOrg(owner, "  Acme Corp  ");
    expect(created.me.role).toBe("OWNER");
    const row = await prisma.organization.findUniqueOrThrow({ where: { id: created.org.id } });
    expect(row.name).toBe("Acme Corp");
    expect(row.slug).toMatch(/^acme-corp-[0-9a-f]{6}$/);
    const again = await call(owner, "POST", "/api/orgs", { name: "Second" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "ALREADY_IN_ORG" });
    expect((await call(owner, "POST", "/api/orgs", { name: "   " })).statusCode).toBe(400);
  });

  it("stores only the invite token's hash, lowercases the address and audits the invite", async () => {
    const owner = await newSession("owner");
    const { org } = await createOrg(owner);
    const token = await invite(owner, "  New.Person@Teams.Test ");
    const row = await prisma.orgInvite.findFirstOrThrow({ where: { orgId: org.id } });
    expect(row.email).toBe("new.person@teams.test");
    expect(row.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(6 * 86_400_000);
    const audit = await prisma.orgAuditEvent.findMany({ where: { orgId: org.id } });
    expect(audit.map((event) => event.action)).toContain("invite.created");
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("joins the invited address as a MEMBER with free/busy NOT shared by default", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    const { org } = await createOrg(owner);
    const token = await invite(owner, member.email.toUpperCase());
    const preview = await call(member, "POST", "/api/orgs/invites/preview", { token });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ orgName: "Acme", emailMatches: true });
    const res = await call(member, "POST", "/api/orgs/invites/accept", { token });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ me: { role: "MEMBER", sharesFreeBusy: false } });
    const grant = await prisma.availabilityGrant.findUniqueOrThrow({
      where: { userId: member.userId },
    });
    expect(grant).toMatchObject({ orgId: org.id, scope: "NONE" });
    const actions = (await prisma.orgAuditEvent.findMany({ where: { orgId: org.id } })).map(
      (event) => event.action,
    );
    expect(actions).toContain("member.joined");
  });

  it("refuses a token a second time: single use", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    await createOrg(owner);
    const token = await invite(owner, member.email);
    expect((await call(member, "POST", "/api/orgs/invites/accept", { token })).statusCode).toBe(
      200,
    );
    await call(member, "POST", "/api/orgs/current/leave");
    const replay = await call(member, "POST", "/api/orgs/invites/accept", { token });
    expect(replay.statusCode).toBe(410);
    expect(replay.json()).toMatchObject({ code: "INVITE_USED" });
  });

  it("lets exactly one of two concurrent accepts of the same token through", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    const { org } = await createOrg(owner);
    const token = await invite(owner, member.email);
    const results = await Promise.all([
      call(member, "POST", "/api/orgs/invites/accept", { token }),
      call(member, "POST", "/api/orgs/invites/accept", { token }),
    ]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 410]);
    expect(await prisma.orgMembership.count({ where: { orgId: org.id } })).toBe(2);
  });

  it("binds the invite to its address: another signed-in account cannot use it", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    const intruder = await newSession("intruder");
    const { org } = await createOrg(owner);
    const token = await invite(owner, member.email);
    const res = await call(intruder, "POST", "/api/orgs/invites/accept", { token });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "INVITE_EMAIL_MISMATCH" });
    const preview = await call(intruder, "POST", "/api/orgs/invites/preview", { token });
    expect(preview.json()).toMatchObject({ emailMatches: false });
    expect(
      await prisma.orgMembership.findUnique({ where: { userId: intruder.userId } }),
    ).toBeNull();
    const row = await prisma.orgInvite.findFirstOrThrow({ where: { orgId: org.id } });
    expect(row.acceptedAt).toBeNull();
    // The rightful owner of the address can still accept it afterwards.
    expect((await call(member, "POST", "/api/orgs/invites/accept", { token })).statusCode).toBe(
      200,
    );
  });

  it("refuses an expired invite and a revoked one", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    const { org } = await createOrg(owner);
    const token = await invite(owner, member.email);
    await prisma.orgInvite.updateMany({
      where: { orgId: org.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await call(member, "POST", "/api/orgs/invites/accept", { token });
    expect(expired.statusCode).toBe(410);
    expect(expired.json()).toMatchObject({ code: "INVITE_EXPIRED" });

    const fresh = await invite(owner, member.email);
    const pending = await call(owner, "GET", "/api/orgs/current/invites");
    const inviteId = (pending.json() as { invites: Array<{ id: string }> }).invites[0]?.id;
    expect((await call(owner, "DELETE", `/api/orgs/current/invites/${inviteId}`)).statusCode).toBe(
      200,
    );
    const revoked = await call(member, "POST", "/api/orgs/invites/accept", { token: fresh });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.json()).toMatchObject({ code: "INVITE_INVALID" });
  });

  it("refuses a malformed or unknown token the same way", async () => {
    const member = await newSession("member");
    for (const token of ["", "not-a-token", "a".repeat(64), 42]) {
      const res = await call(member, "POST", "/api/orgs/invites/accept", { token });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: "INVITE_INVALID" });
    }
  });

  it("re-inviting an address revokes its earlier pending invite", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    await createOrg(owner);
    const first = await invite(owner, member.email);
    const second = await invite(owner, member.email);
    expect(
      (await call(member, "POST", "/api/orgs/invites/accept", { token: first })).statusCode,
    ).toBe(404);
    expect(
      (await call(member, "POST", "/api/orgs/invites/accept", { token: second })).statusCode,
    ).toBe(200);
  });

  it("lists members for everyone in the org, without user ids", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    await createOrg(owner);
    await join(owner, member);
    for (const viewer of [owner, member]) {
      const res = await call(viewer, "GET", "/api/orgs/current/members");
      expect(res.statusCode).toBe(200);
      const { members } = res.json() as { members: Array<Record<string, unknown>> };
      expect(members.map((m) => m.role).sort()).toEqual(["MEMBER", "OWNER"]);
      expect(JSON.stringify(members)).not.toContain(owner.userId);
      expect(JSON.stringify(members)).not.toContain(member.userId);
      expect(members.filter((m) => m.isYou)).toHaveLength(1);
    }
  });

  it("keeps every admin action to the OWNER", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    await createOrg(owner);
    const { me } = await join(owner, member);
    const ownerRow = await prisma.orgMembership.findUniqueOrThrow({
      where: { userId: owner.userId },
    });
    for (const [method, path, body] of [
      ["POST", "/api/orgs/current/invites", { email: "x@teams.test" }],
      ["GET", "/api/orgs/current/invites", undefined],
      ["DELETE", `/api/orgs/current/members/${ownerRow.id}`, undefined],
      ["POST", "/api/orgs/current/transfer", { membershipId: me.membershipId }],
      ["PATCH", "/api/orgs/current", { autoReplyDisabled: true }],
      ["GET", "/api/orgs/current/audit", undefined],
    ] as const) {
      const res = await call(member, method, path, body);
      expect(res.statusCode, `${method} ${path}`).toBe(403);
      expect(res.json()).toMatchObject({ code: "OWNER_ONLY" });
    }
  });

  it("removes a member and their grant, and audits it", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    const { org } = await createOrg(owner);
    const { me } = await join(owner, member, true);
    const res = await call(owner, "DELETE", `/api/orgs/current/members/${me.membershipId}`);
    expect(res.statusCode).toBe(200);
    expect(await prisma.orgMembership.findUnique({ where: { userId: member.userId } })).toBeNull();
    expect(
      await prisma.availabilityGrant.findUnique({ where: { userId: member.userId } }),
    ).toBeNull();
    const removed = await prisma.orgAuditEvent.findFirst({
      where: { orgId: org.id, action: "member.removed" },
    });
    expect(removed).toMatchObject({ actorUserId: owner.userId, targetUserId: member.userId });
    const self = await call(owner, "DELETE", `/api/orgs/current/members/${org.id}`);
    expect(self.statusCode).toBe(404);
  });

  it("lets a member leave, keeps the owner from leaving others behind, and transfers ownership", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    const other = await newSession("other");
    const { org } = await createOrg(owner);
    await join(owner, member);
    const { me: otherMe } = await join(owner, other);

    expect((await call(member, "POST", "/api/orgs/current/leave")).statusCode).toBe(200);
    expect(await prisma.orgMembership.findUnique({ where: { userId: member.userId } })).toBeNull();

    const stuck = await call(owner, "POST", "/api/orgs/current/leave");
    expect(stuck.statusCode).toBe(409);
    expect(stuck.json()).toMatchObject({ code: "OWNER_MUST_TRANSFER" });

    const moved = await call(owner, "POST", "/api/orgs/current/transfer", {
      membershipId: otherMe.membershipId,
    });
    expect(moved.statusCode).toBe(200);
    const roles = await prisma.orgMembership.findMany({ where: { orgId: org.id } });
    expect(roles.filter((m) => m.role === "OWNER").map((m) => m.userId)).toEqual([other.userId]);
    const actions = (await prisma.orgAuditEvent.findMany({ where: { orgId: org.id } })).map(
      (event) => event.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["member.left", "owner.transferred"]));
  });

  it("deletes the organization when its last member, the owner, leaves", async () => {
    const owner = await newSession("owner");
    const { org } = await createOrg(owner);
    const res = await call(owner, "POST", "/api/orgs/current/leave");
    expect(res.json()).toEqual({ left: true, orgDeleted: true });
    expect(await prisma.organization.findUnique({ where: { id: org.id } })).toBeNull();
  });

  it("sets the admin ceilings, which then apply to members server-side", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    const { org } = await createOrg(owner);
    await join(owner, member);
    const bad = await call(owner, "PATCH", "/api/orgs/current", { agentModeCap: "AUTO" });
    expect(bad.statusCode).toBe(400);
    const res = await call(owner, "PATCH", "/api/orgs/current", {
      autoReplyDisabled: true,
      agentModeCap: "SHADOW",
      companyDomains: ["@Acme.Test", "acme.test", "bad domain"],
    });
    expect(res.statusCode).toBe(400);
    const ok = await call(owner, "PATCH", "/api/orgs/current", {
      autoReplyDisabled: true,
      agentModeCap: "SHADOW",
      companyDomains: ["@Acme.Test", "acme.test"],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      org: { autoReplyDisabled: true, agentModeCap: "SHADOW", companyDomains: ["acme.test"] },
    });
    expect(await orgCeilingsFor(member.userId)).toEqual({
      autoReplyDisabled: true,
      agentModeCap: "SHADOW",
    });
    const changed = await prisma.orgAuditEvent.findFirst({
      where: { orgId: org.id, action: "settings.changed" },
    });
    expect(changed?.actorUserId).toBe(owner.userId);
  });

  it("derives a TEAM seat from membership and never writes User.plan", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    const { org } = await createOrg(owner);
    await join(owner, member);
    expect(await effectiveTier({ id: member.userId, plan: "FREE" })).toBe("FREE");
    await prisma.organization.update({
      where: { id: org.id },
      data: { seatsPurchased: 2, subscriptionStatus: "active" },
    });
    expect(await effectiveTier({ id: member.userId, plan: "FREE" })).toBe("TEAM");
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: member.userId } });
    expect(stored.plan).toBe("FREE");
    const res = await call(member, "GET", "/api/orgs/current");
    expect(res.json()).toMatchObject({
      org: { seats: { purchased: 2, used: 2, status: "active" } },
      me: { seated: true },
    });
    const me = await call(member, "GET", "/api/auth/me");
    expect(me.json()).toMatchObject({
      user: { plan: "FREE", effectiveTier: "TEAM", entitled: true, teams: true },
    });
  });

  it("promotes the longest-standing member when the owner deletes their account", async () => {
    const owner = await newSession("owner");
    const first = await newSession("first");
    const second = await newSession("second");
    const { org } = await createOrg(owner);
    await join(owner, first);
    await join(owner, second);
    await deleteUserAndAllData(owner.userId);
    const owners = await prisma.orgMembership.findMany({
      where: { orgId: org.id, role: "OWNER" },
    });
    expect(owners.map((m) => m.userId)).toEqual([first.userId]);
  });

  it("deletes an organization with no other member and no subscription with its owner's account", async () => {
    const owner = await newSession("owner");
    const { org } = await createOrg(owner);
    await deleteUserAndAllData(owner.userId);
    expect(await prisma.organization.findUnique({ where: { id: org.id } })).toBeNull();
  });
});

describePg("org free/busy (real Postgres)", () => {
  const windowStart = "2026-12-01T00:00:00.000Z";
  const windowEnd = "2026-12-03T00:00:00.000Z";
  const availabilityPath = `/api/orgs/current/availability?window_start=${windowStart}&window_end=${windowEnd}&duration_minutes=30`;

  async function busyDay(userId: string, title: string) {
    await prisma.calendarEvent.create({
      data: {
        userId,
        title,
        description: `${title} description`,
        location: `${title} room`,
        startTime: new Date("2026-12-01T09:00:00.000Z"),
        endTime: new Date("2026-12-01T17:00:00.000Z"),
      },
    });
  }

  it("treats a member who has not granted free/busy as unknown and reads nothing of theirs", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    const { org } = await createOrg(owner);
    await join(owner, member, false);
    await busyDay(member.userId, "Private board meeting");
    const res = await call(owner, "GET", availabilityPath);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ unknownMembers: [member.email], checkedMembers: [] });
    const reads = await prisma.orgAuditEvent.count({
      where: { orgId: org.id, action: "availability.read" },
    });
    expect(reads).toBe(0);
  });

  it("uses a granted member's busy times only, never titles, and audits each read", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    const { org } = await createOrg(owner);
    await join(owner, member, true);
    await busyDay(member.userId, "Private board meeting");
    const res = await call(owner, "GET", availabilityPath);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      checkedMembers: string[];
      unknownMembers: string[];
      slots: Array<{ startTime: string; endTime: string }>;
    };
    expect(body.checkedMembers).toEqual([member.email]);
    expect(body.unknownMembers).toEqual([]);
    const raw = res.body;
    expect(raw).not.toContain("Private board meeting");
    expect(raw).not.toContain("description");
    expect(raw).not.toContain("room");
    for (const slot of body.slots) {
      const start = Date.parse(slot.startTime);
      const end = Date.parse(slot.endTime);
      const overlapsBusy =
        start < Date.parse("2026-12-01T17:00:00.000Z") &&
        end > Date.parse("2026-12-01T09:00:00.000Z");
      expect(overlapsBusy).toBe(false);
    }
    const read = await prisma.orgAuditEvent.findFirstOrThrow({
      where: { orgId: org.id, action: "availability.read" },
    });
    expect(read).toMatchObject({ actorUserId: owner.userId, targetUserId: member.userId });
    expect(read.detail).toMatchObject({ windowStart, windowEnd });
  });

  it("stops sharing on the next query once the member revokes the grant", async () => {
    const owner = await newSession("owner");
    const member = await newSession("member");
    await createOrg(owner);
    await join(owner, member, true);
    const revoke = await call(member, "PUT", "/api/orgs/current/availability-grant", {
      shareFreeBusy: false,
    });
    expect(revoke.json()).toEqual({ sharesFreeBusy: false });
    const res = await call(owner, "GET", availabilityPath);
    expect(res.json()).toMatchObject({ unknownMembers: [member.email], checkedMembers: [] });
  });

  it("never reads a member of a different organization", async () => {
    const ownerA = await newSession("ownerA");
    const ownerB = await newSession("ownerB");
    const memberB = await newSession("memberB");
    await createOrg(ownerA, "A");
    await createOrg(ownerB, "B");
    await join(ownerB, memberB, true);
    await busyDay(memberB.userId, "Other company");
    const res = await call(
      ownerA,
      "GET",
      `${availabilityPath}&members=${encodeURIComponent(memberB.email)}`,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "NOT_A_MEMBER" });
  });
});
