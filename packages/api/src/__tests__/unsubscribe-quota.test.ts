/**
 * Auto-unsubscribe caps (security review 2026-08-27). The mocks behave like
 * the conditional writes they stand for — the user row's day/count and the
 * shared counter's upsert — so removing a guard from the implementation
 * fails a test instead of passing by default.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Where = Record<string, unknown>;
type Data = Record<string, unknown>;

const state = vi.hoisted(() => ({
  users: new Map<string, { day: string | null; count: number }>(),
  shared: new Map<string, { day: string; count: number }>(),
  sql: [] as string[],
}));

function userUpdateMany({ where, data }: { where: Where; data: Data }) {
  const row = state.users.get(where.id as string) ?? { day: null, count: 0 };
  state.users.set(where.id as string, row);
  if (Array.isArray(where.OR)) {
    // Rolls over only a null or OLDER day (ISO dates sort as strings).
    const olderThan = (where.OR as Array<{ autoUnsubscribeDay: { lt?: string } | null }>)[1]
      .autoUnsubscribeDay as { lt: string };
    if (row.day !== null && !(row.day < olderThan.lt)) return { count: 0 };
    row.day = data.autoUnsubscribeDay as string;
    row.count = data.autoUnsubscribeCount as number;
    return { count: 1 };
  }
  const bound = where.autoUnsubscribeCount as { lt: number };
  if (row.day !== where.autoUnsubscribeDay || row.count >= bound.lt) return { count: 0 };
  row.count += 1;
  return { count: 1 };
}

/** Same semantics as the INSERT … ON CONFLICT … WHERE … RETURNING statement. */
function sharedUpsert(strings: TemplateStringsArray, key: string, day: string, cap: number) {
  state.sql.push(strings.join("?"));
  const row = state.shared.get(key);
  if (!row || row.day < day) {
    state.shared.set(key, { day, count: 1 });
    return [{ count: 1 }];
  }
  // A stored day newer than the caller's: the WHERE is false, nothing returned.
  if (row.day > day) return [];
  if (row.count >= cap) return [];
  row.count += 1;
  return [{ count: row.count }];
}

const captureError = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureError }));

vi.mock("../db.js", () => ({
  prisma: {
    user: {
      updateMany: vi.fn(async (args: { where: Where; data: Data }) => userUpdateMany(args)),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) =>
      sharedUpsert(strings, values[0] as string, values[1] as string, values[2] as number),
    ),
  },
}));

import {
  autoUnsubscribeGlobalCap,
  autoUnsubscribeHostCap,
  autoUnsubscribeUserCap,
  reserveAutoUnsubscribe,
  resetCapTripReportsForTests,
  targetDomain,
} from "../mail/unsubscribe-quota.js";

const NOW = new Date("2026-10-15T09:00:00Z");
const TOMORROW = new Date("2026-10-16T00:00:01Z");
const ENV = [
  "AUTO_UNSUBSCRIBE_USER_DAILY_CAP",
  "AUTO_UNSUBSCRIBE_HOST_DAILY_CAP",
  "AUTO_UNSUBSCRIBE_GLOBAL_DAILY_CAP",
];

beforeEach(() => {
  state.users.clear();
  state.shared.clear();
  state.sql.length = 0;
  captureError.mockClear();
  resetCapTripReportsForTests();
});

afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

async function reserveTimes(n: number, userId: string, url: string, now = NOW) {
  const results = [];
  for (let i = 0; i < n; i += 1) results.push(await reserveAutoUnsubscribe(userId, url, now));
  return results;
}

