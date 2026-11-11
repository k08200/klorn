/**
 * The INBOX reconcile runs detached from the scheduler's per-user cycle.
 *
 * Production, 2026-11-11: reconcile lists the whole Gmail INBOX and re-reads up
 * to 500 messages per inbox. For the two users with a few thousand mirrored
 * messages the re-read alone took 41-51 s per inbox (EmailMessage.updatedAt of
 * exactly the newest 500 rows per inbox, 11:07:56-11:09:26Z), so awaited inside
 * runUserCycle it overran PER_USER_AUTOMATION_TIMEOUT_MS (30 s) every time:
 * "[scheduler] user cycle skipped (timeout or error)" for both users, 30 s
 * apart. withTimeout does not cancel, so the "skipped" cycle went on in the
 * background while the next tick re-entered the same user.
 *
 * Harness: automation-scheduler-linked-first-mailbox.test.ts's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  isEntitled: vi.fn((_plan: string, _role?: string) => true),
  captureError: vi.fn(),
  syncEmails: vi.fn(async (..._args: unknown[]) => ({ newCount: 0 })),
  syncLinkedInboxesForUser: vi.fn(async (_userId: string) => ({ newCount: 0 })),
  backfill: vi.fn(async (_userId: string) => 0),
  getLinkedInboxClients: vi.fn(async (_userId: string) => [] as unknown[]),
  reconcileEmails: vi.fn(async (_userId: string) => ({ removed: 0, updated: 0 })),
  reconcileLinkedInboxes: vi.fn(async (_userId: string) => ({ removed: 0, updated: 0 })),
  checkAutoReplyRules: vi.fn(async () => null),
  sendPushNotification: vi.fn(async () => ({})),
  sendSms: vi.fn(async () => ({})),
  startDetachedReconcile: vi.fn((..._args: unknown[]): Promise<void> | null => null),
  realStartDetachedReconcile: null as null | ((...args: never[]) => Promise<void> | null),
  resetReconcileJobs: null as null | (() => void),
  overrides: new Map<string, (...args: unknown[]) => unknown>(),
  calls: [] as Array<{ key: string; args: unknown[] }>,
}));

vi.mock("googleapis", () => ({
  google: { calendar: vi.fn(() => ({ events: { list: vi.fn() } })) },
}));
vi.mock("../mail/gmail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mail/gmail.js")>()),
  getAuthedClient: vi.fn(async () => ({})),
  buildLinkedCalendarClient: vi.fn(() => null),
  getLinkedInboxClients: m.getLinkedInboxClients,
  renewExpiringGmailWatches: vi.fn(async () => ({ renewed: 0, failed: 0 })),
}));
vi.mock("../mail/email-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mail/email-sync.js")>()),
  checkAutoReplyRules: m.checkAutoReplyRules,
  reconcileEmails: m.reconcileEmails,
  reconcileLinkedInboxes: m.reconcileLinkedInboxes,
  summarizeUnsummarizedEmails: vi.fn(async () => 0),
  syncEmails: m.syncEmails,
  syncSpamLane: vi.fn(async () => 0),
  syncLinkedInboxesForUser: m.syncLinkedInboxesForUser,
  backfillEmailAttentionItems: m.backfill,
}));
// Pass-through to the real job, so a test can stand in for it (the cap).
vi.mock("../mail/reconcile-job.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mail/reconcile-job.js")>();
  m.realStartDetachedReconcile = actual.startDetachedReconcile as never;
  m.resetReconcileJobs = actual.resetReconcileJobsForTests;
  return { ...actual, startDetachedReconcile: m.startDetachedReconcile };
});
vi.mock("../mail/sent-messages.js", () => ({ syncSentMessages: vi.fn(async () => {}) }));
vi.mock("../mail/email-candidate-intake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mail/email-candidate-intake.js")>()),
  syncRecentCandidateIntakes: vi.fn(async () => 0),
}));
vi.mock("../judge/fallback-rejudge.js", () => ({ sweepFallbackRejudge: vi.fn(async () => 0) }));
vi.mock("../notify/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notify/push.js")>()),
  sendPushNotification: m.sendPushNotification,
}));
vi.mock("../notify/sms.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notify/sms.js")>()),
  sendSms: m.sendSms,
}));
vi.mock("../websocket.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../websocket.js")>()),
  pushNotification: vi.fn(),
}));
vi.mock("../sentry.js", () => ({ captureError: m.captureError, initSentry: vi.fn() }));
vi.mock("../billing/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/stripe.js")>()),
  isEntitled: m.isEntitled,
}));
vi.mock("../pim/daily-digest.js", () => ({ sendDailyDigests: vi.fn(async () => {}) }));
vi.mock("../pim/weekly-report.js", () => ({ sendWeeklySignalReports: vi.fn(async () => {}) }));
vi.mock("../judge/calibration-snapshot.js", () => ({
  runDailyCalibrationSnapshots: vi.fn(async () => {}),
}));
vi.mock("../learning/ontology-proposals-store.js", () => ({
  recomputeOntologyProposalsSafe: vi.fn(async () => {}),
}));
vi.mock("../judge/judge-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../judge/judge-health.js")>()),
  runJudgeHeartbeatCheck: vi.fn(async () => {}),
}));

/** A prisma whose every table method resolves to a harmless empty value. */
vi.mock("../db.js", () => {
  const EMPTY: Record<string, unknown> = {
    findMany: [],
    findFirst: null,
    findUnique: null,
    count: 0,
    groupBy: [],
    deleteMany: { count: 0 },
    updateMany: { count: 0 },
  };
  const table = (name: string) =>
    new Proxy(
      {},
      {
        get: (_target, method: string) => {
          const key = `${name}.${method}`;
          return (...args: unknown[]) => {
            m.calls.push({ key, args });
            const override = m.overrides.get(key);
            if (override) return Promise.resolve(override(...args));
            return Promise.resolve(method in EMPTY ? EMPTY[method] : {});
          };
        },
      },
    );
  const tables = new Map<string, unknown>();
  const prisma = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name === "$queryRawUnsafe") {
          return (sql: string) => {
            m.calls.push({
              key: `$queryRawUnsafe:${sql.includes("unlock") ? "unlock" : "lock"}`,
              args: [],
            });
            return Promise.resolve([{ locked: true, unlocked: true }]);
          };
        }
        if (name === "$queryRaw") return () => Promise.resolve([]);
        if (name === "$transaction") {
          return (arg: unknown) =>
            typeof arg === "function"
              ? (arg as (tx: unknown) => unknown)(prisma)
              : Promise.all(arg as unknown[]);
        }
        if (!tables.has(name)) tables.set(name, table(name));
        return tables.get(name);
      },
    },
  );
  return { prisma, db: prisma };
});

