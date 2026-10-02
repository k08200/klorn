/**
 * The urgent-email sweep and the rule auto-reply loop, driven through one real tick
 * of `startAutomationScheduler`, after an IMAP UIDVALIDITY repair (step B2b of
 * docs/providers/unified-platform-plan.md).
 *
 * A repair re-keys the old rows (`#uv<old>.<ms>`) and re-ingests the INBOX window as
 * new rows. Neither may ring again: the sweep skips tombstones and re-ingested history
 * (an IMAP row received before its account's `inboxUidValidityResetAt`), the rule
 * auto-reply loop skips history before matching a rule. Mail received during the hold
 * keeps its side effects, and Gmail rows go through exactly as before.
 *
 * Harness: the calendar-sync test's (automation-scheduler-calendar-sync.test.ts), a
 * prisma whose every call resolves empty unless a test overrides it, and the Gmail
 * sync itself mocked away.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  isEntitled: vi.fn((_plan: string, _role?: string) => true),
  captureError: vi.fn(),
  syncEmails: vi.fn(async () => ({ newCount: 0 })),
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
  getLinkedInboxClients: vi.fn(async () => []),
  renewExpiringGmailWatches: vi.fn(async () => ({ renewed: 0, failed: 0 })),
}));
vi.mock("../mail/email-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mail/email-sync.js")>()),
  backfillEmailAttentionItems: vi.fn(async () => 0),
  checkAutoReplyRules: m.checkAutoReplyRules,
  reconcileEmails: vi.fn(async () => ({ removed: 0 })),
  reconcileLinkedInboxes: vi.fn(async () => {}),
  summarizeUnsummarizedEmails: vi.fn(async () => 0),
  syncEmails: m.syncEmails,
  syncSpamLane: vi.fn(async () => 0),
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
const RESET_AT = new Date(NOW.getTime() - 20 * 60_000);
const ACCOUNT = "acc-naver";
/** The IMAP mailboxes the sweeps must hold for: Naver, and generic IMAP (step B4). */
const IMAP_CASES = [
  { label: "Naver", head: "naver-imap:me@naver.com" },
  { label: "generic IMAP", head: "generic-imap:me@example.com" },
] as const;
/** The id head of the mailbox under test; set per mailbox by the describe.each blocks below. */
let IMAP: string = IMAP_CASES[0].head;

interface UrgentRow {
  id: string;
  gmailId: string;
  subject: string;
  from: string;
  summary: string | null;
  createdAt: Date;
  receivedAt: Date;
  linkedInboxAccountId: string | null;
}

const urgent = (
  id: string,
  gmailId: string,
  receivedAt: Date,
  linkedInboxAccountId: string | null,
): UrgentRow => ({
  id,
  gmailId,
  subject: `Subject ${id}`,
  from: "Kim <kim@example.com>",
  summary: null,
  createdAt: new Date(NOW.getTime() - 60_000),
  receivedAt,
  linkedInboxAccountId,
});

const BEFORE_RESET = new Date(RESET_AT.getTime() - 60_000);
const DURING_HOLD = new Date(RESET_AT.getTime() + 60_000);

function override(key: string, fn: (...args: unknown[]) => unknown) {
  m.overrides.set(key, fn);
}

const argsOf = (key: string) => m.calls.filter((c) => c.key === key).map((c) => c.args[0]);

