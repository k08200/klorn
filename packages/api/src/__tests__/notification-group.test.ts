/**
 * Notification center groups (NC1): one server rule per group, first match
 * wins — done → later (snoozed) → reply → now → today → later. Pure.
 */

import { describe, expect, it } from "vitest";
import { type GroupInput, needsLocalDay, notificationGroup } from "../notify/notification-group.js";

const HOUR = 3_600_000;
// 2026-11-14 10:00 in Seoul (UTC+9).
const NOW = new Date("2026-11-14T01:00:00.000Z");
const SEOUL = "Asia/Seoul";
const ctx = { now: NOW, timeZone: SEOUL };

function row(overrides: Partial<GroupInput> = {}): GroupInput {
  return {
    isRead: false,
    type: "email",
    createdAt: new Date(NOW.getTime() - HOUR),
    pendingActionStatus: null,
    item: null,
    email: null,
    ...overrides,
  };
}

const item = (overrides: Partial<NonNullable<GroupInput["item"]>> = {}) => ({
  tier: "QUEUE",
  status: "OPEN",
  v3Due: null,
  snoozedUntil: null,
  ...overrides,
});

const email = (overrides: Partial<NonNullable<GroupInput["email"]>> = {}) => ({
  receivedAt: new Date(NOW.getTime() - HOUR),
  needsReply: false,
  repliedAt: null,
  ...overrides,
});

describe("notificationGroup — done", () => {
  it("a read row is done, whatever its lane", () => {
    expect(notificationGroup(row({ isRead: true, item: item({ tier: "PUSH" }) }), ctx)).toBe(
      "done",
    );
  });

  it.each(["RESOLVED", "DISMISSED"])("an unread row whose item is %s is done", (status) => {
    expect(
      notificationGroup(row({ item: item({ tier: "PUSH", status }), email: email() }), ctx),
    ).toBe("done");
  });

  it.each([
    "APPROVED",
    "REJECTED",
    "EXPIRED",
  ])("an approval no longer pending (%s) is done", (status) => {
    expect(notificationGroup(row({ pendingActionStatus: status }), ctx)).toBe("done");
  });
});

describe("notificationGroup — later (snoozed)", () => {
  it("an item snoozed into the future is later, even a fresh PUSH that needs a reply", () => {
    const input = row({
      item: item({
        tier: "PUSH",
        status: "SNOOZED",
        snoozedUntil: new Date(NOW.getTime() + HOUR),
      }),
      email: email({ needsReply: true }),
    });
    expect(notificationGroup(input, ctx)).toBe("later");
  });

  it("a snooze that has run out no longer holds the row back", () => {
    const input = row({
      item: item({
        tier: "PUSH",
        status: "SNOOZED",
        snoozedUntil: new Date(NOW.getTime() - HOUR),
      }),
      email: email(),
    });
    expect(notificationGroup(input, ctx)).toBe("now");
  });
});

describe("notificationGroup — reply", () => {
  it("a mail that needs a reply and has none is reply (before now)", () => {
    const input = row({ item: item({ tier: "PUSH" }), email: email({ needsReply: true }) });
    expect(notificationGroup(input, ctx)).toBe("reply");
  });

  it("an answered mail is not reply", () => {
    const input = row({
      item: item({ tier: "QUEUE" }),
      email: email({ needsReply: true, repliedAt: new Date(NOW.getTime() - HOUR / 2) }),
    });
    expect(notificationGroup(input, ctx)).toBe("later");
  });
});

describe("notificationGroup — now (Today Push 72h, LOCKED)", () => {
  it("an unread PUSH mail received inside 72h is now", () => {
    const input = row({
      item: item({ tier: "PUSH" }),
      email: email({ receivedAt: new Date(NOW.getTime() - 71 * HOUR) }),
    });
    expect(notificationGroup(input, ctx)).toBe("now");
  });

  it("a PUSH mail received more than 72h ago is later", () => {
    const input = row({
      item: item({ tier: "PUSH" }),
      email: email({ receivedAt: new Date(NOW.getTime() - 73 * HOUR) }),
    });
    expect(notificationGroup(input, ctx)).toBe("later");
  });

  it("the retired CALL value reads as PUSH", () => {
    expect(notificationGroup(row({ item: item({ tier: "CALL" }), email: email() }), ctx)).toBe(
      "now",
    );
  });

  it("a row with no known lane is never now", () => {
    expect(notificationGroup(row({ email: email() }), ctx)).toBe("later");
  });

  it.each(["QUEUE", "INFO", "SILENT"])("a %s mail is not now", (tier) => {
    expect(notificationGroup(row({ item: item({ tier }), email: email() }), ctx)).toBe("later");
  });
});

