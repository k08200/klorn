import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Klorn Teams: the organization's company domains reach a member's judge as
// one boolean, through the real relationship loader and real Postgres. The
// organization holds other members (names, addresses) and a name of its own;
// none of it, nor the domain list itself, may appear in what the judge gets.
// Skipped unless KLORN_TEST_PG_URL is set.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import { laneFromFactsV3 } from "../judge/v3/policy.js";
import type { FactsV1 } from "../judge/v3/policy-types.js";
import { loadRelationshipSnapshot } from "../judge/v3/relationship-loader.js";

const describePg = url ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const COMPANY = `corp-${tag}.example`;
const createdUsers: string[] = [];
let orgId = "";
let owner = { id: "", email: "" };
const secrets: string[] = [];

const FACTS: FactsV1 = {
  asks: [],
  addressedTo: "me_direct",
  threadTurn: "none",
  event: null,
  transaction: null,
  risk: [],
  kind: "work_thread",
  ambiguous: false,
};

async function user(label: string, email: string) {
  const name = `Name-${label}-${tag}`;
  const created = await prisma.user.create({
    data: { email, name, emailVerified: true },
    select: { id: true, email: true },
  });
  createdUsers.push(created.id);
  secrets.push(email, name);
  return created;
}

describePg("org company domain fact (real Postgres)", () => {
  const saved = { flag: process.env.TEAMS_ENABLED };

  beforeAll(async () => {
    owner = await user("owner", `owner-${tag}@personal-${tag}.example`);
    const b = await user("b", `member-b-${tag}@${COMPANY}`);
    const c = await user("c", `member-c-${tag}@elsewhere-${tag}.example`);
    const orgName = `Org-${tag}`;
    const created = await prisma.organization.create({
      data: { name: orgName, slug: `org-${tag}`, companyDomains: [COMPANY, `alt-${tag}.example`] },
      select: { id: true },
    });
    orgId = created.id;
    secrets.push(orgName, `org-${tag}`, COMPANY, `alt-${tag}.example`);
    await prisma.orgMembership.createMany({
      data: [
        { orgId, userId: owner.id, role: "OWNER" },
        { orgId, userId: b.id, role: "MEMBER" },
        { orgId, userId: c.id, role: "MEMBER" },
      ],
    });
  });

  afterEach(() => {
    if (saved.flag === undefined) delete process.env.TEAMS_ENABLED;
    else process.env.TEAMS_ENABLED = saved.flag;
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await prisma.$disconnect();
  });

  const load = () =>
    loadRelationshipSnapshot({
      userId: owner.id,
      senderAddress: `Kim <kim@${COMPANY}>`,
      userAddresses: [owner.email],
      senderAuthenticated: true,
    });

  it("flag off: the snapshot carries no org fact", async () => {
    delete process.env.TEAMS_ENABLED;
    const snapshot = await load();
    expect(Object.keys(snapshot)).not.toContain("orgCompanyDomain");
    expect(snapshot.sameOrgDomain).toBe(false);
  });

  it("flag on: one boolean, and nothing about the organization or its members", async () => {
    process.env.TEAMS_ENABLED = "true";
    const on = await load();
    expect(on.orgCompanyDomain).toBe(true);
    delete process.env.TEAMS_ENABLED;
    const off = await load();
    const { orgCompanyDomain: _fact, ...rest } = on;
    expect(rest).toEqual(off);

    process.env.TEAMS_ENABLED = "true";
    const decision = laneFromFactsV3({
      facts: FACTS,
      relationship: on,
      decidedAt: new Date(),
      senderAuthenticated: true,
    });
    const judged = JSON.stringify({ snapshot: on, decision });
    for (const secret of secrets) expect(judged).not.toContain(secret);
    expect(judged).not.toContain(orgId);
  });
});
