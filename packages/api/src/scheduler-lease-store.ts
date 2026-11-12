/**
 * The SQL behind the scheduler lease (scheduler-lease.ts): one row per
 * scheduler in "SchedulerLease", and one atomic statement per acquire, renewal
 * and release. Each statement names its holder, so none of them depends on
 * which pooled backend runs it.
 *
 * Time is the database clock (`clock_timestamp()`, the statement's own time
 * even inside a transaction) converted to UTC, because the columns are
 * timestamp without time zone written in UTC and a pooler may drop the
 * session's TimeZone setting (db-url.ts). Instances with skewed clocks agree.
 *
 * The table has no owning user, so the default scope is withSystem.
 */

import type { PrismaClient } from "@prisma/client";
import { withSystem } from "./db-tenant.js";

/** Largest TTL the statements accept: the TTL is bound as a Postgres int. */
export const MAX_LEASE_TTL_MS = 2_147_483_647;

export type LeaseAcquireResult =
  | { acquired: true; tookOverFrom: { holderId: string; expiresAt: Date } | null }
  | { acquired: false; holderId: string | null; expiresAt: Date | null };

export interface LeaseStore {
  /** Take the lease if it is free, expired, or already this holder's. */
  acquire(name: string, holderId: string, ttlMs: number): Promise<LeaseAcquireResult>;
  /** Extend the lease; false when this holder no longer has it. */
  renew(name: string, holderId: string, ttlMs: number): Promise<boolean>;
  /** Free the lease; false when this holder no longer has it. */
  release(name: string, holderId: string): Promise<boolean>;
}

export type LeaseDb = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;
export type LeaseRunner = <T>(fn: (db: LeaseDb) => Promise<T>) => Promise<T>;

const systemScope: LeaseRunner = (fn) => withSystem(fn);

interface AcquireRow {
  priorHolderId: string | null;
  priorExpiresAt: Date | null;
  priorExpired: boolean | null;
}

export function assertLeaseTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_LEASE_TTL_MS) {
    throw new RangeError(`scheduler lease TTL must be a positive int of ms, got ${ttlMs}`);
  }
}

/**
 * The SQL store. `run` picks the connection scope; the default is withSystem.
 *
 * Acquire is one INSERT ... ON CONFLICT DO UPDATE ... WHERE: Postgres rechecks
 * the WHERE against the latest committed row, so of any number of concurrent
 * acquirers exactly one gets a row back. The "prior" CTE reads the row as the
 * statement's snapshot saw it, only to say whose expired lease was taken over.
 * Under a race that snapshot can be stale (a holder released it meanwhile), so
 * a takeover is reported only when the prior row had expired by the statement's
 * clock; the decision itself never reads "prior".
 */
export function createPrismaLeaseStore(run: LeaseRunner = systemScope): LeaseStore {
  return {
    async acquire(name, holderId, ttlMs) {
      assertLeaseTtl(ttlMs);
      const rows = await run(
        (db) =>
          db.$queryRaw<AcquireRow[]>`
          WITH prior AS (
            SELECT "holderId", "expiresAt" FROM "SchedulerLease" WHERE "name" = ${name}
          ), clock AS (
            SELECT clock_timestamp() AT TIME ZONE 'UTC' AS t
          )
          INSERT INTO "SchedulerLease" AS lease ("name", "holderId", "acquiredAt", "expiresAt", "updatedAt")
          SELECT ${name}, ${holderId}, clock.t, clock.t + ${ttlMs}::int * interval '1 millisecond', clock.t
          FROM clock
          ON CONFLICT ("name") DO UPDATE SET
            "holderId" = EXCLUDED."holderId",
            "acquiredAt" = EXCLUDED."acquiredAt",
            "expiresAt" = EXCLUDED."expiresAt",
            "updatedAt" = EXCLUDED."updatedAt"
          WHERE lease."holderId" IS NULL
             OR lease."holderId" = EXCLUDED."holderId"
             OR lease."expiresAt" <= EXCLUDED."updatedAt"
          RETURNING (SELECT "holderId" FROM prior) AS "priorHolderId",
                    (SELECT "expiresAt" FROM prior) AS "priorExpiresAt",
                    (SELECT prior."expiresAt" <= clock.t FROM prior, clock) AS "priorExpired"`,
      );
      if (rows.length > 0) {
        const { priorHolderId, priorExpiresAt, priorExpired } = rows[0];
        const tookOver =
          priorHolderId !== null && priorHolderId !== holderId && priorExpired === true;
        return {
          acquired: true,
          tookOverFrom:
            tookOver && priorExpiresAt
              ? { holderId: priorHolderId, expiresAt: priorExpiresAt }
              : null,
        };
      }
      const held = await run(
        (db) =>
          db.$queryRaw<{ holderId: string | null; expiresAt: Date }[]>`
          SELECT "holderId", "expiresAt" FROM "SchedulerLease" WHERE "name" = ${name}`,
      );
      return {
        acquired: false,
        holderId: held[0]?.holderId ?? null,
        expiresAt: held[0]?.expiresAt ?? null,
      };
    },

    async renew(name, holderId, ttlMs) {
      assertLeaseTtl(ttlMs);
      const count = await run(
        (db) =>
          db.$executeRaw`
          UPDATE "SchedulerLease"
          SET "expiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + ${ttlMs}::int * interval '1 millisecond',
              "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
          WHERE "name" = ${name} AND "holderId" = ${holderId}`,
      );
      return count > 0;
    },

    async release(name, holderId) {
      const count = await run(
        (db) =>
          db.$executeRaw`
          UPDATE "SchedulerLease"
          SET "holderId" = NULL,
              "expiresAt" = clock_timestamp() AT TIME ZONE 'UTC',
              "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
          WHERE "name" = ${name} AND "holderId" = ${holderId}`,
      );
      return count > 0;
    },
  };
}
