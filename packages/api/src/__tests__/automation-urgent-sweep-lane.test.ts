/**
 * The urgent-email sweep obeys the lane contract (docs/design/tier-ontology-v2.md):
 * it rings only mail whose OPEN firewall item is in the PUSH lane. A keyword
 * "urgent" (EmailMessage.priority = URGENT) never outranks the judge's lane.
 *
 * Production, 2026-11-11: a test mail the judge put in QUEUE at 03:22:44Z still rang
 * an "Urgent email" interrupt from this sweep at 03:23:14Z. Over 30 days 34 of 39
 * "Urgent email" rows came from the sweep; of the mails they named that mapped to a
 * firewall item, 6 were PUSH and 19 were QUEUE, MEETING or SILENT.
 *
 * The sweep is now a safety net for PUSH mail the firewall push did not ring. Mail the
 * judge has not reached yet waits for the judge's own push (the firewall rings it when
 * the item lands). Users under policy v3 stand down from the sweep as before.
 *
 * One exception keeps the pre-#1687 net for a judge outage: when the LLM did not judge
 * the mail (DecisionLabel.decidedBy = "keyword-fallback") and the fallback put it in
 * QUEUE, which is where an urgent mail from an ordinary person lands (poc-judge.ts calls
 * that "a missed interrupt"), the keyword priority still rings it, unless a human or an
 * MCP agent has moved or confirmed the lane since. Like the firewall push, the sweep
 * rings only mail received in the last 6 hours (FIREWALL_PUSH_RECENCY_MS).
 *
 * Harness: the urgent-sweep history test's (automation-urgent-sweep-history.test.ts),
 * one real tick of `startAutomationScheduler` over a prisma whose every call resolves
 * empty unless a test overrides it. AttentionItem reads are answered by filtering a
 * table of items the way the database would.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firewallBellRow } from "../judge/firewall-push.js";

const m = vi.hoisted(() => ({
  isEntitled: vi.fn((_plan: string, _role?: string) => true),
  captureError: vi.fn(),
  syncEmails: vi.fn(async () => ({ newCount: 0 })),
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
  checkAutoReplyRules: vi.fn(async () => null),
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
            if (override) {
              try {
                return Promise.resolve(override(...args));
              } catch (err) {
                return Promise.reject(err);
              }
            }
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
const NOW = new Date("2026-11-11T03:23:14.000Z");

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

interface Item {
  id: string;
  userId: string;
  source: string;
  sourceId: string;
  status: "OPEN" | "RESOLVED" | "DISMISSED" | "SNOOZED";
  tier: string | null;
  isManualOverride: boolean;
  agentTierSetAt: Date | null;
}

/** The decision ledger row of a mail (DecisionLabel): which path set its lane. */
interface Label {
  userId: string;
  source: string;
  sourceId: string;
  decidedBy: string | null;
  outcome: string | null;
}

const urgent = (id: string, gmailId: string): UrgentRow => ({
  id,
  gmailId,
  subject: `Subject ${id}`,
  from: "Kim <kim@example.com>",
  summary: null,
  createdAt: new Date(NOW.getTime() - 60_000),
  receivedAt: new Date(NOW.getTime() - 60_000),
  linkedInboxAccountId: null,
});

const item = (
  emailId: string,
  tier: string | null,
  status: Item["status"] = "OPEN",
  moved: Partial<Pick<Item, "isManualOverride" | "agentTierSetAt">> = {},
): Item => ({
  id: `item-${emailId}`,
  userId: USER,
  source: "EMAIL",
  sourceId: emailId,
  status,
  tier,
  isManualOverride: false,
  agentTierSetAt: null,
  ...moved,
});

const label = (
  emailId: string,
  decidedBy: string | null,
  outcome: string | null = null,
): Label => ({
  userId: USER,
  source: "EMAIL",
  sourceId: emailId,
  decidedBy,
  outcome,
});

/** An urgent mail received `ageMs` ago and synced just now. */
const receivedAgo = (row: UrgentRow, ageMs: number): UrgentRow => ({
  ...row,
  receivedAt: new Date(NOW.getTime() - ageMs),
});

const HOUR_MS = 60 * 60 * 1000;

function override(key: string, fn: (...args: unknown[]) => unknown) {
  m.overrides.set(key, fn);
}

