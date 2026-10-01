/**
 * Step B4 review fix: IMAP poll ticks must not stack. The scheduler fires every five
 * minutes and a tick walks every account serially; a slow tick (many accounts, a slow
 * host) used to be joined by the next one, and so on. Now a tick that starts while
 * the previous one is still running is skipped. This applies to every provider.
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

/** A promise the test settles by hand. */
function gate<T = void>() {
  let open: (value: T) => void = () => {};
  let fail: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.groupBy.mockResolvedValue([{ userId: "u1", provider: "NAVER" }]);
  m.sync.mockResolvedValue({ fetched: 0, inserted: 0, classified: 0, errors: 0 });
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

  it("skips a tick that starts while the previous one is still running", async () => {
    const slow = gate<{ fetched: number; inserted: number; classified: number; errors: number }>();
    m.sync.mockReturnValueOnce(slow.promise);

    const first = runImapTick();
    await vi.waitFor(() => expect(m.sync).toHaveBeenCalledTimes(1));
    await runImapTick(); // returns at once, does nothing
    await runImapTick();

    expect(m.groupBy).toHaveBeenCalledTimes(1);
    expect(m.sync).toHaveBeenCalledTimes(1);

    slow.open({ fetched: 0, inserted: 0, classified: 0, errors: 0 });
    await first;
  });

  it("says so in the log when it skips", async () => {
    const slow = gate<null>();
    m.sync.mockReturnValueOnce(slow.promise);
    const first = runImapTick();
    await vi.waitFor(() => expect(m.sync).toHaveBeenCalledTimes(1));
    await runImapTick();
    const lines = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (call) => call.join(" "),
    );
    expect(lines.some((line) => /still running|skipp/i.test(line))).toBe(true);
    slow.open(null);
    await first;
  });

  it("runs again once the previous tick has finished", async () => {
    await runImapTick();
    await runImapTick();
    expect(m.sync).toHaveBeenCalledTimes(2);
  });

  it("releases the guard when the tick fails (a database error must not wedge the poll)", async () => {
    m.groupBy.mockRejectedValueOnce(new Error("db down"));
    await expect(runImapTick()).rejects.toThrow("db down");
    await runImapTick();
    expect(m.sync).toHaveBeenCalledTimes(1);
  });

  it("releases the guard when one user's sync fails", async () => {
    m.sync.mockRejectedValueOnce(new Error("sync broke"));
    await runImapTick();
    await runImapTick();
    expect(m.sync).toHaveBeenCalledTimes(2);
    expect(m.captureError).toHaveBeenCalledTimes(1);
  });
});

describe("startImapScheduler: ticks do not stack", () => {
  it("a tick still running when the next interval fires is skipped, not doubled", async () => {
    vi.useFakeTimers();
    const slow = gate<null>();
    m.sync.mockReturnValue(slow.promise);

    startImapScheduler();
    await vi.advanceTimersByTimeAsync(30_000); // first tick starts and hangs
    expect(m.sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000); // the next interval fires
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(m.sync).toHaveBeenCalledTimes(1);
    expect(m.groupBy).toHaveBeenCalledTimes(1);

    slow.open(null);
    m.sync.mockResolvedValue({ fetched: 0, inserted: 0, classified: 0, errors: 0 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(m.sync).toHaveBeenCalledTimes(2);
  });
});
