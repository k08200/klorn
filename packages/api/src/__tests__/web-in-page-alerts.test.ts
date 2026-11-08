/**
 * In-page OS notifications in a normal browser tab — the pure decision in
 * packages/web/src/lib/in-page-alerts.ts.
 *
 * Two bugs this pins:
 *  1. The tab fired `new Notification` for EVERY real-time frame with an id
 *     (QUEUE mail, agent notes, briefings), skipping the user's category
 *     opt-outs and quiet hours. The server already tags the frames that passed
 *     that gate with `alert: "push" | "meeting"` (notify/desktop-alert.ts); the
 *     tab must notify for exactly those and leave the rest to the bell.
 *  2. With Web Push on, the service worker showed the same PUSH mail again.
 *     The tab now stays quiet when this browser holds a push subscription, and
 *     both notifications carry one OS tag so a race still shows one.
 */

import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_TAG_PREFIX,
  notificationTag,
  planInPageNotification,
} from "../../../web/src/lib/in-page-alerts";
import { planDesktopAlert } from "../../../web/src/lib/native/desktop-alerts";

const pushFrame = {
  id: "notif-1",
  type: "email",
  title: "Urgent email",
  message: "Kim: Q4 budget",
  alert: "push",
};

const browserTab = {
  isTauri: false,
  permission: "granted" as const,
  hasPushSubscription: false,
};

describe("planInPageNotification — which frames a browser tab turns into an OS notification", () => {
  it("shows a server-tagged PUSH frame when this browser has no push subscription", () => {
    expect(planInPageNotification(pushFrame, browserTab)).toEqual({
      title: "Urgent email",
      options: {
        body: "Kim: Q4 budget",
        icon: "/icon-192.png",
        tag: notificationTag("notif-1"),
        requireInteraction: true,
      },
    });
  });

  it("shows a meeting frame without the server's trailing [eventId] marker", () => {
    const meeting = {
      id: "notif-2",
      type: "meeting",
      title: "Meeting in 5 min: Standup",
      message: "Standup starts soon [evt-123]",
      alert: "meeting",
    };
    expect(planInPageNotification(meeting, browserTab)?.options.body).toBe("Standup starts soon");
  });

  it("shows nothing for an untagged frame — the bell row is the only signal", () => {
    const untagged = [
      { id: "n-q", type: "email", title: "Queued mail", message: "Newsletter" },
      { id: "n-a", type: "insight", title: "[Klorn] Review needed", message: "Draft ready" },
      { id: "n-b", type: "briefing", title: "Daily briefing", message: "3 items" },
      // Same title as the urgent-sweep frame, but the gate did not tag it
      // (quiet hours / opted out): never re-classify from type or title.
      { id: "n-u", type: "email", title: "Urgent email", message: "Kim: Q4 budget" },
    ];
    for (const frame of untagged) {
      expect(planInPageNotification(frame, browserTab)).toBeNull();
    }
  });

  it("skips a tagged frame when this browser holds a push subscription — the service worker shows it", () => {
    expect(
      planInPageNotification(pushFrame, { ...browserTab, hasPushSubscription: true }),
    ).toBeNull();
  });

  it("shows nothing without notification permission", () => {
    for (const permission of ["default", "denied", "unsupported"] as const) {
      expect(planInPageNotification(pushFrame, { ...browserTab, permission })).toBeNull();
    }
  });

  it("rejects unknown alert kinds and malformed frames without throwing", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "frame",
      [pushFrame],
      { ...pushFrame, alert: "PUSH" },
      { ...pushFrame, alert: "auto" },
      { ...pushFrame, id: "" },
      { ...pushFrame, id: 42 },
      { ...pushFrame, id: "x".repeat(201) },
    ];
    for (const frame of bad) {
      expect(planInPageNotification(frame, browserTab)).toBeNull();
    }
  });
});

describe("Tauri shell — unchanged", () => {
  it("never shows an in-page notification inside the Windows shell (its plugin replaces window.Notification)", () => {
    const tauri = { ...browserTab, isTauri: true };
    expect(planInPageNotification(pushFrame, tauri)).toBeNull();
    expect(planInPageNotification(pushFrame, { ...tauri, hasPushSubscription: true })).toBeNull();
  });

  it("the shell still banners exactly the tagged frames, once each", () => {
    const first = planDesktopAlert([], pushFrame);
    expect(first.alert).toEqual({
      id: "notif-1",
      kind: "push",
      title: "Urgent email",
      body: "Kim: Q4 budget",
    });
    expect(planDesktopAlert(first.seen, pushFrame).alert).toBeNull();
    expect(planDesktopAlert([], { ...pushFrame, alert: undefined }).alert).toBeNull();
  });
});

describe("notificationTag — the OS tag shared with the service worker", () => {
  it("is derived from the bell notification id alone", () => {
    expect(notificationTag("notif-1")).toBe(`${NOTIFICATION_TAG_PREFIX}notif-1`);
    expect(notificationTag("notif-1")).toBe(notificationTag("notif-1"));
    expect(notificationTag("notif-1")).not.toBe(notificationTag("notif-2"));
  });
});