const argsOf = (key: string) => m.calls.filter((c) => c.key === key).map((c) => c.args[0]);

/** A where value as Prisma reads it: a literal, `{ in: [...] }` or `{ gte: Date }`. */
function matches(value: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (condition && typeof condition === "object" && "in" in condition) {
    return (condition as { in: unknown[] }).in.includes(value);
  }
  if (condition && typeof condition === "object" && "gte" in condition) {
    const floor = (condition as { gte: Date }).gte;
    return value instanceof Date && value.getTime() >= floor.getTime();
  }
  return value === condition;
}

/** A row against the named columns of a where clause, and one of its `OR` branches if any. */
function rowMatches<Row>(
  row: Row,
  where: Record<string, unknown>,
  columns: readonly (keyof Row)[],
) {
  const all = (clause: Record<string, unknown>) =>
    columns.every((column) => matches(row[column], clause[column as string]));
  const branches = (where.OR as Array<Record<string, unknown>> | undefined) ?? [{}];
  return all(where) && branches.some(all);
}

const ITEM_COLUMNS = [
  "userId",
  "source",
  "sourceId",
  "status",
  "tier",
  "isManualOverride",
  "agentTierSetAt",
] as const;
const LABEL_COLUMNS = ["userId", "source", "sourceId", "decidedBy", "outcome"] as const;

/**
 * The firewall items of mail, answered as the database would for a lookup by mail id
 * (`source: EMAIL`, `sourceId: { in }`). Any other AttentionItem read in the tick
 * gets nothing, as in the shared harness.
 */
function itemsTable(items: readonly Item[]) {
  return (arg: unknown) => {
    const where = (arg as { where?: Record<string, unknown> }).where ?? {};
    if (where.source !== "EMAIL" || !where.sourceId) return [];
    return items.filter((row) => rowMatches(row, where, ITEM_COLUMNS));
  };
}

/** The decision ledger rows of mail, answered the same way for a lookup by mail id. */
function arrangeLedger(labels: readonly Label[]) {
  override("decisionLabel.findMany", (arg) => {
    const where = (arg as { where?: Record<string, unknown> }).where ?? {};
    if (where.source !== "EMAIL" || !where.sourceId) return [];
    return labels.filter((row) => rowMatches(row, where, LABEL_COLUMNS));
  });
}

