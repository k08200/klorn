import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the two push rate buckets (notify/push-rate-limit.ts
// and migration 20261107010000_push_ring_event_bucket): the counts filter on
// the real "bucket" column, rows written without one land in "ambient", and the
// prune spans both buckets. Skipped unless KLORN_TEST_PG_URL points at a
// database with every migration applied; DATABASE_URL is set to the same URL
// because setup.ts loads db.ts first.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import { PUSH_WINDOW_60MIN_MS, recordPushAttempt } from "../notify/push-rate-limit.js";

const describePg = url ? describe : describe.skip;
const created: string[] = [];
// The limiter counts from `now` but the row takes the database's now(), so the
// test clock must be the real one.
const NOW = new Date();
const MINUTE_MS = 60 * 1000;

async function newUser(): Promise<string> {
  const user = await prisma.user.create({ data: { email: `ring-${randomUUID()}@test.local` } });
  created.push(user.id);
  return user.id;
}

async function attempts(userId: string, bucket: "interrupt" | "ambient", n: number) {
  const allowed: boolean[] = [];
  for (let i = 0; i < n; i++) allowed.push((await recordPushAttempt(userId, bucket, NOW)).allowed);
  return allowed;
}

describePg("push rate buckets (Postgres)", () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  });

  it("10 ambient attempts leave the interrupt bucket untouched", async () => {
    const userId = await newUser();

    const ambient = await attempts(userId, "ambient", 10);
    const interrupt = await recordPushAttempt(userId, "interrupt", NOW);

    expect(ambient.filter(Boolean)).toHaveLength(3);
    expect(interrupt.allowed).toBe(true);
    const rows = await prisma.pushRingEvent.groupBy({
      by: ["bucket"],
      where: { userId },
      _count: { _all: true },
    });
    expect(Object.fromEntries(rows.map((r) => [r.bucket, r._count._all]))).toEqual({
      ambient: 3,
      interrupt: 1,
    });
  });

  it("the interrupt bucket caps at 6 per 10 minutes and leaves ambient open", async () => {
    const userId = await newUser();

    const interrupt = await attempts(userId, "interrupt", 7);
    const ambient = await recordPushAttempt(userId, "ambient", NOW);

    expect(interrupt).toEqual([true, true, true, true, true, true, false]);
    expect(ambient.allowed).toBe(true);
  });

  it("a row written without a bucket counts as ambient", async () => {
    const userId = await newUser();
    await prisma.pushRingEvent.createMany({
      data: [1, 2, 3].map(() => ({ userId, createdAt: new Date(NOW.getTime() - MINUTE_MS) })),
    });

    expect((await recordPushAttempt(userId, "ambient", NOW)).allowed).toBe(false);
    expect((await recordPushAttempt(userId, "interrupt", NOW)).allowed).toBe(true);
  });

  it("an allowed attempt prunes both buckets' rows past the 60-minute window", async () => {
    const userId = await newUser();
    const stale = new Date(NOW.getTime() - PUSH_WINDOW_60MIN_MS - MINUTE_MS);
    await prisma.pushRingEvent.createMany({
      data: [
        { userId, bucket: "interrupt", createdAt: stale },
        { userId, bucket: "ambient", createdAt: stale },
      ],
    });

    await recordPushAttempt(userId, "interrupt", NOW);

    const left = await prisma.pushRingEvent.findMany({ where: { userId } });
    expect(left.map((r) => r.bucket)).toEqual(["interrupt"]);
    expect(left[0]?.createdAt.getTime()).toBeGreaterThan(stale.getTime());
  });
});