describe("caps from the environment", () => {
  it("default 20 / 50 / 1000; garbage and < 1 fall back; huge values clamp", () => {
    expect([
      autoUnsubscribeUserCap(),
      autoUnsubscribeHostCap(),
      autoUnsubscribeGlobalCap(),
    ]).toEqual([20, 50, 1000]);
    process.env.AUTO_UNSUBSCRIBE_USER_DAILY_CAP = "abc";
    process.env.AUTO_UNSUBSCRIBE_HOST_DAILY_CAP = "0";
    process.env.AUTO_UNSUBSCRIBE_GLOBAL_DAILY_CAP = "Infinity";
    expect([
      autoUnsubscribeUserCap(),
      autoUnsubscribeHostCap(),
      autoUnsubscribeGlobalCap(),
    ]).toEqual([20, 50, 1000]);
    process.env.AUTO_UNSUBSCRIBE_USER_DAILY_CAP = "500";
    process.env.AUTO_UNSUBSCRIBE_HOST_DAILY_CAP = "1e9";
    process.env.AUTO_UNSUBSCRIBE_GLOBAL_DAILY_CAP = "7.9";
    expect([
      autoUnsubscribeUserCap(),
      autoUnsubscribeHostCap(),
      autoUnsubscribeGlobalCap(),
    ]).toEqual([100, 1000, 7]);
  });
});

describe("targetDomain", () => {
  it("counts a spread of subdomains as one target", () => {
    expect(targetDomain("https://a.b.list.example.com/u?x=1")).toBe("example.com");
    expect(targetDomain("https://EXAMPLE.com./u")).toBe("example.com");
    expect(targetDomain("https://news.shop.co.uk/u")).toBe("shop.co.uk");
    expect(targetDomain("https://mail.naver.co.kr/u")).toBe("naver.co.kr");
    expect(targetDomain("https://x.y.com.au/u")).toBe("y.com.au");
    // ".io" is a two-letter TLD but "github" is not a second-level label.
    expect(targetDomain("https://a.b.github.io/u")).toBe("github.io");
    expect(targetDomain("not a url")).toBeNull();
  });
});

describe("reserveAutoUnsubscribe", () => {
  it("refuses an unsafe target before writing anything", async () => {
    for (const url of [
      "http://shop.com/u",
      "https://127.0.0.1/u",
      "https://localhost/u",
      "garbage",
    ]) {
      expect(await reserveAutoUnsubscribe("u1", url, NOW)).toEqual({
        ok: false,
        reason: "unsafe-endpoint",
      });
    }
    expect(state.users.size).toBe(0);
    expect(state.shared.size).toBe(0);
  });

  it("per user: the 21st of the day is refused, and the shared counters are not touched by it", async () => {
    const results = await reserveTimes(21, "u1", "https://shop.com/u");
    expect(results.slice(0, 20).every((r) => r.ok)).toBe(true);
    expect(results[20]).toEqual({ ok: false, reason: "user-cap" });
    expect(state.shared.get("host:shop.com")?.count).toBe(20);
    expect(state.shared.get("global")?.count).toBe(20);
  });

  it("per target: subdomains share one count across users; the 51st POST to a domain is refused", async () => {
    let allowed = 0;
    for (let user = 0; user < 6; user += 1) {
      for (let i = 0; i < 10; i += 1) {
        const r = await reserveAutoUnsubscribe(`u${user}`, `https://s${i}.victim.com/u`, NOW);
        if (r.ok) allowed += 1;
        else expect(r).toEqual({ ok: false, reason: "host-cap" });
      }
    }
    expect(allowed).toBe(50);
    // Another domain is unaffected.
    expect(await reserveAutoUnsubscribe("u9", "https://other.com/u", NOW)).toEqual({ ok: true });
  });

  it("fleet-wide: the global cap holds across users and domains", async () => {
    process.env.AUTO_UNSUBSCRIBE_GLOBAL_DAILY_CAP = "3";
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await reserveAutoUnsubscribe(`u${i}`, `https://d${i}.example${i}.com/u`, NOW));
    }
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[3]).toEqual({ ok: false, reason: "global-cap" });
  });

  it("a new UTC day starts every count again", async () => {
    process.env.AUTO_UNSUBSCRIBE_USER_DAILY_CAP = "1";
    expect(await reserveAutoUnsubscribe("u1", "https://shop.com/u", NOW)).toEqual({ ok: true });
    expect(await reserveAutoUnsubscribe("u1", "https://shop.com/u", NOW)).toEqual({
      ok: false,
      reason: "user-cap",
    });
    expect(await reserveAutoUnsubscribe("u1", "https://shop.com/u", TOMORROW)).toEqual({
      ok: true,
    });
    expect(state.users.get("u1")).toEqual({ day: "2026-10-16", count: 1 });
  });

  it("the shared counter is one conditional upsert that returns nothing at the cap", async () => {
    await reserveAutoUnsubscribe("u1", "https://shop.com/u", NOW);
    const sql = state.sql[0].replace(/\s+/g, " ");
    expect(sql).toContain('ON CONFLICT ("key") DO UPDATE');
    expect(sql).toContain(
      'WHERE "UnsubscribeQuota"."day" < EXCLUDED."day" OR ("UnsubscribeQuota"."day" = EXCLUDED."day" AND "UnsubscribeQuota"."count" < ?)',
    );
    expect(sql).toContain('RETURNING "count"');
  });

  it("a database error surfaces — the caller decides, and must decide no", async () => {
    const { prisma } = await import("../db.js");
    vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(new Error("db down"));
    await expect(reserveAutoUnsubscribe("u1", "https://shop.com/u", NOW)).rejects.toThrow(
      "db down",
    );
  });
});