/** The urgent mail the sweep reads, their firewall items, and the bell rows already written. */
function arrange(
  rows: UrgentRow[],
  items: Item[],
  bell: Array<{ type: string; title: string; message: string; createdAt: Date }> = [],
) {
  override("emailMessage.findMany", (arg) => {
    const where = (arg as { where?: Record<string, unknown> }).where ?? {};
    if (where.priority !== "URGENT") return [];
    // Every row was synced in the sweep's last hour; the receipt time is checked
    // as the database would.
    return rows.filter((row) => matches(row.receivedAt, where.receivedAt));
  });
  override("attentionItem.findMany", itemsTable(items));
  override("attentionItem.findFirst", (arg) => itemsTable(items)(arg)[0] ?? null);
  override("notification.findMany", (arg) => {
    const where = (arg as { where?: Record<string, unknown> }).where ?? {};
    if (!where.title) return [];
    return bell
      .filter((row) => matches(row.type, where.type) && matches(row.title, where.title))
      .map(({ message, createdAt }) => ({ message, createdAt }));
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

const urgentRows = () =>
  argsOf("notification.create")
    .map((a) => (a as { data: Record<string, unknown> }).data)
    .filter((d) => d.title === "Urgent email");
/** The device pushes for urgent mail: [userId, payload, category, options]. */
const urgentPushes = () =>
  (m.sendPushNotification.mock.calls as unknown[][]).filter((call) => call[2] === "email_urgent");
const syncFailed = () =>
  (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(([line]) =>
    String(line).includes("Email sync failed"),
  );

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
  delete process.env.JUDGE_V3_POLICY;
  delete process.env.JUDGE_V3_SHADOW;
});

describe("the urgent sweep rings only for mail the judge put in the PUSH lane", () => {
  it.each([
    "QUEUE",
    "MEETING",
    "INFO",
    "SILENT",
  ])("a keyword-urgent mail in %s does not ring", async (tier) => {
    arrange([urgent("mail-1", "18abc")], [item("mail-1", tier)]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
    expect(urgentPushes()).toEqual([]);
    expect(m.sendSms).not.toHaveBeenCalled();
  });

  it("a PUSH mail the firewall has not rung rings once, as an interrupt naming its item", async () => {
    arrange([urgent("mail-1", "18abc")], [item("mail-1", "PUSH")]);

    await runOneTick();

    const rows = urgentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceEmailId).toBe("mail-1");
    expect(String(rows[0].message)).toMatch(/\[18abc\]$/);
    const pushes = urgentPushes();
    expect(pushes).toHaveLength(1);
    expect(pushes[0][1]).toMatchObject({ attentionItemId: "item-mail-1", lane: "PUSH" });
    expect(pushes[0][3]).toEqual({ bucket: "interrupt" });
  });

  it.each([
    ["a human", { isManualOverride: true }],
    ["an MCP agent", { agentTierSetAt: new Date(NOW.getTime() - 60_000) }],
  ] as const)("a PUSH mail %s put there still rings", async (_who, moved) => {
    arrange([urgent("mail-1", "18abc")], [item("mail-1", "PUSH", "OPEN", moved)]);

    await runOneTick();

    expect(urgentRows()).toHaveLength(1);
  });

  it("a mail with the retired v1 name for PUSH (CALL) still rings", async () => {
    arrange([urgent("mail-1", "18abc")], [item("mail-1", "CALL")]);

    await runOneTick();

    expect(urgentRows()).toHaveLength(1);
  });

  it("a PUSH mail the firewall already rang does not ring again", async () => {
    const mail = urgent("mail-1", "18abc");
    const firewallRow = firewallBellRow(
      { ...mail, snippet: null, labels: [], linkedInboxAccountId: null },
      "en",
    );
    arrange(
      [mail],
      [item("mail-1", "PUSH")],
      [{ ...firewallRow, createdAt: new Date(NOW.getTime() - 30_000) }],
    );

    await runOneTick();

    expect(urgentRows()).toEqual([]);
    expect(urgentPushes()).toEqual([]);
  });

  it("a mail the judge has not reached yet (no item) does not ring", async () => {
    arrange([urgent("mail-1", "18abc")], []);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
    expect(urgentPushes()).toEqual([]);
  });

  it.each([
    "RESOLVED",
    "DISMISSED",
    "SNOOZED",
  ] as const)("a PUSH item that is %s does not ring", async (status) => {
    arrange([urgent("mail-1", "18abc")], [item("mail-1", "PUSH", status)]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
  });

  it("a mixed batch rings only the PUSH mail, and the marker names only it", async () => {
    arrange(
      [urgent("push-mail", "18aaa"), urgent("queue-mail", "18bbb"), urgent("pending", "18ccc")],
      [item("push-mail", "PUSH"), item("queue-mail", "QUEUE")],
    );

    await runOneTick();

    const rows = urgentRows();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].message)).toMatch(/\[18aaa\]$/);
    expect(rows[0].sourceEmailId).toBe("push-mail");
  });

  it("reads the lanes of the whole batch in one query, not one per mail", async () => {
    arrange(
      [urgent("a", "18aaa"), urgent("b", "18bbb"), urgent("c", "18ccc")],
      [item("a", "PUSH"), item("b", "PUSH"), item("c", "QUEUE")],
    );

    await runOneTick();

    const laneReads = argsOf("attentionItem.findMany").filter(
      (a) => (a as { where?: Record<string, unknown> }).where?.source === "EMAIL",
    );
    expect(laneReads).toHaveLength(1);
    expect(urgentRows()).toHaveLength(1);
    expect(String(urgentRows()[0].message)).toMatch(/\[18aaa,18bbb\]$/);
  });

  it("a failed lane lookup rings nothing (fail closed) and does not end the user's tick", async () => {
    arrange([urgent("mail-1", "18abc")], [item("mail-1", "PUSH")]);
    override("attentionItem.findMany", (arg) => {
      const where = (arg as { where?: Record<string, unknown> }).where ?? {};
      if (where.source === "EMAIL") throw new Error("db down");
      return [];
    });

    await runOneTick();

    expect(urgentRows()).toEqual([]);
    expect(urgentPushes()).toEqual([]);
    expect(syncFailed()).toEqual([]);
    expect(m.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ scope: "automation.urgent-lane" }),
      }),
    );
  });
});

