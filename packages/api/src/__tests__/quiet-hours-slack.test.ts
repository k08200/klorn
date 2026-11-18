/**
 * The quiet-hours summary (notify/quiet-hours-summary.ts) counts Slack PUSH
 * held during quiet hours too. A Slack PUSH that will not ring there writes its
 * bell row named `slack:<episodeId>` (slack/notify.ts, #1794): the Windows shell
 * already toasts it once quiet hours end; the server's channels (web push,
 * Telegram, FCM, APNs) caught up only mail, so a phone never heard of it.
 *
 *   - held Slack: this user's Slack row, written inside the window that just
 *     ended, unread, named `slack:` (a row that rang holds an interrupt slot
 *     key; a row the cap, the budget or a late re-judge held is
 *     `slack-held:`), whose episode the user did not answer in Slack since;
 *   - one held item rings as itself (a Slack row as its live push, opening
 *     Today); two or more ring ONE summary, worded "urgent messages" when a
 *     Slack row is among them, as the Windows shell words its own;
 *   - SLACK_ENABLED off: byte-identical to before (no Slack read at all), and
 *     `cohort` reaches only ROLLOUT_COHORT_USER_IDS.
 *
 * Runs over the strict in-memory database (helpers/fake-db.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const pushes = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const prisma = fakePrismaClient(() => dbHolder.current as FakeDb);
  return { prisma, db: prisma };
});
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));
vi.mock("../notify/push.js", () => ({
  sendPushNotification: vi.fn(async (...args: unknown[]) => {
    pushes.calls.push(args);
    return { status: "sent", subscriptions: 1, attempted: 1, accepted: 1, failed: 0 };
  }),
}));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));

import { notificationCopy } from "../notify/notification-strings.js";
import { sendQuietHoursSummaries } from "../notify/quiet-hours-summary.js";

const USER = "user-1";
const MIN = 60_000;
const HOUR = 60 * MIN;
// Seoul, quiet 22:00–08:00: the window ending the morning of 2026-11-09.
const WINDOW_START = new Date("2026-11-08T13:00:00.000Z");
const WINDOW_END = new Date("2026-11-08T23:00:00.000Z");
const AFTER_END = new Date(WINDOW_END.getTime() + 5 * MIN);
const at = (hours: number) => new Date(WINDOW_START.getTime() + hours * HOUR);

function config(extra: Row = {}): Row {
  return {
    id: "cfg-1",
    userId: USER,
    timezone: "Asia/Seoul",
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    notificationLanguage: "en",
    ...extra,
  };
}

function mailBell(id: string, emailId: string, createdAt: Date): Row {
  return {
    id,
    userId: USER,
    type: "email",
    title: "Urgent email",
    message: `x [gm-${id}]`,
    isRead: false,
    sourceEmailId: emailId,
    createdAt,
  };
}

function email(id: string, from: string, subject: string): Row {
  return {
    id,
    userId: USER,
    gmailId: `gm-${id}`,
    from,
    to: "me@example.com",
    subject,
    isRead: false,
    createdAt: new Date(WINDOW_START.getTime() - HOUR),
  };
}

function item(sourceId: string): Row {
  return {
    id: `ai-${sourceId}`,
    userId: USER,
    source: "EMAIL",
    sourceId,
    status: "OPEN",
    tier: "PUSH",
    tierReason: "Signature needed today",
    title: "t",
  };
}

function slackRow(id: string, extra: Row = {}): Row {
  return {
    id,
    userId: USER,
    type: "slack",
    title: "Slack · Direct message",
    message: "prod is down\nNeeds you now",
    link: "https://acme.slack.com/archives/D0DM/p1",
    isRead: false,
    dedupeKey: `slack:ep-${id}`,
    createdAt: at(4),
    ...extra,
  };
}

function episode(id: string, answeredAt: Date | null = null): Row {
  return { id, userId: USER, answeredAt };
}

let db: FakeDb;

function seed(tables: Partial<Record<string, Row[]>>) {
  db = createFakeDb({
    automationConfig: [config()],
    notification: [],
    emailMessage: [],
    attentionItem: [],
    slackEpisode: [],
    user: [],
    ...tables,
  } as Record<string, Row[]>);
  dbHolder.current = db;
}

/** Two held PUSH mails (Kim Lee at +1 h, Park at +3 h) and one held Slack row at +4 h. */
function seedMailAndSlack(extra: Partial<Record<string, Row[]>> = {}) {
  seed({
    notification: [
      mailBell("n1", "e1", at(1)),
      mailBell("n2", "e2", at(3)),
      slackRow("s1"),
      ...(extra.notification ?? []),
    ],
    emailMessage: [
      email("e1", '"Kim Lee" <kim@example.com>', "Signed contract"),
      email("e2", "Park <park@example.com>", "Board deck"),
    ],
    attentionItem: [item("e1"), item("e2")],
    slackEpisode: [episode("ep-s1"), ...(extra.slackEpisode ?? [])],
    ...(extra.automationConfig ? { automationConfig: extra.automationConfig } : {}),
  });
}

