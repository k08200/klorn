import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it, vi } from "vitest";

// Real-Postgres proof of the scheduler lease's SQL (scheduler-lease-store.ts,
// migration 20261111010000_scheduler_lease): one atomic statement decides who
// holds the lease, so it does not matter which pooled backend runs the acquire,
// the renewal or the release. The session advisory locks it replaces leaked in
// production for exactly that reason; the first test reproduces the leak.
// Skipped unless KLORN_TEST_PG_URL points at a database with every migration
// applied. Set DATABASE_URL to the same URL as well (CI does): db.ts reads it
// when the prisma client is created, which can happen before this file runs.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { prisma } from "../db.js";
import { createPrismaLeaseStore, type LeaseDb, type LeaseStore } from "../scheduler-lease-store.js";

const describePg = url ? describe : describe.skip;
const TTL_MS = 60_000;
const names: string[] = [];
const clients: PrismaClient[] = [];

/** A client with exactly one connection: one Postgres backend, like one pooled server connection. */
function singleBackend(): PrismaClient {
  const sep = url?.includes("?") ? "&" : "?";
  const client = new PrismaClient({
    datasources: { db: { url: `${url}${sep}connection_limit=1` } },
  });
  clients.push(client);
  return client;
}

function storeOn(client: LeaseDb): LeaseStore {
  return createPrismaLeaseStore((fn) => fn(client));
}

function leaseName(): string {
  const name = `test-${randomUUID()}`;
  names.push(name);
  return name;
}

async function backendPid(client: PrismaClient): Promise<number> {
  const rows = await client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  return rows[0].pid;
}

