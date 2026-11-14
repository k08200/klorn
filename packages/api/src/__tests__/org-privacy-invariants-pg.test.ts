import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Klorn Teams privacy invariants (docs/design/team-mode-v3.md, "Not doing" in
// docs/design/pricing-tiers.md): no organization role — OWNER or MEMBER — can
// read another member's mail, attention items or commitments, through the org
// routes or through any mail route. Real Postgres, the real route table and
// real sessions; each member holds mail, an attention item, a commitment and a
// calendar event marked with a unique string, and no other member's response
// may ever carry it. Skipped unless KLORN_TEST_PG_URL is set.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

const sentInvites = vi.hoisted(() => [] as Array<{ token: string }>);
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../mail/email.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mail/email.js")>();
  return {
    ...actual,
    sendOrgInviteEmail: vi.fn(async (input: { token: string }) => {
      sentInvites.push(input);
      return true;
    }),
  };
});

import { registerDevice, signToken } from "../auth.js";
import { prisma } from "../db.js";
import { handleError } from "../error-handler.js";
import { registerApiRoutes } from "../register-api-routes.js";

const describePg = url ? describe : describe.skip;
const createdUsers: string[] = [];
let app: FastifyInstance;

interface Seeded {
  userId: string;
  email: string;
  token: string;
  secret: string;
  emailId: string;
  attentionId: string;
  commitmentId: string;
}

async function seededSession(label: string): Promise<Seeded> {
  const email = `${label}-${randomUUID()}@privacy.test`;
  const user = await prisma.user.create({ data: { email, name: label, emailVerified: true } });
  createdUsers.push(user.id);
  const token = signToken({ userId: user.id, email });
  await registerDevice(user.id, token, { deviceType: "web" });
  const secret = `SECRET-${label}-${randomUUID()}`;
  const mail = await prisma.emailMessage.create({
    data: {
      userId: user.id,
      gmailId: `g-${randomUUID()}`,
      from: `Partner <partner-${secret}@external.test>`,
      to: email,
      subject: `${secret} subject`,
      body: `${secret} body`,
      snippet: `${secret} snippet`,
      receivedAt: new Date(),
    },
  });
  const attention = await prisma.attentionItem.create({
    data: {
      userId: user.id,
      source: "EMAIL",
      sourceId: mail.id,
      type: "REPLY_NEEDED",
      title: `${secret} attention`,
      body: `${secret} attention body`,
      tier: "PUSH",
    },
  });
  const commitment = await prisma.commitment.create({
    data: { userId: user.id, title: `${secret} commitment`, description: `${secret} detail` },
  });
  await prisma.calendarEvent.create({
    data: {
      userId: user.id,
      title: `${secret} event`,
      startTime: new Date("2026-12-01T09:00:00.000Z"),
      endTime: new Date("2026-12-01T10:00:00.000Z"),
    },
  });
  return {
    userId: user.id,
    email,
    token,
    secret,
    emailId: mail.id,
    attentionId: attention.id,
    commitmentId: commitment.id,
  };
}