/** The sweep's rows, the markers it reads, and the reset of the IMAP account. */
function arrange(rows: UrgentRow[], autoReplyRows: Record<string, unknown>[] = []) {
  override("emailMessage.findMany", (arg) => {
    const where = (arg as { where?: Record<string, unknown> }).where ?? {};
    if (where.priority === "URGENT") return rows;
    if ((arg as { orderBy?: Record<string, unknown> }).orderBy?.syncedAt) return autoReplyRows;
    return [];
  });
  override("linkedInboxAccount.findMany", (arg) => {
    const select = (arg as { select?: Record<string, unknown> }).select ?? {};
    return select.inboxUidValidityResetAt
      ? [{ id: ACCOUNT, inboxUidValidityResetAt: RESET_AT }]
      : [];
  });
  override("notification.create", (arg) => ({
    id: "n-1",
    createdAt: NOW,
    ...((arg as { data: object }).data ?? {}),
  }));
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

const createdNotifications = () =>
  argsOf("notification.create").map((a) => (a as { data: Record<string, unknown> }).data);
const resetLookups = () =>
  argsOf("linkedInboxAccount.findMany").filter(
    (a) => (a as { select?: Record<string, unknown> }).select?.inboxUidValidityResetAt,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  m.overrides.clear();
  m.calls.length = 0;
  m.syncEmails.mockResolvedValue({ newCount: 0 });
  m.isEntitled.mockReturnValue(true);
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
  override("user.findMany", () => [{ id: USER, plan: "PRO", role: "USER" }]);
  override("userToken.findMany", () => [{ userId: USER }]);
  override("user.findUnique", () => ({ id: USER, timezone: "Asia/Seoul" }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(IMAP_CASES)("$label: the urgent sweep after an IMAP repair", (imapCase) => {
  beforeEach(() => {
    IMAP = imapCase.head;
  });
  it("rings only for Gmail mail and IMAP mail received during the hold; never for history or tombstones", async () => {
    arrange([
      urgent("gmail", "18abc", BEFORE_RESET, null),
      urgent("history", `${IMAP}:1`, BEFORE_RESET, ACCOUNT),
      urgent("tombstone", `${IMAP}:7#uv1000.1727660000000`, BEFORE_RESET, ACCOUNT),
      urgent("during-hold", `${IMAP}:2`, DURING_HOLD, ACCOUNT),
    ]);

    await runOneTick();

    const created = createdNotifications().filter((d) => d.title === "Urgent email");
    expect(created).toHaveLength(1);
    expect(String(created[0].message).endsWith(`[18abc,${IMAP}:2]`)).toBe(true);
    expect(m.sendPushNotification).toHaveBeenCalledTimes(1);
    expect(resetLookups()).toHaveLength(1);
  });

  it("rings for nothing when every urgent row is history", async () => {
    arrange([
      urgent("history", `${IMAP}:1`, BEFORE_RESET, ACCOUNT),
      urgent("tombstone", `${IMAP}:7#uv1000.1727660000000`, BEFORE_RESET, ACCOUNT),
    ]);

    await runOneTick();

    expect(createdNotifications().filter((d) => d.title === "Urgent email")).toEqual([]);
    expect(m.sendPushNotification).not.toHaveBeenCalled();
    expect(m.sendSms).not.toHaveBeenCalled();
  });

  it("Gmail only: no account lookup, the same key, and an older marker still silences", async () => {
    arrange([urgent("g1", "18abc", BEFORE_RESET, null), urgent("g2", "18def", BEFORE_RESET, null)]);
    override("notification.findMany", (arg) => {
      const where = (arg as { where?: { OR?: unknown[] } }).where;
      return where?.OR
        ? [{ message: "Kim: older [18def]", createdAt: new Date(NOW.getTime() - 3_600_000) }]
        : [];
    });

    await runOneTick();

    const created = createdNotifications().filter((d) => d.title === "Urgent email");
    expect(created).toHaveLength(1);
    expect(created[0].dedupeKey).toBe("urgent:18abc");
    expect(String(created[0].message)).toMatch(/\[18abc\]$/);
    expect(resetLookups()).toEqual([]);
  });
});

describe.each(IMAP_CASES)("$label: the rule auto-reply loop after an IMAP repair", (imapCase) => {
  beforeEach(() => {
    IMAP = imapCase.head;
  });
  it("never matches a rule for re-ingested history; Gmail mail goes through as before", async () => {
    m.syncEmails.mockResolvedValue({ newCount: 2 });
    const gmailRow = { ...urgent("gmail", "18abc", BEFORE_RESET, null), body: "", labels: [] };
    const historyRow = {
      ...urgent("history", `${IMAP}:1`, BEFORE_RESET, ACCOUNT),
      body: "",
      labels: [],
    };
    arrange([], [historyRow, gmailRow]);

    await runOneTick();

    expect(m.checkAutoReplyRules).toHaveBeenCalledTimes(1);
    expect(m.checkAutoReplyRules).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ id: "gmail" }),
    );
  });
});

/**
 * A failed reset lookup must not end the user's tick: it used to escape to the per-user
 * catch ("Email sync failed") and skip the Gmail alert of a mixed batch. IMAP rows fail
 * closed for that tick; Gmail rows go through.
 */
describe.each(IMAP_CASES)("$label: a failing reset lookup", (imapCase) => {
  beforeEach(() => {
    IMAP = imapCase.head;
  });
  const failLookup = () =>
    override("linkedInboxAccount.findMany", (arg) => {
      if ((arg as { select?: Record<string, unknown> }).select?.inboxUidValidityResetAt) {
        throw new Error("db down");
      }
      return [];
    });
  const syncFailed = () =>
    (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([line]) =>
      String(line).includes("Email sync failed"),
    );

  it("in the urgent sweep: still rings for the Gmail row, not for the IMAP row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    arrange([
      urgent("gmail", "18abc", BEFORE_RESET, null),
      urgent("during-hold", `${IMAP}:2`, DURING_HOLD, ACCOUNT),
    ]);
    failLookup();

    await runOneTick();

    const created = createdNotifications().filter((d) => d.title === "Urgent email");
    expect(created).toHaveLength(1);
    expect(String(created[0].message)).toMatch(/\[18abc\]$/);
    expect(m.sendPushNotification).toHaveBeenCalledTimes(1);
    expect(m.sendSms).toHaveBeenCalledTimes(1);
    expect(syncFailed()).toEqual([]);
    expect(m.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { scope: "imap-history.urgent-sweep" } }),
    );
  });

  it("in the rule auto-reply loop: Gmail is still matched, IMAP is not, and the urgent sweep after it runs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.syncEmails.mockResolvedValue({ newCount: 2 });
    const gmailRow = { ...urgent("gmail", "18abc", BEFORE_RESET, null), body: "", labels: [] };
    const imapRow = { ...urgent("imap", `${IMAP}:2`, DURING_HOLD, ACCOUNT), body: "", labels: [] };
    arrange([urgent("gmail-urgent", "18def", BEFORE_RESET, null)], [imapRow, gmailRow]);
    failLookup();

    await runOneTick();

    expect(m.checkAutoReplyRules).toHaveBeenCalledTimes(1);
    expect(m.checkAutoReplyRules).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ id: "gmail" }),
    );
    expect(createdNotifications().filter((d) => d.title === "Urgent email")).toHaveLength(1);
    expect(syncFailed()).toEqual([]);
  });
});
