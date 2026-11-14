/**
 * The Slack scheduler (docs/providers/slack.md §11): the retention purge keeps
 * running when SLACK_ENABLED is switched off, at most every 10 minutes, and a
 * tick with the flag off and no purge due does no database work.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const purge = vi.hoisted(() => ({
  purgeExpiredSlackData: vi.fn(async () => ({ messages: 0, episodes: 0 })),
}));
vi.mock("../slack/purge.js", () => purge);
vi.mock("../scheduler-lease.js", () => ({
  createSchedulerLease: () => ({
    runExclusive: async (work: () => Promise<void>) => (await work(), true),
  }),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import {
  resetSlackSchedulerState,
  SLACK_PURGE_INTERVAL_MS,
  slackSchedulerTick,
} from "../slack/scheduler.js";

const T0 = new Date("2026-11-14T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(() => {
  vi.clearAllMocks();
  resetSlackSchedulerState();
  delete process.env.SLACK_ENABLED;
});

afterEach(() => {
  delete process.env.SLACK_ENABLED;
});

describe("slackSchedulerTick", () => {
  it("purges expired Slack data even while SLACK_ENABLED is off", async () => {
    await slackSchedulerTick(T0);
    expect(purge.purgeExpiredSlackData).toHaveBeenCalledWith(T0);
  });

  it("purges at most every 10 minutes, and an off tick in between takes no lease", async () => {
    const lease = {
      runExclusive: vi.fn(async (work: () => Promise<void>) => (await work(), true)),
    };
    await slackSchedulerTick(T0, lease);
    await slackSchedulerTick(at(30_000), lease);
    await slackSchedulerTick(at(SLACK_PURGE_INTERVAL_MS - 1), lease);
    expect(lease.runExclusive).toHaveBeenCalledTimes(1);
    await slackSchedulerTick(at(SLACK_PURGE_INTERVAL_MS), lease);
    expect(purge.purgeExpiredSlackData).toHaveBeenCalledTimes(2);
  });

  it("with the flag on every tick takes the lease, the purge still throttled", async () => {
    process.env.SLACK_ENABLED = "true";
    const lease = {
      runExclusive: vi.fn(async (work: () => Promise<void>) => (await work(), true)),
    };
    await slackSchedulerTick(T0, lease);
    await slackSchedulerTick(at(30_000), lease);
    expect(lease.runExclusive).toHaveBeenCalledTimes(2);
    expect(purge.purgeExpiredSlackData).toHaveBeenCalledTimes(1);
  });

  it("a failing purge is reported, not thrown, and retried after the interval, not every tick", async () => {
    purge.purgeExpiredSlackData.mockRejectedValueOnce(new Error("db down"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(slackSchedulerTick(T0)).resolves.toBeUndefined();
    await slackSchedulerTick(at(30_000));
    expect(purge.purgeExpiredSlackData).toHaveBeenCalledTimes(1);
    await slackSchedulerTick(at(SLACK_PURGE_INTERVAL_MS));
    expect(purge.purgeExpiredSlackData).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
