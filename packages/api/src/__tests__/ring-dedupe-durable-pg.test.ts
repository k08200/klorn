import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Real-Postgres proof that "Clear all" in the bell is a pure UI action: it never
// makes Klorn ring the same mail (or the same day's briefing) again.
//
// Production, 2026-11-14: clearNotifications hard-deleted the urgent bell rows,
// and both mail interrupt paths (the urgent sweep and the firewall push) decided
// "already rang?" by reading those rows. A still-unread urgent mail rang again on
// the next tick: web push, phone push, Telegram, SMS and a new bell row.
//
// Every channel a ring reaches goes through three calls, all mocked here and
// counted: sendPushNotification (web push, FCM, APNs, Telegram), sendSms (admin
// escalation) and the real-time frame (pushNotification: bell + desktop banner).
// Skipped unless KLORN_TEST_PG_URL points at a database with every migration
// applied.
const url = vi.hoisted(() => {
  const value = process.env.KLORN_TEST_PG_URL;
  if (value) process.env.DATABASE_URL = value;
  return value;
});

const m = vi.hoisted(() => ({
  // What the push hold gates decide: a dispatch time, or null for a hold.
  dispatch: "now" as "now" | "held",
  pushes: [] as Array<{ userId: string; category: string; payload: Record<string, unknown> }>,
  sms: [] as string[],
  frames: [] as Array<{ userId: string; type: string }>,
}));

vi.mock("../sentry.js", () => ({ captureError: vi.fn(), initSentry: vi.fn() }));
vi.mock("../notify/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notify/push.js")>()),
  sendPushNotification: vi.fn(
    async (userId: string, payload: Record<string, unknown>, category: string) => {
      m.pushes.push({ userId, category, payload });
      const held = m.dispatch === "held";
      return {
        status: held ? "skipped" : "sent",
        reason: held ? "quiet_hours" : undefined,
        subscriptions: 1,
        attempted: held ? 0 : 1,
        accepted: held ? 0 : 1,
        failed: 0,
        dispatchedAt: held ? null : new Date(),
      };
    },
  ),
}));
vi.mock("../notify/sms.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../notify/sms.js")>()),
  sendSms: vi.fn(async (userId: string) => {
    m.sms.push(userId);
    return { sent: false };
  }),
}));
vi.mock("../websocket.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../websocket.js")>()),
  pushNotification: vi.fn((userId: string, frame: { type: string }) => {
    m.frames.push({ userId, type: frame.type });
  }),
}));

import { sweepUrgentEmails } from "../automation-scheduler.js";
import { clearNotifications, getNotifications } from "../background.js";
import { prisma } from "../db.js";
import type { JudgeableEmailRow } from "../judge/email-firewall.js";
import { pushForFirewallEmail } from "../judge/firewall-push.js";
import { sendQuietHoursSummaries } from "../notify/quiet-hours-summary.js";
import { ensureDailyBriefingNotification } from "../pim/briefing.js";

const describePg = url ? describe : describe.skip;
const createdUsers: string[] = [];
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

async function newUser(): Promise<string> {
  const user = await prisma.user.create({ data: { email: `ring-${randomUUID()}@test.local` } });
  createdUsers.push(user.id);
  return user.id;
}

