/**
 * Windows desktop shell (apps/desktop-win, Tauri) OS banners — the pure
 * decision rules in packages/web/src/lib/native/desktop-alerts.ts.
 *
 * The server already decides which real-time `notification` frames are
 * interrupts: it tags PUSH-lane mail and meeting-starting-soon frames with
 * `alert: "push" | "meeting"` only when the user's notification preferences
 * and quiet hours allow that category (notify/desktop-alert.ts). The shell
 * must banner exactly those frames, once each, and nothing else — the
 * Tauri notification plugin replaces window.Notification, so any frame that
 * slipped through would become an OS toast for QUEUE/INFO/agent chatter.
 */

import { describe, expect, it } from "vitest";
import {
  BODY_MAX,
  parseDesktopAlert,
  parseSeenIds,
  planDesktopAlert,
  SEEN_CAP,
  TITLE_MAX,
} from "../../../web/src/lib/native/desktop-alerts";

const pushFrame = {
  id: "notif-1",
  type: "email",
  title: "Urgent email",
  message: "Kim: Q4 budget",
  alert: "push",
};

describe("parseDesktopAlert — which real-time frames become OS banners", () => {
  it("accepts a PUSH-tagged frame and keeps sender + subject", () => {
    expect(parseDesktopAlert(pushFrame)).toEqual({
      id: "notif-1",
      kind: "push",
      title: "Urgent email",
      body: "Kim: Q4 budget",
    });
  });

  it("accepts a meeting-tagged frame and strips the server's trailing [id] marker", () => {
    const alert = parseDesktopAlert({
      id: "notif-2",
      type: "meeting",
      title: "Meeting in 5 min: Standup",
      message: "Standup starts soon [evt_123]",
      alert: "meeting",
    });
    expect(alert).toEqual({
      id: "notif-2",
      kind: "meeting",
      title: "Meeting in 5 min: Standup",
      body: "Standup starts soon",
    });
  });

  it("keeps a PUSH subject's own trailing brackets — only meeting markers are stripped", () => {
    expect(parseDesktopAlert({ ...pushFrame, message: "Kim: Q3 report [URGENT]" })?.body).toBe(
      "Kim: Q3 report [URGENT]",
    );
  });

  it("strips a meeting marker that follows a join link", () => {
    const alert = parseDesktopAlert({
      id: "n",
      title: "Meeting in 3 min: Sync",
      message: "Join link: https://meet.example/abc [evt_9]",
      alert: "meeting",
    });
    expect(alert?.body).toBe("Join link: https://meet.example/abc");
  });

  it("ignores frames the server did not tag as an interrupt (QUEUE/INFO/SILENT, agent, briefing)", () => {
    expect(parseDesktopAlert({ ...pushFrame, alert: undefined })).toBeNull();
    expect(
      parseDesktopAlert({ id: "n", type: "insight", title: "Agent note", message: "x" }),
    ).toBeNull();
    expect(
      parseDesktopAlert({ id: "n", type: "briefing", title: "Daily Briefing Ready", message: "" }),
    ).toBeNull();
    expect(
      parseDesktopAlert({ id: "n", type: "system", title: "conversations-updated", message: "" }),
    ).toBeNull();
  });

  it("ignores an untagged 'Urgent email' frame — it does not re-classify from type/title", () => {
    expect(parseDesktopAlert({ ...pushFrame, alert: null })).toBeNull();
  });

  it("rejects unknown alert kinds, including retired lanes", () => {
    for (const alert of ["queue", "info", "silent", "AUTO", "CALL", "PUSH", 1, true]) {
      expect(parseDesktopAlert({ ...pushFrame, alert })).toBeNull();
    }
  });

  it("rejects malformed input instead of throwing", () => {
    for (const bad of [null, undefined, "x", 42, [], { alert: "push" }]) {
      expect(parseDesktopAlert(bad)).toBeNull();
    }
    expect(parseDesktopAlert({ ...pushFrame, id: "" })).toBeNull();
    expect(parseDesktopAlert({ ...pushFrame, id: 7 })).toBeNull();
    expect(parseDesktopAlert({ ...pushFrame, id: "x".repeat(201) })).toBeNull();
    expect(parseDesktopAlert({ ...pushFrame, title: 5 })).toBeNull();
  });

  it("falls back to 'Klorn' for a blank title and an empty body for a missing message", () => {
    expect(parseDesktopAlert({ id: "n", title: "  ", alert: "push" })).toEqual({
      id: "n",
      kind: "push",
      title: "Klorn",
      body: "",
    });
  });

  it("caps title and body length so a hostile subject cannot flood the toast", () => {
    const alert = parseDesktopAlert({
      ...pushFrame,
      title: "t".repeat(TITLE_MAX + 50),
      message: "b".repeat(BODY_MAX + 50),
    });
    expect(alert?.title.length).toBe(TITLE_MAX);
    expect(alert?.body.length).toBe(BODY_MAX);
  });
});

describe("planDesktopAlert — one banner per notification id", () => {
  it("banners a new id and records it", () => {
    const plan = planDesktopAlert([], pushFrame);
    expect(plan.alert?.id).toBe("notif-1");
    expect(plan.seen).toEqual(["notif-1"]);
  });

  it("does not banner an id already seen this session", () => {
    const plan = planDesktopAlert(["notif-1"], pushFrame);
    expect(plan.alert).toBeNull();
    expect(plan.seen).toEqual(["notif-1"]);
  });

  it("does not record or banner frames that are not interrupts", () => {
    const plan = planDesktopAlert(["a"], { id: "n", type: "insight", title: "x", message: "" });
    expect(plan.alert).toBeNull();
    expect(plan.seen).toEqual(["a"]);
  });

  it("never mutates the seen list it was given", () => {
    const seen = Object.freeze(["a"]) as readonly string[];
    const plan = planDesktopAlert(seen, pushFrame);
    expect(seen).toEqual(["a"]);
    expect(plan.seen).toEqual(["a", "notif-1"]);
  });

  it("keeps at most SEEN_CAP ids, dropping the oldest", () => {
    const seen = Array.from({ length: SEEN_CAP }, (_, i) => `old-${i}`);
    const plan = planDesktopAlert(seen, pushFrame);
    expect(plan.seen).toHaveLength(SEEN_CAP);
    expect(plan.seen[0]).toBe("old-1");
    expect(plan.seen.at(-1)).toBe("notif-1");
  });
});

describe("parseSeenIds — session storage is untrusted", () => {
  it("reads a stored JSON array of ids", () => {
    expect(parseSeenIds(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
  });

  it("returns an empty list for missing, corrupt or wrong-shaped values", () => {
    expect(parseSeenIds(null)).toEqual([]);
    expect(parseSeenIds("{not json")).toEqual([]);
    expect(parseSeenIds(JSON.stringify({ a: 1 }))).toEqual([]);
  });

  it("drops non-string entries and trims to SEEN_CAP", () => {
    expect(parseSeenIds(JSON.stringify(["a", 1, null, "b"]))).toEqual(["a", "b"]);
    const many = Array.from({ length: SEEN_CAP + 10 }, (_, i) => `id-${i}`);
    const parsed = parseSeenIds(JSON.stringify(many));
    expect(parsed).toHaveLength(SEEN_CAP);
    expect(parsed[0]).toBe("id-10");
  });
});