async function expire(name: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "SchedulerLease" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second'
    WHERE "name" = ${name}`;
}

/**
 * Runs `inside` on `client` in a transaction that stays open (row locks held)
 * until `hold` resolves; resolves `ready` once `inside` has run.
 */
function openTransaction(client: PrismaClient, inside: (store: LeaseStore) => Promise<unknown>) {
  let ready: () => void = () => {};
  let release: () => void = () => {};
  const isReady = new Promise<void>((r) => {
    ready = r;
  });
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const done = client.$transaction(
    async (tx) => {
      const result = await inside(createPrismaLeaseStore((fn) => fn(tx)));
      ready();
      await hold;
      return result;
    },
    { timeout: 20_000 },
  );
  return { isReady, commit: release, done };
}

describePg("scheduler lease (Postgres)", () => {
  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "SchedulerLease" WHERE "name" = ANY(${names})`;
    await Promise.all(clients.map((client) => client.$disconnect()));
    await prisma.$disconnect();
  });

  it("control: a session advisory lock released from another backend stays held", async () => {
    const [locker, unlocker, other] = [singleBackend(), singleBackend(), singleBackend()];
    expect(new Set(await Promise.all([locker, unlocker, other].map(backendPid))).size).toBe(3);
    const key = Math.floor(Math.random() * 1_000_000_000);
    const lock = (client: PrismaClient) =>
      client.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(${key}::int) AS ok`;

    expect((await lock(locker))[0].ok).toBe(true);
    const unlocked = await unlocker.$queryRaw<{ ok: boolean }[]>`
      SELECT pg_advisory_unlock(${key}::int) AS ok`;
    expect(unlocked[0].ok).toBe(false);
    expect((await lock(other))[0].ok).toBe(false);

    await locker.$queryRaw`SELECT pg_advisory_unlock(${key}::int)`;
  });

  it("a lease taken on one backend and released on another is free again", async () => {
    const name = leaseName();
    const [a, b, c] = [singleBackend(), singleBackend(), singleBackend()];

    expect((await storeOn(a).acquire(name, "instance-a", TTL_MS)).acquired).toBe(true);
    expect(await storeOn(b).renew(name, "instance-a", TTL_MS)).toBe(true);
    expect(await storeOn(c).release(name, "instance-a")).toBe(true);

    expect(await storeOn(a).acquire(name, "instance-b", TTL_MS)).toEqual({
      acquired: true,
      tookOverFrom: null,
    });
  });

  it("exactly one of many concurrent acquirers wins, round after round", async () => {
    const backends = [singleBackend(), singleBackend(), singleBackend(), singleBackend()];
    await Promise.all(backends.map((client) => client.$connect()));

    for (let round = 0; round < 10; round++) {
      const name = leaseName();
      if (round % 2 === 1) {
        // Odd rounds race for an expired row rather than an absent one.
        await storeOn(prisma).acquire(name, "dead-instance", TTL_MS);
        await expire(name);
      }
      const results = await Promise.all(
        backends.map((client, i) => storeOn(client).acquire(name, `instance-${i}`, TTL_MS)),
      );
      expect(results.filter((r) => r.acquired)).toHaveLength(1);
      const winner = results.findIndex((r) => r.acquired);
      for (const loser of results.filter((r) => !r.acquired)) {
        expect(loser).toMatchObject({ acquired: false, holderId: `instance-${winner}` });
      }
    }
  });

  it("a takeover racing an uncommitted takeover of the same expired row loses", async () => {
    const name = leaseName();
    await storeOn(prisma).acquire(name, "dead-instance", TTL_MS);
    await expire(name);
    const first = openTransaction(singleBackend(), (store) =>
      store.acquire(name, "instance-a", TTL_MS),
    );
    await first.isReady;

    const second = storeOn(singleBackend()).acquire(name, "instance-b", TTL_MS);
    await new Promise((resolve) => setTimeout(resolve, 300));
    first.commit();

    expect((await first.done) as { acquired: boolean }).toMatchObject({ acquired: true });
    expect(await second).toMatchObject({ acquired: false, holderId: "instance-a" });
  });

  it("an acquire waiting on a concurrent release takes the lease without calling it a takeover", async () => {
    const name = leaseName();
    await storeOn(prisma).acquire(name, "instance-a", TTL_MS);
    const releasing = openTransaction(singleBackend(), (store) =>
      store.release(name, "instance-a"),
    );
    await releasing.isReady;

    const acquiring = storeOn(singleBackend()).acquire(name, "instance-b", TTL_MS);
    await new Promise((resolve) => setTimeout(resolve, 300));
    releasing.commit();

    expect(await releasing.done).toBe(true);
    expect(await acquiring).toEqual({ acquired: true, tookOverFrom: null });
  });

  it("a held lease refuses others and reports its holder and expiry", async () => {
    const name = leaseName();
    const store = storeOn(prisma);
    await store.acquire(name, "instance-a", TTL_MS);

    const refused = await store.acquire(name, "instance-b", TTL_MS);

    expect(refused.acquired).toBe(false);
    if (refused.acquired) return;
    expect(refused.holderId).toBe("instance-a");
    expect(refused.expiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("the holder re-takes its own lease without a takeover", async () => {
    const name = leaseName();
    const store = storeOn(prisma);
    await store.acquire(name, "instance-a", TTL_MS);

    expect(await store.acquire(name, "instance-a", TTL_MS)).toEqual({
      acquired: true,
      tookOverFrom: null,
    });
  });

  it("an expired lease (its release never ran) is taken over, naming its holder and expiry", async () => {
    const name = leaseName();
    const store = storeOn(prisma);
    await store.acquire(name, "dead-instance", TTL_MS);
    await expire(name);
    const [{ expiresAt }] = await prisma.$queryRaw<{ expiresAt: Date }[]>`
      SELECT "expiresAt" FROM "SchedulerLease" WHERE "name" = ${name}`;

    const taken = await store.acquire(name, "instance-b", TTL_MS);

    expect(taken).toEqual({
      acquired: true,
      tookOverFrom: { holderId: "dead-instance", expiresAt },
    });
    expect(await store.renew(name, "dead-instance", TTL_MS)).toBe(false);
    expect(await store.release(name, "dead-instance")).toBe(false);
  });

  it("only the holder renews or releases", async () => {
    const name = leaseName();
    const store = storeOn(prisma);
    await store.acquire(name, "instance-a", 5_000);

    expect(await store.renew(name, "instance-b", TTL_MS)).toBe(false);
    expect(await store.release(name, "instance-b")).toBe(false);
    expect(await store.renew(name, "instance-a", TTL_MS)).toBe(true);

    const rows = await prisma.$queryRaw<{ holderId: string; expiresAt: Date }[]>`
      SELECT "holderId", "expiresAt" FROM "SchedulerLease" WHERE "name" = ${name}`;
    expect(rows[0].holderId).toBe("instance-a");
    expect(rows[0].expiresAt.getTime() - Date.now()).toBeGreaterThan(TTL_MS - 10_000);
  });

  it("times the lease in UTC whatever the session time zone", async () => {
    const name = leaseName();
    const inZone = (zone: string) =>
      createPrismaLeaseStore((fn) =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('TimeZone', ${zone}, true)`;
          return fn(tx);
        }),
      );
    await inZone("Asia/Seoul").acquire(name, "instance-a", TTL_MS);

    const rows = await prisma.$queryRaw<{ expiresAt: Date }[]>`
      SELECT "expiresAt" FROM "SchedulerLease" WHERE "name" = ${name}`;
    const remaining = rows[0].expiresAt.getTime() - Date.now();
    expect(remaining).toBeGreaterThan(TTL_MS - 10_000);
    expect(remaining).toBeLessThan(TTL_MS + 10_000);
    expect((await inZone("America/Los_Angeles").acquire(name, "instance-b", TTL_MS)).acquired).toBe(
      false,
    );

    await expire(name);
    const taken = await inZone("Asia/Seoul").acquire(name, "instance-b", TTL_MS);
    expect(taken.acquired && taken.tookOverFrom?.holderId).toBe("instance-a");
    expect(await inZone("Pacific/Auckland").renew(name, "instance-b", TTL_MS)).toBe(true);
    expect(await inZone("America/Los_Angeles").release(name, "instance-b")).toBe(true);
  });

  it("under a role that RLS binds, the table opens only to the system scope", async () => {
    const name = leaseName();
    const role = `lease_probe_${randomUUID().replace(/-/g, "")}`;
    await prisma.$executeRawUnsafe(`CREATE ROLE ${role} NOLOGIN`);
    await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON "SchedulerLease" TO ${role}`);
    const asRole = (bypass: boolean) =>
      createPrismaLeaseStore((fn) =>
        prisma.$transaction(async (tx) => {
          if (bypass) await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
          return fn(tx);
        }),
      );
    try {
      await expect(asRole(false).acquire(name, "instance-a", TTL_MS)).rejects.toThrow(
        /row-level security/,
      );
      expect((await asRole(true).acquire(name, "instance-a", TTL_MS)).acquired).toBe(true);
      expect(await asRole(true).renew(name, "instance-a", TTL_MS)).toBe(true);
      expect(await asRole(true).release(name, "instance-a")).toBe(true);
    } finally {
      await prisma.$executeRawUnsafe(`REVOKE ALL ON "SchedulerLease" FROM ${role}`);
      await prisma.$executeRawUnsafe(`DROP ROLE ${role}`);
    }
  });

  it("the default store reaches the table through the system scope", async () => {
    const name = leaseName();
    const store = createPrismaLeaseStore();

    expect((await store.acquire(name, "instance-a", TTL_MS)).acquired).toBe(true);
    expect(await store.renew(name, "instance-a", TTL_MS)).toBe(true);
    expect(await store.release(name, "instance-a")).toBe(true);
  });
});