const USER = "user-1";
const NOW = new Date("2026-09-30T03:00:00.000Z");
const ENV_KEYS = ["MULTI_INBOX_SYNC_ENABLED", "PAYWALL_ENABLED"] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function override(key: string, fn: (...args: unknown[]) => unknown) {
  m.overrides.set(key, fn);
}

/** Run exactly one scheduler tick and wait for it to release its lock. */
async function runOneTick() {
  vi.resetModules();
  const scheduler = await import("../automation-scheduler.js");
  scheduler.startAutomationScheduler();
  const deadline = performance.now() + 4000;
  while (!m.calls.some((c) => c.key === "$queryRawUnsafe:unlock")) {
    if (performance.now() > deadline) throw new Error("scheduler tick did not finish");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  scheduler.stopAutomationScheduler();
}

/** Arrange one user: plan, whether a primary Google token exists, and their linked Google rows. */
function arrangeUser(opts: { plan: string; primary: boolean; linkedGoogle: boolean }) {
  override("user.findMany", () => [{ id: USER, plan: opts.plan, role: "USER" }]);
  override("userToken.findMany", () => (opts.primary ? [{ userId: USER }] : []));
  override("linkedInboxAccount.findMany", (arg) => {
    const where = (arg as { where?: Record<string, unknown> }).where ?? {};
    return where.provider === "GOOGLE" && opts.linkedGoogle ? [{ userId: USER }] : [];
  });
  m.getLinkedInboxClients.mockResolvedValue(
    opts.linkedGoogle ? [{ id: "linked-1", email: "me@gmail.com", client: {} }] : [],
  );
}

/** syncEmails calls for a linked inbox (4th argument set). */
const linkedSyncCalls = () => m.syncEmails.mock.calls.filter((c) => c[3] !== undefined);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  m.overrides.clear();
  m.calls.length = 0;
  m.syncEmails.mockResolvedValue({ newCount: 0 });
  m.syncLinkedInboxesForUser.mockResolvedValue({ newCount: 0 });
  m.isEntitled.mockReturnValue(true);
  m.reconcileEmails.mockResolvedValue({ removed: 0, updated: 0 });
  m.reconcileLinkedInboxes.mockResolvedValue({ removed: 0, updated: 0 });
  // The mocked job module outlives vi.resetModules: drop a hung run a test left behind.
  m.resetReconcileJobs?.();
  m.startDetachedReconcile.mockImplementation((...args: unknown[]) =>
    // biome-ignore lint/style/noNonNullAssertion: set by the module mock on import
    m.realStartDetachedReconcile!(...(args as never[])),
  );
  process.env.MULTI_INBOX_SYNC_ENABLED = "true";
  process.env.PAYWALL_ENABLED = "true";
  override("automationConfig.findMany", () => [
    {
      userId: USER,
      dailyBriefing: false,
      emailAutoClassify: true,
      autonomousAgent: false,
      proactiveActions: false,
      phoneEscalationEnabled: false,
      focusWindowEnabled: false,
      attentionMode: "SUGGEST",
      timezone: "Asia/Seoul",
    },
  ]);
  override("user.findUnique", () => ({ id: USER, timezone: "Asia/Seoul" }));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The urgent keyword sweep: the step that runs after reconcile in the cycle. */
const urgentSweepQueried = () =>
  m.calls.some(
    (c) =>
      c.key === "emailMessage.findMany" &&
      (c.args[0] as { where?: { priority?: string } } | undefined)?.where?.priority === "URGENT",
  );

describe("reconcile is detached from the per-user cycle", () => {
  it("a reconcile still running does not hold up the cycle, the steps after it, or the tick", async () => {
    m.reconcileEmails.mockImplementation(() => new Promise(() => {}));
    arrangeUser({ plan: "PRO", primary: true, linkedGoogle: false });

    await runOneTick();

    expect(m.reconcileEmails).toHaveBeenCalledWith(USER);
    expect(urgentSweepQueried()).toBe(true);
    expect(m.captureError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: expect.objectContaining({ scope: "scheduler.user-cycle" }),
      }),
    );
  });

  it("reconciles the linked inboxes too while linked sync is on", async () => {
    arrangeUser({ plan: "PRO", primary: true, linkedGoogle: true });

    await runOneTick();

    await vi.waitFor(() => expect(m.reconcileLinkedInboxes).toHaveBeenCalledWith(USER));
    expect(m.reconcileEmails).toHaveBeenCalledWith(USER);
  });

  it("leaves the linked inboxes alone while linked sync is off", async () => {
    delete process.env.MULTI_INBOX_SYNC_ENABLED;
    arrangeUser({ plan: "PRO", primary: true, linkedGoogle: false });

    await runOneTick();

    await vi.waitFor(() => expect(m.reconcileEmails).toHaveBeenCalledWith(USER));
    expect(m.reconcileLinkedInboxes).not.toHaveBeenCalled();
  });

  it("a failing reconcile is reported and never fails the cycle", async () => {
    m.reconcileEmails.mockRejectedValue(new Error("Gmail 500"));
    arrangeUser({ plan: "PRO", primary: true, linkedGoogle: false });

    await runOneTick();

    await vi.waitFor(() =>
      expect(m.captureError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ scope: "automation.reconcile", userId: USER }),
        }),
      ),
    );
    expect(urgentSweepQueried()).toBe(true);
  });
});

