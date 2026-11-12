/**
 * Quiet hours hold urgent mail for the server's push channels and ring it once
 * after they end (notify/quiet-hours-summary.ts), the server side of what the
 * Mac app (#1650) and the Windows shell (#1644, decision N6) do on their own:
 *   - the window math is the user's wall clock, midnight-spanning windows and
 *     DST included (quiet-hours.ts lastEndedQuietWindow);
 *   - held = an unread urgent-mail bell row written inside the window that just
 *     ended, whose mail is still an OPEN PUSH item;
 *   - one held mail rings as itself, two or more as ONE summary;
 *   - ambient bucket, at most once per window (restart-safe claim row), never
 *     a real-time frame (the desktop shells summarize their own);
 *   - PUSH_QUIET_HOLD_DISABLED=true turns it off.
 *
 * Runs over the strict in-memory database (helpers/fake-db.ts), so the where
 * clauses are evaluated, not just issued.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const pushes = vi.hoisted(() => ({
  calls: [] as unknown[][],
  frames: [] as unknown[][],
  /** Queued sendPushNotification results; empty means "sent". */
  results: [] as Array<Record<string, unknown>>,
}));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../notify/push.js", () => ({
  sendPushNotification: vi.fn(async (...args: unknown[]) => {
    pushes.calls.push(args);
    return (
      pushes.results.shift() ?? {
        status: "sent",
        subscriptions: 1,
        attempted: 1,
        accepted: 1,
        failed: 0,
      }
    );
  }),
}));
vi.mock("../websocket.js", () => ({
  pushNotification: vi.fn((...args: unknown[]) => {
    pushes.frames.push(args);
  }),
}));

import { desktopCatchUp } from "../notify/desktop-catchup.js";
import { notificationSuppressionReason } from "../notify/notification-policy.js";
import {
  NOTIFICATION_LANGUAGES,
  notificationCopy,
  URGENT_EMAIL_TITLES,
} from "../notify/notification-strings.js";
import { lastEndedQuietWindow } from "../notify/quiet-hours.js";
import {
  formatSenders,
  QUIET_SUMMARY_GRACE_MS,
  sendQuietHoursSummaries,
} from "../notify/quiet-hours-summary.js";

const USER = "user-1";
const OTHER = "user-2";
const MIN = 60_000;
const HOUR = 60 * MIN;

// Seoul (UTC+9, no DST). Quiet 22:00–08:00 → the window that ends on the
// morning of 2026-11-09 runs 2026-11-08T13:00Z .. 2026-11-08T23:00Z.
const WINDOW_START = new Date("2026-11-08T13:00:00.000Z");
const WINDOW_END = new Date("2026-11-08T23:00:00.000Z");
const AFTER_END = new Date(WINDOW_END.getTime() + 5 * MIN); // 08:05 KST
const INSIDE = new Date(WINDOW_START.getTime() + 2 * HOUR); // 00:00 KST

function config(extra: Row = {}): Row {
  return {
    id: `cfg-${(extra.userId as string | undefined) ?? USER}`,
    userId: USER,
    timezone: "Asia/Seoul",
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    notificationLanguage: "en",
    ...extra,
  };
}

function bell(id: string, emailId: string | null, extra: Row = {}): Row {
  return {
    id,
    userId: USER,
    type: "email",
    title: "Urgent email",
    message: `x [gm-${id}]`,
    isRead: false,
    sourceEmailId: emailId,
    createdAt: INSIDE,
    ...extra,
  };
}

function email(id: string, from: string, subject: string, userId = USER): Row {
  return {
    id,
    userId,
    gmailId: `gm-${id}`,
    from,
    to: "me@example.com",
    subject,
    // Explicit: rows pushed into db.tables after seeding get no @default.
    isRead: false,
    createdAt: new Date(WINDOW_START.getTime() - HOUR),
  };
}

function item(sourceId: string, extra: Row = {}): Row {
  return {
    id: `ai-${sourceId}`,
    userId: USER,
    source: "EMAIL",
    sourceId,
    status: "OPEN",
    tier: "PUSH",
    tierReason: "Signature needed today",
    title: "t",
    ...extra,
  };
}

let db: FakeDb;