describe("notificationGroup — today (the user's local day)", () => {
  it("a MEETING mail whose row was written today is today", () => {
    const input = row({ item: item({ tier: "MEETING" }), email: email() });
    expect(notificationGroup(input, ctx)).toBe("today");
  });

  it("a MEETING mail from yesterday (local) is later", () => {
    // 2026-11-13 23:00 Seoul = 14:00Z on the 13th.
    const input = row({
      createdAt: new Date("2026-11-13T14:00:00.000Z"),
      item: item({ tier: "MEETING" }),
      email: email(),
    });
    expect(notificationGroup(input, ctx)).toBe("later");
  });

  it("local day, not UTC day: 00:30 Seoul today is today although it is yesterday in UTC", () => {
    const input = row({
      createdAt: new Date("2026-11-13T15:30:00.000Z"),
      item: item({ tier: "MEETING" }),
      email: email(),
    });
    expect(notificationGroup(input, ctx)).toBe("today");
  });

  it("a QUEUE mail whose v3 ask is due today is today", () => {
    const input = row({
      createdAt: new Date(NOW.getTime() - 50 * HOUR),
      item: item({ tier: "QUEUE", v3Due: new Date("2026-11-14T09:00:00.000Z") }),
      email: email({ receivedAt: new Date(NOW.getTime() - 50 * HOUR) }),
    });
    expect(notificationGroup(input, ctx)).toBe("today");
  });

  it("an ask due tomorrow is later", () => {
    const input = row({
      item: item({ tier: "QUEUE", v3Due: new Date("2026-11-15T09:00:00.000Z") }),
      email: email(),
    });
    expect(notificationGroup(input, ctx)).toBe("later");
  });

  it.each(["meeting", "calendar", "reminder"])("a %s row written today is today", (type) => {
    expect(notificationGroup(row({ type }), ctx)).toBe("today");
  });

  it("a reminder row from an earlier day is later", () => {
    const input = row({ type: "reminder", createdAt: new Date(NOW.getTime() - 30 * HOUR) });
    expect(notificationGroup(input, ctx)).toBe("later");
  });

  it("an approval still pending is today", () => {
    expect(
      notificationGroup(row({ type: "agent_proposal", pendingActionStatus: "PENDING" }), ctx),
    ).toBe("today");
  });
});

describe("notificationGroup — later (everything else)", () => {
  it.each([
    "briefing",
    "info",
    "task",
    "email",
  ])("an unread %s row with nothing else is later", (type) => {
    expect(notificationGroup(row({ type }), ctx)).toBe("later");
  });
});

describe("needsLocalDay", () => {
  it("is false for rows the local day cannot change", () => {
    expect(needsLocalDay(row({ isRead: true, type: "reminder" }))).toBe(false);
    expect(needsLocalDay(row({ type: "info" }))).toBe(false);
    expect(needsLocalDay(row({ item: item({ tier: "PUSH" }), email: email() }))).toBe(false);
  });

  it("is true when the today rule has to read the calendar day", () => {
    expect(needsLocalDay(row({ type: "reminder" }))).toBe(true);
    expect(needsLocalDay(row({ item: item({ tier: "MEETING" }), email: email() }))).toBe(true);
    expect(
      needsLocalDay(row({ item: item({ v3Due: new Date(NOW.getTime()) }), email: email() })),
    ).toBe(true);
  });

  it("agrees with notificationGroup: a row that does not need it groups the same in any zone", () => {
    const rows = [
      row({ type: "info" }),
      row({ item: item({ tier: "PUSH" }), email: email() }),
      row({ isRead: true, type: "meeting" }),
    ];
    for (const r of rows) {
      expect(needsLocalDay(r)).toBe(false);
      expect(notificationGroup(r, { now: NOW, timeZone: "UTC" })).toBe(
        notificationGroup(r, { now: NOW, timeZone: "Pacific/Kiritimati" }),
      );
    }
  });
});
