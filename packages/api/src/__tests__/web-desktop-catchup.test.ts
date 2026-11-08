/**
 * Windows desktop shell (apps/desktop-win, Tauri) catch-up banners — the pure
 * rules in packages/web/src/lib/native/desktop-catchup.ts.
 *
 * Live banners come from real-time `notification` frames the server tags
 * `alert: "push" | "meeting"`. A frame sent while the app was quit, the
 * machine slept, or the socket was down is lost (websocket.ts keeps no
 * replay), so on start and on every bell refetch the shell banners the
 * meeting bell rows it has not announced yet (urgent mail: decision N6,
 * web-desktop-push-catchup.test.ts) — mirroring the Mac app's
 * PushLedger (apps/desktop-mac/Sources/KlornMac/Notifications.swift):
 * silent baseline on first run, each id at most once across restarts, at most
 * five banners per pass, newest first — plus a freshness cutoff so a long
 * absence never dumps old mail.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ prisma: {} }));

import { SEEN_CAP } from "../../../web/src/lib/native/desktop-alerts";
import {
  ALL_ALERT_KINDS,
  type AlertLedger,
  allowedKindsFromConfig,
  CATCHUP_MAX,
  freshLedger,
  interruptFromRow,
  MEETING_CATCHUP_WINDOW_MS,
  PUSH_BELL_TITLE,
  parseLedger,
  planCatchUp,
  planLiveAlert,
  resolveLedger,
  SETTLE_MS,
} from "../../../web/src/lib/native/desktop-catchup";
import { firewallBellRow } from "../judge/firewall-push.js";
import { buildUrgentDedupMessage } from "../notify/urgent-dedup.js";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const MIN = 60_000;

function pushRow(id: string, ageMs: number, message = `Kim: Q4 budget [gm-${id}]`) {
  return {
    id,
    type: "email",
    title: PUSH_BELL_TITLE,
    message,
    isRead: false,
    createdAt: new Date(NOW - ageMs).toISOString(),
  };
}

function meetingRow(id: string, ageMs: number) {
  return {
    id,
    type: "meeting",
    title: "Meeting in 5 min: Standup",
    message: "Standup starts soon [evt_1]",
    isRead: false,
    createdAt: new Date(NOW - ageMs).toISOString(),
  };
}

function queueRow(id: string, ageMs: number) {
  return {
    id,
    type: "email",
    title: "New email",
    message: "Newsletter",
    isRead: false,
    createdAt: new Date(NOW - ageMs).toISOString(),
  };
}

const established = (notified: string[] = []): AlertLedger => ({
  owner: "user-1",
  baselineEstablished: true,
  notified,
});

function plan(
  ledger: AlertLedger,
  rows: unknown[],
  allowed: ReadonlySet<"push" | "meeting"> = ALL_ALERT_KINDS,
) {
  return planCatchUp({ ledger, rows, nowMs: NOW, allowed });
}

describe("interruptFromRow — which bell rows are interrupts", () => {
  it("reads a PUSH bell row and strips the server's trailing dedupe marker", () => {
    const row = interruptFromRow(pushRow("n1", 10 * MIN));
    expect(row?.alert).toEqual({
      id: "n1",
      kind: "push",
      title: PUSH_BELL_TITLE,
      body: "Kim: Q4 budget",
      open: null,
    });
    expect(row?.createdAtMs).toBe(NOW - 10 * MIN);
  });

  it("keeps a subject's own brackets — only the last (marker) group goes", () => {
    const row = interruptFromRow(pushRow("n1", MIN, "Kim: Q3 [URGENT] [gm-1,gm-2]"));
    expect(row?.alert.body).toBe("Kim: Q3 [URGENT]");
  });

  it("reads a meeting-starting-soon row", () => {
    expect(interruptFromRow(meetingRow("m1", MIN))?.alert).toEqual({
      id: "m1",
      kind: "meeting",
      title: "Meeting in 5 min: Standup",
      body: "Standup starts soon",
      open: null,
    });
  });

  it("ignores every other row: QUEUE mail, agent notes, briefings, malformed input", () => {
    expect(interruptFromRow(queueRow("q1", MIN))).toBeNull();
    expect(interruptFromRow({ ...pushRow("x", MIN), type: "briefing" })).toBeNull();
    expect(interruptFromRow({ ...pushRow("x", MIN), id: "" })).toBeNull();
    expect(interruptFromRow({ ...pushRow("x", MIN), id: "a".repeat(201) })).toBeNull();
    expect(interruptFromRow(null)).toBeNull();
    expect(interruptFromRow("Urgent email")).toBeNull();
    expect(interruptFromRow([pushRow("x", MIN)])).toBeNull();
  });

  it("an unparseable createdAt reads as NaN, never as fresh", () => {
    expect(interruptFromRow({ ...pushRow("x", MIN), createdAt: "soon" })?.createdAtMs).toBeNaN();
  });
});

describe("the bell rows the server actually writes are recognised", () => {
  it("the firewall PUSH / MEETING-lane bell row (judge/firewall-push.ts)", () => {
    const bell = firewallBellRow({
      gmailId: "18c0ffee",
      from: '"Kim Lee" <kim@example.com>',
      subject: "Signed contract due today",
    } as unknown as Parameters<typeof firewallBellRow>[0]);
    const row = interruptFromRow({
      id: "n1",
      ...bell,
      createdAt: new Date(NOW).toISOString(),
    });
    expect(row?.alert.kind).toBe("push");
    expect(row?.alert.body).toBe("Kim Lee: Signed contract due today");
  });

  it("the urgent-sweep bell row (automation-scheduler.ts) shares the title and marker", () => {
    const row = interruptFromRow({
      id: "n2",
      type: "email",
      title: "Urgent email",
      message: buildUrgentDedupMessage("Kim: invoice overdue", ["gm-1", "gm-2"]),
      createdAt: new Date(NOW).toISOString(),
    });
    expect(row?.alert).toMatchObject({ kind: "push", body: "Kim: invoice overdue" });
  });
});

describe("planCatchUp — first run is a silent baseline", () => {
  it("records every meeting row and banners none", () => {
    const result = plan(freshLedger("user-1"), [meetingRow("m1", MIN), meetingRow("m2", MIN)]);
    expect(result.toBanner).toEqual([]);
    expect(result.next).toEqual({
      owner: "user-1",
      baselineEstablished: true,
      notified: ["m1", "m2"],
    });
  });

  it("establishes the baseline even when the bell holds no interrupt", () => {
    const result = plan(freshLedger("user-1"), [queueRow("q1", MIN)]);
    expect(result.next.baselineEstablished).toBe(true);
    expect(result.next.notified).toEqual([]);
  });
});

describe("planCatchUp — PUSH rows belong to the urgent-mail catch-up (decision N6)", () => {
  it("neither banners nor records a PUSH row, on the first run or after", () => {
    const first = plan(freshLedger("user-1"), [pushRow("n1", 10 * MIN)]);
    expect(first.toBanner).toEqual([]);
    expect(first.next.notified).toEqual([]);
    const later = plan(established(), [pushRow("n1", 10 * MIN)]);
    expect(later.toBanner).toEqual([]);
    expect(later.next.notified).toEqual([]);
  });
});

describe("planCatchUp — meetings after the baseline", () => {
  const SEC = 1_000;

  it("banners a reminder that arrived while the app was away", () => {
    const result = plan(established(["old"]), [meetingRow("m1", MIN)]);
    expect(result.toBanner.map((a) => a.id)).toEqual(["m1"]);
    expect(result.next.notified).toEqual(["old", "m1"]);
  });

  it("never repeats an id already announced, live or by an earlier catch-up", () => {
    const result = plan(established(["m1"]), [meetingRow("m1", MIN)]);
    expect(result.toBanner).toEqual([]);
    expect(result.next.notified).toEqual(["m1"]);
  });

  it("caps one pass at five banners, newest first, and records the rest silently", () => {
    const rows = [7, 3, 6, 1, 5, 2, 4].map((n) => meetingRow(`m${n}`, 30 * SEC + n * 10 * SEC));
    const result = plan(established(), rows);
    expect(CATCHUP_MAX).toBe(5);
    expect(result.toBanner.map((a) => a.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(new Set(result.next.notified)).toEqual(new Set(rows.map((r) => r.id)));
    // The two left over are not offered again on the next pass.
    expect(plan(result.next, rows).toBanner).toEqual([]);
  });

  it("dedupes an id the server returned twice", () => {
    const result = plan(established(), [meetingRow("m1", MIN), meetingRow("m1", MIN)]);
    expect(result.toBanner.map((a) => a.id)).toEqual(["m1"]);
    expect(result.next.notified).toEqual(["m1"]);
  });

  it("does not banner a meeting reminder that may describe a meeting already under way", () => {
    // Reminders are written 1-5 minutes before the start (api background.ts),
    // so only a short delay keeps "Meeting in N min" roughly true.
    const started = meetingRow("late", MEETING_CATCHUP_WINDOW_MS + 1_000);
    const soon = meetingRow("soon", MEETING_CATCHUP_WINDOW_MS - 1_000);
    const result = plan(established(), [started, soon]);
    expect(MEETING_CATCHUP_WINDOW_MS).toBe(2 * MIN);
    expect(result.toBanner.map((a) => a.id)).toEqual(["soon"]);
    expect(result.next.notified).toEqual(expect.arrayContaining(["late", "soon"]));
  });

  it("a row already read elsewhere (phone, web) is recorded, never bannered", () => {
    const result = plan(established(), [{ ...meetingRow("read", MIN), isRead: true }]);
    expect(result.toBanner).toEqual([]);
    expect(result.next.notified).toEqual(["read"]);
  });

  it("an unparseable timestamp is recorded, never bannered", () => {
    const result = plan(established(), [{ ...meetingRow("odd", MIN), createdAt: "nope" }]);
    expect(result.toBanner).toEqual([]);
    expect(result.next.notified).toEqual(["odd"]);
  });

  it("leaves a row younger than the settle window to its live frame", () => {
    // The server writes the bell row, then evaluates the preference/quiet-hours
    // gate, then sends the tagged frame. A refetch landing in between must not
    // banner (or swallow) the row before the server's gate has spoken.
    const result = plan(established(), [meetingRow("new", SETTLE_MS - 1_000)]);
    expect(result.toBanner).toEqual([]);
    expect(result.next.notified).toEqual([]);
    const later = planCatchUp({
      ledger: result.next,
      rows: [meetingRow("new", SETTLE_MS - 1_000)],
      nowMs: NOW + SETTLE_MS,
      allowed: ALL_ALERT_KINDS,
    });
    expect(later.toBanner.map((a) => a.id)).toEqual(["new"]);
  });

  it("a category the user turned off is recorded silently, never bannered", () => {
    const result = plan(established(), [meetingRow("m1", MIN)], new Set(["push"]));
    expect(result.toBanner).toEqual([]);
    expect(result.next.notified).toEqual(["m1"]);
  });

  it("ignores rows that are not interrupts", () => {
    const result = plan(established(), [queueRow("q1", 2 * MIN)]);
    expect(result.toBanner).toEqual([]);
    expect(result.next.notified).toEqual([]);
  });

  it("caps the remembered ids, dropping the oldest", () => {
    const full = established(Array.from({ length: SEEN_CAP }, (_, i) => `old-${i}`));
    const result = plan(full, [meetingRow("m1", MIN)]);
    expect(result.next.notified).toHaveLength(SEEN_CAP);
    expect(result.next.notified.at(-1)).toBe("m1");
    expect(result.next.notified[0]).toBe("old-1");
  });

  it("never mutates its input ledger", () => {
    const ledger = established(["a"]);
    const snapshot = structuredClone(ledger);
    plan(ledger, [meetingRow("m1", MIN)]);
    expect(ledger).toEqual(snapshot);
  });

  it("tolerates a non-array row list", () => {
    const result = planCatchUp({
      ledger: established(),
      rows: "nope" as unknown as unknown[],
      nowMs: NOW,
      allowed: ALL_ALERT_KINDS,
    });
    expect(result.toBanner).toEqual([]);
  });
});

describe("planLiveAlert — the real-time path shares the ledger", () => {
  const tagged = {
    id: "n1",
    type: "email",
    title: PUSH_BELL_TITLE,
    message: "Kim: Q4 budget",
    alert: "push",
  };

  it("banners a tagged frame once and records it, so catch-up never repeats it", () => {
    const first = planLiveAlert(established(), tagged);
    expect(first.alert?.id).toBe("n1");
    expect(first.next.notified).toEqual(["n1"]);
    expect(planLiveAlert(first.next, tagged).alert).toBeNull();
    expect(plan(first.next, [pushRow("n1", 2 * MIN)]).toBanner).toEqual([]);
  });

  it("records an UNTAGGED interrupt frame silently — the server's gate said no", () => {
    // Quiet hours / opted out: the server sent the frame without `alert`.
    // Catch-up must not banner it a minute later from the bell refetch.
    const { alert: _drop, ...untagged } = tagged;
    const result = planLiveAlert(established(), untagged);
    expect(result.alert).toBeNull();
    expect(result.next.notified).toEqual(["n1"]);
    expect(plan(result.next, [pushRow("n1", 2 * MIN)]).toBanner).toEqual([]);
  });

  it("leaves the ledger alone for frames that are not interrupts", () => {
    const ledger = established(["a"]);
    const result = planLiveAlert(ledger, { id: "q1", type: "email", title: "New email" });
    expect(result.alert).toBeNull();
    expect(result.next).toEqual(ledger);
  });

  it("never establishes the baseline — only a catch-up pass does", () => {
    const result = planLiveAlert(freshLedger("user-1"), tagged);
    expect(result.alert?.id).toBe("n1");
    expect(result.next.baselineEstablished).toBe(false);
  });
});

describe("ledger storage is untrusted input, scoped to one account", () => {
  it("round-trips a stored ledger", () => {
    const ledger = established(["a", "b"]);
    expect(parseLedger(JSON.stringify(ledger))).toEqual(ledger);
  });

  it("reads anything malformed as no ledger", () => {
    for (const raw of [
      null,
      "",
      "{",
      "[]",
      "42",
      JSON.stringify({ owner: "", baselineEstablished: true, notified: [] }),
      JSON.stringify({ owner: "u", baselineEstablished: "yes", notified: [] }),
      JSON.stringify({ owner: "u", baselineEstablished: true, notified: "a" }),
    ]) {
      expect(parseLedger(raw)).toBeNull();
    }
  });

  it("drops non-string ids and caps the list", () => {
    const raw = JSON.stringify({
      owner: "u",
      baselineEstablished: true,
      notified: [1, "a", null, ...Array.from({ length: SEEN_CAP + 5 }, (_, i) => `id-${i}`)],
    });
    const ledger = parseLedger(raw);
    expect(ledger?.notified).toHaveLength(SEEN_CAP);
    expect(ledger?.notified.every((id) => typeof id === "string")).toBe(true);
  });

  it("another account's ledger is never reused — that account starts a new baseline", () => {
    expect(resolveLedger(established(["a"]), "user-2")).toEqual(freshLedger("user-2"));
    expect(resolveLedger(established(["a"]), "user-1")).toEqual(established(["a"]));
    expect(resolveLedger(null, "user-1")).toEqual(freshLedger("user-1"));
  });
});

describe("allowedKindsFromConfig — the user's category opt-outs", () => {
  it("allows both kinds by default, as the server does", () => {
    expect(allowedKindsFromConfig({})).toEqual(new Set(["push", "meeting"]));
  });

  it("drops a kind whose category the user turned off", () => {
    expect(allowedKindsFromConfig({ notifyEmailUrgent: false, notifyMeeting: true })).toEqual(
      new Set(["meeting"]),
    );
    expect(allowedKindsFromConfig({ notifyEmailUrgent: true, notifyMeeting: false })).toEqual(
      new Set(["push"]),
    );
  });

  it("returns null for a malformed response, so the pass is skipped, not recorded", () => {
    expect(allowedKindsFromConfig(null)).toBeNull();
    expect(allowedKindsFromConfig("x")).toBeNull();
    expect(allowedKindsFromConfig([])).toBeNull();
  });
});