function claimRows(): Row[] {
  return db.tables.notification.filter((r) =>
    String(r.dedupeKey ?? "").startsWith("quiet-summary:"),
  );
}

const MAIL_ONLY_SUMMARY = {
  title: "2 urgent emails during quiet hours",
  body: "Park, Kim Lee",
  url: "/today",
};

/**
 * Every model read of the mail-only summary, in order, as the sweep issued
 * them before held Slack rows were counted (recorded on 82fda23f). Slack off
 * must keep exactly this list: no Slack read, no extra notification read.
 */
const MAIL_ONLY_READS = [
  "automationConfig",
  "notification",
  "notification",
  "attentionItem",
  "emailMessage",
];

beforeEach(() => {
  pushes.calls = [];
  delete process.env.SLACK_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
  delete process.env.PUSH_QUIET_HOLD_DISABLED;
});

afterEach(() => {
  delete process.env.SLACK_ENABLED;
  delete process.env.ROLLOUT_COHORT_USER_IDS;
});

describe("Slack off — the summary is byte-identical to the mail-only one", () => {
  it("ignores a held Slack row: same payload, same reads, same claim", async () => {
    seedMailAndSlack();

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(1);

    expect(pushes.calls).toEqual([
      [USER, MAIL_ONLY_SUMMARY, "email_urgent", { bucket: "ambient" }],
    ]);
    expect(db.reads).toEqual(MAIL_ONLY_READS);
    expect(claimRows()).toHaveLength(1);
    expect(claimRows()[0]).toMatchObject({
      dedupeKey: "quiet-summary:2026-11-09",
      message: "2 held",
    });
  });

  it("a night with only held Slack rings nothing and claims nothing", async () => {
    seed({ notification: [slackRow("s1")], slackEpisode: [episode("ep-s1")] });

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(0);

    expect(pushes.calls).toEqual([]);
    expect(claimRows()).toEqual([]);
    expect(db.reads).not.toContain("slackEpisode");
  });

  it("cohort reaches only the cohort: anyone else keeps the mail-only summary", async () => {
    process.env.SLACK_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = "someone-else";
    seedMailAndSlack();

    await sendQuietHoursSummaries(AFTER_END);

    expect(pushes.calls).toEqual([
      [USER, MAIL_ONLY_SUMMARY, "email_urgent", { bucket: "ambient" }],
    ]);
    expect(db.reads).toEqual(MAIL_ONLY_READS);
  });
});

