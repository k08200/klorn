/**
 * C2: an invite present in the primary and a linked calendar is two
 * CalendarEvent rows. The back-to-back warning measures the gap between
 * consecutive events, so a duplicated row would read as a meeting that starts
 * before the previous one ends and raise a false "back-to-back" alert.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  backToBackEvents: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<{ data: { title: string; message: string } }>,
}));

vi.mock("../db.js", () => {
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) =>
          vi.fn(async (args?: { select?: Record<string, unknown> }) => {
            if (name === "calendarEvent" && method === "findMany") {
              // checkBackToBackMeetings is the only caller selecting an end time
              // without an id.
              const select = args?.select ?? {};
              return select.endTime && !select.id ? m.backToBackEvents : [];
            }
            if (name === "notification" && method === "create") {
              m.notifications.push(args as { data: { title: string; message: string } });
              return { id: "n1", createdAt: new Date("2026-10-01T03:00:00Z") };
            }
            if (method === "findMany") return [];
            if (method === "count") return 0;
            return null;
          }),
      },
    );
  const prisma = new Proxy({}, { get: (_t, name: string) => model(name) });
  return { prisma, db: prisma };
});
vi.mock("../notify/push.js", () => ({ sendPushNotification: vi.fn(async () => undefined) }));
vi.mock("../notify/sms.js", () => ({ sendSms: vi.fn(async () => undefined) }));
vi.mock("../websocket.js", () => ({ pushNotification: vi.fn() }));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

import { runProactiveActions } from "../agentcore/proactive-actions.js";

const at = (hourUtc: number) => new Date(Date.UTC(2099, 0, 1, hourUtc));

function event(title: string, startHour: number, endHour: number, sourceAccountId: string | null) {
  return {
    title,
    startTime: at(startHour),
    endTime: at(endHour),
    provider: "GOOGLE",
    externalId: `g-${title}`,
    sourceAccountId,
  };
}

function backToBackAlerts() {
  return m.notifications.filter((n) => /back-to-back/.test(n.data.title));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.backToBackEvents = [];
  m.notifications = [];
  // The check only looks at the rest of "today"; pin the clock just before the events.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.UTC(2099, 0, 1, 0, 0)));
});

describe("back-to-back meetings warning — linked calendar copies", () => {
  it("does not warn when the only 'pair' is one invite present in two calendars", async () => {
    m.backToBackEvents = [event("Review", 9, 10, "acct-1"), event("Review", 9, 10, null)];

    await runProactiveActions("u1");

    expect(backToBackAlerts()).toHaveLength(0);
  });

  it("still warns for two genuinely back-to-back meetings", async () => {
    m.backToBackEvents = [event("A", 9, 10, null), event("B", 10, 11, "acct-1")];

    await runProactiveActions("u1");

    const alerts = backToBackAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.data.title).toContain("1 back-to-back");
  });
});
