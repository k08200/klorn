/**
 * The scheduler's linked-inbox sync, driven through one real tick of
 * `startAutomationScheduler`, under the first-mailbox-free rule (founder
 * decision 2026-10-15):
 *
 * - A user WITHOUT a primary Google token whose mailbox is a linked Google
 *   inbox gets it synced by the scheduler (before: only on a manual /sync,
 *   because the linked fan-out lived inside the primary Gmail block).
 * - The fan-out for users WITH a primary token is scoped like connecting:
 *   paywall off or multi_account → every linked inbox; FREE → none (their
 *   linked inbox is a second mailbox).
 * - Linked Google sync of any kind stays behind MULTI_INBOX_SYNC_ENABLED.
 *
 * Harness: automation-urgent-sweep-history.test.ts's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  isEntitled: vi.fn((_plan: string, _role?: string) => true),
  captureError: vi.fn(),
  syncEmails: vi.fn(async (..._args: unknown[]) => ({ newCount: 0 })),
  syncLinkedInboxesForUser: vi.fn(async (_userId: string) => ({ newCount: 0 })),
  backfill: vi.fn(async (_userId: string) => 0),
  getLinkedInboxClients: vi.fn(async (_userId: string) => [] as unknown[]),
  checkAutoReplyRules: vi.fn(async () => null),
  sendPushNotification: vi.fn(async () => ({})),
  sendSms: vi.fn(async () => ({})),
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
  reconcileEmails: vi.fn(async () => ({ removed: 0 })),
  reconcileLinkedInboxes: vi.fn(async () => {}),
  summarizeUnsummarizedEmails: vi.fn(async () => 0),
  syncEmails: m.syncEmails,
  syncSpamLane: vi.fn(async () => 0),
  syncLinkedInboxesForUser: m.syncLinkedInboxesForUser,
  backfillEmailAttentionItems: m.backfill,
}));
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
vi.mock("../llm/openrouter-catalog-check.js", () => ({
  runOpenRouterCatalogCheck: vi.fn(async () => {}),
}));
vi.mock("../llm/openrouter-key-health.js", () => ({
  runOpenRouterKeyCheck: vi.fn(async () => {}),
}));
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  m.overrides.clear();
  m.calls.length = 0;
  m.syncEmails.mockResolvedValue({ newCount: 0 });
  m.syncLinkedInboxesForUser.mockResolvedValue({ newCount: 0 });
  m.isEntitled.mockReturnValue(true);
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

describe("no primary Google token: the linked inbox is the user's mailbox", () => {
  it("a FREE user's first (linked Google) mailbox is synced by the scheduler", async () => {
    arrangeUser({ plan: "FREE", primary: false, linkedGoogle: true });
    await runOneTick();
    expect(m.syncLinkedInboxesForUser).toHaveBeenCalledWith(USER);
    expect(m.backfill).toHaveBeenCalledWith(USER);
    // The primary Gmail sync is not attempted without a token.
    expect(m.syncEmails).not.toHaveBeenCalled();
  });

  it("a PRO user without a primary token gets the same scheduled sync", async () => {
    arrangeUser({ plan: "PRO", primary: false, linkedGoogle: true });
    await runOneTick();
    expect(m.syncLinkedInboxesForUser).toHaveBeenCalledWith(USER);
  });

  it("stays dark while MULTI_INBOX_SYNC_ENABLED is off", async () => {
    delete process.env.MULTI_INBOX_SYNC_ENABLED;
    arrangeUser({ plan: "FREE", primary: false, linkedGoogle: true });
    await runOneTick();
    expect(m.syncLinkedInboxesForUser).not.toHaveBeenCalled();
  });

  it("skips users with no linked Google row (IMAP-only, abandoned signups)", async () => {
    arrangeUser({ plan: "FREE", primary: false, linkedGoogle: false });
    await runOneTick();
    expect(m.syncLinkedInboxesForUser).not.toHaveBeenCalled();
  });

  it("honours an explicit emailAutoClassify opt-out", async () => {
    override("automationConfig.findMany", () => [
      { userId: USER, emailAutoClassify: false, timezone: "Asia/Seoul" },
    ]);
    arrangeUser({ plan: "FREE", primary: false, linkedGoogle: true });
    await runOneTick();
    expect(m.syncLinkedInboxesForUser).not.toHaveBeenCalled();
  });

  it("a failing linked sync is reported and never fails the tick", async () => {
    m.syncLinkedInboxesForUser.mockRejectedValue(new Error("quota"));
    arrangeUser({ plan: "FREE", primary: false, linkedGoogle: true });
    await runOneTick();
    expect(m.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ scope: "automation.linked-only-sync" }),
      }),
    );
  });
});

describe("with a primary Google token: the fan-out after the primary sync", () => {
  it("FREE (paywall on): the linked inbox is a second mailbox and is not synced", async () => {
    arrangeUser({ plan: "FREE", primary: true, linkedGoogle: true });
    await runOneTick();
    expect(m.syncEmails).toHaveBeenCalledWith(USER, 20);
    expect(linkedSyncCalls()).toHaveLength(0);
    expect(m.syncLinkedInboxesForUser).not.toHaveBeenCalled();
  });

  it("PRO: every linked inbox is synced", async () => {
    arrangeUser({ plan: "PRO", primary: true, linkedGoogle: true });
    await runOneTick();
    expect(linkedSyncCalls()).toHaveLength(1);
  });

  it("paywall off: every linked inbox is synced for FREE too (same as connect)", async () => {
    delete process.env.PAYWALL_ENABLED;
    arrangeUser({ plan: "FREE", primary: true, linkedGoogle: true });
    await runOneTick();
    expect(linkedSyncCalls()).toHaveLength(1);
  });
});
