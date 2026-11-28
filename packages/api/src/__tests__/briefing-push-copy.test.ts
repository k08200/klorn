import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The daily briefing's device push under NOTIFY_PUSH_PRESENTATION (NT0 brief
 * copy, decided 2026-11-17): title "오늘 브리핑", body "급한 메일 2 · 회의 3 ·
 * 빈 시간 5시간" — Today's PUSH mail (72h window, one per thread), today's
 * meetings and free hours from the day shape the briefing page shows. The bell
 * row, the live frame and, flag off, the push keep the briefing text.
 */

const state = vi.hoisted(() => ({
  config: { timezone: "Asia/Seoul", notificationLanguage: "ko" } as Record<string, unknown>,
  items: [] as Array<Record<string, unknown>>,
  mails: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  itemsFail: false,
}));

vi.mock("../db.js", () => ({
  prisma: {
    automationConfig: { findUnique: vi.fn(async () => state.config) },
    notification: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "notif-b",
        createdAt: new Date(),
        ...data,
      })),
    },
    attentionItem: {
      findMany: vi.fn(async () => {
        if (state.itemsFail) throw new Error("db down");
        return state.items;
      }),
    },
    emailMessage: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        state.mails.filter((m) => where.id.in.includes(String(m.id))),
      ),
    },
  },
}));
vi.mock("../pim/calendar-read.js", () => ({ readCalendarRows: vi.fn(async () => state.events) }));
vi.mock("../llm/openai.js", () => ({ MODEL: "test-model", createCompletion: vi.fn() }));
vi.mock("../pim/tasks.js", () => ({ listTasks: vi.fn(async () => ({ tasks: [] })) }));
vi.mock("../mail/gmail.js", () => ({ listEmails: vi.fn(async () => ({ emails: [] })) }));
vi.mock("../pim/notes.js", () => ({ listNotes: vi.fn(async () => ({ notes: [] })) }));
vi.mock("../llm/llm-credentials.js", () => ({
  getUserLlmCredentials: vi.fn(async () => undefined),
}));
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn(async () => undefined) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../report-db-failure.js", () => ({ logDbFailure: vi.fn(), captureDbFailure: vi.fn() }));

import { sendPushNotification } from "../notify/push.js";
import { ensureDailyBriefingNotification } from "../pim/briefing.js";
import { logDbFailure } from "../report-db-failure.js";
import { pushNotification } from "../websocket.js";

// 2026-11-19 08:30 in Seoul.
const NOW = new Date("2026-11-18T23:30:00.000Z");
const HOUR = 3_600_000;
const BRIEFING = "Morning. Two things need you before noon.";

/** A Seoul wall-clock hour today as a UTC instant. */
const seoulHour = (hour: number) => new Date(Date.UTC(2026, 10, 19, hour - 9));

function arrangeDay() {
  // Two PUSH mails in one thread + one more thread, inside 72h; one PUSH mail too old.
  state.items = [
    { sourceId: "m1", createdAt: NOW },
    { sourceId: "m2", createdAt: NOW },
    { sourceId: "m3", createdAt: NOW },
    { sourceId: "m-old", createdAt: NOW },
  ];
  state.mails = [
    {
      id: "m1",
      receivedAt: new Date(NOW.getTime() - HOUR),
      threadId: "t1",
      linkedInboxAccountId: null,
    },
    {
      id: "m2",
      receivedAt: new Date(NOW.getTime() - 2 * HOUR),
      threadId: "t1",
      linkedInboxAccountId: null,
    },
    {
      id: "m3",
      receivedAt: new Date(NOW.getTime() - 3 * HOUR),
      threadId: "t2",
      linkedInboxAccountId: null,
    },
    {
      id: "m-old",
      receivedAt: new Date(NOW.getTime() - 80 * HOUR),
      threadId: "t3",
      linkedInboxAccountId: null,
    },
  ];
  // Three meetings, 10–11, 11–12 and 14–16: 4 of the day's 12 hours (08–20) busy, 8 free.
  state.events = [
    { title: "A", startTime: seoulHour(10), endTime: seoulHour(11) },
    { title: "B", startTime: seoulHour(11), endTime: seoulHour(12) },
    { title: "C", startTime: seoulHour(14), endTime: seoulHour(16) },
  ];
}

