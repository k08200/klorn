/**
 * The KakaoTalk orphan sweep (kakao-import/commitments.ts
 * sweepOrphanKakaoCommitments) runs every 10 minutes whatever
 * KAKAO_IMPORT_ENABLED says. Its first query groups the Kakao commitments of
 * every user by thread. Commitment's other indexes all lead with userId, so
 * without one on (sourceType, threadId) that query read the whole table, every
 * user's mail commitments included, on every run.
 *
 * Planner check against real Postgres: with sequential scans priced out, the
 * sweep's filter must be answered by an index condition on sourceType, not by
 * a filter over every row.
 */

import { describe, expect, it, vi } from "vitest";

const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

import { prisma } from "../db.js";

const describePg = url ? describe : describe.skip;

/** The WHERE of the sweep's groupBy, as Prisma sends it. */
const SWEEP_QUERY = `
  SELECT "userId", "threadId" FROM "Commitment"
  WHERE "sourceType" = CAST('KAKAO'::text AS "CommitmentSource")
    AND "threadId"::text LIKE 'kakao-import:%'
  GROUP BY "userId", "threadId"`;

describePg("the Kakao orphan sweep's commitment scan", () => {
  it("is an index lookup on sourceType, not a pass over every commitment", async () => {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`EXPLAIN ${SWEEP_QUERY}`);
    });
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/Index Cond: .*"sourceType"/);
    expect(text).not.toContain('Seq Scan on "Commitment"');
  });
});
