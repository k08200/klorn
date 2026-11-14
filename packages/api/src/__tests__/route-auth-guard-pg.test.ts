import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the route-auth guard on a route that used to accept a
// bare JWT signature (GET /api/briefing/status). Real Device rows and the real
// session epoch: a logout deletes the row, a password reset stamps
// sessionsInvalidatedAt — after either, the same unexpired token must stop
// working. Skipped unless KLORN_TEST_PG_URL points at a database with every
// migration applied; DATABASE_URL is set to the same URL because setup.ts
// loads db.ts before this file runs.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { registerDevice, removeDeviceSession, signToken } from "../auth.js";
import { prisma } from "../db.js";
import { handleError } from "../error-handler.js";
import { registerApiRoutes } from "../register-api-routes.js";

const describePg = url ? describe : describe.skip;
const created: string[] = [];
let app: FastifyInstance;

async function newSession(): Promise<{ userId: string; token: string }> {
  const user = await prisma.user.create({ data: { email: `guard-${randomUUID()}@test.local` } });
  created.push(user.id);
  const token = signToken({ userId: user.id, email: user.email });
  await registerDevice(user.id, token, { deviceType: "web" });
  return { userId: user.id, token };
}

function briefingStatus(token: string) {
  return app.inject({
    method: "GET",
    url: "/api/briefing/status",
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  if (!url) return;
  app = Fastify();
  app.setErrorHandler(handleError);
  await registerApiRoutes(app);
  await app.ready();
});

afterAll(async () => {
  if (!url) return;
  await app.close();
  await prisma.user.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describePg("route-auth guard against real sessions", () => {
  it("serves a live session", async () => {
    const { token } = await newSession();
    const res = await briefingStatus(token);
    expect(res.statusCode).toBe(200);
  });

  it("rejects the same unexpired token after logout deleted its Device row", async () => {
    const { token } = await newSession();
    expect((await briefingStatus(token)).statusCode).toBe(200);
    await removeDeviceSession(token);
    const res = await briefingStatus(token);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "DEVICE_KICKED" });
  });

  it("rejects a token issued before a password reset revoked every session", async () => {
    const { userId, token } = await newSession();
    expect((await briefingStatus(token)).statusCode).toBe(200);
    await prisma.user.update({
      where: { id: userId },
      data: { sessionsInvalidatedAt: new Date(Date.now() + 2000) },
    });
    const res = await briefingStatus(token);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "DEVICE_KICKED" });
  });

  it("answers 401, not 500, with no token at all", async () => {
    const res = await app.inject({ method: "GET", url: "/api/briefing/status" });
    expect(res.statusCode).toBe(401);
  });
});
