/**
 * The firewall's urgent-mail bell row opens the mail (judge/firewall-push.ts).
 * The row carried the mail id (sourceEmailId) but no link, so the web bell fell
 * back to its type route and a click landed on /briefing instead of the mail.
 * The stored row and the live WebSocket frame both carry the reader path now;
 * the device push already did (`url`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pushNotification: vi.fn(),
  sendPushNotification: vi.fn(async () => ({ status: "sent" })),
}));

vi.mock("../db.js", () => ({
  prisma: { attentionItem: { findFirst: vi.fn(async () => null) } },
}));
vi.mock("../websocket.js", () => ({ pushNotification: mocks.pushNotification }));
vi.mock("../notify/push.js", () => ({ sendPushNotification: mocks.sendPushNotification }));
vi.mock("../notify/desktop-alert.js", () => ({
  desktopAlertTag: vi.fn(async () => ({ alert: "push" })),
}));

import { deliverFirewallPush, firewallBellRow } from "../judge/firewall-push.js";

type Email = Parameters<typeof firewallBellRow>[0];

const EMAIL = {
  id: "email-db-1",
  gmailId: "18c0ffee",
  from: '"Kim Lee" <kim@example.com>',
  subject: "Signed contract due today",
  receivedAt: new Date("2026-11-11T08:00:00Z"),
} as unknown as Email;

beforeEach(() => {
  mocks.pushNotification.mockClear();
  mocks.sendPushNotification.mockClear();
});

describe("firewall urgent-mail bell row", () => {
  it("links the row to the mail it names", () => {
    const row = firewallBellRow(EMAIL, "en");
    expect(row.sourceEmailId).toBe("email-db-1");
    expect(row.link).toBe("/email/email-db-1");
  });

  it("keeps the [gmailId] dedupe marker the push dedupe reads back", () => {
    expect(firewallBellRow(EMAIL, "en").message.endsWith("[18c0ffee]")).toBe(true);
  });

  it("the live frame opens the same mail as the stored row and the device push", async () => {
    await deliverFirewallPush(
      "user-1",
      EMAIL,
      { id: "notif-1", createdAt: new Date("2026-11-11T08:00:05Z") },
      "en",
    );
    const frame = mocks.pushNotification.mock.calls[0][1] as { id: string; link?: string };
    expect(frame).toMatchObject({ id: "notif-1", link: "/email/email-db-1" });
    const payload = (
      mocks.sendPushNotification.mock.calls[0] as unknown as [string, { url: string }]
    )[1];
    expect(payload.url).toBe("/email/email-db-1");
  });
});
