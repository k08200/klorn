import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTION_CATEGORIES,
  ANDROID_CHANNELS,
  androidActionTypes,
  notificationIdOf,
  parseDataPush,
  STALE_AFTER_MS,
} from "./android";
import { intentOf, PUSH_ACTIONS } from "./route";

const NOW = Date.parse("2026-10-16T01:28:00Z");

/**
 * What the server's buildFcmMessage puts in `data` for a firewall PUSH mail
 * (packages/api notify/push-device.ts), plus the title / body a data-only
 * message must carry.
 */
const full = {
  title: "PUSH · 박서연",
  body: "계약서 오늘 18시 마감 — 답장 초안을 준비해 뒀어요.",
  url: "/inbox/firewall",
  category: "email_urgent",
  emailId: "email-att-push-1",
  attentionItemId: "att-1",
  pendingActionId: "pa-1",
  route: "/mail/email-att-push-1",
  sentAt: String(NOW - 5_000),
};

describe("Android data-only pushes", () => {
  it("uses the same action-set ids as the server's APNs categories and AppDelegate.swift", () => {
    // packages/api notify/push-apns.ts APNS_MAIL_CATEGORY / APNS_MAIL_DRAFT_CATEGORY.
    expect(ACTION_CATEGORIES).toEqual({
      withDraft: "KLORN_PUSH_MAIL_DRAFT",
      plain: "KLORN_PUSH_MAIL",
      meeting: "KLORN_PUSH_MEETING",
    });
    const swift = readFileSync("ios/App/App/AppDelegate.swift", "utf8");
    expect(swift).toContain(`static let pushWithDraft = "${ACTION_CATEGORIES.withDraft}"`);
    expect(swift).toContain(`static let push = "${ACTION_CATEGORIES.plain}"`);
    expect(swift).toContain(`static let meeting = "${ACTION_CATEGORIES.meeting}"`);
    for (const action of [
      PUSH_ACTIONS.send,
      PUSH_ACTIONS.reply,
      PUSH_ACTIONS.later,
      PUSH_ACTIONS.notUrgent,
      PUSH_ACTIONS.done,
    ]) {
      expect(swift).toContain(`identifier: "${action}"`);
    }
    // Decision N1: Silent / Mute is never a notification action.
    expect(swift).not.toMatch(/identifier: "KLORN_(SILENT|MUTE)/);
  });

  it("posts a data-only Klorn message with the draft actions on the PUSH channel", () => {
    const push = parseDataPush({ data: full }, NOW);
    expect(push).toMatchObject({
      title: full.title,
      body: full.body,
      category: ACTION_CATEGORIES.withDraft,
      channelId: ANDROID_CHANNELS.push.id,
      data: {
        emailId: "email-att-push-1",
        attentionItemId: "att-1",
        pendingActionId: "pa-1",
        route: "/mail/email-att-push-1",
        url: "/inbox/firewall",
      },
    });
    expect(push?.notificationId).toBe(notificationIdOf("att-1"));
  });

  it("leaves notification messages to the OS, and ignores empty or stale ones", () => {
    expect(parseDataPush({ title: "shown by FCM", data: full }, NOW)).toBeNull();
    expect(parseDataPush({ data: { ...full, title: "  " } }, NOW)).toBeNull();
    expect(parseDataPush({ data: { emailId: "e1" } }, NOW)).toBeNull();
    expect(
      parseDataPush({ data: { ...full, sentAt: String(NOW - STALE_AFTER_MS - 1) } }, NOW),
    ).toBeNull();
  });

  it("derives the action set from the ids — a draft only with pendingActionId — and drops bad ids", () => {
    // A mail push without a draft (the firewall's today): emailId alone is enough.
    const mail = parseDataPush(
      { data: { title: "t", body: "b", category: "email_urgent", emailId: "e-1" } },
      NOW,
    );
    expect(mail?.category).toBe(ACTION_CATEGORIES.plain);
    const plain = parseDataPush(
      { data: { title: "t", body: "b", attentionItemId: "att-2", emailId: "../x" } },
      NOW,
    );
    expect(plain?.category).toBe(ACTION_CATEGORIES.plain);
    expect(plain?.data).toEqual({ attentionItemId: "att-2" });
    // Not about one mail (a briefing): no buttons, a tap still routes.
    const briefing = parseDataPush(
      { data: { title: "t", body: "b", category: "daily_briefing", url: "/briefing" } },
      NOW,
    );
    expect(briefing?.category).toBeNull();
    expect(briefing?.data).toEqual({ url: "/briefing" });
    // `category` is the server's NotifCategory: never read as an action set.
    expect(
      parseDataPush({ data: { title: "t", body: "b", category: "KLORN_PUSH_MAIL" } }, NOW)
        ?.category,
    ).toBeNull();
  });

  it("works without sentAt (the server does not send it), and puts only PUSH mail on the high channel", () => {
    const { sentAt: _sentAt, ...noSentAt } = full;
    expect(parseDataPush({ data: noSentAt }, NOW)).not.toBeNull();
    expect(parseDataPush({ data: { ...full, category: "meeting" } }, NOW)?.channelId).toBe(
      ANDROID_CHANNELS.other.id,
    );
    expect(ANDROID_CHANNELS.push.importance).toBe(4); // NotificationManager.IMPORTANCE_HIGH
  });

  it("gives stable 31-bit positive notification ids", () => {
    const id = notificationIdOf("att-1");
    expect(id).toBe(notificationIdOf("att-1"));
    expect(id).not.toBe(notificationIdOf("att-2"));
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it("shows 나중에 · 급하지 않음 · 처리 완료 on a mail, 나중에 on a meeting, and never sends", () => {
    const types = androidActionTypes({
      later: "나중에",
      notUrgent: "급하지 않음",
      done: "처리 완료",
    });
    const byId = Object.fromEntries(types.map((type) => [type.id, type.actions]));
    for (const id of [ACTION_CATEGORIES.withDraft, ACTION_CATEGORIES.plain]) {
      expect(byId[id]?.map((a) => a.title)).toEqual(["나중에", "급하지 않음", "처리 완료"]);
      expect(byId[id]?.map((a) => a.id)).toEqual([
        PUSH_ACTIONS.later,
        PUSH_ACTIONS.notUrgent,
        PUSH_ACTIONS.done,
      ]);
    }
    expect(byId[ACTION_CATEGORIES.meeting]?.map((a) => a.id)).toEqual([PUSH_ACTIONS.later]);
    for (const type of types) expect(type.actions.map((a) => a.id)).not.toContain(PUSH_ACTIONS.send);
    const data = parseDataPush({ data: full }, NOW)?.data;
    expect(intentOf(PUSH_ACTIONS.review, data)).toEqual({
      kind: "review",
      route: { name: "assistant", section: "approvals", id: "pa-1" },
    });
    // Later / Done act on the mail by its email id (works for any mail).
    expect(intentOf(PUSH_ACTIONS.later, data)).toMatchObject({
      kind: "snooze",
      target: { emailId: "email-att-push-1" },
    });
    expect(intentOf(PUSH_ACTIONS.done, data)).toMatchObject({
      kind: "done",
      target: { emailId: "email-att-push-1" },
    });
    // Review on a mail without a draft opens the mail.
    expect(intentOf(PUSH_ACTIONS.review, { emailId: "e1", attentionItemId: "att-1" })).toEqual({
      kind: "review",
      route: { name: "mail", id: "e1" },
    });
  });
});

describe("decision N1: the lane picks the Android action set", () => {
  it("a MEETING mail takes the meeting set and keeps its lane; a draft still wins", () => {
    const { pendingActionId: _p, ...mail } = full;
    const meeting = parseDataPush({ data: { ...mail, lane: "MEETING" } }, NOW);
    expect(meeting?.category).toBe(ACTION_CATEGORIES.meeting);
    expect(meeting?.data.lane).toBe("MEETING");
    expect(parseDataPush({ data: { ...full, lane: "MEETING" } }, NOW)?.category).toBe(
      ACTION_CATEGORIES.withDraft,
    );
    expect(parseDataPush({ data: { ...mail, lane: "PUSH" } }, NOW)?.category).toBe(
      ACTION_CATEGORIES.plain,
    );
    // An unknown lane is dropped, never trusted.
    const odd = parseDataPush({ data: { ...mail, lane: "SILENT" } }, NOW);
    expect(odd?.category).toBe(ACTION_CATEGORIES.plain);
    expect(odd?.data).not.toHaveProperty("lane");
  });
});

describe("parity with the native service (KlornPushPayload.java)", () => {
  // The same vectors are asserted in android/app/src/test/.../KlornPushPayloadTest.java,
  // so a repeat posted natively replaces one posted from here, and vice versa.
  it.each([
    ["item-1", 1470695920],
    ["email-1", 1646888158],
    ["pa-1", 1482157022],
    ["Klorn — Alice\nQ3 budget", 384908386],
    ["처리 완료", 1992001445],
  ])("notificationIdOf(%j) = %i", (key, id) => {
    expect(notificationIdOf(key)).toBe(id);
  });
});
