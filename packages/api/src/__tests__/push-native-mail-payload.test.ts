/**
 * Native push payloads for MAIL-driven interrupts (firewall PUSH / MEETING, a
 * single-email urgent sweep): the bundled mobile app deep-links and offers
 * lock-screen actions from them.
 *
 *   - every key a push already carried (web, desktop and the current app read
 *     them) is byte-identical, in the same order — a push with no `emailId`
 *     produces exactly the JSON / FCM message it produced before;
 *   - a mail push adds `emailId`, `attentionItemId`, `pendingActionId` (only when
 *     a draft approval exists) and `route: /mail/<emailId>`; on APNs also
 *     `aps.category` (KLORN_PUSH_MAIL, or KLORN_PUSH_MAIL_DRAFT with a draft
 *     approval) and `aps.mutable-content: 1`;
 *   - the new keys are opaque ids and a route — no sender, subject or address;
 *   - web push and Telegram receive the payload WITHOUT the new keys.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  prisma: {
    devicePushToken: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({})) },
  },
}));
vi.mock("../sentry.js", () => ({ captureError: vi.fn() }));

const { buildApnsBody } = await import("../notify/push-apns.js");
const { buildFcmMessage } = await import("../notify/push-device.js");

const BASE = { title: "Klorn — Alice", body: "Q3 budget", url: "/inbox/firewall" };

/** The APNs body exactly as push-apns.ts built it before mail fields existed. */
function legacyApnsBody(
  payload: { title: string; body: string; url?: string; notificationId?: string },
  category: string,
): string {
  return JSON.stringify({
    aps: { alert: { title: payload.title, body: payload.body }, sound: "default" },
    ...(payload.url ? { url: payload.url } : {}),
    ...(payload.notificationId ? { notificationId: payload.notificationId } : {}),
    category,
  });
}

/** The FCM message exactly as push-device.ts built it before mail fields existed. */
function legacyFcmMessage(
  token: string,
  payload: { title: string; body: string; url?: string; notificationId?: string },
  category: string,
) {
  const data: Record<string, string> = {};
  if (payload.url) data.url = payload.url;
  if (payload.notificationId) data.notificationId = payload.notificationId;
  return {
    token,
    notification: { title: payload.title, body: payload.body },
    data: { ...data, category },
    android: { priority: "high" },
  };
}

describe("APNs body", () => {
  it.each([
    ["no url", { title: "t", body: "b" }],
    ["url + notificationId", { ...BASE, notificationId: "n-1" }],
    // attentionItemId alone (no emailId) is not a mail deep link: unchanged.
    ["attentionItemId without emailId", { ...BASE, attentionItemId: "item-1" }],
  ])("a non-mail push (%s) is byte-identical to before", (_label, payload) => {
    expect(buildApnsBody(payload, "system")).toBe(legacyApnsBody(payload, "system"));
  });

  it("a mail push keeps every existing key, in order, and adds the deep link", () => {
    const payload = {
      ...BASE,
      notificationId: "n-1",
      emailId: "email-1",
      attentionItemId: "item-1",
    };
    const parsed = JSON.parse(buildApnsBody(payload, "email_urgent"));
    const legacy = JSON.parse(legacyApnsBody(payload, "email_urgent"));
    // Existing keys: same values, same order, at the front.
    expect(Object.keys(parsed).slice(0, Object.keys(legacy).length)).toEqual(Object.keys(legacy));
    for (const key of Object.keys(legacy)) {
      if (key === "aps") continue;
      expect(parsed[key]).toEqual(legacy[key]);
    }
    expect(Object.keys(parsed.aps).slice(0, 2)).toEqual(["alert", "sound"]);
    expect(parsed.aps.alert).toEqual(legacy.aps.alert);
    expect(parsed.aps.sound).toBe("default");
    // New keys.
    expect(parsed.aps.category).toBe("KLORN_PUSH_MAIL");
    expect(parsed.aps["mutable-content"]).toBe(1);
    expect(parsed.emailId).toBe("email-1");
    expect(parsed.attentionItemId).toBe("item-1");
    expect(parsed.route).toBe("/mail/email-1");
    expect(parsed).not.toHaveProperty("pendingActionId");
  });

  it("a mail push with a draft approval uses the draft category and carries its id", () => {
    const parsed = JSON.parse(
      buildApnsBody({ ...BASE, emailId: "email-1", pendingActionId: "pa-1" }, "email_urgent"),
    );
    expect(parsed.aps.category).toBe("KLORN_PUSH_MAIL_DRAFT");
    expect(parsed.pendingActionId).toBe("pa-1");
    expect(parsed).not.toHaveProperty("attentionItemId");
  });

  it("the route is path-safe for any id", () => {
    const parsed = JSON.parse(buildApnsBody({ ...BASE, emailId: "a/b?c" }, "email_urgent"));
    expect(parsed.route).toBe("/mail/a%2Fb%3Fc");
  });
});

