/**
 * Capacitor shell (Structure A, PR6b): Android posts a data-only Klorn push
 * itself (with the decision-N1 buttons) through @capacitor/local-notifications.
 * The pure half, packages/web/src/lib/native/android-push.ts, is a port of
 * apps/mobile/src/push/android.ts and must stay byte-for-byte compatible with
 * what the native side registers: the same channel ids, the same action
 * category ids as iOS AppDelegate.swift, the same notification-id hash as
 * KlornPushPayload.java.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTION_CATEGORIES,
  ANDROID_CHANNELS,
  androidActionTypes,
  notificationIdOf,
  parseDataPush,
  STALE_AFTER_MS,
} from "../../../web/src/lib/native/android-push";
import { PUSH_ACTIONS } from "../../../web/src/lib/native/push-intent";

const NOW = Date.parse("2026-10-16T01:28:00Z");

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

describe("ids shared with the native projects", () => {
  it("keeps the channel ids the Android app already created", () => {
    expect(ANDROID_CHANNELS).toEqual({
      push: { id: "klorn_push", importance: 4 },
      other: { id: "klorn_other", importance: 3 },
    });
  });

  it("uses the iOS AppDelegate's category and action identifiers", () => {
    const swift = readFileSync(
      new URL("../../../../apps/mobile/ios/App/App/AppDelegate.swift", import.meta.url),
      "utf8",
    );
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
  });

  it.each([
    ["item-1", 1470695920],
    ["email-1", 1646888158],
    ["pa-1", 1482157022],
    ["Klorn — Alice\nQ3 budget", 384908386],
    ["처리 완료", 1992001445],
  ])("notificationIdOf(%j) = %i (KlornPushPayload.java parity)", (key, id) => {
    expect(notificationIdOf(key)).toBe(id);
  });
});

describe("parseDataPush", () => {
  it("posts a data-only message with the draft actions on the PUSH channel", () => {
    const push = parseDataPush({ data: full }, NOW);
    expect(push).toMatchObject({
      title: full.title,
      body: full.body,
      category: ACTION_CATEGORIES.withDraft,
      channelId: ANDROID_CHANNELS.push.id,
      notificationId: notificationIdOf("att-1"),
    });
    expect(push?.data).toEqual({
      emailId: full.emailId,
      attentionItemId: full.attentionItemId,
      pendingActionId: full.pendingActionId,
      route: full.route,
      url: full.url,
    });
  });

  it("leaves a notification message (the OS showed it) alone", () => {
    expect(parseDataPush({ title: "shown", data: full }, NOW)).toBeNull();
  });

  it("drops a stale replay and a payload without title or body", () => {
    expect(
      parseDataPush({ data: { ...full, sentAt: String(NOW - STALE_AFTER_MS - 1) } }, NOW),
    ).toBeNull();
    expect(parseDataPush({ data: { ...full, title: "  " } }, NOW)).toBeNull();
  });

  it("picks the action set from the ids and lane, never trusting an unknown lane", () => {
    const { pendingActionId: _p, ...mail } = full;
    expect(parseDataPush({ data: { ...mail, lane: "MEETING" } }, NOW)?.category).toBe(
      ACTION_CATEGORIES.meeting,
    );
    const odd = parseDataPush({ data: { ...mail, lane: "SILENT" } }, NOW);
    expect(odd?.category).toBe(ACTION_CATEGORIES.plain);
    expect(odd?.data).not.toHaveProperty("lane");
    expect(
      parseDataPush({ data: { title: "Briefing", body: "Ready", category: "briefing" } }, NOW)
        ?.category,
    ).toBeNull();
  });
});

describe("androidActionTypes", () => {
  it("offers Later · Not urgent · Done (Later only for MEETING), never Send", () => {
    const types = androidActionTypes({ later: "L", notUrgent: "N", done: "D" });
    const byId = Object.fromEntries(types.map((t) => [t.id, t.actions]));
    expect(byId[ACTION_CATEGORIES.plain]?.map((a) => a.id)).toEqual([
      PUSH_ACTIONS.later,
      PUSH_ACTIONS.notUrgent,
      PUSH_ACTIONS.done,
    ]);
    expect(byId[ACTION_CATEGORIES.meeting]?.map((a) => a.id)).toEqual([PUSH_ACTIONS.later]);
    for (const type of types)
      expect(type.actions.map((a) => a.id)).not.toContain(PUSH_ACTIONS.send);
  });
});