function seed(tables: Partial<Record<string, Row[]>>) {
  db = createFakeDb({
    automationConfig: [config()],
    notification: [],
    emailMessage: [],
    attentionItem: [],
    user: [],
    ...tables,
  } as Record<string, Row[]>);
  dbHolder.current = db;
}

/** Two held PUSH mails from different senders, inside the window. */
function seedTwoHeld(extra: Partial<Record<string, Row[]>> = {}) {
  seed({
    notification: [
      bell("n1", "e1", { createdAt: new Date(WINDOW_START.getTime() + HOUR) }),
      bell("n2", "e2", { createdAt: new Date(WINDOW_START.getTime() + 3 * HOUR) }),
    ],
    emailMessage: [
      email("e1", '"Kim Lee" <kim@example.com>', "Signed contract"),
      email("e2", "Park <park@example.com>", "Board deck"),
    ],
    attentionItem: [item("e1"), item("e2")],
    ...extra,
  });
}

function claimRows(): Row[] {
  return db.tables.notification.filter((r) =>
    String(r.dedupeKey ?? "").startsWith("quiet-summary:"),
  );
}

beforeEach(() => {
  pushes.calls = [];
  pushes.frames = [];
  pushes.results = [];
  delete process.env.PUSH_QUIET_HOLD_DISABLED;
  seed({});
});

afterEach(() => {
  delete process.env.PUSH_QUIET_HOLD_DISABLED;
});

describe("lastEndedQuietWindow — the user's wall clock", () => {
  const overnight = { quietHoursStart: "22:00", quietHoursEnd: "08:00" };

  it("returns the midnight-spanning window that just ended, start the evening before", () => {
    expect(lastEndedQuietWindow(AFTER_END, overnight, "Asia/Seoul")).toEqual({
      start: WINDOW_START,
      end: WINDOW_END,
      endDateKey: "2026-11-09",
    });
  });

  it("counts the end minute itself as ended (end is exclusive)", () => {
    expect(lastEndedQuietWindow(WINDOW_END, overnight, "Asia/Seoul")?.end).toEqual(WINDOW_END);
  });

  it("returns null while still inside quiet hours", () => {
    expect(lastEndedQuietWindow(INSIDE, overnight, "Asia/Seoul")).toBeNull();
    expect(
      lastEndedQuietWindow(new Date(WINDOW_END.getTime() - 1), overnight, "Asia/Seoul"),
    ).toBeNull();
  });

  it("reads a same-day window from yesterday when today's has not started", () => {
    // 10:00 KST on 2026-11-09; 13:00–17:00 last ran on 2026-11-08.
    const now = new Date("2026-11-09T01:00:00.000Z");
    expect(
      lastEndedQuietWindow(now, { quietHoursStart: "13:00", quietHoursEnd: "17:00" }, "Asia/Seoul"),
    ).toEqual({
      start: new Date("2026-11-08T04:00:00.000Z"),
      end: new Date("2026-11-08T08:00:00.000Z"),
      endDateKey: "2026-11-08",
    });
  });

  it("evaluates in the user's timezone, not the server's", () => {
    // 2026-11-09T13:10Z is 08:10 in New York (EST) but 22:10 in Seoul.
    const now = new Date("2026-11-09T13:10:00.000Z");
    expect(lastEndedQuietWindow(now, overnight, "America/New_York")).toEqual({
      start: new Date("2026-11-09T03:00:00.000Z"),
      end: new Date("2026-11-09T13:00:00.000Z"),
      endDateKey: "2026-11-09",
    });
    expect(lastEndedQuietWindow(now, overnight, "Asia/Seoul")).toBeNull();
  });

  it("keeps wall-clock edges across a DST change (New York, fall back 2026-11-01)", () => {
    // 22:00 EDT on 10-31 = 02:00Z; 08:00 EST on 11-01 = 13:00Z.
    const now = new Date("2026-11-01T13:30:00.000Z");
    expect(lastEndedQuietWindow(now, overnight, "America/New_York")).toEqual({
      start: new Date("2026-11-01T02:00:00.000Z"),
      end: new Date("2026-11-01T13:00:00.000Z"),
      endDateKey: "2026-11-01",
    });
  });

  it("returns null when quiet hours are off, malformed or zero-length", () => {
    expect(
      lastEndedQuietWindow(AFTER_END, { quietHoursStart: null, quietHoursEnd: "08:00" }, "UTC"),
    ).toBeNull();
    expect(
      lastEndedQuietWindow(AFTER_END, { quietHoursStart: "25:00", quietHoursEnd: "08:00" }, "UTC"),
    ).toBeNull();
    expect(
      lastEndedQuietWindow(AFTER_END, { quietHoursStart: "08:00", quietHoursEnd: "08:00" }, "UTC"),
    ).toBeNull();
  });
});