describe("FCM message", () => {
  it.each([
    ["no url", { title: "t", body: "b" }],
    ["url + notificationId", { ...BASE, notificationId: "n-1" }],
    ["attentionItemId without emailId", { ...BASE, attentionItemId: "item-1" }],
  ])("a non-mail push (%s) is identical to before", (_label, payload) => {
    expect(buildFcmMessage("tok", payload, "system")).toEqual(
      legacyFcmMessage("tok", payload, "system"),
    );
    expect(JSON.stringify(buildFcmMessage("tok", payload, "system"))).toBe(
      JSON.stringify(legacyFcmMessage("tok", payload, "system")),
    );
  });

  it("a mail push keeps every existing data key and adds string deep-link fields", () => {
    const payload = {
      ...BASE,
      notificationId: "n-1",
      emailId: "email-1",
      attentionItemId: "item-1",
      pendingActionId: "pa-1",
    };
    const message = buildFcmMessage("tok", payload, "email_urgent");
    const legacy = legacyFcmMessage("tok", payload, "email_urgent");
    expect(message.notification).toEqual(legacy.notification);
    expect(message.android).toEqual(legacy.android);
    expect(message.token).toBe("tok");
    expect(Object.keys(message.data ?? {}).slice(0, 3)).toEqual(Object.keys(legacy.data));
    expect(message.data).toEqual({
      ...legacy.data,
      emailId: "email-1",
      attentionItemId: "item-1",
      pendingActionId: "pa-1",
      route: "/mail/email-1",
    });
    for (const value of Object.values(message.data ?? {})) expect(typeof value).toBe("string");
  });
});

describe("FCM data-only message (dataMessages device, ANDROID_DATA_PUSH_ENABLED)", () => {
  const MAIL = { ...BASE, notificationId: "n-1", emailId: "email-1", pendingActionId: "pa-1" };

  it("a mail push moves title and body into data, adds sentAt, and drops the notification block", () => {
    const message = buildFcmMessage("tok", MAIL, "email_urgent", { dataOnly: true, now: 1_700 });
    expect(message).toEqual({
      token: "tok",
      data: {
        url: "/inbox/firewall",
        notificationId: "n-1",
        category: "email_urgent",
        emailId: "email-1",
        pendingActionId: "pa-1",
        route: "/mail/email-1",
        title: "Klorn — Alice",
        body: "Q3 budget",
        sentAt: "1700",
      },
      android: { priority: "high" },
    });
    expect("notification" in message).toBe(false);
    for (const value of Object.values(message.data ?? {})) expect(typeof value).toBe("string");
  });

  it("a push that is not about one mail stays a notification message", () => {
    const payload = { ...BASE, attentionItemId: "item-1" };
    expect(buildFcmMessage("tok", payload, "system", { dataOnly: true })).toEqual(
      legacyFcmMessage("tok", payload, "system"),
    );
  });

  it("without dataOnly a mail push is the notification message it always was", () => {
    expect(buildFcmMessage("tok", MAIL, "email_urgent", { dataOnly: false })).toEqual(
      buildFcmMessage("tok", MAIL, "email_urgent"),
    );
    expect(buildFcmMessage("tok", MAIL, "email_urgent").notification).toEqual({
      title: "Klorn — Alice",
      body: "Q3 budget",
    });
  });
});