/** An unread URGENT mail synced just now, its OPEN PUSH item and its ledger row. */
async function urgentPushMail(userId: string, subject: string): Promise<JudgeableEmailRow> {
  const gmailId = `18${randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const receivedAt = new Date(Date.now() - 2 * MINUTE);
  const mail = await prisma.emailMessage.create({
    data: {
      userId,
      gmailId,
      from: "Jane Kim <jane@partner.example>",
      to: "me@test.local",
      subject,
      priority: "URGENT",
      isRead: false,
      receivedAt,
    },
    select: { id: true },
  });
  await prisma.attentionItem.create({
    data: {
      userId,
      source: "EMAIL",
      sourceId: mail.id,
      type: "REPLY_NEEDED",
      title: subject,
      tier: "PUSH",
    },
  });
  await prisma.decisionLabel.create({
    data: {
      userId,
      source: "EMAIL",
      sourceId: mail.id,
      shownTier: "PUSH",
      features: { confidence: 0.9, senderTrust: 0.8, reversibility: 0.2, urgency: 0.9 },
      decidedBy: "llm",
    },
  });
  return {
    id: mail.id,
    gmailId,
    from: "Jane Kim <jane@partner.example>",
    subject,
    snippet: null,
    labels: ["INBOX"],
    receivedAt,
  };
}

const sweep = (userId: string) => sweepUrgentEmails({ userId, notificationLanguage: "en" });
const mailPushes = (userId: string) =>
  m.pushes.filter((p) => p.userId === userId && p.category === "email_urgent");
const mailFrames = (userId: string) =>
  m.frames.filter((f) => f.userId === userId && f.type === "email");
const rangAt = async (userId: string, emailId: string) =>
  (
    await prisma.decisionLabel.findUnique({
      where: { userId_source_sourceId: { userId, source: "EMAIL", sourceId: emailId } },
      select: { rangAt: true },
    })
  )?.rangAt ?? null;

/** The sweep stamps the ring off its tick (unawaited push): wait for the ledger. */
async function waitForRang(userId: string, emailId: string): Promise<void> {
  await vi.waitFor(async () => expect(await rangAt(userId, emailId)).not.toBeNull(), {
    timeout: 5_000,
    interval: 25,
  });
}

/** Every ring channel a mail interrupt reaches, counted for one user. */
const channels = (userId: string) => ({
  pushes: mailPushes(userId).length,
  sms: m.sms.filter((u) => u === userId).length,
  frames: mailFrames(userId).length,
});

beforeEach(() => {
  m.dispatch = "now";
  m.pushes.length = 0;
  m.sms.length = 0;
  m.frames.length = 0;
});

afterAll(async () => {
  if (!url) return;
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describePg("Clear all never re-rings an urgent mail (real Postgres)", () => {
  it("sweep rings X, Clear all, sweep again: no second ring on any channel", async () => {
    const userId = await newUser();
    const x = await urgentPushMail(userId, "Contract due today");

    await sweep(userId);
    await waitForRang(userId, x.id);
    expect(channels(userId)).toEqual({ pushes: 1, sms: 1, frames: 1 });

    await clearNotifications(userId);
    expect(await getNotifications(userId)).toEqual([]);

    await sweep(userId);
    await sweep(userId);
    expect(channels(userId)).toEqual({ pushes: 1, sms: 1, frames: 1 });
    expect(await getNotifications(userId)).toEqual([]);
  });

  it("a bell row removed by any other path (a single delete) does not re-ring either", async () => {
    const userId = await newUser();
    const x = await urgentPushMail(userId, "Wire instructions");

    await sweep(userId);
    await waitForRang(userId, x.id);
    const [row] = await getNotifications(userId);
    // No route deletes one bell row today; whatever ever does must not re-ring.
    await prisma.notification.delete({ where: { id: row.id } });

    await sweep(userId);
    expect(channels(userId)).toEqual({ pushes: 1, sms: 1, frames: 1 });
  });

  it("a new mail Y still rings after X was rung and cleared", async () => {
    const userId = await newUser();
    const x = await urgentPushMail(userId, "First");
    await sweep(userId);
    await waitForRang(userId, x.id);
    await clearNotifications(userId);

    const y = await urgentPushMail(userId, "Second");
    await sweep(userId);
    await waitForRang(userId, y.id);

    const pushes = mailPushes(userId);
    expect(pushes).toHaveLength(2);
    expect(pushes[1].payload.emailId).toBe(y.id);
    const bell = await getNotifications(userId);
    expect(bell).toHaveLength(1);
    expect(bell[0].sourceEmailId).toBe(y.id);
  });

  it("an interrupt the hold gates held is not re-rung after Clear all either", async () => {
    const userId = await newUser();
    const x = await urgentPushMail(userId, "Held by quiet hours");
    m.dispatch = "held";

    await sweep(userId);
    await vi.waitFor(() => expect(mailPushes(userId)).toHaveLength(1), { timeout: 5_000 });
    // Held: nothing reached a device, so the ledger records no ring.
    expect(await rangAt(userId, x.id)).toBeNull();

    await clearNotifications(userId);
    await sweep(userId);
    expect(channels(userId)).toEqual({ pushes: 1, sms: 1, frames: 1 });
    expect(await getNotifications(userId)).toEqual([]);
  });

  it("firewall push then sweep, with a Clear all between: one ring in total", async () => {
    const userId = await newUser();
    const x = await urgentPushMail(userId, "Board deck");

    expect(await pushForFirewallEmail(userId, x, false)).toBe("sent");
    expect(await rangAt(userId, x.id)).not.toBeNull();
    await clearNotifications(userId);

    await sweep(userId);
    expect(mailPushes(userId)).toHaveLength(1);
    expect(mailFrames(userId)).toHaveLength(1);
  });

  it("sweep then a firewall re-judge, with a Clear all between: one ring in total", async () => {
    const userId = await newUser();
    const x = await urgentPushMail(userId, "Signature needed");

    await sweep(userId);
    await waitForRang(userId, x.id);
    await clearNotifications(userId);

    expect(await pushForFirewallEmail(userId, x, false)).toBe("skipped");
    expect(mailPushes(userId)).toHaveLength(1);
    expect(mailFrames(userId)).toHaveLength(1);
  });

  it("a firewall bell row removed by any path still dedupes the firewall's own re-judge", async () => {
    const userId = await newUser();
    const x = await urgentPushMail(userId, "Invoice overdue");

    expect(await pushForFirewallEmail(userId, x, false)).toBe("sent");
    await prisma.notification.deleteMany({ where: { userId } });

    expect(await pushForFirewallEmail(userId, x, false)).toBe("skipped");
    expect(mailPushes(userId)).toHaveLength(1);
  });
});

describePg("when the ledger fails, the bell-row marker still holds (real Postgres)", () => {
  it("a failed 'already rang' read still rings a new PUSH mail once, and Clear all does not re-ring it", async () => {
    const userId = await newUser();
    await urgentPushMail(userId, "Ledger down");
    const read = vi
      .spyOn(prisma.decisionLabel, "findMany")
      .mockRejectedValue(new Error("ledger down"));
    try {
      await sweep(userId);
      expect(mailPushes(userId)).toHaveLength(1);

      await clearNotifications(userId);
      await sweep(userId);
      expect(read).toHaveBeenCalled();
      expect(channels(userId)).toEqual({ pushes: 1, sms: 1, frames: 1 });
    } finally {
      read.mockRestore();
    }
  });

  it("a failed ring stamp leaves the cleared bell row to dedupe: no second ring", async () => {
    const userId = await newUser();
    const x = await urgentPushMail(userId, "Stamp lost");
    const stamp = vi
      .spyOn(prisma.decisionLabel, "updateMany")
      .mockRejectedValue(new Error("ledger down"));
    try {
      await sweep(userId);
      await vi.waitFor(() => expect(stamp).toHaveBeenCalled(), { timeout: 5_000 });
    } finally {
      stamp.mockRestore();
    }
    expect(await rangAt(userId, x.id)).toBeNull();

    await clearNotifications(userId);
    await sweep(userId);
    expect(channels(userId)).toEqual({ pushes: 1, sms: 1, frames: 1 });
  });
});

/** "HH:MM" in UTC for an instant. */
const hhmm = (d: Date) =>
  `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

describePg("the quiet-hours summary is counted once (real Postgres)", () => {
  it("held mail rings once in the summary; Clear all, the sweep and a second summary add nothing", async () => {
    const userId = await newUser();
    // A quiet window around now that has ended by `after` (the summary's clock).
    const start = new Date(Date.now() - 30 * MINUTE);
    const end = new Date(Date.now() + 30 * MINUTE);
    const after = new Date(end.getTime() + 2 * MINUTE);
    await prisma.automationConfig.create({
      data: { userId, timezone: "UTC", quietHoursStart: hhmm(start), quietHoursEnd: hhmm(end) },
    });
    const x = await urgentPushMail(userId, "Night incident");

    m.dispatch = "held";
    await sweep(userId);
    await vi.waitFor(() => expect(mailPushes(userId)).toHaveLength(1), { timeout: 5_000 });
    expect(await rangAt(userId, x.id)).toBeNull();

    m.dispatch = "now";
    expect(await sendQuietHoursSummaries(after)).toBeGreaterThanOrEqual(1);
    expect(mailPushes(userId)).toHaveLength(2);
    expect(await rangAt(userId, x.id)).not.toBeNull();

    await clearNotifications(userId);
    await sweep(userId);
    await sendQuietHoursSummaries(after);
    expect(mailPushes(userId)).toHaveLength(2);
    expect(mailFrames(userId)).toHaveLength(1);
  });
});

describePg("Clear all keeps every other day-scoped dedupe (real Postgres)", () => {
  it("the day's briefing does not push again after Clear all", async () => {
    const userId = await newUser();
    const dayKey = "2026-11-14";

    expect(
      await ensureDailyBriefingNotification(userId, "Two meetings today.", dayKey),
    ).not.toBeNull();
    await clearNotifications(userId);
    expect(await ensureDailyBriefingNotification(userId, "Two meetings today.", dayKey)).toBeNull();

    expect(
      m.pushes.filter((p) => p.userId === userId && p.category === "daily_briefing"),
    ).toHaveLength(1);
    expect(await getNotifications(userId)).toEqual([]);
  });
});

describePg("clearNotifications: what it hides, what it deletes (real Postgres)", () => {
  it("hides recent rows, deletes rows past the dedupe window, keeps claims, and touches no one else", async () => {
    const userId = await newUser();
    const other = await newUser();
    const old = new Date(Date.now() - 8 * DAY);
    await prisma.notification.createMany({
      data: [
        { id: randomUUID(), userId, type: "task", title: "recent", message: "m" },
        { id: randomUUID(), userId, type: "task", title: "old", message: "m", createdAt: old },
        {
          id: randomUUID(),
          userId,
          type: "briefing",
          title: "Daily Briefing",
          message: "m",
          dedupeKey: "briefing:2026-11-14",
        },
        {
          id: randomUUID(),
          userId,
          type: "email",
          title: "Klorn replied for you",
          message: "m",
          dedupeKey: "auto-reply:g-1",
          createdAt: old,
        },
        { id: randomUUID(), userId: other, type: "task", title: "theirs", message: "m" },
      ],
    });

    await clearNotifications(userId);

    expect(await getNotifications(userId)).toEqual([]);
    const rows = await prisma.notification.findMany({
      where: { userId },
      select: { title: true, type: true, isRead: true, clearedAt: true },
      orderBy: { title: "asc" },
    });
    expect(rows.map((r) => r.title)).toEqual(["Daily Briefing", "Klorn replied for you", "recent"]);
    for (const r of rows.filter((r) => r.title !== "Klorn replied for you")) {
      expect(r.isRead).toBe(true);
      expect(r.clearedAt).not.toBeNull();
    }
    // The reply claim is hidden the way it always was.
    expect(rows.find((r) => r.title === "Klorn replied for you")?.type).toBe("claim");
    expect(await getNotifications(other)).toHaveLength(1);

    // A second clear is idempotent and keeps the first clear's time.
    const firstClear = rows.find((r) => r.title === "recent")?.clearedAt;
    await clearNotifications(userId);
    const again = await prisma.notification.findFirst({
      where: { userId, title: "recent" },
      select: { clearedAt: true },
    });
    expect(again?.clearedAt).toEqual(firstClear);
  });
});