describe("review hardening (2026-10-15)", () => {
  it("refuses IP literals, empty labels and over-long names; strips every trailing dot", () => {
    expect(targetDomain("https://1.2.3.4/u")).toBeNull();
    expect(targetDomain("https://[::ffff:102:304]/u")).toBeNull();
    expect(targetDomain("https://[64:ff9b::102:304]/u")).toBeNull();
    expect(targetDomain(`https://${"a".repeat(250)}.com/u`)).toBeNull();
    expect(targetDomain("https://a.victim.com../u")).toBe("victim.com");
  });

  it("a caller whose day is older than the stored one never resets today's counts", async () => {
    process.env.AUTO_UNSUBSCRIBE_USER_DAILY_CAP = "1";
    expect(await reserveAutoUnsubscribe("u1", "https://shop.com/u", TOMORROW)).toEqual({
      ok: true,
    });
    // A stale call computed for the day before.
    expect(await reserveAutoUnsubscribe("u1", "https://shop.com/u", NOW)).toEqual({
      ok: false,
      reason: "user-cap",
    });
    expect(state.users.get("u1")).toEqual({ day: "2026-10-16", count: 1 });
    // The shared counter likewise refuses a stale day instead of resetting.
    state.shared.set("host:other.com", { day: "2026-10-16", count: 3 });
    expect(await reserveAutoUnsubscribe("u2", "https://other.com/u", NOW)).toEqual({
      ok: false,
      reason: "host-cap",
    });
    expect(state.shared.get("host:other.com")).toEqual({ day: "2026-10-16", count: 3 });
  });

  it("a tripped host cap is reported once per target per day, with the domain only in extra", async () => {
    process.env.AUTO_UNSUBSCRIBE_HOST_DAILY_CAP = "1";
    await reserveAutoUnsubscribe("u1", "https://a.victim.com/u", NOW);
    await reserveAutoUnsubscribe("u2", "https://b.victim.com/u", NOW);
    await reserveAutoUnsubscribe("u3", "https://c.victim.com/u", NOW);
    expect(captureError).toHaveBeenCalledTimes(1);
    const [err, context] = captureError.mock.calls[0];
    expect((err as Error).message).toBe("auto-unsubscribe host-cap reached");
    expect(context).toEqual({
      tags: { scope: "auto-unsubscribe.cap" },
      extra: { reason: "host-cap", domain: "victim.com", day: "2026-10-15" },
    });
  });
});