type PushCall = [string, { title: string; body: string }, string];
const push = () => (vi.mocked(sendPushNotification).mock.calls as unknown as PushCall[])[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.config = { timezone: "Asia/Seoul", notificationLanguage: "ko" };
  state.itemsFail = false;
  arrangeDay();
  delete process.env.NOTIFY_PUSH_PRESENTATION;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.NOTIFY_PUSH_PRESENTATION;
});

describe("daily briefing push — NT0 brief copy", () => {
  it("flag on: title 오늘 브리핑, body = urgent mail threads · meetings · free hours", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";

    await ensureDailyBriefingNotification("u1", BRIEFING, "2026-11-19");

    const [, payload, category] = push();
    expect(category).toBe("daily_briefing");
    expect(payload).toMatchObject({
      title: "오늘 브리핑",
      body: "급한 메일 2 · 회의 3 · 빈 시간 8시간",
      url: "/briefing",
      notificationId: "notif-b",
    });
    // The bell row and the live frame keep the briefing itself.
    expect(vi.mocked(pushNotification).mock.calls[0][1]).toMatchObject({
      title: "오늘의 브리핑",
      message: BRIEFING,
    });
  });

  it("flag on, English: plurals", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    state.config = { timezone: "Asia/Seoul", notificationLanguage: "en" };

    await ensureDailyBriefingNotification("u1", BRIEFING, "2026-11-19");

    expect(push()[1]).toMatchObject({
      title: "Today's briefing",
      body: "2 urgent emails · 3 meetings · 8 hours free",
    });
  });

  it("flag on, a failed count read: the old push, and the failure reported as facts", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    state.itemsFail = true;

    await ensureDailyBriefingNotification("u1", BRIEFING, "2026-11-19");

    expect(push()[1]).toMatchObject({ title: "오늘의 브리핑", body: BRIEFING });
    expect(vi.mocked(logDbFailure)).toHaveBeenCalledWith(
      "[BRIEFING] push counts read failed",
      expect.any(Error),
      { ids: { userId: "u1" } },
    );
  });

  it("flag on, no urgent mail and no meeting: the old push (counts that say nothing do not ring)", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    state.items = [];
    state.events = [];

    await ensureDailyBriefingNotification("u1", BRIEFING, "2026-11-19");

    expect(push()[1]).toMatchObject({ title: "오늘의 브리핑", body: BRIEFING });
  });

  it("flag on: counts the PUSH lane under its retired v1 name too", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";

    await ensureDailyBriefingNotification("u1", BRIEFING, "2026-11-19");

    const { prisma } = await import("../db.js");
    expect(vi.mocked(prisma.attentionItem.findMany).mock.calls[0][0]).toMatchObject({
      where: { userId: "u1", status: "OPEN", tier: { in: ["PUSH", "CALL"] }, source: "EMAIL" },
    });
  });

  it("flag off: the push is exactly what it was", async () => {
    await ensureDailyBriefingNotification("u1", BRIEFING, "2026-11-19");

    expect(push()[1]).toEqual({
      title: "오늘의 브리핑",
      body: BRIEFING,
      url: "/briefing",
      notificationId: "notif-b",
    });
  });

  it("a quiet briefing still pushes nothing, flag on or off", async () => {
    process.env.NOTIFY_PUSH_PRESENTATION = "on";
    await ensureDailyBriefingNotification("u1", BRIEFING, "2026-11-19", { quiet: true });
    expect(sendPushNotification).not.toHaveBeenCalled();
  });
});
