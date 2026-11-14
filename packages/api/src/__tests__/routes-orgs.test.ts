/**
 * /api/orgs gating and error shape (Klorn Teams v1). The behaviour behind each
 * route is proven against real Postgres in orgs-pg.test.ts; this file pins the
 * HTTP layer without a database: dark while TEAMS_ENABLED is off (Fastify's
 * default 404, even unauthenticated), cohort-only in cohort mode, and a
 * service refusal answered as `{ error, code }` with its status.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ userId: "user-1", authed: true }));
vi.mock("../auth.js", () => ({
  requireAuth: async (
    _request: unknown,
    reply: { code(n: number): { send(b: unknown): void } },
  ) => {
    if (!auth.authed) reply.code(401).send({ error: "Authentication required" });
  },
  getUserId: () => auth.userId,
}));

const service = vi.hoisted(() => ({
  currentOrgView: vi.fn(async () => ({ org: null })),
  acceptInvite: vi.fn(),
}));
vi.mock("../org/org-members.js", () => ({
  createOrganization: vi.fn(),
  currentOrgView: service.currentOrgView,
  listAudit: vi.fn(),
  listMembers: vi.fn(),
  requireMembership: vi.fn(),
  setAvailabilityGrant: vi.fn(),
  updateOrganization: vi.fn(),
}));
vi.mock("../org/org-membership-changes.js", () => ({
  leaveOrganization: vi.fn(),
  removeMember: vi.fn(),
  transferOwnership: vi.fn(),
}));
vi.mock("../org/org-invites.js", () => ({
  acceptInvite: service.acceptInvite,
  inviteMember: vi.fn(),
  listInvites: vi.fn(),
  previewInvite: vi.fn(),
  revokeInvite: vi.fn(),
}));
vi.mock("../org/org-availability.js", () => ({ orgAvailabilityMembers: vi.fn() }));
vi.mock("../org/transparency.js", () => ({ transparencyFor: vi.fn() }));
vi.mock("../pim/team-availability.js", () => ({ getTeamAvailability: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { OrgError } from "../org/org-error.js";
import { orgRoutes } from "../routes/orgs.js";

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  auth.userId = "user-1";
  auth.authed = true;
  delete process.env.TEAMS_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  app = Fastify();
  await app.register(orgRoutes, { prefix: "/api/orgs" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  delete process.env.TEAMS_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

describe("/api/orgs gating", () => {
  it("answers Fastify's default 404 while TEAMS_ENABLED is off, before authentication", async () => {
    auth.authed = false;
    const res = await app.inject({ method: "GET", url: "/api/orgs/current" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      message: "Route GET:/api/orgs/current not found",
      error: "Not Found",
      statusCode: 404,
    });
    expect(service.currentOrgView).not.toHaveBeenCalled();
  });

  it("serves a signed-in user once the flag is on, and requires a session", async () => {
    process.env.TEAMS_ENABLED = "true";
    expect((await app.inject({ method: "GET", url: "/api/orgs/current" })).json()).toEqual({
      org: null,
    });
    auth.authed = false;
    expect((await app.inject({ method: "GET", url: "/api/orgs/current" })).statusCode).toBe(401);
  });

  it("lets only the cohort in when the flag is in cohort mode", async () => {
    process.env.TEAMS_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "user-2";
    expect((await app.inject({ method: "GET", url: "/api/orgs/current" })).statusCode).toBe(404);
    auth.userId = "user-2";
    expect((await app.inject({ method: "GET", url: "/api/orgs/current" })).statusCode).toBe(200);
  });
});

describe("/api/orgs error shape", () => {
  it("answers a service refusal with its status and stable code", async () => {
    process.env.TEAMS_ENABLED = "true";
    service.acceptInvite.mockRejectedValueOnce(
      new OrgError(403, "INVITE_EMAIL_MISMATCH", "This invite was sent to a different address."),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/orgs/invites/accept",
      payload: { token: "a".repeat(64) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: "This invite was sent to a different address.",
      code: "INVITE_EMAIL_MISMATCH",
    });
  });

  it("keeps an unexpected failure's internals out of the response", async () => {
    process.env.TEAMS_ENABLED = "true";
    service.currentOrgView.mockRejectedValueOnce(new Error('relation "Organization" missing'));
    const res = await app.inject({ method: "GET", url: "/api/orgs/current" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("Organization");
  });
});