describe("Slack on — held Slack PUSH rings with the held mail", () => {
  beforeEach(() => {
    process.env.SLACK_ENABLED = "true";
  });

  it("counts a held Slack row in ONE summary, worded as urgent messages, newest first", async () => {
    seedMailAndSlack();

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(1);

    expect(pushes.calls).toHaveLength(1);
    const [userId, payload, category, options] = pushes.calls[0];
    expect(userId).toBe(USER);
    expect(payload).toEqual({
      title: notificationCopy("en").messagesDuringQuietHours(3),
      body: "Slack · Direct message, Park, Kim Lee",
      url: "/today",
    });
    expect(category).toBe("email_urgent");
    expect(options).toEqual({ bucket: "ambient" });
    expect(claimRows()[0]).toMatchObject({ message: "3 held" });
  });

  it("the cohort user gets it under cohort", async () => {
    process.env.SLACK_ENABLED = "cohort";
    process.env.ROLLOUT_COHORT_USER_IDS = `other, ${USER}`;
    seedMailAndSlack();

    await sendQuietHoursSummaries(AFTER_END);

    expect((pushes.calls[0][1] as { title: string }).title).toBe(
      notificationCopy("en").messagesDuringQuietHours(3),
    );
  });

  it("rings one held Slack row as its own live push, opening Today", async () => {
    seed({ notification: [slackRow("s1")], slackEpisode: [episode("ep-s1")] });

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(1);

    expect(pushes.calls).toEqual([
      [
        USER,
        {
          title: "Slack · Direct message",
          body: "prod is down\nNeeds you now",
          url: "/today",
          bellNotificationId: "s1",
          language: "en",
        },
        "email_urgent",
        { bucket: "ambient" },
      ],
    ]);
    expect(claimRows()[0]).toMatchObject({ message: "1 held" });
  });

  it("speaks the user's notification language", async () => {
    seedMailAndSlack({ automationConfig: [config({ notificationLanguage: "ko" })] });

    await sendQuietHoursSummaries(AFTER_END);

    expect((pushes.calls[0][1] as { title: string }).title).toBe(
      notificationCopy("ko").messagesDuringQuietHours(3),
    );
  });

  it("keeps the mail wording when no Slack row was held", async () => {
    seed({
      notification: [mailBell("n1", "e1", at(1)), mailBell("n2", "e2", at(3))],
      emailMessage: [
        email("e1", '"Kim Lee" <kim@example.com>', "Signed contract"),
        email("e2", "Park <park@example.com>", "Board deck"),
      ],
      attentionItem: [item("e1"), item("e2")],
    });

    await sendQuietHoursSummaries(AFTER_END);

    expect(pushes.calls[0][1]).toEqual(MAIL_ONLY_SUMMARY);
  });

  it("leaves out Slack rows that rang, were held for good, read, answered, outside the window or not this user's", async () => {
    seed({
      notification: [
        // Rang live: it holds an interrupt-budget slot key.
        slackRow("rung", { dedupeKey: "interrupt:2026-11-08:1" }),
        // The cap, the budget or a late re-judge held it: never rings.
        slackRow("capped", { dedupeKey: "slack-held:ep-capped" }),
        // Unnamed (a second row of one episode): the named one stands for it.
        slackRow("unnamed", { dedupeKey: null }),
        slackRow("read", { isRead: true }),
        slackRow("cleared", { isRead: true, clearedAt: at(5) }),
        slackRow("answered"),
        slackRow("before", { createdAt: new Date(WINDOW_START.getTime() - MIN) }),
        slackRow("after", { createdAt: WINDOW_END }),
        slackRow("other", { userId: "user-2", dedupeKey: "slack:ep-other" }),
        // Not a Slack row at all.
        slackRow("mail-ish", { type: "email" }),
      ],
      slackEpisode: [episode("ep-answered", at(6))],
    });

    expect(await sendQuietHoursSummaries(AFTER_END)).toBe(0);

    expect(pushes.calls).toEqual([]);
    expect(claimRows()).toEqual([]);
  });

  it("rings at most once per window, Slack included", async () => {
    seedMailAndSlack();

    await sendQuietHoursSummaries(AFTER_END);
    await sendQuietHoursSummaries(new Date(AFTER_END.getTime() + MIN));

    expect(pushes.calls).toHaveLength(1);
    expect(claimRows()).toHaveLength(1);
  });
});
