/**
 * The IMAP poll scheduler (every provider). Ticks used to be serialised by ONE
 * boolean: a tick that never settled stopped all IMAP polling for good, and the
 * heartbeat (recorded before the guard) stayed green while every later tick was
 * skipped. Now:
 *   - there is no global lock: a stuck tick cannot stop the next one; the double-poll
 *     guard is per ACCOUNT, inside the fan-out (imap-accounts.ts, tested in
 *     imap-accounts.test.ts), so a stuck account cannot block the others;
 *   - the heartbeat is recorded by a tick that actually runs (inside runImapTick),
 *     not by the interval callback ahead of any decision.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  groupBy: vi.fn(),
  sync: vi.fn(),
  notify: vi.fn(),
  captureError: vi.fn(),
  registerScheduler: vi.fn(),
  recordSchedulerTick: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: { linkedInboxAccount: { groupBy: (...args: unknown[]) => m.groupBy(...args) } },
}));
vi.mock("../mail/imap-accounts.js", () => ({
  syncImapAccountsForUser: (...args: unknown[]) => m.sync(...args),
}));
vi.mock("../notify/conversations-updated.js", () => ({
  notifyConversationsUpdated: (...args: unknown[]) => m.notify(...args),
}));
vi.mock("../scheduler-heartbeat.js", () => ({
  registerScheduler: (...args: unknown[]) => m.registerScheduler(...args),
  recordSchedulerTick: (...args: unknown[]) => m.recordSchedulerTick(...args),
}));
vi.mock("../sentry.js", () => ({ captureError: (...args: unknown[]) => m.captureError(...args) }));

const { runImapTick, startImapScheduler, stopImapScheduler } = await import(
  "../mail/imap-scheduler.js"
);

const AGGREGATE = { fetched: 0, inserted: 0, classified: 0, errors: 0 };

/** A promise the test settles by hand. */
function gate<T = void>() {
  let open: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.groupBy.mockResolvedValue([{ userId: "u1", provider: "NAVER" }]);
  m.sync.mockResolvedValue(AGGREGATE);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  stopImapScheduler();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runImapTick", () => {
  it("runs a tick", async () => {
    await runImapTick();
    expect(m.groupBy).toHaveBeenCalledTimes(1);
    expect(m.sync).toHaveBeenCalledTimes(1);
  });

  it("a tick that never settles does not stop the next one (no global lock)", async () => {
    const stuck = gate<typeof AGGREGATE>();
    m.sync.mockReturnValueOnce(stuck.promise);

    const first = runImapTick();
    await vi.waitFor(() => expect(m.sync).toHaveBeenCalledTimes(1));
    await runImapTick(); // not skipped: it runs and reaches the sync
    await runImapTick();

    expect(m.groupBy).toHaveBeenCalledTimes(3);
    expect(m.sync).toHaveBeenCalledTimes(3);

    stuck.open(AGGREGATE);
    await first;
  });

  it("a stuck tick for one owner does not hold the next tick's other owners", async () => {
    m.groupBy.mockResolvedValue([
      { userId: "slow-user", provider: "NAVER" },
      { userId: "other-user", provider: "NAVER" },
    ]);
    const stuck = gate<typeof AGGREGATE>();
    let slowCalls = 0;
    // The real fan-out skips an account whose poll is still running and returns at once
    // (imap-accounts.ts, per-account guard); this stands in for that on the second call.
    m.sync.mockImplementation((userId: string) =>
      userId === "slow-user" && ++slowCalls === 1 ? stuck.promise : Promise.resolve(AGGREGATE),
    );

    const first = runImapTick(); // stuck on slow-user, never reaches other-user
    await vi.waitFor(() => expect(m.sync).toHaveBeenCalledTimes(1));
    await runImapTick(); // slow-user is skipped by the per-account guard; other-user is polled

    const polled = m.sync.mock.calls.map((call) => call[0]);
    expect(polled.filter((id) => id === "other-user")).toHaveLength(1);

    stuck.open(AGGREGATE);
    await first;
  });

  it("records the heartbeat for a tick that runs, and only from inside the tick", async () => {
    expect(m.recordSchedulerTick).not.toHaveBeenCalled();
    await runImapTick();
    expect(m.recordSchedulerTick).toHaveBeenCalledTimes(1);
    expect(m.recordSchedulerTick).toHaveBeenCalledWith("imap");
  });

  it("surfaces a failed tick to its caller", async () => {
    m.groupBy.mockRejectedValueOnce(new Error("db down"));
    await expect(runImapTick()).rejects.toThrow("db down");
    await runImapTick();
    expect(m.sync).toHaveBeenCalledTimes(1);
  });

  it("one user's failed sync is reported and does not stop the tick", async () => {
    m.sync.mockRejectedValueOnce(new Error("sync broke"));
    await runImapTick();
    expect(m.captureError).toHaveBeenCalledTimes(1);
    await runImapTick();
    expect(m.sync).toHaveBeenCalledTimes(2);
  });
});

describe("startImapScheduler", () => {
  it("every interval is a tick that runs and is recorded; a stuck one never makes the rest silent", async () => {
    vi.useFakeTimers();
    const stuck = gate<typeof AGGREGATE>();
    m.sync.mockReturnValue(stuck.promise);

    startImapScheduler();
    expect(m.recordSchedulerTick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000); // first tick starts and hangs
    expect(m.recordSchedulerTick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(m.recordSchedulerTick).toHaveBeenCalledTimes(3);
    expect(m.groupBy).toHaveBeenCalledTimes(3);

    stuck.open(AGGREGATE);
  });
});
