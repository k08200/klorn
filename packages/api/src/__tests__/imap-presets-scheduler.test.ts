/**
 * The IMAP poll and the preset flag: off selects no preset row, on polls every
 * preset row, and cohort polls only the rows of users in ROLLOUT_COHORT_USER_IDS
 * (rows another user connected while the flag was on are left alone).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ groupBy: vi.fn(), sync: vi.fn() }));

vi.mock("../db.js", () => ({
  prisma: { linkedInboxAccount: { groupBy: (...args: unknown[]) => m.groupBy(...args) } },
}));
vi.mock("../mail/imap-accounts.js", () => ({
  syncImapAccountsForUser: (...args: unknown[]) => m.sync(...args),
}));
vi.mock("../notify/conversations-updated.js", () => ({ notifyConversationsUpdated: vi.fn() }));
vi.mock("../scheduler-heartbeat.js", () => ({
  registerScheduler: vi.fn(),
  recordSchedulerTick: vi.fn(),
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { runImapTick } = await import("../mail/imap-scheduler.js");

const ENV = ["IMAP_PRESETS_ENABLED", "ROLLOUT_COHORT_USER_IDS"] as const;
const ORIGINAL = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

const OWNERS = [
  { userId: "u-naver", provider: "NAVER" },
  { userId: "u-cohort", provider: "YAHOO" },
  { userId: "u-outside", provider: "FASTMAIL" },
];

/** The (user, provider) pairs the tick synced. */
function synced(): string[] {
  return m.sync.mock.calls.map(
    ([userId, cfg]) => `${userId}:${(cfg as { provider: string }).provider}`,
  );
}

/** The provider filter the tick's groupBy asked for. */
function queriedProviders(): string[] {
  const where = (m.groupBy.mock.calls[0]?.[0] as { where: { provider: { in: string[] } } }).where;
  return where.provider.in;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.groupBy.mockImplementation(async (args: { where: { provider: { in: string[] } } }) =>
    OWNERS.filter((owner) => args.where.provider.in.includes(owner.provider)),
  );
  m.sync.mockResolvedValue({ fetched: 0, inserted: 0, classified: 0, errors: 0 });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const name of ENV) {
    const value = ORIGINAL[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

describe("runImapTick and IMAP_PRESETS_ENABLED", () => {
  it("off: no preset row is selected", async () => {
    delete process.env.IMAP_PRESETS_ENABLED;
    await runImapTick();
    expect(queriedProviders()).not.toContain("YAHOO");
    expect(queriedProviders()).not.toContain("FASTMAIL");
    expect(synced()).toEqual(["u-naver:NAVER"]);
  });

  it("on: every preset row is polled", async () => {
    process.env.IMAP_PRESETS_ENABLED = "true";
    await runImapTick();
    expect(synced()).toEqual(["u-naver:NAVER", "u-cohort:YAHOO", "u-outside:FASTMAIL"]);
  });

  it("cohort: only the cohort's preset rows are polled; other providers are untouched", async () => {
    process.env.IMAP_PRESETS_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "u-cohort";
    await runImapTick();
    expect(synced()).toEqual(["u-naver:NAVER", "u-cohort:YAHOO"]);
  });
});