describe("a judge outage: urgent mail the keyword fallback put in QUEUE still rings", () => {
  it("a keyword-fallback QUEUE mail rings once, as an interrupt naming its item", async () => {
    arrange([urgent("mail-1", "18abc")], [item("mail-1", "QUEUE")]);
    arrangeLedger([label("mail-1", "keyword-fallback")]);

    await runOneTick();

    const rows = urgentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceEmailId).toBe("mail-1");
    expect(String(rows[0].message)).toMatch(/\[18abc\]$/);
    const pushes = urgentPushes();
    expect(pushes).toHaveLength(1);
    expect(pushes[0][1]).toMatchObject({ attentionItemId: "item-mail-1" });
    expect(pushes[0][3]).toEqual({ bucket: "interrupt" });
  });

  it("a keyword-fallback QUEUE mail already rung does not ring again", async () => {
    const mail = urgent("mail-1", "18abc");
    arrange(
      [mail],
      [item("mail-1", "QUEUE")],
      [
        {
          type: "email",
          title: "Urgent email",
          message: "Kim: Subject mail-1 [18abc]",
          createdAt: new Date(NOW.getTime() - 5 * 60_000),
        },
      ],
    );
    arrangeLedger([label("mail-1", "keyword-fallback")]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
    expect(urgentPushes()).toEqual([]);
  });

  it.each([
    "llm",
    "fast-path",
    "sender-prior",
    "pinned-rule",
    "learned-rule",
    null,
  ])("a QUEUE mail decided by %s does not ring", async (decidedBy) => {
    arrange([urgent("mail-1", "18abc")], [item("mail-1", "QUEUE")]);
    arrangeLedger([label("mail-1", decidedBy)]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
    expect(urgentPushes()).toEqual([]);
  });

  it.each([
    "SILENT",
    "INFO",
    "MEETING",
  ])("a keyword-fallback mail in %s does not ring", async (tier) => {
    arrange([urgent("mail-1", "18abc")], [item("mail-1", tier)]);
    arrangeLedger([label("mail-1", "keyword-fallback")]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
    expect(urgentPushes()).toEqual([]);
  });

  it("a keyword-fallback QUEUE mail a human moved there does not ring", async () => {
    arrange(
      [urgent("mail-1", "18abc")],
      [item("mail-1", "QUEUE", "OPEN", { isManualOverride: true })],
    );
    arrangeLedger([label("mail-1", "keyword-fallback")]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
  });

  it("a keyword-fallback QUEUE mail an MCP agent moved there does not ring", async () => {
    arrange(
      [urgent("mail-1", "18abc")],
      [item("mail-1", "QUEUE", "OPEN", { agentTierSetAt: new Date(NOW.getTime() - 60_000) })],
    );
    arrangeLedger([label("mail-1", "keyword-fallback")]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
  });

  it("a keyword-fallback QUEUE mail whose lane the user confirmed does not ring", async () => {
    arrange([urgent("mail-1", "18abc")], [item("mail-1", "QUEUE")]);
    arrangeLedger([label("mail-1", "keyword-fallback", "CONFIRM:QUEUE")]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
  });

  it("a keyword-fallback QUEUE item that is no longer OPEN does not ring", async () => {
    arrange([urgent("mail-1", "18abc")], [item("mail-1", "QUEUE", "SNOOZED")]);
    arrangeLedger([label("mail-1", "keyword-fallback")]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
  });

  it("a keyword-fallback ledger row with no item yet does not ring", async () => {
    arrange([urgent("mail-1", "18abc")], []);
    arrangeLedger([label("mail-1", "keyword-fallback")]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
  });

  it("a mixed batch rings PUSH and keyword-fallback QUEUE mail in one item read and one ledger read", async () => {
    arrange(
      [urgent("push", "18aaa"), urgent("fallback", "18bbb"), urgent("llm-queue", "18ccc")],
      [item("push", "PUSH"), item("fallback", "QUEUE"), item("llm-queue", "QUEUE")],
    );
    arrangeLedger([label("fallback", "keyword-fallback"), label("llm-queue", "llm")]);

    await runOneTick();

    const rows = urgentRows();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].message)).toMatch(/\[18aaa,18bbb\]$/);
    const emailReads = (key: string) =>
      argsOf(key).filter(
        (a) => (a as { where?: Record<string, unknown> }).where?.source === "EMAIL",
      );
    expect(emailReads("attentionItem.findMany")).toHaveLength(1);
    expect(emailReads("decisionLabel.findMany")).toHaveLength(1);
  });

  it("does not read the ledger when no urgent mail sits in QUEUE", async () => {
    arrange([urgent("mail-1", "18abc")], [item("mail-1", "PUSH")]);

    await runOneTick();

    expect(urgentRows()).toHaveLength(1);
    expect(argsOf("decisionLabel.findMany")).toEqual([]);
  });

  it("a keyword-fallback QUEUE mail from an automated sender does not ring (its floor never interrupts)", async () => {
    const mail = { ...urgent("mail-1", "18abc"), from: "GitHub <notifications@github.com>" };
    arrange([mail], [item("mail-1", "QUEUE")]);
    arrangeLedger([label("mail-1", "keyword-fallback")]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
    expect(argsOf("decisionLabel.findMany")).toEqual([]);
  });

  it("a PUSH mail from an automated sender (a pin or rule put it there) still rings", async () => {
    const mail = { ...urgent("mail-1", "18abc"), from: "GitHub <notifications@github.com>" };
    arrange([mail], [item("mail-1", "PUSH")]);

    await runOneTick();

    expect(urgentRows()).toHaveLength(1);
  });

  it("another user's keyword-fallback ledger row does not count", async () => {
    arrange([urgent("mail-1", "18abc")], [item("mail-1", "QUEUE")]);
    arrangeLedger([{ ...label("mail-1", "keyword-fallback"), userId: "user-2" }]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
  });

  it("a failed ledger lookup still rings PUSH mail, rings no QUEUE mail, and is reported", async () => {
    arrange(
      [urgent("push", "18aaa"), urgent("fallback", "18bbb")],
      [item("push", "PUSH"), item("fallback", "QUEUE")],
    );
    override("decisionLabel.findMany", () => {
      throw new Error("db down");
    });

    await runOneTick();

    const rows = urgentRows();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].message)).toMatch(/\[18aaa\]$/);
    expect(syncFailed()).toEqual([]);
    expect(m.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ scope: "automation.urgent-lane" }),
      }),
    );
  });
});