describe("a user turned away at the reconcile concurrency cap", () => {
  /** One tick of an already-imported scheduler, so its per-user due state carries over. */
  async function tickOnce(scheduler: typeof import("../automation-scheduler.js")) {
    m.calls.length = 0;
    scheduler.startAutomationScheduler();
    const deadline = performance.now() + 4000;
    while (!m.calls.some((c) => c.key === "$queryRawUnsafe:unlock")) {
      if (performance.now() > deadline) throw new Error("scheduler tick did not finish");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    scheduler.stopAutomationScheduler();
  }

  /** Two ticks a minute apart (email sync, and the reconcile check in it, is due each minute). */
  async function twoTicks() {
    vi.resetModules();
    const scheduler = await import("../automation-scheduler.js");
    await tickOnce(scheduler);
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    await tickOnce(scheduler);
  }

  it("is tried again on the next tick, not 30 minutes later", async () => {
    m.startDetachedReconcile.mockReturnValueOnce(null);
    arrangeUser({ plan: "PRO", primary: true, linkedGoogle: false });

    await twoTicks();

    expect(m.startDetachedReconcile).toHaveBeenCalledTimes(2);
  });

  it("once a reconcile has started, the next tick does not start another", async () => {
    arrangeUser({ plan: "PRO", primary: true, linkedGoogle: false });

    await twoTicks();

    expect(m.startDetachedReconcile).toHaveBeenCalledTimes(1);
    expect(m.reconcileEmails).toHaveBeenCalledTimes(1);
  });
});
