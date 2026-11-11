import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

// The scheduler lease (scheduler-lease.ts) that replaced the session advisory
// locks. Those leaked in production: behind Supavisor the lock and the unlock
// ran on different pooled backends, the unlock returned false, and every later
// tick whose acquire landed on another backend was skipped without a word.
// These tests drive the lease's tick logic against an in-memory store with the
// same semantics as the SQL one; scheduler-lease-pg.test.ts proves the SQL.

const m = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: m.captureError }));

import {
  createSchedulerLease,
  LEASE_CALL_TIMEOUT_MS,
  SCHEDULER_LEASE_RENEW_EVERY_MS,
  SCHEDULER_LEASE_TTL_MS,
} from "../scheduler-lease.js";
import type { LeaseAcquireResult, LeaseStore } from "../scheduler-lease-store.js";

const MINUTE_MS = 60_000;
const NAME = "automation";

interface Row {
  holderId: string | null;
  expiresAt: number;
}

/** The SQL store's semantics, timed by the (fake) system clock. */
function memoryStore() {
  const rows = new Map<string, Row>();
  const store: LeaseStore = {
    async acquire(name, holderId, ttlMs): Promise<LeaseAcquireResult> {
      const now = Date.now();
      const row = rows.get(name);
      const heldByOther =
        row !== undefined &&
        row.holderId !== null &&
        row.holderId !== holderId &&
        row.expiresAt > now;
      if (heldByOther) {
        return { acquired: false, holderId: row.holderId, expiresAt: new Date(row.expiresAt) };
      }
      rows.set(name, { holderId, expiresAt: now + ttlMs });
      const tookOverFrom =
        row?.holderId != null && row.holderId !== holderId
          ? { holderId: row.holderId, expiresAt: new Date(row.expiresAt) }
          : null;
      return { acquired: true, tookOverFrom };
    },
    async renew(name, holderId, ttlMs) {
      const row = rows.get(name);
      if (row?.holderId !== holderId) return false;
      rows.set(name, { holderId, expiresAt: Date.now() + ttlMs });
      return true;
    },
    async release(name, holderId) {
      const row = rows.get(name);
      if (row?.holderId !== holderId) return false;
      rows.set(name, { holderId: null, expiresAt: Date.now() });
      return true;
    },
  };
  return { store, rows };
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function leaseFor(store: LeaseStore, holderId: string) {
  return createSchedulerLease({ name: NAME, logPrefix: "[TEST]", store, holderId });
}

let warn: MockInstance<typeof console.warn>;
let error: MockInstance<typeof console.error>;
let log: MockInstance<typeof console.log>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T21:00:00.000Z"));
  m.captureError.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scheduler lease: one tick at a time across instances", () => {
  it("runs the work while holding the lease and frees it afterwards", async () => {
    const { store, rows } = memoryStore();
    const work = vi.fn(async () => {
      expect(rows.get(NAME)?.holderId).toBe("instance-a");
    });

    expect(await leaseFor(store, "instance-a").runExclusive(work)).toBe(true);

    expect(work).toHaveBeenCalledTimes(1);
    expect(rows.get(NAME)?.holderId).toBeNull();
    expect(await leaseFor(store, "instance-b").runExclusive(async () => {})).toBe(true);
  });

  it("a second instance skips its tick while the first one holds the lease", async () => {
    const { store } = memoryStore();
    const gate = deferred();
    const first = leaseFor(store, "instance-a").runExclusive(() => gate.promise);
    await vi.advanceTimersByTimeAsync(0);

    const otherWork = vi.fn(async () => {});
    expect(await leaseFor(store, "instance-b").runExclusive(otherWork)).toBe(false);
    expect(otherWork).not.toHaveBeenCalled();

    gate.resolve();
    expect(await first).toBe(true);
  });

  it("frees the lease when the work throws, and rethrows", async () => {
    const { store } = memoryStore();
    const boom = new Error("tick failed");

    await expect(
      leaseFor(store, "instance-a").runExclusive(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(await leaseFor(store, "instance-b").runExclusive(async () => {})).toBe(true);
  });

  it("a release that never lands does not wedge later ticks", async () => {
    // The production failure: the unlock reached a backend that did not hold
    // the lock, so the lock stayed held and later ticks were skipped for hours.
    const { store } = memoryStore();
    const lost: LeaseStore = {
      ...store,
      release: async () => {
        throw new Error("connection reset");
      },
    };

    expect(await leaseFor(lost, "instance-a").runExclusive(async () => {})).toBe(true);
    // The same instance's next tick runs: the lease names its holder, not a backend.
    expect(await leaseFor(lost, "instance-a").runExclusive(async () => {})).toBe(true);
    // Another instance waits out the TTL at most, then runs.
    expect(await leaseFor(store, "instance-b").runExclusive(async () => {})).toBe(false);
    vi.setSystemTime(Date.now() + SCHEDULER_LEASE_TTL_MS);
    expect(await leaseFor(store, "instance-b").runExclusive(async () => {})).toBe(true);
  });

  it("takes over an expired lease and logs whose it was", async () => {
    const { store } = memoryStore();
    // An instance that died mid-tick (deploy, crash) never releases.
    await store.acquire(NAME, "dead-instance", SCHEDULER_LEASE_TTL_MS);
    vi.setSystemTime(Date.now() + SCHEDULER_LEASE_TTL_MS + 1);

    expect(await leaseFor(store, "instance-b").runExclusive(async () => {})).toBe(true);

    const takeover = warn.mock.calls
      .map((call) => String(call[0]))
      .find((s) => s.includes("took over"));
    expect(takeover).toContain("dead-instance");
    expect(takeover).toContain(NAME);
  });

  it("does not report a takeover when the instance re-takes its own unreleased lease", async () => {
    const { store } = memoryStore();
    await store.acquire(NAME, "instance-a", SCHEDULER_LEASE_TTL_MS);

    expect(await leaseFor(store, "instance-a").runExclusive(async () => {})).toBe(true);

    expect(warn.mock.calls.some((call) => String(call[0]).includes("took over"))).toBe(false);
  });
});

describe("scheduler lease: a long tick keeps its lease", () => {
  it("renews while the work runs, so no other instance takes over mid-tick", async () => {
    const { store } = memoryStore();
    const gate = deferred();
    const first = leaseFor(store, "instance-a").runExclusive(() => gate.promise);

    await vi.advanceTimersByTimeAsync(5 * SCHEDULER_LEASE_TTL_MS);

    expect(await leaseFor(store, "instance-b").runExclusive(async () => {})).toBe(false);
    gate.resolve();
    expect(await first).toBe(true);
    expect(SCHEDULER_LEASE_RENEW_EVERY_MS * 3).toBeLessThanOrEqual(SCHEDULER_LEASE_TTL_MS);
  });

  it("stops renewing once the tick ends", async () => {
    const { store } = memoryStore();
    const renew = vi.spyOn(store, "renew");

    await leaseFor(store, "instance-a").runExclusive(async () => {});
    await vi.advanceTimersByTimeAsync(10 * SCHEDULER_LEASE_RENEW_EVERY_MS);

    expect(renew).not.toHaveBeenCalled();
  });

  it("reports a lease lost mid-tick once, to the log and to Sentry", async () => {
    const { store } = memoryStore();
    const stolen: LeaseStore = { ...store, renew: async () => false, release: async () => false };
    const gate = deferred();
    const tick = leaseFor(stolen, "instance-a").runExclusive(() => gate.promise);

    await vi.advanceTimersByTimeAsync(4 * SCHEDULER_LEASE_RENEW_EVERY_MS);
    gate.resolve();
    await tick;

    expect(error.mock.calls.filter((call) => String(call[0]).includes("lost"))).toHaveLength(1);
    expect(m.captureError).toHaveBeenCalledTimes(1);
  });

  it("reports a release that finds the lease already taken over", async () => {
    const { store } = memoryStore();
    const stolen: LeaseStore = { ...store, release: async () => false };

    await leaseFor(stolen, "instance-a").runExclusive(async () => {});

    expect(error.mock.calls.some((call) => String(call[0]).includes("lost"))).toBe(true);
    expect(m.captureError).toHaveBeenCalledTimes(1);
  });
});

describe("scheduler lease: a skipped tick is never silent", () => {
  it("logs the first skip, then at most every 10 minutes, and alerts Sentry once", async () => {
    const { store } = memoryStore();
    const gate = deferred();
    const holder = leaseFor(store, "instance-a").runExclusive(() => gate.promise);
    await vi.advanceTimersByTimeAsync(0);
    const blocked = leaseFor(store, "instance-b");
    const skipLines = () =>
      warn.mock.calls.filter((call) => String(call[0]).includes("not acquired")).length;
    // The holder's own tick runs 20 minutes here, so its long-hold alert fires
    // too; count only the skip alerts.
    const skipAlerts = () =>
      m.captureError.mock.calls.filter((call) => String(call[0]).includes("not acquired")).length;

    await blocked.runExclusive(async () => {});
    expect(skipLines()).toBe(1);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("instance-a");

    for (let minute = 1; minute < 10; minute++) {
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await blocked.runExclusive(async () => {});
    }
    expect(skipLines()).toBe(1);
    expect(skipAlerts()).toBe(0);

    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await blocked.runExclusive(async () => {});
    expect(skipLines()).toBe(2);
    expect(skipAlerts()).toBe(1);

    for (let minute = 11; minute <= 20; minute++) {
      await vi.advanceTimersByTimeAsync(MINUTE_MS);
      await blocked.runExclusive(async () => {});
    }
    expect(skipLines()).toBe(3);
    expect(skipAlerts()).toBe(1);

    gate.resolve();
    await holder;
    expect(await blocked.runExclusive(async () => {})).toBe(true);
    expect(log.mock.calls.some((call) => String(call[0]).includes("acquired after"))).toBe(true);
  });

  it("an acquire that throws skips the tick and logs the error", async () => {
    const { store } = memoryStore();
    const failing: LeaseStore = {
      ...store,
      acquire: async () => {
        throw new Error("db unreachable");
      },
    };
    const work = vi.fn(async () => {});

    expect(await leaseFor(failing, "instance-a").runExclusive(work)).toBe(false);

    expect(work).not.toHaveBeenCalled();
    const line = warn.mock.calls.find((call) => String(call[0]).includes("not acquired"));
    expect(line?.map(String).join(" ")).toContain("db unreachable");
  });
});

describe("scheduler lease: review hardening", () => {
  const skipLines = () =>
    warn.mock.calls.filter((call) => String(call[0]).includes("not acquired")).length;

  it("a 10-minute loop logs and alerts on its second skip despite latency jitter", async () => {
    // The agent loop's interval equals both thresholds; a tick landing 100 ms
    // early must not push the log and the alert to the third skip (20 min).
    const { store } = memoryStore();
    await store.acquire(NAME, "live-instance", 60 * MINUTE_MS);
    const blocked = leaseFor(store, "instance-b");

    await blocked.runExclusive(async () => {});
    vi.setSystemTime(Date.now() + 10 * MINUTE_MS - 100);
    await blocked.runExclusive(async () => {});

    expect(skipLines()).toBe(2);
    expect(m.captureError).toHaveBeenCalledTimes(1);
  });

  it("a second call in the same process while a tick runs is refused", async () => {
    const { store } = memoryStore();
    const lease = leaseFor(store, "instance-a");
    const gate = deferred();
    const first = lease.runExclusive(() => gate.promise);
    await vi.advanceTimersByTimeAsync(0);

    const second = vi.fn(async () => {});
    expect(await lease.runExclusive(second)).toBe(false);
    expect(second).not.toHaveBeenCalled();

    gate.resolve();
    expect(await first).toBe(true);
    expect(await lease.runExclusive(second)).toBe(true);
  });

  it("an acquire that hangs times out as a skipped tick instead of stalling the caller", async () => {
    const { store } = memoryStore();
    const hung: LeaseStore = { ...store, acquire: () => new Promise(() => {}) };
    const work = vi.fn(async () => {});

    const tick = leaseFor(hung, "instance-a").runExclusive(work);
    await vi.advanceTimersByTimeAsync(LEASE_CALL_TIMEOUT_MS);

    expect(await tick).toBe(false);
    expect(work).not.toHaveBeenCalled();
    expect(skipLines()).toBe(1);
  });

  it("a release that hangs times out, and the next tick still runs", async () => {
    const { store } = memoryStore();
    const hung: LeaseStore = { ...store, release: () => new Promise(() => {}) };
    const lease = leaseFor(hung, "instance-a");

    // In steps: each release's timeout is armed a few microtasks after the start.
    const runTick = async (work: () => Promise<void>) => {
      const tick = lease.runExclusive(work);
      for (let elapsed = 0; elapsed <= LEASE_CALL_TIMEOUT_MS; elapsed += 1000) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      return tick;
    };

    expect(await runTick(async () => {})).toBe(true);
    const next = vi.fn(async () => {});
    expect(await runTick(next)).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((call) => String(call[0]).includes("release failed"))).toBe(true);
  });

  it("a renewal still in flight when the tick ends is not reported as a loss", async () => {
    const { store } = memoryStore();
    const late = deferred();
    const slow: LeaseStore = { ...store, renew: () => late.promise.then(() => false) };
    const gate = deferred();
    const tick = leaseFor(slow, "instance-a").runExclusive(() => gate.promise);

    await vi.advanceTimersByTimeAsync(SCHEDULER_LEASE_RENEW_EVERY_MS);
    gate.resolve();
    expect(await tick).toBe(true);
    late.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(error).not.toHaveBeenCalled();
    expect(m.captureError).not.toHaveBeenCalled();
  });

  it("renewal errors are retried; only failures for half the TTL alert, once", async () => {
    const { store } = memoryStore();
    let failing = true;
    const flaky: LeaseStore = {
      ...store,
      renew: async (...args) => {
        if (failing) throw new Error("pool timeout");
        return store.renew(...args);
      },
    };
    const gate = deferred();
    const tick = leaseFor(flaky, "instance-a").runExclusive(() => gate.promise);

    await vi.advanceTimersByTimeAsync(SCHEDULER_LEASE_RENEW_EVERY_MS);
    expect(m.captureError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3 * SCHEDULER_LEASE_RENEW_EVERY_MS);
    expect(m.captureError).toHaveBeenCalledTimes(1);

    failing = false;
    await vi.advanceTimersByTimeAsync(SCHEDULER_LEASE_RENEW_EVERY_MS);
    expect(await leaseFor(store, "instance-b").runExclusive(async () => {})).toBe(false);
    gate.resolve();
    expect(await tick).toBe(true);
    expect(m.captureError).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.some((call) => String(call[0]).includes("lost"))).toBe(false);
  });

  it("a tick that holds the lease for 15 minutes alerts once", async () => {
    const { store } = memoryStore();
    const gate = deferred();
    const tick = leaseFor(store, "instance-a").runExclusive(() => gate.promise);

    await vi.advanceTimersByTimeAsync(14 * MINUTE_MS);
    expect(m.captureError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20 * MINUTE_MS);
    expect(m.captureError).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain("held it for");

    gate.resolve();
    expect(await tick).toBe(true);
  });

  it("rejects a TTL the SQL cannot bind and a renewal cadence that cannot keep the lease", () => {
    const { store } = memoryStore();
    const make = (ttlMs: number, renewEveryMs: number) => () =>
      createSchedulerLease({ name: NAME, logPrefix: "[TEST]", store, ttlMs, renewEveryMs });

    expect(make(0, 1)).toThrow(RangeError);
    expect(make(2 ** 31, 1000)).toThrow(RangeError);
    expect(make(1.5, 1)).toThrow(RangeError);
    expect(make(60_000, 60_000)).toThrow(RangeError);
    expect(make(60_000, 15_000)).not.toThrow();
  });
});