describe("sendQuietHoursSummaries — what was held rings once after", () => {
  it("rings ONE ambient summary for two or more held PUSH mails, opening Today", async () => {
    seedTwoHeld();

    const sent = await sendQuietHoursSummaries(AFTER_END);

    expect(sent).toBe(1);
    expect(pushes.calls).toHaveLength(1);
    const [userId, payload, category, options] = pushes.calls[0];
    expect(userId).toBe(USER);
    expect(payload).toEqual({
      title: "2 urgent emails during quiet hours",
      // Newest first, as the desktop summaries name them.
      body: "Park, Kim Lee",
      url: "/today",
    });
    expect(category).toBe("email_urgent");
    expect(options).toEqual({ bucket: "ambient" });
  });

  it("rings one held mail as itself (N1 shape, opens the mail, Reply/Later lane)", async () => {
    seed({
      notification: [bell("n1", "e1")],
      emailMessage: [email("e1", '"Kim Lee" <kim@example.com>', "Signed contract")],
      attentionItem: [item("e1")],
    });

    await sendQuietHoursSummaries(AFTER_END);

    expect(pushes.calls).toHaveLength(1);
    const [, payload, category, options] = pushes.calls[0];
    expect(payload).toEqual({
      title: "Kim Lee",
      body: "Signed contract\nSignature needed today",
      url: "/email/e1",
      attentionItemId: "ai-e1",
      lane: "PUSH",
      language: "en",
      emailId: "e1",
      bellNotificationId: "n1",
    });
    expect(category).toBe("email_urgent");
    expect(options).toEqual({ bucket: "ambient" });
  });

  it("names three senders then +k, each sender once, and counts every mail", async () => {
    const senders = [
      "Ann <a@x.com>",
      "Bo <b@x.com>",
      "Ann <a2@x.com>",
      "Cy <c@x.com>",
      "Di <d@x.com>",
    ];
    seed({
      notification: senders.map((_, i) =>
        bell(`n${i}`, `e${i}`, { createdAt: new Date(WINDOW_START.getTime() + (5 - i) * HOUR) }),
      ),
      emailMessage: senders.map((from, i) => email(`e${i}`, from, `s${i}`)),
      attentionItem: senders.map((_, i) => item(`e${i}`)),
    });

    await sendQuietHoursSummaries(AFTER_END);

    const payload = pushes.calls[0][1] as { title: string; body: string };
    expect(payload.title).toBe("5 urgent emails during quiet hours");
    expect(payload.body).toBe("Ann, Bo, Cy +1");
  });

  it("speaks the user's notification language", async () => {
    seedTwoHeld({ automationConfig: [config({ notificationLanguage: "ko" })] });

    await sendQuietHoursSummaries(AFTER_END);

    expect((pushes.calls[0][1] as { title: string }).title).toBe(
      "방해 금지 시간 동안 긴급 메일 2건",
    );
  });

  it("excludes mail handled, moved off PUSH, read, outside the window, or another user's", async () => {
    // "read" is the bell row; "seen" is the mail itself, read in the mailbox.
    seed({
      notification: [
        bell("done", "e1"),
        bell("queue", "e2"),
        bell("meeting", "e3"),
        bell("read", "e4", { isRead: true }),
        bell("before", "e5", { createdAt: new Date(WINDOW_START.getTime() - MIN) }),
        bell("after", "e6", { createdAt: WINDOW_END }),
        bell("theirs", "e7", { userId: OTHER }),
        bell("nomail", null),
        bell("other-title", "e8", { title: "Draft ready" }),
        bell("seen", "e9"),
      ],
      emailMessage: ["e1", "e2", "e3", "e4", "e5", "e6", "e8"]
        .map((id) => email(id, `${id} <${id}@x.com>`, "s"))
        .concat([
          email("e7", "e7 <e7@x.com>", "s", OTHER),
          { ...email("e9", "e9 <e9@x.com>", "s"), isRead: true },
        ]),
      attentionItem: [
        item("e1", { status: "DONE" }),
        item("e2", { tier: "QUEUE" }),
        item("e3", { tier: "MEETING" }),
        item("e4"),
        item("e5"),
        item("e6"),
        item("e7", { userId: OTHER }),
        item("e8"),
        item("e9"),
      ],
    });

    const sent = await sendQuietHoursSummaries(AFTER_END);

    expect(sent).toBe(0);
    expect(pushes.calls).toEqual([]);
    expect(claimRows()).toEqual([]);
  });

  it("rings nothing and writes nothing when nothing was held", async () => {
    seed({});

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(0);
    expect(pushes.calls).toEqual([]);
    expect(db.writes.notification ?? []).toEqual([]);
  });

  it("waits while quiet hours still run, and gives up once the grace period passes", async () => {
    seedTwoHeld();

    expect(await sendQuietHoursSummaries(INSIDE)).toBe(0);
    expect(
      await sendQuietHoursSummaries(new Date(WINDOW_END.getTime() + QUIET_SUMMARY_GRACE_MS + 1)),
    ).toBe(0);
    expect(pushes.calls).toEqual([]);
    // The last instant of the grace period still rings.
    expect(
      await sendQuietHoursSummaries(new Date(WINDOW_END.getTime() + QUIET_SUMMARY_GRACE_MS)),
    ).toBe(1);
  });

  it("uses each user's own timezone", async () => {
    // 22:00–08:00 in New York (EST) ends at 2026-11-09T13:00Z. At 13:05Z it has
    // just ended there, while in Seoul (22:05) quiet hours have just begun.
    const nyStart = new Date("2026-11-09T03:00:00.000Z");
    const nyNow = new Date("2026-11-09T13:05:00.000Z");
    const rows = [
      bell("n1", "e1", { createdAt: new Date(nyStart.getTime() + HOUR) }),
      bell("n2", "e2", { createdAt: new Date(nyStart.getTime() + 3 * HOUR) }),
    ];

    seedTwoHeld({ notification: rows, automationConfig: [config({ timezone: "Asia/Seoul" })] });
    expect(await sendQuietHoursSummaries(nyNow)).toBe(0);

    seedTwoHeld({
      notification: rows.map((r) => ({ ...r })),
      automationConfig: [config({ timezone: "America/New_York" })],
    });
    expect(await sendQuietHoursSummaries(nyNow)).toBe(1);
    expect((pushes.calls[0][1] as { body: string }).body).toBe("Park, Kim Lee");
  });

  it("holds a row written exactly at the window start (start is inclusive)", async () => {
    seed({
      notification: [bell("n1", "e1", { createdAt: WINDOW_START })],
      emailMessage: [email("e1", "Kim <k@x.com>", "s")],
      attentionItem: [item("e1")],
    });

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(1);
  });

  it("counts a mail once when two urgent rows name it", async () => {
    seed({
      notification: [
        bell("n1", "e1", { createdAt: new Date(WINDOW_START.getTime() + HOUR) }),
        bell("n1b", "e1", { createdAt: new Date(WINDOW_START.getTime() + 2 * HOUR) }),
      ],
      emailMessage: [email("e1", '"Kim Lee" <kim@example.com>', "Signed contract")],
      attentionItem: [item("e1")],
    });

    await sendQuietHoursSummaries(AFTER_END);

    // One mail rings as itself, from its newest row.
    const payload = pushes.calls[0][1] as { title: string; bellNotificationId: string };
    expect(payload.title).toBe("Kim Lee");
    expect(payload.bellNotificationId).toBe("n1b");
  });

  it("rings each user only their own held mail", async () => {
    seedTwoHeld({
      automationConfig: [config(), config({ userId: OTHER })],
    });
    db.tables.notification.push(
      bell("o1", "e3", { userId: OTHER }),
      bell("o2", "e4", { userId: OTHER, createdAt: new Date(INSIDE.getTime() + HOUR) }),
    );
    db.tables.emailMessage.push(
      email("e3", "Cy <c@x.com>", "s", OTHER),
      email("e4", "Di <d@x.com>", "s", OTHER),
    );
    db.tables.attentionItem.push(item("e3", { userId: OTHER }), item("e4", { userId: OTHER }));

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(2);

    const byUser = Object.fromEntries(
      pushes.calls.map(([userId, payload]) => [userId, (payload as { body: string }).body]),
    );
    expect(byUser).toEqual({ [USER]: "Park, Kim Lee", [OTHER]: "Di, Cy" });
  });

  it("is at most once per window: a second tick, a restart, or overlapping ticks ring once", async () => {
    seedTwoHeld();

    const [a, b] = await Promise.all([
      sendQuietHoursSummaries(AFTER_END),
      sendQuietHoursSummaries(AFTER_END),
    ]);
    expect(a + b).toBe(1);
    expect(await sendQuietHoursSummaries(new Date(AFTER_END.getTime() + MIN))).toBe(0);

    // A restart: fresh module state, same database.
    vi.resetModules();
    const fresh = await import("../notify/quiet-hours-summary.js");
    expect(await fresh.sendQuietHoursSummaries(new Date(AFTER_END.getTime() + 2 * MIN))).toBe(0);

    expect(pushes.calls).toHaveLength(1);
    expect(claimRows()).toHaveLength(1);
  });

  it("a window already rung costs a later tick one claim read, nothing more", async () => {
    seedTwoHeld();
    await sendQuietHoursSummaries(AFTER_END);
    const before = db.reads.length;

    await sendQuietHoursSummaries(new Date(AFTER_END.getTime() + MIN));

    expect(db.reads.slice(before)).toEqual(["automationConfig", "notification"]);
  });

  it("gives the claim back when the rate limit refused, so a later tick rings", async () => {
    seedTwoHeld();
    pushes.results.push({ status: "skipped", reason: "rate_limited" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(0);
    expect(claimRows()).toEqual([]);
    expect(await sendQuietHoursSummaries(new Date(AFTER_END.getTime() + 10 * MIN))).toBe(1);

    expect(pushes.calls).toHaveLength(2);
    expect(claimRows()).toHaveLength(1);
    log.mockRestore();
  });

  it("keeps the claim when the push was skipped for any other reason (at most once)", async () => {
    seedTwoHeld();
    pushes.results.push({ status: "skipped", reason: "user_preferences" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(0);
    expect(await sendQuietHoursSummaries(new Date(AFTER_END.getTime() + MIN))).toBe(0);

    expect(pushes.calls).toHaveLength(1);
    expect(claimRows()).toHaveLength(1);
    expect(log.mock.calls.flat().join(" ")).toContain("user_preferences");
    log.mockRestore();
  });

  it("a summary past the hold gates records the ring on every held mail's ledger row (IP24)", async () => {
    const judgedAt = new Date(WINDOW_START.getTime() + HOUR);
    const ledger = (sourceId: string): Row => ({
      id: `dl-${sourceId}`,
      userId: USER,
      source: "EMAIL",
      sourceId,
      shownTier: "PUSH",
      features: {},
      judgedAt,
    });
    seedTwoHeld({ decisionLabel: [ledger("e1"), ledger("e2")] });
    const dispatchedAt = new Date(AFTER_END.getTime() + 1_000);
    pushes.results.push({ status: "sent", dispatchedAt });

    await sendQuietHoursSummaries(AFTER_END);

    const rang = Object.fromEntries(
      db.tables.decisionLabel.map((r) => [r.sourceId as string, r.rangAt ?? null]),
    );
    expect(rang).toEqual({ e1: dispatchedAt, e2: dispatchedAt });
  });

  it("a summary held at a gate records no ring", async () => {
    seedTwoHeld({
      decisionLabel: [
        {
          id: "dl-e1",
          userId: USER,
          source: "EMAIL",
          sourceId: "e1",
          shownTier: "PUSH",
          features: {},
        },
      ],
    });
    pushes.results.push({ status: "skipped", reason: "user_preferences", dispatchedAt: null });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await sendQuietHoursSummaries(AFTER_END);

    expect(db.tables.decisionLabel[0].rangAt ?? null).toBeNull();
    log.mockRestore();
  });

  it("rings again for the next night's window", async () => {
    seedTwoHeld();
    await sendQuietHoursSummaries(AFTER_END);

    const nextStart = new Date(WINDOW_START.getTime() + 24 * HOUR);
    db.tables.notification.push(
      bell("n3", "e3", { createdAt: new Date(nextStart.getTime() + HOUR) }),
      bell("n4", "e4", { createdAt: new Date(nextStart.getTime() + 2 * HOUR) }),
    );
    db.tables.emailMessage.push(email("e3", "Cy <c@x.com>", "s"), email("e4", "Di <d@x.com>", "s"));
    db.tables.attentionItem.push(item("e3"), item("e4"));

    expect(await sendQuietHoursSummaries(new Date(AFTER_END.getTime() + 24 * HOUR))).toBe(1);
    expect(pushes.calls).toHaveLength(2);
    expect((pushes.calls[1][1] as { body: string }).body).toBe("Di, Cy");
  });

  it("keeps the claim row out of the bell and out of the Windows catch-up", async () => {
    seedTwoHeld();
    await sendQuietHoursSummaries(AFTER_END);

    const [claim] = claimRows();
    expect(claim.type).toBe("claim");
    expect(claim.isRead).toBe(true);
    expect(claim.dedupeKey).toBe("quiet-summary:2026-11-09");
    expect(URGENT_EMAIL_TITLES).not.toContain(claim.title);
    const catchUp = await desktopCatchUp(USER, [claim.id as string], AFTER_END);
    expect(catchUp.items).toEqual([]);
  });

  it("never sends a real-time frame: the desktop shells summarize their own held mail", async () => {
    seedTwoHeld();

    await sendQuietHoursSummaries(AFTER_END);

    expect(pushes.calls).toHaveLength(1);
    expect(pushes.frames).toEqual([]);
  });

  it("is off with PUSH_QUIET_HOLD_DISABLED=true and reads nothing", async () => {
    seedTwoHeld();
    process.env.PUSH_QUIET_HOLD_DISABLED = "true";

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(0);
    expect(pushes.calls).toEqual([]);
    expect(db.reads).toEqual([]);
  });

  it.each(["1", " Yes ", "ON"])("is off for PUSH_QUIET_HOLD_DISABLED=%j too", async (value) => {
    seedTwoHeld();
    process.env.PUSH_QUIET_HOLD_DISABLED = value;

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(0);
    expect(pushes.calls).toEqual([]);
  });

  it("stays on for any other value of PUSH_QUIET_HOLD_DISABLED", async () => {
    seedTwoHeld();
    process.env.PUSH_QUIET_HOLD_DISABLED = "false";

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(1);
  });

  it("one user's failed read does not starve the others", async () => {
    seedTwoHeld({ automationConfig: [config({ userId: OTHER }), config()] });
    const realFindMany = db.model("notification").findMany.bind(db.model("notification"));
    const notification = db.model("notification");
    let calls = 0;
    notification.findMany = async (args) => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return realFindMany(args);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a claim the database refuses (a data wipe) rings nothing for that user and logs no content", async () => {
    seedTwoHeld({ automationConfig: [config({ userId: OTHER }), config()] });
    db.tables.notification.push(bell("o1", "e3", { userId: OTHER }));
    db.tables.emailMessage.push(email("e3", "Secret Sender <s@x.com>", "s", OTHER));
    db.tables.attentionItem.push(item("e3", { userId: OTHER }));
    const notification = db.model("notification");
    const realCreate = notification.create.bind(notification);
    notification.create = async (args) => {
      if (args.data.userId === OTHER) throw new Error("refused for Secret Sender");
      return realCreate(args);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(1);

    expect(pushes.calls.map(([userId]) => userId)).toEqual([USER]);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).toContain(OTHER);
    expect(logged).not.toContain("Secret Sender");
    warn.mockRestore();
  });
});

describe("summary copy", () => {
  it("is in every shipped language and never trips the push noise policy", () => {
    for (const lang of NOTIFICATION_LANGUAGES) {
      const title = notificationCopy(lang).heldDuringQuietHours(3);
      expect(title).toContain("3");
      expect(
        notificationSuppressionReason({
          title,
          message: "Kim, Park",
          notificationType: "firewall",
        }),
      ).toBeNull();
    }
  });

  it("formatSenders matches the desktop shells: distinct, trimmed, three then +k", () => {
    expect(formatSenders([])).toBe("");
    expect(formatSenders(["A", " A ", "", "B"])).toBe("A, B");
    expect(formatSenders(["A", "B", "C", "D", "E"])).toBe("A, B, C +2");
  });
});
