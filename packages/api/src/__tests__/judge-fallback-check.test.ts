/**
 * DB-backed judge fallback alarm (#1319 follow-up).
 *
 * Prod volume is ~3 emails/hour and deploys wipe process memory several times
 * a day, so the alarm reads the judged-by source that attention-mirror stamps
 * into AttentionItem.evidence over the last 24 h — one aggregate query — and
 * dedupes through the ops Notification dedupeKey, not process memory.
 *
 * The fake $queryRaw below emulates the statement from its bound parameters
 * (since, eligible sources, streak length); a changed parameter order or count
 * fails the shape guard instead of being emulated wrongly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface JudgedRow {
  at: number;
  source: string;
}

const store = vi.hoisted(() => ({
  rows: [] as Array<{ at: number; source: string }>,
  admins: [{ id: "admin-1" }, { id: "admin-2" }] as Array<{ id: string }>,
  notifications: [] as Array<Record<string, unknown>>,
  notificationFailure: null as unknown,
  queryCount: 0,
  statements: [] as Array<{ text: string; values: unknown[] }>,
}));

function emulateCounts(values: unknown[]): Array<{ source: string; scope: string; count: number }> {
  if (values.length !== 3) throw new Error(`unexpected parameter count ${values.length}`);
  const [since, eligible, streak] = values as [Date, string[], number];
  if (!(since instanceof Date) || !Array.isArray(eligible) || typeof streak !== "number") {
    throw new Error("unexpected parameter shape");
  }
  const windowRows = store.rows.filter((r) => r.at >= since.getTime());
  const group = (rows: JudgedRow[], scope: string) => {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
    return [...counts.entries()].map(([source, count]) => ({ source, scope, count }));
  };
  const streakRows = windowRows
    .filter((r) => eligible.includes(r.source))
    .sort((a, b) => b.at - a.at)
    .slice(0, streak);
  return [...group(windowRows, "window"), ...group(streakRows, "streak")];
}

vi.mock("../db.js", () => ({
  prisma: {
    $queryRaw: vi.fn(async (stmt: { text: string; values: unknown[] }) => {
      store.queryCount += 1;
      store.statements.push({ text: stmt.text, values: stmt.values });
      return emulateCounts(stmt.values);
    }),
    user: { findMany: vi.fn(async () => store.admins) },
    notification: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (store.notificationFailure) throw store.notificationFailure;
        const dup = store.notifications.some(
          (n) => n.userId === args.data.userId && n.dedupeKey === args.data.dedupeKey,
        );
        if (dup) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        store.notifications.push(args.data);
        return { id: `n-${store.notifications.length}` };
      }),
    },
  },
}));

const sentry = vi.hoisted(() => ({ events: [] as Array<{ err: unknown; ctx: unknown }> }));
vi.mock("../sentry.js", () => ({
  captureError: vi.fn((err: unknown, ctx: unknown) => {
    sentry.events.push({ err, ctx });
  }),
}));

const HOUR = 60 * 60 * 1000;
// 2027-01-15T00:00:00Z — a fixed UTC midnight so day keys are predictable.
const DAY0 = Date.UTC(2027, 0, 15);

type CheckModule = typeof import("../judge/judge-fallback-check.js");

async function freshInstance(): Promise<{
  check: CheckModule;
  failures: typeof import("../llm/llm-failure-log.js");
}> {
  vi.resetModules();
  const check = await import("../judge/judge-fallback-check.js");
  const failures = await import("../llm/llm-failure-log.js");
  return { check, failures };
}

function addRows(source: string, n: number, at: number): void {
  for (let i = 0; i < n; i++) store.rows.push({ at: at + i, source });
}

let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

function alarmLines(): string[] {
  return errSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes("[JUDGE-HEALTH] LLM judge failing"));
}

beforeEach(() => {
  store.rows = [];
  store.admins = [{ id: "admin-1" }, { id: "admin-2" }];
  store.notifications = [];
  store.notificationFailure = null;
  store.queryCount = 0;
  store.statements = [];
  sentry.events = [];
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("named constants", () => {
  it("pins the lookback, sample floor, ratio threshold and streak length", async () => {
    const { check } = await freshInstance();
    expect(check.JUDGE_FALLBACK_LOOKBACK_MS).toBe(24 * HOUR);
    expect(check.JUDGE_FALLBACK_MIN_ELIGIBLE).toBe(5);
    expect(check.JUDGE_FALLBACK_ALARM_RATIO).toBe(0.5);
    expect(check.JUDGE_FALLBACK_STREAK).toBe(6);
    expect(check.JUDGE_FALLBACK_CHECK_INTERVAL_MS).toBe(HOUR);
  });
});

describe("one aggregate query, no content", () => {
  it("issues exactly one statement over AttentionItem's judged-by fact, binding since/eligible/streak", async () => {
    const { check } = await freshInstance();
    await check.runJudgeFallbackCheck(DAY0 + 10 * HOUR);
    expect(store.queryCount).toBe(1);
    const [stmt] = store.statements;
    expect(stmt.text).toContain('"AttentionItem"');
    expect(stmt.text).toContain("Judged by");
    expect(stmt.text).toContain('"inputHashAt"');
    expect(stmt.text).toMatch(/COUNT\(\*\)/i);
    // No content column is ever selected.
    for (const col of ['"title"', '"body"', '"tierReason"', '"userId"', "From", '"sourceId"']) {
      expect(stmt.text).not.toContain(col);
    }
    expect(stmt.values).toEqual([
      new Date(DAY0 + 10 * HOUR - 24 * HOUR),
      ["llm", "keyword-fallback"],
      6,
    ]);
  });
});

describe("conditions", () => {
  it("fires within 3 hours of simulated time at 3 eligible judgments per hour, all fallback", async () => {
    const { check } = await freshInstance();
    let firstAlarmHour: number | null = null;
    for (let h = 1; h <= 3; h++) {
      addRows("keyword-fallback", 3, DAY0 + (h - 1) * HOUR + 60_000);
      await check.runJudgeFallbackCheck(DAY0 + h * HOUR);
      if (firstAlarmHour === null && store.notifications.length > 0) firstAlarmHour = h;
    }
    expect(firstAlarmHour).not.toBeNull();
    expect(firstAlarmHour).toBeLessThanOrEqual(3);
    expect(alarmLines().length).toBeGreaterThan(0);
  });

  it("does not alarm at 40% fallback", async () => {
    const { check } = await freshInstance();
    const pattern = ["keyword-fallback", "llm", "keyword-fallback", "llm", "keyword-fallback"];
    pattern.push("llm", "keyword-fallback", "llm", "llm", "llm");
    pattern.forEach((source, i) => {
      store.rows.push({ at: DAY0 + i * 60_000, source });
    });
    const status = await check.runJudgeFallbackCheck(DAY0 + HOUR);
    expect(status.fallbackRatio).toBeCloseTo(0.4, 5);
    expect(status.conditions).toEqual([]);
    expect(status.degraded).toBe(false);
    expect(store.notifications).toEqual([]);
    expect(sentry.events).toEqual([]);
    expect(alarmLines()).toEqual([]);
  });

  it("is not diluted by fast-path / sender-prior / pinned / learned traffic", async () => {
    const { check } = await freshInstance();
    addRows("llm", 1, DAY0);
    addRows("keyword-fallback", 5, DAY0 + HOUR);
    addRows("fast-path", 60, DAY0 + 2 * HOUR);
    addRows("sender-prior", 30, DAY0 + 2 * HOUR);
    addRows("pinned-rule", 5, DAY0 + 2 * HOUR);
    addRows("learned-rule", 5, DAY0 + 2 * HOUR);
    const status = await check.runJudgeFallbackCheck(DAY0 + 3 * HOUR);
    expect(status.eligible).toBe(6);
    expect(status.fallbacks).toBe(5);
    expect(status.conditions).toContain("ratio");
  });

  it("fires the volume-independent streak when the ratio alone would stay quiet", async () => {
    const { check } = await freshInstance();
    addRows("llm", 7, DAY0);
    addRows("keyword-fallback", 6, DAY0 + HOUR);
    // Newest rows are short-circuits; they must not break the streak.
    addRows("fast-path", 10, DAY0 + 2 * HOUR);
    const status = await check.runJudgeFallbackCheck(DAY0 + 3 * HOUR);
    expect(status.fallbackRatio).toBeCloseTo(6 / 13, 5);
    expect(status.conditions).toEqual(["streak"]);
    expect(status.degraded).toBe(true);
  });

  it("needs the full streak: 5 fallbacks after an llm success are not a streak", async () => {
    const { check } = await freshInstance();
    addRows("keyword-fallback", 3, DAY0);
    addRows("llm", 1, DAY0 + HOUR);
    addRows("keyword-fallback", 5, DAY0 + 2 * HOUR);
    const status = await check.runJudgeFallbackCheck(DAY0 + 3 * HOUR);
    expect(status.conditions).toEqual(["ratio"]);
  });

  it("ignores judgments older than the 24 h lookback", async () => {
    const { check } = await freshInstance();
    addRows("keyword-fallback", 20, DAY0);
    const status = await check.runJudgeFallbackCheck(DAY0 + 25 * HOUR);
    expect(status.eligible).toBe(0);
    expect(status.degraded).toBe(false);
  });
});

describe("alarm delivery and dedupe", () => {
  it("names the top unrecovered provider error, or says the process restarted", async () => {
    const first = await freshInstance();
    first.failures.tallyLlmFailure(
      { provider: "openrouter", model: "m" },
      Object.assign(new Error("402"), { status: 402 }),
      DAY0 + HOUR,
    );
    addRows("keyword-fallback", 6, DAY0 + HOUR);
    await first.check.runJudgeFallbackCheck(DAY0 + 2 * HOUR);
    expect(alarmLines()[0]).toContain(
      "LLM judge failing: 100% fallback in last 24 h (6/6 LLM-eligible judgments), top error: 402 credits exhausted (openrouter)",
    );
    expect(String(store.notifications[0].message)).toContain("402 credits exhausted");

    // Next day, new process: the in-memory failure log is gone.
    store.notifications = [];
    const second = await freshInstance();
    addRows("keyword-fallback", 6, DAY0 + 25 * HOUR);
    await second.check.runJudgeFallbackCheck(DAY0 + 26 * HOUR);
    expect(String(store.notifications[0].message)).toContain(
      "top error: unknown (restarted since)",
    );
  });

  it("creates one ops Notification per ADMIN per condition per day, deduped across instances and restarts", async () => {
    addRows("keyword-fallback", 6, DAY0 + HOUR);

    const instanceA = await freshInstance();
    await instanceA.check.runJudgeFallbackCheck(DAY0 + 2 * HOUR);
    expect(store.notifications).toHaveLength(4); // 2 admins × {ratio, streak}
    const keys = new Set(store.notifications.map((n) => n.dedupeKey));
    expect(keys).toEqual(
      new Set(["judge-fallback:ratio:2027-01-15", "judge-fallback:streak:2027-01-15"]),
    );
    expect(store.notifications.every((n) => n.type === "ops")).toBe(true);
    expect(sentry.events).toHaveLength(2);
    expect(alarmLines()).toHaveLength(2);

    // A second instance runs the same hourly check the same day.
    const instanceB = await freshInstance();
    await instanceB.check.runJudgeFallbackCheck(DAY0 + 3 * HOUR);
    // A restart of instance A later that day.
    const restarted = await freshInstance();
    await restarted.check.runJudgeFallbackCheck(DAY0 + 9 * HOUR);
    // Same process, next hour.
    await restarted.check.runJudgeFallbackCheck(DAY0 + 10 * HOUR);

    expect(store.notifications).toHaveLength(4);
    // Sentry + console.error fire only when a Notification was actually created.
    expect(sentry.events).toHaveLength(2);
    expect(alarmLines()).toHaveLength(2);

    // Still degraded the next UTC day → a new day's notifications.
    addRows("keyword-fallback", 6, DAY0 + 24 * HOUR + 60_000);
    await restarted.check.runJudgeFallbackCheck(DAY0 + 25 * HOUR);
    expect(store.notifications).toHaveLength(8);
    expect(sentry.events).toHaveLength(4);
  });

  it("with no ADMIN users stays loud once per process per day (Sentry + console.error)", async () => {
    store.admins = [];
    addRows("keyword-fallback", 6, DAY0 + HOUR); // ratio + streak
    const first = await freshInstance();
    await first.check.runJudgeFallbackCheck(DAY0 + 2 * HOUR);
    await first.check.runJudgeFallbackCheck(DAY0 + 3 * HOUR);
    expect(sentry.events).toHaveLength(2);
    expect(alarmLines()).toHaveLength(2);

    const second = await freshInstance();
    await second.check.runJudgeFallbackCheck(DAY0 + 4 * HOUR);
    expect(sentry.events).toHaveLength(4);
  });

  it("stays loud once per process per day when the Notification write fails, and never throws", async () => {
    store.notificationFailure = new Error("db down");
    addRows("keyword-fallback", 6, DAY0 + HOUR);
    const { check } = await freshInstance();
    await expect(check.runJudgeFallbackCheck(DAY0 + 2 * HOUR)).resolves.toMatchObject({
      degraded: true,
    });
    await check.runJudgeFallbackCheck(DAY0 + 3 * HOUR);
    expect(sentry.events).toHaveLength(2); // ratio + streak, once each
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("environment overrides", () => {
  it("honours JUDGE_HEALTH_FALLBACK_RATE and JUDGE_HEALTH_MIN_SAMPLE", async () => {
    vi.stubEnv("JUDGE_HEALTH_FALLBACK_RATE", "0.3");
    vi.stubEnv("JUDGE_HEALTH_MIN_SAMPLE", "10");
    const { check } = await freshInstance();
    const pattern = ["keyword-fallback", "llm", "keyword-fallback", "llm", "keyword-fallback"];
    pattern.push("llm", "keyword-fallback", "llm", "llm", "llm");
    pattern.forEach((source, i) => {
      store.rows.push({ at: DAY0 + i * 60_000, source });
    });
    // 40% > 0.3 with 10 >= 10 eligible.
    expect((await check.runJudgeFallbackCheck(DAY0 + HOUR)).conditions).toEqual(["ratio"]);

    store.rows = [];
    addRows("keyword-fallback", 6, DAY0 + 2 * HOUR);
    // 6 < 10: the ratio has too little signal; the streak still fires.
    expect((await check.runJudgeFallbackCheck(DAY0 + 3 * HOUR)).conditions).toEqual(["streak"]);
  });

  it("ignores invalid override values", async () => {
    vi.stubEnv("JUDGE_HEALTH_FALLBACK_RATE", "2");
    vi.stubEnv("JUDGE_HEALTH_MIN_SAMPLE", "abc");
    const { check } = await freshInstance();
    expect(check.resolveJudgeFallbackThresholds()).toEqual({ minEligible: 5, ratio: 0.5 });
  });

  it("warns once when the retired count-based JUDGE_HEALTH_WINDOW is still set", async () => {
    vi.stubEnv("JUDGE_HEALTH_WINDOW", "200");
    const { check } = await freshInstance();
    check.warnRetiredJudgeHealthEnv();
    check.warnRetiredJudgeHealthEnv();
    const lines = warnSpy.mock.calls.filter((c) => String(c[0]).includes("JUDGE_HEALTH_WINDOW"));
    expect(lines).toHaveLength(1);
  });

  it("stays silent when it is not set", async () => {
    const { check } = await freshInstance();
    check.warnRetiredJudgeHealthEnv();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("JUDGE_HEALTH_WINDOW"))).toBe(
      false,
    );
  });
});

describe("read surfaces", () => {
  it("public: unknown before any check, then the cached result — not a query per request", async () => {
    const { check } = await freshInstance();
    // No check yet: a background refresh is kicked off, the read itself answers now.
    expect(check.getPublicJudgeHealth(DAY0)).toEqual({ status: "unknown", fallbackRatio: null });
    await vi.waitFor(() => expect(store.queryCount).toBe(1));

    addRows("keyword-fallback", 6, DAY0 + HOUR);
    await check.runJudgeFallbackCheck(DAY0 + 2 * HOUR);
    const queriesAfterCheck = store.queryCount;
    for (let i = 0; i < 10; i++) check.getPublicJudgeHealth(DAY0 + 2 * HOUR + i);
    expect(store.queryCount).toBe(queriesAfterCheck);
    expect(check.getPublicJudgeHealth(DAY0 + 2 * HOUR)).toEqual({
      status: "degraded",
      fallbackRatio: 1,
    });
  });

  it("public: the ratio is null below the minimum sample, and no error text ever leaks", async () => {
    const { check, failures } = await freshInstance();
    failures.tallyLlmFailure(
      { provider: "openrouter", model: "m" },
      Object.assign(new Error("402"), { status: 402 }),
      DAY0,
    );
    addRows("keyword-fallback", 2, DAY0);
    await check.runJudgeFallbackCheck(DAY0 + HOUR);
    const pub = check.getPublicJudgeHealth(DAY0 + HOUR);
    expect(pub).toEqual({ status: "ok", fallbackRatio: null });
    expect(JSON.stringify(pub)).not.toMatch(/credit|402|openrouter/i);
  });

  it("public: a stale cache refreshes in the background without alarming", async () => {
    const { check } = await freshInstance();
    addRows("keyword-fallback", 6, DAY0 + HOUR);
    check.getPublicJudgeHealth(DAY0 + 2 * HOUR);
    await vi.waitFor(() =>
      expect(check.getPublicJudgeHealth(DAY0 + 2 * HOUR).status).toBe("degraded"),
    );
    expect(store.notifications).toEqual([]);
    expect(sentry.events).toEqual([]);
  });

  it("admin: carries the last check and the top error", async () => {
    const { check, failures } = await freshInstance();
    failures.tallyLlmFailure(
      { provider: "openrouter", model: "m" },
      Object.assign(new Error("402"), { status: 402 }),
      DAY0 + HOUR,
    );
    addRows("keyword-fallback", 6, DAY0 + HOUR);
    await check.runJudgeFallbackCheck(DAY0 + 2 * HOUR);
    const admin = check.getJudgeHealth(DAY0 + 2 * HOUR);
    expect(admin.lookbackMs).toBe(24 * HOUR);
    expect(admin.topError).toBe("402 credits exhausted (openrouter)");
    expect(admin.lastCheck).toMatchObject({
      eligible: 6,
      fallbacks: 6,
      fallbackRatio: 1,
      degraded: true,
    });
  });
});