describe("the sweep rings only mail received in the firewall push's recency window", () => {
  it("a PUSH mail received more than 6 hours ago, synced just now, does not ring", async () => {
    arrange([receivedAgo(urgent("mail-1", "18abc"), 6 * HOUR_MS + 1000)], [item("mail-1", "PUSH")]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
    expect(urgentPushes()).toEqual([]);
  });

  it("a keyword-fallback QUEUE mail received more than 6 hours ago does not ring", async () => {
    arrange([receivedAgo(urgent("mail-1", "18abc"), 7 * HOUR_MS)], [item("mail-1", "QUEUE")]);
    arrangeLedger([label("mail-1", "keyword-fallback")]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
  });

  it("a PUSH mail received exactly 6 hours ago still rings, as the firewall push would", async () => {
    arrange([receivedAgo(urgent("mail-1", "18abc"), 6 * HOUR_MS)], [item("mail-1", "PUSH")]);

    await runOneTick();

    expect(urgentRows()).toHaveLength(1);
  });
});

describe("policy v3: the sweep still stands down", () => {
  it("rings nothing for a policy user even when the keyword fallback put the mail in QUEUE", async () => {
    process.env.JUDGE_V3_POLICY = "true";
    process.env.JUDGE_V3_SHADOW = "true";
    arrange([urgent("mail-1", "18abc")], [item("mail-1", "QUEUE")]);
    arrangeLedger([label("mail-1", "keyword-fallback")]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
    expect(urgentPushes()).toEqual([]);
  });

  it("rings nothing for a policy user even when the mail is PUSH", async () => {
    process.env.JUDGE_V3_POLICY = "true";
    process.env.JUDGE_V3_SHADOW = "true";
    arrange([urgent("mail-1", "18abc")], [item("mail-1", "PUSH")]);

    await runOneTick();

    expect(urgentRows()).toEqual([]);
    expect(urgentPushes()).toEqual([]);
    expect(
      argsOf("emailMessage.findMany").some(
        (a) => (a as { where?: { priority?: unknown } }).where?.priority === "URGENT",
      ),
    ).toBe(false);
  });
});
