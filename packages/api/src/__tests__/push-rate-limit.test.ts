import { beforeEach, describe, expect, it, vi } from "vitest";
import { PUSH_WINDOW_10MIN_MS } from "../config.js";
import type { PushBucket } from "../notify/push-bucket.js";

// DB-backed limiter: PushRingEvent rows are the source of truth so caps
// survive process restarts (Render deploys) and horizontal scaling. Each
// bucket counts only its own rows. The mock tells the two windows apart by the
// `gte` cutoff each count uses, and the two buckets apart by `where.bucket`.
const NOW = new Date("2026-06-12T12:00:00.000Z");

type Counts = { in10: number; in60: number };
const state = {
  counts: {
    interrupt: { in10: 0, in60: 0 },
    ambient: { in10: 0, in60: 0 },
  } as Record<PushBucket, Counts>,
  countError: null as Error | null,
};
interface CountWhere {
  userId: string;
  bucket?: PushBucket;
  createdAt: { gte: Date };
}
const countWheres: CountWhere[] = [];
const createCalls: Array<{ userId: string; bucket?: PushBucket }> = [];
const deleteCalls: Array<{ userId: string; bucket?: PushBucket; lt: Date }> = [];

vi.mock("../db.js", () => ({
  prisma: {
    pushRingEvent: {
      count: vi.fn(async (args: { where: CountWhere }) => {
        if (state.countError) throw state.countError;
        countWheres.push(args.where);
        // A count with no bucket filter sees every row, as the shared cap did.
        const buckets: PushBucket[] = args.where.bucket
          ? [args.where.bucket]
          : ["interrupt", "ambient"];
        const isTenMinWindow =
          args.where.createdAt.gte.getTime() === NOW.getTime() - PUSH_WINDOW_10MIN_MS;
        return buckets.reduce(
          (sum, b) => sum + (isTenMinWindow ? state.counts[b].in10 : state.counts[b].in60),
          0,
        );
      }),
      create: vi.fn(async (args: { data: { userId: string; bucket?: PushBucket } }) => {
        createCalls.push({ userId: args.data.userId, bucket: args.data.bucket });
        return { id: "ring-1" };
      }),
      deleteMany: vi.fn(
        async (args: {
          where: { userId: string; bucket?: PushBucket; createdAt: { lt: Date } };
        }) => {
          deleteCalls.push({
            userId: args.where.userId,
            bucket: args.where.bucket,
            lt: args.where.createdAt.lt,
          });
          return { count: 0 };
        },
      ),
    },
  },
}));

async function loadLimiter() {
  return await import("../notify/push-rate-limit.js");
}

const BUCKETS: PushBucket[] = ["interrupt", "ambient"];