function call(who: Seeded, method: string, path: string, payload?: unknown) {
  return app.inject({
    method: method as "GET",
    url: path,
    headers: { authorization: `Bearer ${who.token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

let owner: Seeded;
let member: Seeded;

beforeAll(async () => {
  if (!url) return;
  process.env.TEAMS_ENABLED = "true";
  app = Fastify();
  app.setErrorHandler(handleError);
  await registerApiRoutes(app);
  await app.ready();

  owner = await seededSession("owner");
  member = await seededSession("member");
  expect((await call(owner, "POST", "/api/orgs", { name: "Privacy Co" })).statusCode).toBe(201);
  expect(
    (await call(owner, "POST", "/api/orgs/current/invites", { email: member.email })).statusCode,
  ).toBe(201);
  const token = sentInvites[sentInvites.length - 1]?.token;
  const accepted = await call(member, "POST", "/api/orgs/invites/accept", {
    token,
    shareFreeBusy: true,
  });
  expect(accepted.statusCode).toBe(200);
  // Both directions share free/busy, so the availability read is exercised.
  await call(owner, "PUT", "/api/orgs/current/availability-grant", { shareFreeBusy: true });
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

const ORG_READS = [
  "/api/orgs/current",
  "/api/orgs/current/members",
  "/api/orgs/current/invites",
  "/api/orgs/current/audit",
  "/api/orgs/current/transparency",
  "/api/orgs/current/availability?window_start=2026-12-01T00:00:00.000Z&window_end=2026-12-02T00:00:00.000Z",
];

describePg("no org role reads another member's mail, attention items or commitments", () => {
  for (const [viewerName, otherName] of [
    ["owner", "member"],
    ["member", "owner"],
  ] as const) {
    describe(`${viewerName} → ${otherName}`, () => {
      const pair = () => ({
        viewer: viewerName === "owner" ? owner : member,
        other: otherName === "owner" ? owner : member,
      });

      it("finds nothing of the other member in any org route", async () => {
        const { viewer, other } = pair();
        for (const path of ORG_READS) {
          // The owner-only reads answer a member 403; everything else answers.
          const ownerOnly = path.endsWith("/invites") || path.endsWith("/audit");
          const res = await call(viewer, "GET", path);
          expect(res.statusCode, path).toBe(ownerOnly && viewerName === "member" ? 403 : 200);
          expect(res.body, path).not.toContain(other.secret);
          expect(res.body, path).not.toContain(viewer.secret);
          if (path.includes("/availability")) {
            // The read did use the other member's calendar — as busy times only.
            expect(res.json()).toMatchObject({ checkedMembers: [other.email] });
          }
        }
      });

      it("cannot open the other member's mail by id", async () => {
        const { viewer, other } = pair();
        const res = await call(viewer, "GET", `/api/email/${other.emailId}`);
        expect(res.body).not.toContain(other.secret);
        expect(res.json()).toMatchObject({ error: "Email not found" });
      });

      it("cannot open the other member's commitment by id", async () => {
        const { viewer, other } = pair();
        const res = await call(viewer, "GET", `/api/commitments/${other.commitmentId}`);
        expect([403, 404]).toContain(res.statusCode);
        expect(res.body).not.toContain(other.secret);
      });

      it("sees only their own rows in mail, commitment and attention lists", async () => {
        const { viewer, other } = pair();
        // A list that answered with an error would pass the check vacuously:
        // each must answer, and the stored lists carry the viewer's own rows.
        // GET /api/email serves Gmail (a demo list without a Google grant).
        for (const [path, holdsOwnRows] of [
          ["/api/commitments", true],
          // Its top 3 never lists EMAIL-source items, so it carries no own row here.
          ["/api/inbox/summary", false],
          ["/api/email", false],
        ] as const) {
          const res = await call(viewer, "GET", path);
          expect(res.statusCode, path).toBe(200);
          if (holdsOwnRows) expect(res.body, path).toContain(viewer.secret);
          expect(res.body, path).not.toContain(other.secret);
        }
      });

      it("cannot read the attention item of the other member's mail", async () => {
        const { viewer, other } = pair();
        process.env.MAIL_V2 = "true";
        try {
          const own = await call(viewer, "GET", `/api/email/${viewer.emailId}/reader-context`);
          expect(own.statusCode).toBe(200);
          expect(own.json()).toMatchObject({ tier: "PUSH" });
          const res = await call(viewer, "GET", `/api/email/${other.emailId}/reader-context`);
          expect(res.statusCode).toBe(404);
          expect(res.body).not.toContain(other.secret);
        } finally {
          delete process.env.MAIL_V2;
        }
      });

      it("exports only their own data", async () => {
        const { viewer, other } = pair();
        const res = await call(viewer, "GET", "/api/user/me/export");
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain(other.secret);
        expect(res.body).toContain(viewer.secret);
      });
    });
  }

  it("leaves the other member's rows owned by them alone", async () => {
    for (const who of [owner, member]) {
      const mail = await prisma.emailMessage.findUniqueOrThrow({ where: { id: who.emailId } });
      const item = await prisma.attentionItem.findUniqueOrThrow({ where: { id: who.attentionId } });
      const promise = await prisma.commitment.findUniqueOrThrow({
        where: { id: who.commitmentId },
      });
      expect([mail.userId, item.userId, promise.userId]).toEqual([
        who.userId,
        who.userId,
        who.userId,
      ]);
    }
  });

  it("states in the transparency view that mail, attention items and commitments are never visible", async () => {
    const res = await call(member, "GET", "/api/orgs/current/transparency");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { neverVisible: string[]; visibleToOrg: Array<{ key: string }> };
    expect(body.neverVisible).toEqual(
      expect.arrayContaining(["mail", "attentionItems", "commitments", "eventDetails"]),
    );
    expect(body.visibleToOrg.map((entry) => entry.key)).not.toContain("mail");
  });
});