describe("push-rate-limit (DB-backed, two buckets)", () => {
  beforeEach(() => {
    state.counts = { interrupt: { in10: 0, in60: 0 }, ambient: { in10: 0, in60: 0 } };
    state.countError = null;
    countWheres.length = 0;
    createCalls.length = 0;
    deleteCalls.length = 0;
  });

  it("keeps today's ambient caps and gives interrupts their own, wider caps", async () => {
    const { PUSH_BUCKET_CAPS } = await loadLimiter();
    expect(PUSH_BUCKET_CAPS).toEqual({
      ambient: { per10Min: 3, per60Min: 6 },
      interrupt: { per10Min: 6, per60Min: 20 },
    });
  });

  it.each(BUCKETS)("allows a %s push under both caps and records its bucket", async (bucket) => {
    const { recordPushAttempt } = await loadLimiter();
    const result = await recordPushAttempt("user-a", bucket, NOW);
    expect(result.allowed).toBe(true);
    expect(createCalls).toEqual([{ userId: "user-a", bucket }]);
  });

  it.each(BUCKETS)("blocks a %s push at its 10-minute cap without recording", async (bucket) => {
    const { PUSH_BUCKET_CAPS, recordPushAttempt } = await loadLimiter();
    const cap = PUSH_BUCKET_CAPS[bucket].per10Min;
    state.counts[bucket] = { in10: cap, in60: cap };
    const result = await recordPushAttempt("user-a", bucket, NOW);
    expect(result).toEqual({ allowed: false, reason: `10min cap ${cap}/${cap}` });
    expect(createCalls).toHaveLength(0);
  });

  it.each(BUCKETS)("allows a %s push one under its 10-minute cap", async (bucket) => {
    const { PUSH_BUCKET_CAPS, recordPushAttempt } = await loadLimiter();
    const cap = PUSH_BUCKET_CAPS[bucket].per10Min;
    state.counts[bucket] = { in10: cap - 1, in60: cap - 1 };
    const result = await recordPushAttempt("user-a", bucket, NOW);
    expect(result.allowed).toBe(true);
  });

  it.each(
    BUCKETS,
  )("blocks a %s push at its 60-minute cap even when the 10-minute window is clear", async (bucket) => {
    const { PUSH_BUCKET_CAPS, recordPushAttempt } = await loadLimiter();
    const cap = PUSH_BUCKET_CAPS[bucket].per60Min;
    state.counts[bucket] = { in10: 0, in60: cap };
    const result = await recordPushAttempt("user-a", bucket, NOW);
    expect(result).toEqual({ allowed: false, reason: `60min cap ${cap}/${cap}` });
    expect(createCalls).toHaveLength(0);
  });

  it("an interrupt is allowed past the ambient cap (4 urgent in 10 minutes)", async () => {
    const { recordPushAttempt } = await loadLimiter();
    state.counts.interrupt = { in10: 3, in60: 3 };
    const result = await recordPushAttempt("user-a", "interrupt", NOW);
    expect(result.allowed).toBe(true);
  });

  it("a full ambient bucket never blocks an interrupt", async () => {
    const { PUSH_BUCKET_CAPS, recordPushAttempt } = await loadLimiter();
    state.counts.ambient = {
      in10: PUSH_BUCKET_CAPS.ambient.per60Min * 10,
      in60: PUSH_BUCKET_CAPS.ambient.per60Min * 10,
    };
    const result = await recordPushAttempt("user-a", "interrupt", NOW);
    expect(result.allowed).toBe(true);
  });

  it("a full interrupt bucket never blocks an ambient push", async () => {
    const { PUSH_BUCKET_CAPS, recordPushAttempt } = await loadLimiter();
    state.counts.interrupt = {
      in10: PUSH_BUCKET_CAPS.interrupt.per60Min,
      in60: PUSH_BUCKET_CAPS.interrupt.per60Min,
    };
    const result = await recordPushAttempt("user-a", "ambient", NOW);
    expect(result.allowed).toBe(true);
  });

  it.each(BUCKETS)("scopes both %s window counts to the user and the bucket", async (bucket) => {
    const { recordPushAttempt } = await loadLimiter();
    await recordPushAttempt("user-a", bucket, NOW);
    expect(countWheres).toHaveLength(2);
    for (const where of countWheres) {
      expect(where.userId).toBe("user-a");
      expect(where.bucket).toBe(bucket);
    }
  });

  it("prunes every bucket's rows older than the shared 60-minute window", async () => {
    const { PUSH_WINDOW_60MIN_MS, recordPushAttempt } = await loadLimiter();
    await recordPushAttempt("user-a", "interrupt", NOW);
    expect(deleteCalls).toEqual([
      { userId: "user-a", bucket: undefined, lt: new Date(NOW.getTime() - PUSH_WINDOW_60MIN_MS) },
    ]);
  });

  it.each(
    BUCKETS,
  )("fails open for a %s push when the DB is unreachable (push must not die with the limiter)", async (bucket) => {
    const { recordPushAttempt } = await loadLimiter();
    state.countError = new Error("connection refused");
    const result = await recordPushAttempt("user-a", bucket, NOW);
    expect(result.allowed).toBe(true);
    expect(createCalls).toHaveLength(0);
  });
});
